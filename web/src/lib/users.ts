import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, dbLocation, dbPath } from './panel-db';
import { ALL_PERMISSIONS, INSTANCE_PERMISSIONS, normalizePermissions, type Permission } from './permissions';
import { osUserSource } from './osusers';
import { sudoCapability, type SudoCapability } from './sudo';
import { dataDir } from './panel';
import { instanceFor, type Instance } from './instance';

/**
 * The panel stores *authorization* only — who may use the panel and what they may
 * do. Authentication belongs to Linux: there are no passwords here.
 *
 * Records mirror /etc/passwd. A user row is created the moment an account is
 * seen (at login, or during a sync), and disappears from view if the account is
 * removed. The panel never creates, edits or deletes an OS account.
 */

export type User = {
  id: number;
  /** Linux username — the identity, and the key to the user's instance. */
  username: string;
  /**
   * Derived from the OS: an account that may run sudo, or root. Read-only in the
   * panel — you grant admin with `usermod -aG sudo`, not with a checkbox, so the
   * panel can never disagree with the server about who is privileged.
   */
  is_admin: boolean;
  /** Whether this account may run privileged panel work (see ./sudo.ts). */
  sudo: SudoCapability;
  permissions: Permission[];
  /** Admins can block an account from the panel without touching the OS. */
  enabled: boolean;
  /**
   * Derived: the Linux account no longer exists, but the row is kept so its
   * permissions survive a temporary removal (and so admins can see what's stale).
   */
  orphaned: boolean;
  /** Derived: this user's backup instance, if it can be resolved. */
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

/** The schema and the legacy migration live in ./panel-db.ts, next to the audit log. */
export { dbLocation };

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

/** The mirrorable accounts, plus whether the account database could be read. */
type Accounts = { ok: boolean; names: Set<string> };

function accounts(): Accounts {
  // getOsUser() is not used here: this is a bulk check, and it is cached.
  const src = osUserSource();
  return { ok: src.ok, names: new Set(src.users.map((u) => u.username)) };
}

function toUser(row: UserRow, accounts: Accounts): User {
  const sudo = sudoCapability(row.username);
  // Admin follows the OS. Only when sudo could not be asked at all do we keep
  // what the record already said, so a failed probe cannot demote everybody.
  const isAdmin = sudo.source === 'unknown' ? row.is_admin === 1 : sudo.has_sudo;
  return {
    id: row.id,
    username: row.username,
    is_admin: isAdmin,
    sudo,
    permissions: isAdmin ? ALL_PERMISSIONS : normalizePermissions(JSON.parse(row.permissions || '[]')),
    enabled: row.enabled === 1,
    // Only ever orphaned when the account database was read successfully: an
    // unreadable passwd database must not make every user look deleted.
    orphaned: accounts.ok && !accounts.names.has(row.username),
    instance: instanceFor(row.username),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * How many accounts are administrators right now, as the OS sees it. There is no
 * "last admin" problem to defend against any more: admin comes from sudo, and the
 * panel cannot revoke it. Accounts whose Linux user is gone do not count — they
 * cannot sign in.
 */
export function countAdmins(): number {
  return listUsers().filter((u) => u.is_admin && !u.orphaned).length;
}

/**
 * Insert a row for this Linux account if it is not tracked yet. Called at login so
 * a brand-new account works immediately, without waiting for a full sync.
 */
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
  /** Every known record, with `orphaned` marking accounts Linux no longer has. */
  users: User[];
  /** Linux accounts that had no record yet — a `useradd` shows up here. */
  added: string[];
  /** Records whose Linux account is gone. Kept until pruned, so permissions survive. */
  missing: string[];
  /** False when the account database could not be read; nothing was changed. */
  sourceOk: boolean;
};

/**
 * Reconcile the mirror with Linux: give every mirrored account a record, and
 * report which records have lost their account.
 *
 * This is the whole "add a user" story — `useradd` on the server is enough,
 * because the account then appears here on the next reconciliation (the panel
 * runs one automatically; see ./userwatch.ts). Nothing is ever deleted on the
 * strength of a failed read, and nothing is deleted at all until an admin asks
 * (see `pruneOrphans`), so a re-created account keeps its permissions.
 */
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

/** Records only — the common case, for callers that do not need the report. */
export function syncUsers(): User[] {
  return reconcileUsers().users;
}

export function listUsers(): User[] {
  const rows = db().prepare('SELECT * FROM panel_users ORDER BY username').all() as UserRow[];
  const accounts_ = accounts();
  return rows.map((r) => toUser(r, accounts_));
}

/** DB lookup only — must stay cheap, it runs on every authenticated request. */
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
  /** Accepted for compatibility and ignored: admin is the OS's call. */
  is_admin?: boolean;
  permissions?: Permission[];
  enabled?: boolean;
};

/**
 * Update authorization for a user. Admins hold every permission implicitly, so
 * what is stored here only matters for accounts without sudo; `is_admin` is
 * ignored on purpose (it is derived — see `toUser`).
 */
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

/**
 * Drop records whose Linux account no longer exists.
 *
 * Refuses when the account database could not be read — an unreadable passwd
 * file would otherwise look like "every account was deleted" and wipe every
 * permission grant in one click.
 */
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
