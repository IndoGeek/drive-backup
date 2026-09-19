import fs from 'node:fs';
import {
  autoProvision,
  autoSync,
  passwdWatchIntervalMs,
  passwdWatchPath,
  syncIntervalMs,
} from './panel';

/**
 * Keeps the panel's mirror of Linux accounts current without anyone asking.
 *
 * The model is "the OS owns identity": an account exists in the panel because it
 * exists in /etc/passwd. That is only true if something reconciles the two, so
 * this module — started once per server process from `src/instrumentation.ts` —
 *
 *   - reconciles immediately at startup, so the panel is correct the moment it
 *     comes up (after a reboot, a `pm2 restart`, a deploy),
 *   - polls on an interval as a backstop, and
 *   - watches the passwd file, so `useradd` / `userdel` are picked up within
 *     seconds rather than at the next poll.
 *
 * Only *authorization records* are synced. Creating, modifying or deleting a
 * Linux account is never done by the panel; `useradd` is the add-user story.
 * No record is ever deleted here — a removed account is merely flagged as
 * orphaned until an admin prunes it, so re-creating an account keeps its
 * permissions.
 *
 * Provisioning (creating a user's instance directory and seeded config.yml) is
 * separate and *off by default*, because it writes into that user's home: see
 * `autoProvision()` in ./panel.ts.
 */

export type UserSyncReport = {
  at: string;
  /** Why the sync ran: 'startup' | 'interval' | 'passwd-change' | 'request'. */
  reason: string;
  added: string[];
  missing: string[];
  sourceOk: boolean;
};

export type UserWatchState = {
  /** The watcher is active in this process. */
  running: boolean;
  /** False when BACKUP_MGR_AUTO_SYNC=0. */
  auto_sync: boolean;
  /** False when BACKUP_MGR_AUTO_PROVISION is not 1. */
  auto_provision: boolean;
  interval_ms: number;
  watching_file: string | null;
  last: UserSyncReport | null;
  /** Accounts auto-provisioned by the watcher (empty unless auto-provision is on). */
  provisioned: string[];
  /** Recent failures, newest last. Surfaced in the panel so a broken mirror shows. */
  errors: string[];
};

type WatchState = {
  running: boolean;
  timer: ReturnType<typeof setInterval> | null;
  file: string | null;
  debounce: ReturnType<typeof setTimeout> | null;
  busy: boolean;
  last: UserSyncReport | null;
  provisioned: string[];
  errors: string[];
};

// Held on globalThis so a Next.js dev-mode reload (or a second register() call)
// cannot start a second loop, or a second sqlite handle, in one process.
const GLOBAL_KEY = '__backupMgrUserWatch';

type GlobalWithWatch = typeof globalThis & { [GLOBAL_KEY]?: WatchState };

function state(): WatchState {
  const g = globalThis as GlobalWithWatch;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      running: false,
      timer: null,
      file: null,
      debounce: null,
      busy: false,
      last: null,
      provisioned: [],
      errors: [],
    };
  }
  return g[GLOBAL_KEY]!;
}

function note(msg: string): void {
  console.log(`[user-sync] ${msg}`);
}

function recordError(msg: string): void {
  const st = state();
  st.errors.push(msg);
  // Keep the tail only; this is diagnostics, not an audit log.
  if (st.errors.length > 20) st.errors.splice(0, st.errors.length - 20);
  console.error(`[user-sync] ${msg}`);
}

function fmt(list: string[]): string {
  return list.join(', ');
}

/**
 * Reconcile now. Safe to call from anywhere (the API uses it for "Re-sync");
 * concurrent calls collapse into the one already running.
 */
export async function syncUsersNow(reason = 'request'): Promise<UserSyncReport | null> {
  const st = state();
  if (st.busy) return st.last;
  st.busy = true;
  try {
    // Imported lazily so instrumentation never pulls the database layer into the
    // Edge bundle, and so a broken DB fails here rather than at server start.
    const { reconcileUsers } = await import('./users');
    const result = reconcileUsers();
    st.last = {
      at: new Date().toISOString(),
      reason,
      added: result.added,
      missing: result.missing,
      sourceOk: result.sourceOk,
    };
    if (!result.sourceOk) {
      recordError('could not read the account database; nothing was changed');
      return st.last;
    }
    if (result.added.length) note(`new account(s) mirrored from Linux: ${fmt(result.added)} (${reason})`);
    if (result.missing.length) {
      note(
        `account(s) no longer on this server: ${fmt(result.missing)} — records kept, permissions ` +
          'survive if the account comes back; an admin can prune them',
      );
    }
    if (autoProvision() && result.added.length) await provisionNew(result.added);
    return st.last;
  } catch (e) {
    recordError(e instanceof Error ? e.message : String(e));
    return st.last;
  } finally {
    st.busy = false;
  }
}

/** Create the instance of each newly mirrored account. Opt-in (BACKUP_MGR_AUTO_PROVISION=1). */
async function provisionNew(usernames: string[]): Promise<void> {
  const { instanceFor, provision } = await import('./instance');
  for (const username of usernames) {
    const inst = instanceFor(username);
    if (!inst) continue;
    const res = await provision(inst);
    if (res.ok) {
      state().provisioned.push(username);
      note(`provisioned '${username}' at ${inst.root}`);
    } else {
      recordError(`could not provision '${username}': ${res.error ?? 'unknown error'}`);
    }
  }
}

/**
 * Watch the passwd file for edits. `useradd` rewrites it, so this turns a new
 * account into a panel user within a couple of seconds. Debounced because a
 * single account edit touches the file more than once.
 *
 * fs.watchFile polls stat() itself, which works everywhere (including filesystems
 * where inotify does not) at the cost of one stat every couple of seconds.
 */
function watchPasswdFile(): void {
  const st = state();
  const file = passwdWatchPath();
  try {
    fs.watchFile(file, { interval: passwdWatchIntervalMs() }, () => {
      if (st.debounce) clearTimeout(st.debounce);
      st.debounce = setTimeout(() => void syncUsersNow('passwd-change'), 400);
      st.debounce.unref?.();
    });
    st.file = file;
    note(`watching ${file} for account changes`);
  } catch (e) {
    // Not fatal: the interval below still reconciles the mirror.
    recordError(`could not watch ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Start the watcher. Idempotent, and a no-op (beyond logging) when
 * BACKUP_MGR_AUTO_SYNC=0 — reconciliation then happens only when the panel asks
 * for it, e.g. the Users page or a sign-in.
 */
export function startUserWatch(): void {
  const st = state();
  if (st.running) return;
  st.running = true;

  if (!autoSync()) {
    note('automatic sync disabled (BACKUP_MGR_AUTO_SYNC=0) — reconcile on demand only');
    return;
  }

  st.timer = setInterval(() => void syncUsersNow('interval'), syncIntervalMs());
  // Do not hold the process open on this account alone.
  st.timer.unref?.();
  watchPasswdFile();
  note(`polling every ${Math.round(syncIntervalMs() / 1000)}s`);
  if (autoProvision()) note('auto-provision is ON: new accounts get an instance created for them');
  void syncUsersNow('startup');
}

/** Stop the watcher. Used by tests; the panel never stops it. */
export function stopUserWatch(): void {
  const st = state();
  if (st.timer) clearInterval(st.timer);
  if (st.debounce) clearTimeout(st.debounce);
  if (st.file) fs.unwatchFile(st.file);
  st.timer = null;
  st.debounce = null;
  st.file = null;
  st.running = false;
}

/** What the panel shows about the mirror. */
export function userWatchState(): UserWatchState {
  const st = state();
  return {
    running: st.running,
    auto_sync: autoSync(),
    auto_provision: autoProvision(),
    interval_ms: syncIntervalMs(),
    watching_file: st.file,
    last: st.last,
    provisioned: st.provisioned,
    errors: st.errors.slice(-5),
  };
}
