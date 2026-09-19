import { NextResponse } from 'next/server';
import { COOKIE_NAME } from '@/lib/session';
import { clearSessionGrant } from '@/lib/sudo';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  // Signing out ends elevation with the session — the same way closing your shell
  // ends an interactive sudo session. Deliberately not guarded: logging out must
  // always work, including for an account an admin has just blocked.
  clearSessionGrant(req, undefined, 'sign-out');
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
