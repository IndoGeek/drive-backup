import fs from 'node:fs';
import {
  autoProvision,
  autoSync,
  passwdWatchIntervalMs,
  passwdWatchPath,
  syncIntervalMs,
} from './panel';

export type UserSyncReport = {
  at: string;

  reason: string;
  added: string[];
  missing: string[];
  sourceOk: boolean;
};

export type UserWatchState = {
  running: boolean;

  auto_sync: boolean;

  auto_provision: boolean;
  interval_ms: number;
  watching_file: string | null;
  last: UserSyncReport | null;

  provisioned: string[];

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

  if (st.errors.length > 20) st.errors.splice(0, st.errors.length - 20);
  console.error(`[user-sync] ${msg}`);
}

function fmt(list: string[]): string {
  return list.join(', ');
}

export async function syncUsersNow(reason = 'request'): Promise<UserSyncReport | null> {
  const st = state();
  if (st.busy) return st.last;
  st.busy = true;
  try {
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
    recordError(`could not watch ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function startUserWatch(): void {
  const st = state();
  if (st.running) return;
  st.running = true;

  if (!autoSync()) {
    note('automatic sync disabled (BACKUP_MGR_AUTO_SYNC=0) — reconcile on demand only');
    return;
  }

  st.timer = setInterval(() => void syncUsersNow('interval'), syncIntervalMs());

  st.timer.unref?.();
  watchPasswdFile();
  note(`polling every ${Math.round(syncIntervalMs() / 1000)}s`);
  if (autoProvision()) note('auto-provision is ON: new accounts get an instance created for them');
  void syncUsersNow('startup');
}

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
