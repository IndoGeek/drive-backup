import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './panel';
import { osUserSource } from './osusers';

export function dbPath(): string {
  return process.env.BACKUP_MGR_USERS_DB || path.join(dataDir(), 'users.db');
}

export function dbLocation(): string {
  return dbPath();
}

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  const d = new Database(dbPath());
  d.pragma('journal_mode = WAL');
  d.exec(`
    CREATE TABLE IF NOT EXISTS panel_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      is_admin INTEGER NOT NULL DEFAULT 0,
      permissions TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      username TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '{}',
      via TEXT,
      address TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at DESC);
  `);
  migrateLegacyAuth(d);
  try {
    fs.chmodSync(dbPath(), 0o600);
  } catch {
  }
  _db = d;
  return d;
}

function migrateLegacyAuth(d: Database.Database): void {
  const legacy = d
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'users'")
    .get() as { name: string } | undefined;
  if (!legacy) return;

  const rows = d
    .prepare('SELECT username, is_admin, permissions FROM users')
    .all() as { username: string; is_admin: number; permissions: string }[];
  const accounts = new Set(osUserSource().users.map((u) => u.username));
  const now = new Date().toISOString();
  const insert = d.prepare(
    `INSERT OR IGNORE INTO panel_users (username, is_admin, permissions, enabled, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  );
  for (const r of rows) {
    if (!accounts.has(r.username)) continue;
    insert.run(r.username, r.is_admin === 1 ? 1 : 0, r.permissions || '[]', now, now);
  }
  d.exec('DROP TABLE users');
}
