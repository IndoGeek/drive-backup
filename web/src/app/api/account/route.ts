import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { authenticate, getUserByName, passwordProblem, updateOwnAccount } from '@/lib/users';

export const runtime = 'nodejs';

type AccountBody = { currentPassword?: string; username?: string; password?: string };

export async function POST(req: Request) {
  const user = currentUser(req);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: AccountBody | null = null;
  try {
    body = (await req.json()) as AccountBody;
  } catch {
    body = null;
  }

  const currentPassword = String(body?.currentPassword ?? '');
  if (!authenticate(user.username, currentPassword)) {
    return NextResponse.json({ error: 'Current password is incorrect' }, { status: 403 });
  }

  const username = body?.username !== undefined ? String(body.username).trim() : undefined;
  const password = body?.password !== undefined ? String(body.password) : undefined;

  if (username !== undefined) {
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
      return NextResponse.json(
        { error: 'Username must be 3-32 chars: letters, digits, dot, underscore or dash' },
        { status: 400 },
      );
    }
    if (username !== user.username && getUserByName(username)) {
      return NextResponse.json({ error: 'That username is already taken' }, { status: 409 });
    }
  }
  if (password !== undefined && password.length > 0) {
    const problem = passwordProblem(password, username ?? user.username);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  }

  const updated = updateOwnAccount(user.id, { username, password });
  if (!updated) return NextResponse.json({ error: 'account not found' }, { status: 404 });
  // `must_change_password` is cleared whenever a new password is set, so the
  // client can just re-read /api/auth/me to learn it may continue.
  return NextResponse.json({ ok: true, must_change_password: updated.must_change_password });
}
