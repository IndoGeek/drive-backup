import { NextResponse } from 'next/server';
import { ensureUser } from '@/lib/users';
import { clientAddress, COOKIE_NAME, createSession } from '@/lib/session';
import { publicUser } from '@/lib/auth';
import {
  authKey,
  recordFailure,
  recordSuccess,
  throttleRemaining,
  verifySystemPassword,
} from '@/lib/systemauth';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let body: { username?: unknown; password?: unknown } | null = null;
  try {
    body = (await req.json()) as { username?: unknown; password?: unknown };
  } catch {
    body = null;
  }
  const username = String(body?.username ?? '').trim();
  const password = String(body?.password ?? '');
  if (!username || !password) {
    return NextResponse.json({ error: 'Username and password are required' }, { status: 400 });
  }

  const key = authKey(username, clientAddress(req));
  const waitMs = throttleRemaining(key);
  if (waitMs > 0) {
    const seconds = Math.ceil(waitMs / 1000);
    return NextResponse.json(
      { error: `Too many failed attempts. Try again in ${seconds}s.` },
      { status: 429, headers: { 'Retry-After': String(seconds) } },
    );
  }

  const result = await verifySystemPassword(username, password);

  if (!result.ok) {
    // Misconfiguration is not a failed login: report it plainly and do not count
    // it against the account, or an admin lockout would be blamed on the attacker.
    if (result.reason === 'sudo' || result.reason === 'tooling') {
      console.error(`[login] cannot verify passwords: ${result.message}`);
      return NextResponse.json({ error: result.message }, { status: 500 });
    }

    recordFailure(key);
    // Locked and password-less accounts are reported vaguely on purpose: saying
    // "this account is locked" would confirm that a username exists. The real
    // reason goes to the panel log for an administrator to read.
    if (result.reason === 'locked' || result.reason === 'no-password') {
      console.warn(`[login] refusing '${username}': ${result.reason}`);
      return NextResponse.json(
        { error: 'This account cannot sign in to the panel. Contact an administrator.' },
        { status: 403 },
      );
    }
    return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
  }

  // Verified against Linux, so the account exists. Mirror it into the panel, which
  // is what makes `useradd` alone enough to gain access.
  const user = ensureUser(username);
  if (!user) {
    return NextResponse.json({ error: 'This account cannot sign in to the panel' }, { status: 403 });
  }
  if (!user.enabled) {
    return NextResponse.json(
      { error: 'This account has been blocked by an administrator' },
      { status: 403 },
    );
  }

  recordSuccess(key);
  const { value, exp } = createSession(user.id);
  const proto = req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '');
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
