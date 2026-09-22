import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { envNumber, passwdWatchIntervalMs, sudoTimeoutMs, syncIntervalMs } from './panel';
import { minUid } from './osusers';

const TOUCHED = [
  'BACKUP_MGR_SUDO_TIMEOUT_MS',
  'BACKUP_MGR_AUTO_SYNC_INTERVAL_MS',
  'BACKUP_MGR_PASSWD_WATCH_INTERVAL_MS',
  'BACKUP_MGR_MIN_UID',
] as const;

const saved = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  setEnv('BACKUP_MGR_SUDO_TIMEOUT_MS', saved.get('BACKUP_MGR_SUDO_TIMEOUT_MS'));
  setEnv('BACKUP_MGR_AUTO_SYNC_INTERVAL_MS', saved.get('BACKUP_MGR_AUTO_SYNC_INTERVAL_MS'));
  setEnv('BACKUP_MGR_PASSWD_WATCH_INTERVAL_MS', saved.get('BACKUP_MGR_PASSWD_WATCH_INTERVAL_MS'));
  setEnv('BACKUP_MGR_MIN_UID', saved.get('BACKUP_MGR_MIN_UID'));
});

describe('envNumber', () => {
  it('treats unset, empty and whitespace as absent', () => {
    setEnv('BACKUP_MGR_SUDO_TIMEOUT_MS', undefined);
    expect(envNumber('BACKUP_MGR_SUDO_TIMEOUT_MS')).toBeUndefined();
    setEnv('BACKUP_MGR_SUDO_TIMEOUT_MS', '');
    expect(envNumber('BACKUP_MGR_SUDO_TIMEOUT_MS')).toBeUndefined();
    setEnv('BACKUP_MGR_SUDO_TIMEOUT_MS', '   ');
    expect(envNumber('BACKUP_MGR_SUDO_TIMEOUT_MS')).toBeUndefined();
    setEnv('BACKUP_MGR_SUDO_TIMEOUT_MS', 'nonsense');
    expect(envNumber('BACKUP_MGR_SUDO_TIMEOUT_MS')).toBeUndefined();
  });

  it('keeps a real zero, which is a value and not a missing setting', () => {
    setEnv('BACKUP_MGR_SUDO_TIMEOUT_MS', '0');
    expect(envNumber('BACKUP_MGR_SUDO_TIMEOUT_MS')).toBe(0);
  });
});

describe('the elevation window', () => {
  it('defaults to sudo’s own 15 minutes when nothing is set', () => {
    setEnv('BACKUP_MGR_SUDO_TIMEOUT_MS', undefined);
    expect(sudoTimeoutMs()).toBe(15 * 60_000);

    setEnv('BACKUP_MGR_SUDO_TIMEOUT_MS', '');
    expect(sudoTimeoutMs()).toBe(15 * 60_000);
  });

  it('honours an explicit window, including zero', () => {
    setEnv('BACKUP_MGR_SUDO_TIMEOUT_MS', '60000');
    expect(sudoTimeoutMs()).toBe(60_000);
    setEnv('BACKUP_MGR_SUDO_TIMEOUT_MS', '0');
    expect(sudoTimeoutMs()).toBe(0);
  });
});

describe('the other intervals', () => {
  it('falls back to their defaults when blank, and clamps the floor', () => {
    setEnv('BACKUP_MGR_AUTO_SYNC_INTERVAL_MS', '');
    expect(syncIntervalMs()).toBe(15_000);
    setEnv('BACKUP_MGR_AUTO_SYNC_INTERVAL_MS', '5000');
    expect(syncIntervalMs()).toBe(5000);
    setEnv('BACKUP_MGR_AUTO_SYNC_INTERVAL_MS', '100');
    expect(syncIntervalMs()).toBe(15_000);

    setEnv('BACKUP_MGR_PASSWD_WATCH_INTERVAL_MS', '');
    expect(passwdWatchIntervalMs()).toBe(2000);
  });

  it('never lets a blank MIN_UID mirror every service account', () => {
    setEnv('BACKUP_MGR_MIN_UID', '');
    expect(minUid()).toBe(1000);
    setEnv('BACKUP_MGR_MIN_UID', undefined);
    expect(minUid()).toBe(1000);
    setEnv('BACKUP_MGR_MIN_UID', '0');
    expect(minUid()).toBe(0);
    setEnv('BACKUP_MGR_MIN_UID', '500');
    expect(minUid()).toBe(500);
  });
});

describe('the pm2 ecosystem file', () => {
  it('omits blank variables instead of defining them as empty', () => {
    for (const name of TOUCHED) setEnv(name, undefined);
    setEnv('BACKUP_MGR_SUDO_TIMEOUT_MS', '');
    setEnv('BACKUP_MGR_ADMIN_USER', '');

    const file = path.join(__dirname, '..', '..', 'ecosystem.config.cjs');

    const cfg = require(file) as { apps: { env: Record<string, string> }[] };
    const env = cfg.apps[0]!.env;

    expect(env.NODE_ENV).toBe('production');
    for (const [key, value] of Object.entries(env)) {
      expect(`${key}=${JSON.stringify(value)}`).not.toMatch(/=""$/);
    }
    expect(env.BACKUP_MGR_SUDO_TIMEOUT_MS).toBeUndefined();
    expect(env.BACKUP_MGR_ADMIN_USER).toBeUndefined();
  });
});
