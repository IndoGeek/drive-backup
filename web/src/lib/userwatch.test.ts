import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The multi-user model promises that `useradd` is the whole story: a new Linux
 * account becomes a panel user with nobody opening the panel. These tests drive
 * that promise end to end — start the watcher, add an account to the account
 * database, and wait for it to appear — rather than calling the sync directly.
 */

const ACCOUNT = { name: 'watchadmin', uid: 1500, gid: 1500, home: '/home/watchadmin' };
const EXISTING = { name: 'existing', uid: 1000, gid: 1000, home: '/home/existing' };

let passwdFile = '';

beforeAll(async () => {
  const { tmpDir, writePasswdFixture } = await import('./testhelp');
  const sandbox = tmpDir('bm-watch-');
  const dataDir = path.join(sandbox, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.BACKUP_MGR_DATA_DIR = dataDir;
  process.env.BACKUP_MGR_USERS_DB = path.join(dataDir, 'panel.db');
  process.env.BACKUP_MGR_ADMIN_USER = ACCOUNT.name;
  // Keep the loops fast so the test does not wait on the production defaults.
  process.env.BACKUP_MGR_AUTO_SYNC_INTERVAL_MS = '2000';
  process.env.BACKUP_MGR_PASSWD_WATCH_INTERVAL_MS = '300';
  process.env.BACKUP_MGR_OSUSER_CACHE_MS = '100';
  process.env.BACKUP_MGR_EXCLUDE_USERS = '';
  passwdFile = writePasswdFixture([ACCOUNT, EXISTING]);
  process.env.BACKUP_MGR_PASSWD_FILE = passwdFile;
});

afterAll(async () => {
  const { stopUserWatch } = await import('./userwatch');
  stopUserWatch();
});

/** Append an account the way `useradd` would, then let the watcher notice. */
function addOsUser(name: string, uid: number): void {
  fs.appendFileSync(
    passwdFile,
    [name, 'x', uid, uid, name, `/home/${name}`, '/bin/bash'].join(':') + '\n',
  );
}

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

describe('the account watcher', () => {
  it(
    'starts, reconciles immediately, and reports what it is watching',
    async () => {
      const { startUserWatch, userWatchState } = await import('./userwatch');
      startUserWatch();
      const state = userWatchState();
      expect(state.running).toBe(true);
      expect(state.auto_sync).toBe(true);
      expect(state.watching_file).toBe(passwdFile);
      // The startup pass is what makes the panel correct the moment it comes up.
      expect(await waitFor(() => userWatchState().last?.reason === 'startup')).toBe(true);
    },
    20_000,
  );

  it(
    'mirrors an account added to the account database, with no panel action',
    async () => {
      const { getUserByName } = await import('./users');
      expect(getUserByName('latecomer')).toBeNull();

      addOsUser('latecomer', 1200);

      const appeared = await waitFor(() => getUserByName('latecomer') !== null);
      expect(appeared).toBe(true);
      const user = getUserByName('latecomer');
      expect(user?.enabled).toBe(true);
      expect(user?.is_admin).toBe(false);
      // Usable at once: the account can sign in and sees its own instance.
      expect(user?.instance?.osUser).toBe('latecomer');
      expect(user?.instance?.pm2Name).toBe('backup-mgr-latecomer');
    },
    20_000,
  );

  it('reports the new account in its last sync report', async () => {
    const { userWatchState } = await import('./userwatch');
    const report = userWatchState().last;
    expect(report?.added).toContain('latecomer');
    expect(report?.sourceOk).toBe(true);
  });

  it('does not provision the new account unless auto-provision is enabled', async () => {
    const { userWatchState } = await import('./userwatch');
    // Provisioning writes into a user's home, so it is opt-in by design.
    expect(userWatchState().auto_provision).toBe(false);
    expect(userWatchState().provisioned).toEqual([]);
    expect(fs.existsSync('/home/latecomer/backup-mgr')).toBe(false);
  });

  it(
    'flags an account removed from the account database',
    async () => {
      const { getUserByName } = await import('./users');
      const { userWatchState } = await import('./userwatch');
      // `userdel existing` — the watcher's own report is what we wait on, not a
      // live read, so this proves the passwd change was noticed by the watcher.
      const kept = fs
        .readFileSync(passwdFile, 'utf8')
        .split('\n')
        .filter((l) => l && !l.startsWith('existing:'))
        .join('\n');
      fs.writeFileSync(passwdFile, kept + '\n');

      const noticed = await waitFor(
        () => userWatchState().last?.missing.includes('existing') === true,
      );
      expect(noticed).toBe(true);
      // Never deleted here — an admin prunes, so permissions survive a re-add.
      const record = getUserByName('existing');
      expect(record).not.toBeNull();
      expect(record?.orphaned).toBe(true);
    },
    20_000,
  );

  it('is idempotent: starting twice leaves one watcher', async () => {
    const { startUserWatch, userWatchState } = await import('./userwatch');
    const before = userWatchState().last?.at;
    startUserWatch();
    expect(userWatchState().running).toBe(true);
    // No second loop was created, so the last report is untouched by the call.
    expect(userWatchState().last?.at).toBe(before);
  });
});
