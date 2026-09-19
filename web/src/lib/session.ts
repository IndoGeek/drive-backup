import crypto from 'node:crypto';
import { sessionSecret } from './users';

export const COOKIE_NAME = 'bm_session';
const TTL_MS = 1000 * 60 * 60 * 12; // 12h

function signPayload(payload: string): string {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
}

/** Cookie value: `userId.expiry.signature`. */
export function createSession(userId: number): { value: string; exp: number } {
  const exp = Date.now() + TTL_MS;
  const payload = `${userId}.${exp}`;
  return { value: `${payload}.${signPayload(payload)}`, exp };
}

export function parseSession(value: string | undefined): { userId: number; exp: number } | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [uidS, expS, sig] = parts;
  const userId = Number(uidS);
  const exp = Number(expS);
  if (!Number.isInteger(userId) || userId <= 0 || Number.isNaN(exp) || exp < Date.now()) {
    return null;
  }
  const expected = signPayload(`${uidS}.${expS}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { userId, exp };
}

export const SESSION_TTL_MS = TTL_MS;
