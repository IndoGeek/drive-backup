import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRestoreGrants,
  encryptionFromConfig,
  encryptionState,
  restoreUnlocked,
  restoreUnlockUntil,
  unlockRestore,
} from './restoregate';
import { instanceFor } from './instance';
import { useSoloInstance } from './testhelp';
import { ensureUser } from './users';
import type { Instance } from './instance';

let root = '';
let inst: Instance;
let who = '';

function writeConfig(body: string): void {
  fs.writeFileSync(path.join(root, 'config.yml'), body, { mode: 0o600 });
}

function request(): Request {
  return new Request('http://test/api/restore', { headers: { cookie: 'bm_session=restore-test' } });
}

beforeEach(() => {
  const solo = useSoloInstance();
  root = solo.root;
  who = solo.account.name;
  fs.mkdirSync(root, { recursive: true });
  const built = instanceFor(who);
  if (!built) throw new Error('could not build an instance for the current account');
  inst = built;
  clearRestoreGrants(request(), who);
});

describe('encryptionFromConfig', () => {
  it('reports when archives are encrypted and a passphrase is set', () => {
    expect(
      encryptionFromConfig({ encrypt: { enabled: true, passphrase: 'hunter2', cipher: 'AES256' } }),
    ).toEqual({ enabled: true, has_passphrase: true, cipher: 'AES256' });
  });

  it('treats a blank passphrase as no encryption even when enabled is true', () => {
    expect(encryptionFromConfig({ encrypt: { enabled: true, passphrase: '  ' } })).toEqual({
      enabled: true,
      has_passphrase: false,
      cipher: null,
    });
  });

  it('handles a missing encrypt section', () => {
    expect(encryptionFromConfig({})).toEqual({
      enabled: false,
      has_passphrase: false,
      cipher: null,
    });
  });
});

describe('the restore passphrase gate', () => {
  it('needs nothing when the instance does not encrypt', async () => {
    writeConfig('backup:\n  time: "03:30"\n');
    expect(await encryptionState(inst)).toEqual({
      enabled: false,
      has_passphrase: false,
      cipher: null,
    });

    const req = request();
    expect(restoreUnlocked(req, who, inst.root)).toBe(false);
    const user = ensureUser(who)!;
    const result = await unlockRestore(req, user, inst, '');
    expect(result).toMatchObject({ ok: true, required: false });
    expect(restoreUnlocked(req, who, inst.root)).toBe(false);
  });

  it('locks a restore until the configured passphrase is confirmed', async () => {
    writeConfig('encrypt:\n  enabled: true\n  passphrase: "correct horse"\n  cipher: AES256\n');
    const req = request();
    const user = ensureUser(who)!;

    expect(await encryptionState(inst)).toMatchObject({ enabled: true, has_passphrase: true });
    expect(restoreUnlocked(req, who, inst.root)).toBe(false);

    const wrong = await unlockRestore(req, user, inst, 'battery staple');
    expect(wrong).toMatchObject({ ok: false, status: 401 });
    expect(restoreUnlocked(req, who, inst.root)).toBe(false);

    const right = await unlockRestore(req, user, inst, 'correct horse');
    expect(right).toMatchObject({ ok: true, required: true });
    expect(restoreUnlocked(req, who, inst.root)).toBe(true);
    expect(restoreUnlockUntil(req, who, inst.root)).toBeTruthy();
  });

  it('refuses an empty passphrase', async () => {
    writeConfig('encrypt:\n  enabled: true\n  passphrase: "secret"\n');
    const req = request();
    const user = ensureUser(who)!;
    expect(await unlockRestore(req, user, inst, '')).toMatchObject({ ok: false, status: 400 });
  });

  it('scopes the unlock to the login and the instance', async () => {
    writeConfig('encrypt:\n  enabled: true\n  passphrase: "secret"\n');
    const req = request();
    const user = ensureUser(who)!;
    await unlockRestore(req, user, inst, 'secret');

    const otherLogin = new Request('http://test/api/restore', {
      headers: { cookie: 'bm_session=someone-else' },
    });
    expect(restoreUnlocked(req, who, inst.root)).toBe(true);
    expect(restoreUnlocked(otherLogin, who, inst.root)).toBe(false);
    expect(restoreUnlocked(req, who, '/some/other/instance')).toBe(false);
  });

  it('drops the unlock on sign-out and on request', async () => {
    writeConfig('encrypt:\n  enabled: true\n  passphrase: "secret"\n');
    const req = request();
    const user = ensureUser(who)!;

    await unlockRestore(req, user, inst, 'secret');
    expect(clearRestoreGrants(req, who, 'sign-out')).toBe(1);
    expect(restoreUnlocked(req, who, inst.root)).toBe(false);

    await unlockRestore(req, user, inst, 'secret');
    expect(clearRestoreGrants(req, who, 'requested')).toBe(1);
    expect(restoreUnlocked(req, who, inst.root)).toBe(false);
  });
});
