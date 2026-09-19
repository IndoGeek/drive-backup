import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';

const ACCOUNT = { name: 'testadmin', uid: 1500, gid: 1500, home: '/home/testadmin' };
const OTHERS = [
  { name: 'alice', uid: 1000, gid: 1000, home: '/home/alice' },
  { name: 'bob', uid: 1001, gid: 1001, home: '/home/bob' },
  { name: 'gone', uid: 1002, gid: 1002, home: '/home/gone' },
];

let dataDir = '';
let usersDb = '';

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-users-'));
  usersDb = path.join(dataDir, 'panel.db');
  process.env.BACKUP_MGR_DATA_DIR = dataDir;
  process.env.BACKUP_MGR_USERS_DB = usersDb;
  process.env.BACKUP_MGR_MIN_VERIFY_MS = '0';
  process.env.BACKUP_MGR_ADMIN_USER = ACCOUNT.name;

  const { useSudoFixture, writePasswdFixture } = await import('./testhelp');
  process.env.BACKUP_MGR_PASSWD_FILE = writePasswdFixture([ACCOUNT, ...OTHERS]);
  // Admin comes from sudo, so it has to be declared rather than assumed: without
  // this the suite would depend on the host's own sudoers.
  useSudoFixture({
    [ACCOUNT.name]: { has_sudo: true, passwordless: true },
    ...Object.fromEntries(OTHERS.map((u) => [u.name, { has_sudo: false }])),
    newcomer: { has_sudo: false },
    dave: { has_sudo: false },
  });

  // Seed a database in the *previous* schema, so the migration is exercised for
  // real rather than assumed.
  const legacy = new Database(usersDb);
  legacy.exec(`
    CREATE TABLE users (
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
  const now = new Date().toISOString();
  for (const [name, perms] of [
    ['alice', '["dashboard.view","logs.view"]'],
    ['admin', '["config.edit"]'],
  ] as const) {
    legacy
      .prepare(
        `INSERT INTO users (username, password_hash, is_admin, permissions, must_change_password, created_at, updated_at)
         VALUES (?, 'scrypt$dead$beef', 0, ?, 1, ?, ?)`,
      )
      .run(name, perms, now, now);
  }
  legacy.close();
});

async function usersApi() {
  return import('./users');
}

describe('migration from the password-based schema', () => {
  it('carries permissions across for accounts that still exist', async () => {
    const { getUserByName, syncUsers } = await usersApi();
    syncUsers();
    expect(getUserByName('alice')?.permissions.sort()).toEqual(['dashboard.view', 'logs.view']);
  });

  it('drops records for panel-only users, which have no Linux account', async () => {
    const { getUserByName } = await usersApi();
    // 'admin' existed only in the old panel store; it is not an OS account, so it
    // must not become a login that no Linux password can ever satisfy.
    expect(getUserByName('admin')).toBeNull();
  });

  it('removes the legacy table, so no unused password hashes remain', async () => {
    await usersApi();
    const db = new Database(usersDb, { readonly: true });
    try {
      const legacy = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
        .get();
      expect(legacy).toBeUndefined();
      const cols = db.prepare('PRAGMA table_info(panel_users)').all() as { name: string }[];
      expect(cols.map((c) => c.name)).not.toContain('password_hash');
    } finally {
      db.close();
    }
  });
});

describe('mirroring Linux accounts', () => {
  it('creates a record per mirrored account, with no password column', async () => {
    const { syncUsers } = await usersApi();
    const users = syncUsers();
    expect(users.map((u) => u.username).sort()).toEqual(['alice', 'bob', 'gone', 'testadmin']);
    for (const u of users) {
      expect(u).not.toHaveProperty('password_hash');
    }
  });

  it('is idempotent', async () => {
    const { syncUsers } = await usersApi();
    const first = syncUsers().length;
    expect(syncUsers().length).toBe(first);
  });

  it('gives every new account full control of its own instance, and nothing global', async () => {
    const { getUserByName } = await usersApi();
    const { INSTANCE_PERMISSIONS } = await import('./permissions');
    // 'bob' is a fresh account (alice inherited narrower permissions from the
    // legacy database, which is the migration behaving correctly).
    const bob = getUserByName('bob');
    expect(bob?.permissions.sort()).toEqual([...INSTANCE_PERMISSIONS].sort());
    // Privileged, panel-wide permissions must never be handed out by default.
    expect(bob?.permissions).not.toContain('users.manage');
    expect(bob?.permissions).not.toContain('binary.install');
  });

  it('resolves each user to their own instance', async () => {
    const { getUserByName } = await usersApi();
    expect(getUserByName('alice')?.instance?.root).toBe('/home/alice/backup-mgr');
    expect(getUserByName('alice')?.instance?.pm2Name).toBe('backup-mgr-alice');
  });

  it('marks an account whose Linux user has been deleted', async () => {
    const { syncUsers } = await usersApi();
    const { writePasswdFixture } = await import('./testhelp');
    const { resetOsUserCache } = await import('./osusers');
    // 'gone' is removed from the passwd database, as `userdel` would.
    process.env.BACKUP_MGR_PASSWD_FILE = writePasswdFixture([ACCOUNT, ...OTHERS.slice(0, 2)]);
    resetOsUserCache();

    const users = syncUsers();
    expect(users.find((u) => u.username === 'gone')?.orphaned).toBe(true);
    expect(users.find((u) => u.username === 'alice')?.orphaned).toBe(false);
  });

  it('prunes records for deleted accounts', async () => {
    const { pruneOrphans, getUserByName, syncUsers } = await usersApi();
    syncUsers();
    const { removed } = pruneOrphans();
    expect(removed).toContain('gone');
    expect(getUserByName('gone')).toBeNull();
  });
});

describe('admin follows sudo', () => {
  it('makes accounts with sudo administrators, and the rest ordinary users', async () => {
    const { syncUsers, getUserByName } = await usersApi();
    syncUsers();
    expect(getUserByName('testadmin')?.is_admin).toBe(true);
    expect(getUserByName('testadmin')?.sudo.has_sudo).toBe(true);
    expect(getUserByName('alice')?.is_admin).toBe(false);
    expect(getUserByName('alice')?.sudo.has_sudo).toBe(false);
  });

  it('makes root an administrator, because root is the privilege', async () => {
    const { writePasswdFixture, useSudoFixture } = await import('./testhelp');
    const { resetOsUserCache } = await import('./osusers');
    const { resetSudoCache } = await import('./sudo');
    // Note: no fixture entry for root — this is sudo's own answer for uid 0.
    useSudoFixture({ [ACCOUNT.name]: { has_sudo: true, passwordless: true } });
    process.env.BACKUP_MGR_PASSWD_FILE = writePasswdFixture([
      { name: 'root', uid: 0, gid: 0, home: '/root' },
      ACCOUNT,
    ]);
    resetOsUserCache();
    resetSudoCache();
    try {
      const { syncUsers, getUserByName, pruneOrphans } = await usersApi();
      syncUsers();
      const root = getUserByName('root');
      expect(root?.is_admin).toBe(true);
      expect(root?.sudo.source).toBe('root');
      // Put the world back: without this, a mirrored 'root' record would linger as
      // a stale administrator for the tests that follow.
      process.env.BACKUP_MGR_PASSWD_FILE = writePasswdFixture([ACCOUNT, ...OTHERS]);
      resetOsUserCache();
      pruneOrphans();
    } finally {
      process.env.BACKUP_MGR_PASSWD_FILE = writePasswdFixture([ACCOUNT, ...OTHERS]);
      resetOsUserCache();
      resetSudoCache();
    }
  });

  it('gives an admin every permission implicitly', async () => {
    const { getUserByName } = await usersApi();
    const { ALL_PERMISSIONS } = await import('./permissions');
    expect(getUserByName('testadmin')?.permissions.sort()).toEqual([...ALL_PERMISSIONS].sort());
  });
});

describe('ensureUser', () => {
  it('tracks an account the moment it logs in', async () => {
    const { ensureUser } = await usersApi();
    const { writePasswdFixture } = await import('./testhelp');
    const { resetOsUserCache } = await import('./osusers');

    process.env.BACKUP_MGR_PASSWD_FILE = writePasswdFixture([
      ACCOUNT,
      ...OTHERS.slice(0, 2),
      { name: 'newcomer', uid: 1003, gid: 1003, home: '/home/newcomer' },
    ]);
    resetOsUserCache();

    const created = ensureUser('newcomer');
    expect(created?.username).toBe('newcomer');
    expect(created?.is_admin).toBe(false);
    expect(created?.enabled).toBe(true);
  });
});

describe('updates', () => {
  it('changes permissions and blocked state', async () => {
    const { getUserByName, updateUser } = await usersApi();
    const alice = getUserByName('alice');
    if (!alice) throw new Error('alice missing');

    updateUser(alice.id, { permissions: ['dashboard.view'], enabled: false });
    const after = getUserByName('alice');
    expect(after?.permissions).toEqual(['dashboard.view']);
    expect(after?.enabled).toBe(false);
  });

  it('ignores attempts to set admin from the panel — the OS owns it', async () => {
    const { getUserByName, updateUser, countAdmins } = await usersApi();
    expect(countAdmins()).toBe(1);
    const alice = getUserByName('alice');
    if (!alice) throw new Error('alice missing');
    // Silently ignored here (the API answers 409 instead), because admin is
    // derived from sudo and must not be forgeable from inside the panel.
    updateUser(alice.id, { is_admin: true });
    expect(getUserByName('alice')?.is_admin).toBe(false);
  });

  it('fails closed when sudo cannot be asked, keeping what was already recorded', async () => {
    const { listUsers } = await usersApi();
    const { clearSudoFixture } = await import('./testhelp');
    const { resetSudoCache } = await import('./sudo');
    // No fixture, and an empty PATH: neither `sudo` nor `id` can be spawned, which
    // is a host where sudo is unanswerable. Nobody may be demoted on that basis,
    // so the recorded flag is honoured — and only for those who already had it.
    clearSudoFixture();
    const originalPath = process.env.PATH;
    const originalOverride = process.env.BACKUP_MGR_ADMIN_USER;
    process.env.PATH = '';
    // The explicit override is an escape hatch for exactly this situation, so it
    // must not be what makes the test pass.
    delete process.env.BACKUP_MGR_ADMIN_USER;
    const record = new Database(usersDb);
    record.prepare("UPDATE panel_users SET is_admin = 1 WHERE username = 'testadmin'").run();
    record.close();
    try {
      const admin = listUsers().find((u) => u.username === 'testadmin');
      expect(admin?.sudo.source).toBe('unknown');
      expect(admin?.is_admin).toBe(true);
      // Everyone else fails closed rather than being promoted by a failed probe.
      expect(listUsers().find((u) => u.username === 'alice')?.is_admin).toBe(false);
    } finally {
      process.env.PATH = originalPath;
      if (originalOverride === undefined) delete process.env.BACKUP_MGR_ADMIN_USER;
      else process.env.BACKUP_MGR_ADMIN_USER = originalOverride;
      const reset = new Database(usersDb);
      reset.prepare("UPDATE panel_users SET is_admin = 0 WHERE username = 'testadmin'").run();
      reset.close();
      resetSudoCache();
    }
  });

  it('keeps the database readable only by its owner', async () => {
    if (process.platform === 'win32') return; // no POSIX modes
    const { dbLocation } = await usersApi();
    expect(fs.statSync(dbLocation()).mode & 0o777).toBe(0o600);
  });
});

/**
 * Reconciliation is the "a new Linux account is a new panel user" path. These
 * tests drive it the way the watcher does — a passwd file that changed — rather
 * than through the API, so the mechanism itself is covered.
 */
describe('reconciliation', () => {
  type Account = { name: string; uid: number; gid: number; home: string };
  const DAVE: Account = { name: 'dave', uid: 1003, gid: 1003, home: '/home/dave' };
  // 'newcomer' was added by the ensureUser test above, so it belongs here too —
  // otherwise it would show up as "missing" and muddy the assertions.
  const NEWCOMER: Account = { name: 'newcomer', uid: 1004, gid: 1004, home: '/home/newcomer' };
  const fixture = (...extra: Account[]): Account[] => [
    ACCOUNT,
    ...OTHERS.slice(0, 2),
    NEWCOMER,
    ...extra,
  ];

  async function pointAt(users: Account[]) {
    const { writePasswdFixture } = await import('./testhelp');
    const { resetOsUserCache } = await import('./osusers');
    process.env.BACKUP_MGR_PASSWD_FILE = writePasswdFixture(users);
    resetOsUserCache();
  }

  it('reports and records an account that appeared, with no admin action', async () => {
    const { reconcileUsers, getUserByName } = await usersApi();
    const { INSTANCE_PERMISSIONS } = await import('./permissions');
    await pointAt(fixture(DAVE));

    const result = reconcileUsers();
    expect(result.sourceOk).toBe(true);
    expect(result.added).toEqual(['dave']);
    expect(result.missing).toEqual([]);
    // A newly seen account is usable straight away: mirrored, enabled, and with
    // control of its own instance.
    const dave = getUserByName('dave');
    expect(dave?.orphaned).toBe(false);
    expect(dave?.enabled).toBe(true);
    expect(dave?.permissions.sort()).toEqual([...INSTANCE_PERMISSIONS].sort());
  });

  it('is idempotent, so a second pass adds nothing', async () => {
    const { reconcileUsers } = await usersApi();
    expect(reconcileUsers().added).toEqual([]);
  });

  it('flags an account that disappeared but keeps its record and permissions', async () => {
    const { reconcileUsers, getUserByName, updateUser } = await usersApi();
    const dave = getUserByName('dave');
    if (!dave) throw new Error('dave missing');
    // A deliberately narrowed grant, to prove it survives the account going away.
    updateUser(dave.id, { permissions: ['logs.view'] });

    await pointAt(fixture()); // `userdel dave`
    const result = reconcileUsers();
    expect(result.missing).toContain('dave');
    expect(result.added).toEqual([]);
    expect(result.users.find((u) => u.username === 'dave')?.orphaned).toBe(true);

    const kept = getUserByName('dave');
    expect(kept).not.toBeNull();
    expect(kept?.permissions).toEqual(['logs.view']);
    expect(kept?.orphaned).toBe(true);
  });

  it('re-creating the account restores access with its permissions intact', async () => {
    const { reconcileUsers, getUserByName } = await usersApi();
    await pointAt(fixture(DAVE)); // `adduser dave` again
    const result = reconcileUsers();
    // Not "added": the record was only ever flagged, never deleted.
    expect(result.added).toEqual([]);
    const dave = getUserByName('dave');
    expect(dave?.orphaned).toBe(false);
    expect(dave?.permissions).toEqual(['logs.view']);
  });

  it('never orphans anyone when the account database cannot be read', async () => {
    const { reconcileUsers, getUserByName } = await usersApi();
    const { resetOsUserCache } = await import('./osusers');
    // A transient getent/LDAP failure must not look like "every account was
    // deleted" — which would lock out every signed-in user at once.
    process.env.BACKUP_MGR_PASSWD_FILE = '/nonexistent/passwd-fixture';
    resetOsUserCache();

    const result = reconcileUsers();
    expect(result.sourceOk).toBe(false);
    expect(result.added).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.users.every((u) => !u.orphaned)).toBe(true);
    expect(getUserByName('testadmin')?.orphaned).toBe(false);
  });

  it('refuses to prune while the account database is unreadable', async () => {
    const { pruneOrphans, getUserByName } = await usersApi();
    const { removed, sourceOk } = pruneOrphans();
    expect(sourceOk).toBe(false);
    expect(removed).toEqual([]);
    // Nothing was deleted on the strength of a failed read.
    expect(getUserByName('testadmin')).not.toBeNull();
    expect(getUserByName('alice')).not.toBeNull();
  });
});
