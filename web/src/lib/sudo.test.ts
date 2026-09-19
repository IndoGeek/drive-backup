import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { User } from './users';

const PASSWORD = 'unit-sudo-pass-123';
let meName = '';
let me: User;
let noSudo: User;

const mailbox: { elevated_until?: string } = {};

beforeAll(async () => {
  const { currentAccount, makeHash, tmpDir, usePasswdFixture, useSudoFixture, writeShadowFixture } =
    await import('./testhelp');
  const me_ = currentAccount();
  meName = me_.name;

  const sandbox = tmpDir('bm-sudo-unit-');
  const dataDir = path.join(sandbox, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.BACKUP_MGR_DATA_DIR = dataDir;
  process.env.BACKUP_MGR_USERS_DB = path.join(dataDir, 'panel.db');
  process.env.BACKUP_MGR_MIN_VERIFY_MS = '0';

  usePasswdFixture([
    { name: me_.name, uid: me_.uid, gid: me_.gid, home: me_.home },
    { name: 'nosudo', uid: 4321, gid: 4321, home: '/home/nosudo' },
  ]);
  useSudoFixture({
    [me_.name]: { has_sudo: true, passwordless: false },
    nosudo: { has_sudo: false },
  });
  process.env.BACKUP_MGR_SHADOW_FILE = writeShadowFixture([
    { name: me_.name, hash: makeHash(PASSWORD) },
  ]);

  const { ensureUser } = await import('./users');
  const a = ensureUser(me_.name);
  const b = ensureUser('nosudo');
  if (!a || !b) throw new Error('could not mirror the fixture accounts');
  me = a;
  noSudo = b;
  mailbox.elevated_until = undefined;
});

function request(label: string): Request {
  return new Request('http://test/api/sudo', {
    headers: { cookie: `bm_session=${label}` },
  });
}

describe('sudo capability (who is an administrator)', () => {
  it('follows the declared sudo answer', async () => {
    const { sudoCapability } = await import('./sudo');
    expect(sudoCapability(meName)).toMatchObject({ has_sudo: true, source: 'assumed' });
    expect(sudoCapability('nosudo')).toMatchObject({ has_sudo: false, source: 'assumed' });
  });

  it('treats root as privileged without asking anyone', async () => {
    const { sudoCapability } = await import('./sudo');
    expect(sudoCapability('root')).toMatchObject({ has_sudo: true, source: 'root' });
  });

  it('honours an explicit override as a last-resort escape hatch', async () => {
    const { clearSudoFixture } = await import('./testhelp');
    const { sudoCapability, resetSudoCache } = await import('./sudo');
    const original = process.env.BACKUP_MGR_ADMIN_USER;
    process.env.BACKUP_MGR_ADMIN_USER = 'nosudo';
    clearSudoFixture();
    try {
      expect(sudoCapability('nosudo')).toMatchObject({ has_sudo: true, source: 'assumed' });
    } finally {
      if (original === undefined) delete process.env.BACKUP_MGR_ADMIN_USER;
      else process.env.BACKUP_MGR_ADMIN_USER = original;
      const { useSudoFixture } = await import('./testhelp');
      useSudoFixture({
        [meName]: { has_sudo: true, passwordless: false },
        nosudo: { has_sudo: false },
      });
      resetSudoCache();
    }
  });

  it('answers without a fixture, from sudo or from groups — never by crashing', async () => {
    const { clearSudoFixture, useSudoFixture } = await import('./testhelp');
    const { sudoCapability, resetSudoCache } = await import('./sudo');
    clearSudoFixture();
    try {
      const cap = sudoCapability(meName);
      expect(typeof cap.has_sudo).toBe('boolean');

      expect(['sudo', 'group', 'unknown']).toContain(cap.source);
    } finally {
      useSudoFixture({
        [meName]: { has_sudo: true, passwordless: false },
        nosudo: { has_sudo: false },
      });
      resetSudoCache();
    }
  });
});

describe('privileged work is authorized by that account’s sudo', () => {
  it('refuses outright when the account has no sudo', async () => {
    const { authorizePrivileged } = await import('./sudo');
    const res = await authorizePrivileged(request('no-sudo-session'), noSudo, 'manage users');
    expect(res?.status).toBe(403);
    expect(await res?.json()).toMatchObject({ sudo_denied: true });
  });

  it('asks for a password when sudo would', async () => {
    const { authorizePrivileged } = await import('./sudo');
    const res = await authorizePrivileged(request('plain-session'), me, 'manage users');
    expect(res?.status).toBe(428);
    expect(await res?.json()).toMatchObject({ sudo_required: true, action: 'manage users' });
  });

  it('never asks when the declared rules are NOPASSWD', async () => {
    const { useSudoFixture } = await import('./testhelp');
    const { authorizePrivileged, resetSudoCache } = await import('./sudo');
    useSudoFixture({ [meName]: { has_sudo: true, passwordless: true } });
    try {
      expect(await authorizePrivileged(request('nopass-session'), me, 'manage users')).toBeNull();
    } finally {
      useSudoFixture({ [meName]: { has_sudo: true, passwordless: false } });
      resetSudoCache();
    }
  });
});

describe('the elevation grant', () => {
  it('rejects a wrong password and accepts the account’s own Linux password', async () => {
    const { authorizeSudo, resetSudoCache } = await import('./sudo');
    resetSudoCache();
    const req = request('grant-session');

    const wrong = await authorizeSudo(req, me, 'definitely-not-it');
    expect(wrong).toMatchObject({ ok: false, status: 401 });

    const right = await authorizeSudo(req, me, PASSWORD);
    expect(right.ok).toBe(true);
    if (right.ok) mailbox.elevated_until = right.elevated_until;
  });

  it('clears the way for privileged work while it lasts', async () => {
    const { authorizePrivileged } = await import('./sudo');
    expect(mailbox.elevated_until).toBeDefined();

    expect(await authorizePrivileged(request('grant-session'), me, 'manage users')).toBeNull();
  });

  it('is scoped to one login, not to the account', async () => {
    const { authorizePrivileged } = await import('./sudo');
    const res = await authorizePrivileged(request('other-login'), me, 'manage users');
    expect(res?.status).toBe(428);
  });

  it('lapses again once the timeout is up', async () => {
    const { authorizeSudo, authorizePrivileged, sudoStatus, resetSudoCache } = await import('./sudo');
    const original = process.env.BACKUP_MGR_SUDO_TIMEOUT_MS;

    process.env.BACKUP_MGR_SUDO_TIMEOUT_MS = '0';
    try {
      const req = request('expiry-session');
      expect((await authorizeSudo(req, me, PASSWORD)).ok).toBe(true);
      const status = await sudoStatus(req, meName);
      expect(status.elevated_until).toBeNull();
      expect((await authorizePrivileged(req, me, 'manage users'))?.status).toBe(428);
    } finally {
      if (original === undefined) delete process.env.BACKUP_MGR_SUDO_TIMEOUT_MS;
      else process.env.BACKUP_MGR_SUDO_TIMEOUT_MS = original;
      resetSudoCache();
    }
  });

  it('is dropped on request, like sudo -k', async () => {
    const { authorizeSudo, authorizePrivileged, clearSessionGrant } = await import('./sudo');
    const req = request('clear-session');
    expect((await authorizeSudo(req, me, PASSWORD)).ok).toBe(true);
    expect(await authorizePrivileged(req, me, 'manage users')).toBeNull();

    clearSessionGrant(req);
    expect((await authorizePrivileged(req, me, 'manage users'))?.status).toBe(428);
  });

  it('is never opened for an account without sudo', async () => {
    const { authorizeSudo } = await import('./sudo');
    const res = await authorizeSudo(request('no-sudo-elevate'), noSudo, 'anything');
    expect(res).toMatchObject({ ok: false, status: 403 });
  });
});

describe('running a command under that account’s own sudo', () => {
  it('runs passwordlessly where the host allows it, and reports output', async () => {
    const { clearSudoFixture, useSudoFixture, currentAccount } = await import('./testhelp');
    const { probePasswordless, resetSudoCache, runElevated } = await import('./sudo');

    clearSudoFixture();
    resetSudoCache();
    try {
      if (!(await probePasswordless(currentAccount().name))) {
        return;
      }
      const res = await runElevated(request('runner-session'), currentAccount().name, 'echo', [
        'sudo-ok',
      ]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.stdout.trim()).toBe('sudo-ok');
        expect(res.via).toBe('passwordless');
      }
    } finally {
      useSudoFixture({
        [meName]: { has_sudo: true, passwordless: false },
        nosudo: { has_sudo: false },
      });
      resetSudoCache();
    }
  });

  it('runs the command in the directory it was given, not the panel’s own', async () => {
    const { clearSudoFixture, useSudoFixture, currentAccount, tmpDir } = await import('./testhelp');
    const { probePasswordless, resetSudoCache, runElevated } = await import('./sudo');
    clearSudoFixture();
    resetSudoCache();
    try {
      if (!(await probePasswordless(currentAccount().name))) return;
      const dir = tmpDir('bm-runner-cwd-');
      fs.writeFileSync(path.join(dir, 'relative.txt'), 'found it');

      const res = await runElevated(request('cwd-session'), currentAccount().name, 'cat', [
        'relative.txt',
      ], { cwd: dir });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.stdout).toContain('found it');
    } finally {
      useSudoFixture({
        [meName]: { has_sudo: true, passwordless: false },
        nosudo: { has_sudo: false },
      });
      resetSudoCache();
    }
  });

  it('runs the command once even if the caller repeats its name', async () => {
    const { clearSudoFixture, useSudoFixture, currentAccount } = await import('./testhelp');
    const { probePasswordless, resetSudoCache, runElevated } = await import('./sudo');
    clearSudoFixture();
    resetSudoCache();
    try {
      if (!(await probePasswordless(currentAccount().name))) return;

      const res = await runElevated(request('repeat-session'), currentAccount().name, 'echo', [
        'echo',
        'deduped',
      ]);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.stdout.trim()).toBe('deduped');
    } finally {
      useSudoFixture({
        [meName]: { has_sudo: true, passwordless: false },
        nosudo: { has_sudo: false },
      });
      resetSudoCache();
    }
  });

  it('reports a command that failed on its own terms as a failure, not as “needs a password”', async () => {
    const { clearSudoFixture, useSudoFixture, currentAccount } = await import('./testhelp');
    const { probePasswordless, resetSudoCache, runElevated } = await import('./sudo');
    clearSudoFixture();
    resetSudoCache();
    try {
      if (!(await probePasswordless(currentAccount().name))) return;
      const res = await runElevated(request('runner-fail'), currentAccount().name, 'cat', [
        'no-such-file-on-this-host',
      ]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.needs_password).toBe(false);
        if (!res.needs_password) expect(res.error).toMatch(/no such file/i);
      }
    } finally {
      useSudoFixture({
        [meName]: { has_sudo: true, passwordless: false },
        nosudo: { has_sudo: false },
      });
      resetSudoCache();
    }
  });
});
