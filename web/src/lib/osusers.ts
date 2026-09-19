import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { envNumber } from './panel';

export type OsUser = {
  username: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;

  privileged: boolean;
};

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
  const raw = envNumber('BACKUP_MGR_MIN_UID');
  return raw !== undefined && raw >= 0 ? raw : 1000;
}

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

export function isMirrored(r: RawEntry): boolean {
  if (excludedUsers().has(r.username)) return false;
  if (SHELL_DENY.test(r.shell)) return false;
  if (r.uid === 0) return includeRoot();
  return r.uid >= minUid();
}

function toOsUser(r: RawEntry): OsUser {
  return { ...r, privileged: r.uid === 0 };
}

function cacheMs(): number {
  const raw = envNumber('BACKUP_MGR_OSUSER_CACHE_MS');
  return raw !== undefined && raw >= 0 ? raw : 5000;
}

let cache: { at: number; source: OsUserSource } | null = null;

export function resetOsUserCache(): void {
  cache = null;
}

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
    source = { ok: false, users: [], error: e instanceof Error ? e.message : String(e) };
  }
  cache = { at: now, source };
  return source;
}

export function listOsUsers(): OsUser[] {
  return osUserSource().users;
}

export function getOsUser(username: string): OsUser | null {
  if (!username || !/^[A-Za-z0-9._-]{1,32}$/.test(username)) return null;
  return listOsUsers().find((u) => u.username === username) ?? null;
}

export function preferredAdmin(): string | null {
  const explicit = process.env.BACKUP_MGR_ADMIN_USER?.trim();
  if (explicit) return explicit;
  const users = listOsUsers();
  const human = users.find((u) => !u.privileged);
  return (human ?? users[0])?.username ?? null;
}

export function runningAsRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}
