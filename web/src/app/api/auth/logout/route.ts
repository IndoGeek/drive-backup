import { NextResponse } from 'next/server';import { COOKIE_NAME } from '@/lib/session';
import { clearSessionGrant } from '@/lib/sudo';
import { clearRestoreGrants } from '@/lib/restoregate';

export const runtime = 'nodejs';
export async function POST(req: Request) {
  clearSessionGrant(req, undefined, 'sign-out');
  clearRestoreGrants(req, undefined, 'sign-out');
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
