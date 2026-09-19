import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ALL_PERMISSIONS, normalizePermissions, type Permission } from './permissions';

export type User = {
  id: number;
  username: string;
  is_admin: boolean;
  permissions: Permission[];
  /** Set while the account still uses an admin-assigned / default password. */
  must_change_password: boolean;
  created_at: string;
  updated_at: string;
};

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  is_admin: number;
  permissions: string;
  must_change_password: number;
  created_at: string;
  updated_at: string;
};

function dataDir(): string {
  const dir = process.env.BACKUP_MGR_DATA_DIR || path.join(process.cwd(), 'data');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function dbPath(): string {
  return process.env.BACKUP_MGR_USERS_DB || path.join(dataDir(), 'users.db');
}

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (_db) return _db;
  const d = new Database(dbPath());
  d.pragma('journal_mode = WAL');
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      permissions TEXT NOT NULL DEFAULT '[]',
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureColumns(d);
  bootstrapAdmin(d);
  // The hash is not a secret we want world-readable. The 0700 parent dir already
  // blocks traversal, but match session.secret (0600) for defence in depth.
  try {
    fs.chmodSync(dbPath(), 0o600);
  } catch {
    // best effort (e.g. a filesystem without POSIX modes)
  }
  _db = d;
  return d;
}

/** Add columns introduced after the first release (existing databases). */
function ensureColumns(d: Database.Database): void {
  const cols = d.prepare('PRAGMA table_info(users)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'must_change_password')) {
    d.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  }
}

/**
 * Create the default admin (username `admin`) on first start. When the password
 * is the well-known default, the account is flagged so the panel forces a change
 * before it will do anything else. An operator-supplied BACKUP_MGR_PASSWORD is
 * already a deliberate choice, so it does not trigger the prompt.
 */
function bootstrapAdmin(d: Database.Database): void {
  const { n } = d.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (n > 0) return;
  const envPassword = process.env.BACKUP_MGR_PASSWORD?.trim();
  // Treat the well-known default as "still default", however it was supplied.
  const usingDefault = !envPassword || envPassword === 'admin';
  const password = usingDefault ? 'admin' : envPassword!;
  const now = new Date().toISOString();
  d.prepare(
    `INSERT INTO users (username, password_hash, is_admin, permissions, must_change_password, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    'admin',
    hashPassword(password),
    JSON.stringify(ALL_PERMISSIONS),
    usingDefault ? 1 : 0,
    now,
    now,
  );
}

export function dbLocation(): string {
  return dbPath();
}

export const MIN_PASSWORD_LENGTH = 8;

const COMMON_PASSWORDS = new Set(['admin', 'password', 'changeme', '12345678', 'backup-mgr']);

/**
 * Shared password policy. Returns an error message, or null when acceptable.
 * Used both when an admin assigns a password and when a user picks their own
 * (including the forced change of the default password).
 */
export function passwordProblem(password: string, username: string): string | null {
  const lower = password.toLowerCase();
  // Checked before the length rule so `admin` is reported as too common rather
  // than merely too short — a more useful message for the default password.
  if (COMMON_PASSWORDS.has(lower)) {
    return 'That password is too common — please pick something else';
  }
  if (lower === username.toLowerCase()) {
    return 'Password must not be the same as the username';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    is_admin: row.is_admin === 1,
    permissions: normalizePermissions(JSON.parse(row.permissions || '[]')),
    must_change_password: row.must_change_password === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listUsers(): User[] {
  const rows = db().prepare('SELECT * FROM users ORDER BY id').all() as UserRow[];
  return rows.map(toUser);
}

export function getUserById(id: number): User | null {
  const row = db().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function getUserByName(username: string): User | null {
  const row = db().prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | UserRow
    | undefined;
  return row ? toUser(row) : null;
}

export function countAdmins(): number {
  const { n } = db()
    .prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1')
    .get() as { n: number };
  return n;
}

/** Verify credentials, returning the user on success. */
export function authenticate(username: string, password: string): User | null {
  const row = db().prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | UserRow
    | undefined;
  if (!row) {
    // Still do a hash comparison to keep timing roughly constant.
    verifyPassword(password, 'scrypt$00$00');
    return null;
  }
  if (!verifyPassword(password, row.password_hash)) return null;
  return toUser(row);
}

export type CreateUserInput = {
  username: string;
  password: string;
  is_admin: boolean;
  permissions: Permission[];
  /** Force the new user to pick their own password at first sign-in. */
  must_change_password?: boolean;
};

export function createUser(input: CreateUserInput): User {
  const now = new Date().toISOString();
  const permissions = input.is_admin ? ALL_PERMISSIONS : normalizePermissions(input.permissions);
  const info = db()
    .prepare(
      `INSERT INTO users (username, password_hash, is_admin, permissions, must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.username,
      hashPassword(input.password),
      input.is_admin ? 1 : 0,
      JSON.stringify(permissions),
      input.must_change_password ? 1 : 0,
      now,
      now,
    );
  const user = getUserById(Number(info.lastInsertRowid));
  if (!user) throw new Error('failed to create user');
  return user;
}

export function updateUser(
  id: number,
  updates: {
    is_admin?: boolean;
    permissions?: Permission[];
    password?: string;
    must_change_password?: boolean;
  },
): User | null {
  const existing = getUserById(id);
  if (!existing) return null;
  const isAdmin = updates.is_admin ?? existing.is_admin;
  const permissions =
    updates.permissions !== undefined
      ? normalizePermissions(updates.permissions)
      : existing.permissions;
  const now = new Date().toISOString();
  const settingPassword = !!updates.password && updates.password.length > 0;
  // Admins can hand out a temporary password and require it be replaced.
  const mustChange =
    updates.must_change_password ?? (settingPassword ? false : existing.must_change_password);
  const permsJson = JSON.stringify(isAdmin ? ALL_PERMISSIONS : permissions);

  if (settingPassword) {
    db()
      .prepare(
        'UPDATE users SET is_admin = ?, permissions = ?, password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        isAdmin ? 1 : 0,
        permsJson,
        hashPassword(updates.password!),
        mustChange ? 1 : 0,
        now,
        id,
      );
  } else {
    db()
      .prepare(
        'UPDATE users SET is_admin = ?, permissions = ?, must_change_password = ?, updated_at = ? WHERE id = ?',
      )
      .run(isAdmin ? 1 : 0, permsJson, mustChange ? 1 : 0, now, id);
  }
  return getUserById(id);
}

export function updateOwnAccount(
  id: number,
  updates: { username?: string; password?: string },
): User | null {
  const existing = getUserById(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  if (updates.username && updates.username !== existing.username) {
    db().prepare('UPDATE users SET username = ?, updated_at = ? WHERE id = ?').run(
      updates.username,
      now,
      id,
    );
  }
  if (updates.password && updates.password.length > 0) {
    // Choosing your own password clears the forced-change flag.
    db()
      .prepare(
        'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?',
      )
      .run(hashPassword(updates.password), now, id);
  }
  return getUserById(id);
}

export function deleteUser(id: number): boolean {
  const info = db().prepare('DELETE FROM users WHERE id = ?').run(id);
  return info.changes > 0;
}

/** Session signing secret: env override, else a generated file in the data dir. */
export function sessionSecret(): string {
  if (process.env.BACKUP_MGR_SESSION_SECRET) return process.env.BACKUP_MGR_SESSION_SECRET;
  const file = path.join(dataDir(), 'session.secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // fall through and create one
  }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, secret, { mode: 0o600 });
  } catch {
    // best effort; an ephemeral secret still works for the current process
  }
  return secret;
}
