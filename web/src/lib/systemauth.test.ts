import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authKey,
  recordFailure,
  recordSuccess,
  resetThrottle,
  throttleRemaining,
  verifySystemPassword,
} from './systemauth';
import { currentAccount, makeHash, usePasswdFixture, writeShadowFixture } from './testhelp';

const ACCOUNT = currentAccount();
const PASSWORD = 'correct-horse-battery';

/** Bob is a normal mirrored account; svc is a service account and not mirrorable. */
const PASSWD = [
  { name: ACCOUNT.name, uid: ACCOUNT.uid, gid: ACCOUNT.gid, home: ACCOUNT.home },
  { name: 'bob', uid: 1001, gid: 1001, home: '/home/bob' },
  // Locked and password-less accounts are still real, mirrorable accounts — the
  // shadow entry is what makes them unusable, not the passwd entry.
  { name: 'locked', uid: 1003, gid: 1003, home: '/home/locked' },
  { name: 'nopass', uid: 1004, gid: 1004, home: '/home/nopass' },
  { name: 'svc', uid: 1002, gid: 1002, home: '/srv/svc', shell: '/usr/sbin/nologin' },
];

beforeEach(() => {
  // The 350ms floor keeps reply times uniform in production; tests do not need it.
  process.env.BACKUP_MGR_MIN_VERIFY_MS = '0';
  delete process.env.BACKUP_MGR_MAX_LOGIN_FAILURES;
  usePasswdFixture(PASSWD);
  process.env.BACKUP_MGR_SHADOW_FILE = writeShadowFixture([
    // A genuine crypt(3) hash, so the perl/python crypt path is really exercised.
    { name: 'bob', hash: makeHash(PASSWORD) },
    // Locked with `passwd -l` (hash prefixed with !).
    { name: 'locked', hash: `!${makeHash('whatever')}` },
    // `*` means no password was ever set.
    { name: 'nopass', hash: '*' },
  ]);
});

afterEach(() => {
  resetThrottle();
});

describe('verifySystemPassword', () => {
  it('accepts the correct Linux password', async () => {
    await expect(verifySystemPassword('bob', PASSWORD)).resolves.toEqual({ ok: true });
  });

  it('rejects a wrong password', async () => {
    const res = await verifySystemPassword('bob', 'not-the-password');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid');
  });

  it('reports an unknown account identically to a wrong password', async () => {
    // Same reason, so the endpoint cannot be used to enumerate usernames.
    const res = await verifySystemPassword('nobody-here', 'x');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unknown-user');
  });

  it('refuses accounts that are not mirrorable at all', async () => {
    const res = await verifySystemPassword('svc', PASSWORD);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unknown-user');
  });

  it('distinguishes a locked account from a wrong password', async () => {
    const res = await verifySystemPassword('locked', 'whatever');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('locked');
  });

  it('distinguishes an account with no password set', async () => {
    const res = await verifySystemPassword('nopass', 'anything');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-password');
  });

  it('rejects an empty password outright', async () => {
    const res = await verifySystemPassword('bob', '');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid');
  });

  it('reports a broken shadow source as an infrastructure problem, not a bad password', async () => {
    // A misconfigured source must not look like "wrong password", which would
    // send an operator hunting for the wrong bug.
    process.env.BACKUP_MGR_SHADOW_FILE = '/definitely/not/here/shadow';
    const res = await verifySystemPassword('bob', PASSWORD);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('sudo');
      expect(res.message).toMatch(/BACKUP_MGR_SHADOW_FILE/);
    }
  });
});

describe('throttling', () => {
  it('does not lock out before the failure limit', () => {
    const key = authKey('bob', '127.0.0.1');
    for (let i = 0; i < 4; i++) recordFailure(key);
    expect(throttleRemaining(key)).toBe(0);
  });

  it('locks out once the failure limit is reached', () => {
    const key = authKey('bob', '127.0.0.1');
    for (let i = 0; i < 5; i++) recordFailure(key);
    expect(throttleRemaining(key)).toBeGreaterThan(0);
  });

  it('backs off further on continued failures', () => {
    const key = authKey('bob', '127.0.0.1');
    for (let i = 0; i < 5; i++) recordFailure(key);
    const first = throttleRemaining(key);
    recordFailure(key);
    expect(throttleRemaining(key)).toBeGreaterThan(first);
  });

  it('keys on account and address together', () => {
    const a = authKey('bob', '10.0.0.1');
    const b = authKey('bob', '10.0.0.2');
    for (let i = 0; i < 5; i++) recordFailure(a);
    expect(throttleRemaining(a)).toBeGreaterThan(0);
    expect(throttleRemaining(b)).toBe(0);
  });

  it('clears the counter on a success', () => {
    const key = authKey('bob', '127.0.0.1');
    for (let i = 0; i < 5; i++) recordFailure(key);
    recordSuccess(key);
    expect(throttleRemaining(key)).toBe(0);
  });
});
