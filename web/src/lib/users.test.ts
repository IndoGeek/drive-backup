import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-users-'));
  process.env.BACKUP_MGR_DATA_DIR = dir;
  process.env.BACKUP_MGR_USERS_DB = path.join(dir, 'users.db');
  delete process.env.BACKUP_MGR_PASSWORD;
});

async function usersApi() {
  return import('./users');
}

describe('user store', () => {
  it('bootstraps a default admin on first use', async () => {
    const { authenticate, getUserByName } = await usersApi();
    const admin = getUserByName('admin');
    expect(admin?.is_admin).toBe(true);
    expect(authenticate('admin', 'admin')?.username).toBe('admin');
    expect(authenticate('admin', 'wrong')).toBeNull();
  });

  it('creates users with explicit permissions', async () => {
    const { createUser, authenticate } = await usersApi();
    const user = createUser({
      username: 'alice',
      password: 'secret',
      is_admin: false,
      permissions: ['dashboard.view', 'backup.run'],
    });
    expect(user.is_admin).toBe(false);
    expect(user.permissions.sort()).toEqual(['backup.run', 'dashboard.view']);

    const authed = authenticate('alice', 'secret');
    expect(authed?.id).toBe(user.id);
  });

  it('administrators implicitly hold every permission', async () => {
    const { createUser } = await usersApi();
    const { ALL_PERMISSIONS } = await import('./permissions');
    const user = createUser({
      username: 'root2',
      password: 'secret',
      is_admin: true,
      permissions: [],
    });
    expect(user.permissions.sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('updates permissions and passwords', async () => {
    const { createUser, updateUser, authenticate, getUserById } = await usersApi();
    const user = createUser({
      username: 'bob',
      password: 'one',
      is_admin: false,
      permissions: ['dashboard.view'],
    });

    updateUser(user.id, { permissions: ['logs.view'] });
    expect(getUserById(user.id)?.permissions).toEqual(['logs.view']);

    updateUser(user.id, { password: 'two' });
    expect(authenticate('bob', 'two')?.id).toBe(user.id);
    expect(authenticate('bob', 'one')).toBeNull();
  });

  it('changes own username and password', async () => {
    const { createUser, updateOwnAccount, authenticate } = await usersApi();
    const user = createUser({
      username: 'carol',
      password: 'pw',
      is_admin: false,
      permissions: [],
    });
    updateOwnAccount(user.id, { username: 'carol2', password: 'pw2' });
    expect(authenticate('carol2', 'pw2')?.id).toBe(user.id);
  });

  it('deletes users', async () => {
    const { createUser, deleteUser, getUserById } = await usersApi();
    const user = createUser({
      username: 'dave',
      password: 'pw',
      is_admin: false,
      permissions: [],
    });
    expect(deleteUser(user.id)).toBe(true);
    expect(getUserById(user.id)).toBeNull();
    expect(deleteUser(user.id)).toBe(false);
  });

  it('keeps the user database readable only by its owner', async () => {
    if (process.platform === 'win32') return; // no POSIX modes
    const { dbLocation } = await usersApi();
    expect(fs.statSync(dbLocation()).mode & 0o777).toBe(0o600);
  });

  it('flags the bootstrap admin so the default password must be changed', async () => {
    const { getUserByName } = await usersApi();
    expect(getUserByName('admin')?.must_change_password).toBe(true);
  });

  it('does not flag an admin-assigned password unless asked', async () => {
    const { createUser } = await usersApi();
    const plain = createUser({
      username: 'noforce',
      password: 'assigned-password',
      is_admin: false,
      permissions: [],
    });
    expect(plain.must_change_password).toBe(false);

    const forced = createUser({
      username: 'forced',
      password: 'assigned-password',
      is_admin: false,
      permissions: [],
      must_change_password: true,
    });
    expect(forced.must_change_password).toBe(true);
  });

  it('clears the flag once the user chooses their own password', async () => {
    const { createUser, updateOwnAccount, getUserById } = await usersApi();
    const user = createUser({
      username: 'picker',
      password: 'assigned-password',
      is_admin: false,
      permissions: [],
      must_change_password: true,
    });

    // Renaming alone must not clear it.
    updateOwnAccount(user.id, { username: 'picker2' });
    expect(getUserById(user.id)?.must_change_password).toBe(true);

    updateOwnAccount(user.id, { password: 'chosen-by-me' });
    expect(getUserById(user.id)?.must_change_password).toBe(false);
  });

  it('lets an admin require a change via updateUser', async () => {
    const { createUser, updateUser, getUserById } = await usersApi();
    const user = createUser({
      username: 'resetme',
      password: 'assigned-password',
      is_admin: false,
      permissions: [],
    });
    updateUser(user.id, { password: 'new-temp-password', must_change_password: true });
    expect(getUserById(user.id)?.must_change_password).toBe(true);
  });

  it('enforces the shared password policy', async () => {
    const { passwordProblem } = await usersApi();
    expect(passwordProblem('short', 'bob')).toMatch(/at least/);
    expect(passwordProblem('longname123', 'longname123')).toMatch(/username/);
    expect(passwordProblem('admin', 'bob')).toMatch(/too common/);
    expect(passwordProblem('correct horse battery', 'bob')).toBeNull();
  });
});
