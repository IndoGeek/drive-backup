import { NextResponse } from 'next/server';
import { authenticate } from '@/lib/users';
import { COOKIE_NAME, createSession } from '@/lib/session';
import { publicUser } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let body: { username?: string; password?: string } | null = null;
  try {
    body = (await req.json()) as { username?: string; password?: string };
  } catch {
    body = null;
  }
  const username = String(body?.username ?? '').trim();
  const password = String(body?.password ?? '');
  if (!username || !password) {
    return NextResponse.json({ error: 'Username and password are required' }, { status: 400 });
  }

  const user = authenticate(username, password);
  if (!user) {
    return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
  }

  const { value, exp } = createSession(user.id);
  const proto =
    req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '');
  const res = NextResponse.json({ ok: true, user: publicUser(user) });
  res.cookies.set(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    expires: new Date(exp),
    secure: proto === 'https',
  });
  return res;
}
