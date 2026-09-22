import crypto from 'node:crypto';
import { getPath, readInstanceConfig } from './config';
import { clientAddress, sessionKey } from './session';
import { recordAudit } from './audit';
import { restoreUnlockMs } from './panel';
import { authKey, recordFailure, recordSuccess, throttleRemaining } from './systemauth';
import type { Instance } from './instance';
import type { User } from './users';

export type EncryptionState = {
  enabled: boolean;
  has_passphrase: boolean;
  cipher: string | null;
};

export function encryptionFromConfig(cfg: Record<string, unknown>): EncryptionState {
  const cipher = getPath(cfg, 'encrypt.cipher');
  return {
    enabled: getPath(cfg, 'encrypt.enabled') === true,
    has_passphrase: String(getPath(cfg, 'encrypt.passphrase') ?? '').trim() !== '',
    cipher: cipher ? String(cipher) : null,
  };
}

export async function encryptionState(inst: Instance): Promise<EncryptionState> {
  return encryptionFromConfig(await readInstanceConfig(inst));
}

function sameSecret(a: string, b: string): boolean {
  const left = crypto.createHash('sha256').update(a, 'utf8').digest();
  const right = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

function secretOf(cfg: Record<string, unknown>): string {
  return String(getPath(cfg, 'encrypt.passphrase') ?? '');
}

type Grant = { expiresAt: number; username: string; root: string };

const grants = new Map<string, Grant>();

function grantKey(req: Request, username: string, root: string): string {
  return `${sessionKey(req)}:${username}:${root}`;
}

function purgeExpired(now = Date.now()): void {
  for (const [key, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(key);
  }
}

export function restoreUnlocked(req: Request, username: string, root: string): boolean {
  purgeExpired();
  const grant = grants.get(grantKey(req, username, root));
  return Boolean(grant && grant.expiresAt > Date.now());
}

export function restoreUnlockUntil(req: Request, username: string, root: string): string | null {
  if (!restoreUnlocked(req, username, root)) return null;
  const grant = grants.get(grantKey(req, username, root))!;
  return new Date(grant.expiresAt).toISOString();
}

export function clearRestoreGrants(
  req: Request,
  username?: string,
  reason: 'requested' | 'sign-out' = 'requested',
): number {
  const prefix = `${sessionKey(req)}:`;
  let cleared = 0;
  for (const [key, grant] of grants) {
    if (!key.startsWith(prefix)) continue;
    if (username && grant.username !== username) continue;
    grants.delete(key);
    cleared += 1;
    recordAudit({
      username: grant.username,
      action: 'restore unlock ended',
      outcome: 'elevation_ended',
      detail: { reason, instance: grant.root },
      address: clientAddress(req),
    });
  }
  return cleared;
}

export type UnlockResult =
  | { ok: true; required: boolean; until: string | null; timeout_ms: number }
  | { ok: false; status: number; error: string };

export async function unlockRestore(
  req: Request,
  user: User,
  inst: Instance,
  passphrase: string,
): Promise<UnlockResult> {
  const cfg = await readInstanceConfig(inst);
  const state = encryptionFromConfig(cfg);

  if (!state.enabled || !state.has_passphrase) {
    return { ok: true, required: false, until: null, timeout_ms: 0 };
  }

  const key = authKey(user.username, 'restore-passphrase');
  const waitMs = throttleRemaining(key);
  if (waitMs > 0) {
    return {
      ok: false,
      status: 429,
      error: `too many attempts — try again in ${Math.ceil(waitMs / 1000)}s`,
    };
  }
  if (!passphrase) {
    return { ok: false, status: 400, error: 'the encryption passphrase is required' };
  }

  if (!sameSecret(passphrase, secretOf(cfg))) {
    recordFailure(key);
    recordAudit({
      username: user.username,
      action: 'restore unlocked',
      outcome: 'denied',
      detail: { reason: 'wrong passphrase', instance: inst.root },
      address: clientAddress(req),
    });
    return { ok: false, status: 401, error: 'That is not the encryption passphrase in config.yml' };
  }

  recordSuccess(key);
  const timeout = restoreUnlockMs();
  const until = Date.now() + timeout;
  grants.set(grantKey(req, user.username, inst.root), {
    expiresAt: until,
    username: user.username,
    root: inst.root,
  });
  recordAudit({
    username: user.username,
    action: 'restore unlocked',
    outcome: 'allowed',
    detail: { until: new Date(until).toISOString(), instance: inst.root },
    address: clientAddress(req),
  });
  return { ok: true, required: true, until: new Date(until).toISOString(), timeout_ms: timeout };
}
