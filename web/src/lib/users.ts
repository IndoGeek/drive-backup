import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, dbLocation, dbPath } from './panel-db';
import { ALL_PERMISSIONS, INSTANCE_PERMISSIONS, normalizePermissions, type Permission } from './permissions';
import { osUserSource } from './osusers';
import { sudoCapability, type SudoCapability } from './sudo';
import { dataDir } from './panel';
import { instanceFor, type Instance } from './instance';

export type User = {
  id: number;

  username: string;

  is_admin: boolean;

  sudo: SudoCapability;
  permissions: Permission[];

  enabled: boolean;

  orphaned: boolean;

  instance: Instance | null;
  created_at: string;
  updated_at: string;
};

type UserRow = {
  id: number;
  username: string;
  is_admin: number;
  permissions: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

export { dbLocation };

export function sessionSecret(): string {
  if (process.env.BACKUP_MGR_SESSION_SECRET) return process.env.BACKUP_MGR_SESSION_SECRET;
  const file = path.join(dataDir(), 'session.secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
  }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, secret, { mode: 0o600 });
  } catch {
  }
  return secret;
}

type Accounts = { ok: boolean; names: Set<string> };

function accounts(): Accounts {
  const src = osUserSource();
  return { ok: src.ok, names: new Set(src.users.map((u) => u.username)) };
}

function toUser(row: UserRow, accounts: Accounts): User {
  const sudo = sudoCapability(row.username);

  const isAdmin = sudo.source === 'unknown' ? row.is_admin === 1 : sudo.has_sudo;
  return {
    id: row.id,
    username: row.username,
    is_admin: isAdmin,
    sudo,
    permissions: isAdmin ? ALL_PERMISSIONS : normalizePermissions(JSON.parse(row.permissions || '[]')),
    enabled: row.enabled === 1,

    orphaned: accounts.ok && !accounts.names.has(row.username),
    instance: instanceFor(row.username),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function countAdmins(): number {
  return listUsers().filter((u) => u.is_admin && !u.orphaned).length;
}

export function ensureUser(username: string): User | null {
  const d = db();
  const existing = d.prepare('SELECT * FROM panel_users WHERE username = ?').get(username) as
    | UserRow
    | undefined;
  if (!existing) {
    const now = new Date().toISOString();
    d.prepare(
      `INSERT INTO panel_users (username, is_admin, permissions, enabled, created_at, updated_at)
       VALUES (?, 0, ?, 1, ?, ?)`,
    ).run(username, JSON.stringify(INSTANCE_PERMISSIONS), now, now);
  }
  const row = d.prepare('SELECT * FROM panel_users WHERE username = ?').get(username) as
    | UserRow
    | undefined;
  return row ? toUser(row, accounts()) : null;
}

export type SyncResult = {
  users: User[];

  added: string[];

  missing: string[];

  sourceOk: boolean;
};

export function reconcileUsers(): SyncResult {
  const d = db();
  const src = osUserSource();
  const known = new Set(
    (d.prepare('SELECT username FROM panel_users').all() as { username: string }[]).map(
      (r) => r.username,
    ),
  );
  const added: string[] = [];
  if (src.ok) {
    const now = new Date().toISOString();
    const insert = d.prepare(
      `INSERT OR IGNORE INTO panel_users (username, is_admin, permissions, enabled, created_at, updated_at)
       VALUES (?, 0, ?, 1, ?, ?)`,
    );
    const tx = d.transaction(() => {
      for (const u of src.users) {
        if (known.has(u.username)) continue;
        insert.run(u.username, JSON.stringify(INSTANCE_PERMISSIONS), now, now);
        added.push(u.username);
      }
    });
    tx();
  }
  const users = listUsers();
  return {
    users,
    added,
    missing: users.filter((u) => u.orphaned).map((u) => u.username),
    sourceOk: src.ok,
  };
}

export function syncUsers(): User[] {
  return reconcileUsers().users;
}

export function listUsers(): User[] {
  const rows = db().prepare('SELECT * FROM panel_users ORDER BY username').all() as UserRow[];
  const accounts_ = accounts();
  return rows.map((r) => toUser(r, accounts_));
}

export function getUserById(id: number): User | null {
  const row = db().prepare('SELECT * FROM panel_users WHERE id = ?').get(id) as UserRow | undefined;
  return row ? toUser(row, accounts()) : null;
}

export function getUserByName(username: string): User | null {
  const row = db().prepare('SELECT * FROM panel_users WHERE username = ?').get(username) as
    | UserRow
    | undefined;
  return row ? toUser(row, accounts()) : null;
}

export type UpdateUserInput = {
  is_admin?: boolean;
  permissions?: Permission[];
  enabled?: boolean;
};

export function updateUser(id: number, updates: UpdateUserInput): User | null {
  const existing = getUserById(id);
  if (!existing) return null;
  const permissions =
    updates.permissions !== undefined
      ? normalizePermissions(updates.permissions)
      : existing.permissions;
  const enabled = updates.enabled ?? existing.enabled;
  db()
    .prepare('UPDATE panel_users SET permissions = ?, enabled = ?, updated_at = ? WHERE id = ?')
    .run(
      JSON.stringify(existing.is_admin ? ALL_PERMISSIONS : permissions),
      enabled ? 1 : 0,
      new Date().toISOString(),
      id,
    );
  return getUserById(id);
}

export function pruneOrphans(): { removed: string[]; sourceOk: boolean } {
  const src = osUserSource();
  if (!src.ok) return { removed: [], sourceOk: false };
  const names = new Set(src.users.map((u) => u.username));
  const rows = db().prepare('SELECT id, username FROM panel_users').all() as {
    id: number;
    username: string;
  }[];
  const orphans = rows.filter((r) => !names.has(r.username));
  const del = db().prepare('DELETE FROM panel_users WHERE id = ?');
  const tx = db().transaction(() => {
    for (const o of orphans) del.run(o.id);
  });
  tx();
  return { removed: orphans.map((o) => o.username), sourceOk: true };
}
