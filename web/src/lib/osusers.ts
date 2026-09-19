import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { envNumber } from './panel';

/**
 * Linux accounts are the source of truth for who exists. The panel mirrors them
 * read-only: it never creates, modifies or deletes an OS account, so `useradd`
 * is all it takes for someone to appear in the panel.
 *
 * "Mirrored" means a human account — root, or uid >= BACKUP_MGR_MIN_UID (1000 by
 * default) with a real login shell. Service accounts (www-data, mysql, …) are
 * deliberately skipped: they have no password a human would type and no business
 * holding backup credentials.
 */

export type OsUser = {
  username: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
  /** uid 0. */
  privileged: boolean;
};

/**
 * The account database, plus whether it could actually be read.
 *
 * The distinction matters: "no accounts" and "could not read the accounts" look
 * identical if both return an empty list, and treating a transient `getent`
 * failure as "every account was deleted" would mis-flag every panel user as gone.
 * Callers that react to absence (orphan detection, pruning) must check `ok`.
 */
export type OsUserSource = {
  ok: boolean;
  users: OsUser[];
  error?: string;
};

type RawEntry = {
  username: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
};

const SHELL_DENY = /(nologin|false|sync|shutdown|halt|uucp)$/;

export function minUid(): number {
  // A blank value must not become 0, which would mirror every service account.
  const raw = envNumber('BACKUP_MGR_MIN_UID');
  return raw !== undefined && raw >= 0 ? raw : 1000;
}

/** Root is mirrorable by default; set BACKUP_MGR_INCLUDE_ROOT=0 to keep it out. */
export function includeRoot(): boolean {
  return process.env.BACKUP_MGR_INCLUDE_ROOT !== '0';
}

export function excludedUsers(): Set<string> {
  return new Set(
    (process.env.BACKUP_MGR_EXCLUDE_USERS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * The account database. Normally `getent passwd` so NIS/LDAP accounts are included,
 * but BACKUP_MGR_PASSWD_FILE points at a file instead — used by the tests, and handy
 * when you want the panel to mirror a curated list rather than the live one.
 */
function readPasswdRaw(): string {
  const file = process.env.BACKUP_MGR_PASSWD_FILE;
  if (file) return fs.readFileSync(file, 'utf8');
  return execFileSync('getent', ['passwd'], { encoding: 'utf8' });
}

function parsePasswd(out: string): RawEntry[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const f = line.split(':');
      return {
        username: f[0] ?? '',
        uid: Number(f[2]),
        gid: Number(f[3]),
        home: f[5] ?? '',
        shell: f[6] ?? '',
      };
    })
    .filter((r) => r.username.length > 0 && Number.isFinite(r.uid));
}

/** Is this account one a human could own, and that we are allowed to mirror? */
export function isMirrored(r: RawEntry): boolean {
  if (excludedUsers().has(r.username)) return false;
  if (SHELL_DENY.test(r.shell)) return false;
  if (r.uid === 0) return includeRoot();
  return r.uid >= minUid();
}

function toOsUser(r: RawEntry): OsUser {
  return { ...r, privileged: r.uid === 0 };
}

// `getent` is only a few ms, but the Users page and every request that resolves a
// username would otherwise shell out repeatedly. /etc/passwd changes are rare and
// a new account showing up a few seconds late is harmless.
/** How long an account-database read is reused. Read per call so tests and a
 *  restart pick up a change. */
function cacheMs(): number {
  const raw = envNumber('BACKUP_MGR_OSUSER_CACHE_MS');
  return raw !== undefined && raw >= 0 ? raw : 5000;
}

let cache: { at: number; source: OsUserSource } | null = null;

export function resetOsUserCache(): void {
  cache = null;
}

/**
 * Every mirrorable account, ordered by uid, with the read's success reported.
 * Cached for a few seconds so the Users page and the per-request account check
 * do not each spawn `getent`.
 */
export function osUserSource(): OsUserSource {
  const now = Date.now();
  if (cache && now - cache.at < cacheMs()) return cache.source;
  let source: OsUserSource;
  try {
    const users = parsePasswd(readPasswdRaw())
      .filter(isMirrored)
      .map(toOsUser)
      .sort((a, b) => a.uid - b.uid);
    source = { ok: true, users };
  } catch (e) {
    // No getent (or an unreadable passwd database). Reported as a failure rather
    // than as an empty database, so nothing gets deleted or disabled on the
    // strength of a transient error.
    source = { ok: false, users: [], error: e instanceof Error ? e.message : String(e) };
  }
  cache = { at: now, source };
  return source;
}

/** Every mirrorable account, ordered by uid. Empty also means "could not read". */
export function listOsUsers(): OsUser[] {
  return osUserSource().users;
}

/**
 * Look up a single account and apply the same mirroring rules. Used by login, so
 * a non-mirrored account can never authenticate even if it has a valid password.
 */
export function getOsUser(username: string): OsUser | null {
  // Reject anything that could not be a real account name, so a crafted value can
  // never reach a shell as an argument.
  if (!username || !/^[A-Za-z0-9._-]{1,32}$/.test(username)) return null;
  return listOsUsers().find((u) => u.username === username) ?? null;
}

/**
 * Who administers the panel out of the box: BACKUP_MGR_ADMIN_USER if set,
 * otherwise the lowest-uid human account (normally the deploy user), falling back
 * to root if no human account exists. Everyone else starts as a normal user.
 */
export function preferredAdmin(): string | null {
  const explicit = process.env.BACKUP_MGR_ADMIN_USER?.trim();
  if (explicit) return explicit;
  const users = listOsUsers();
  const human = users.find((u) => !u.privileged);
  return (human ?? users[0])?.username ?? null;
}

/** True when the panel's own process user is root (affects sudo usage). */
export function runningAsRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}
