import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import {
  countAdmins,
  createUser,
  deleteUser,
  getUserByName,
  listUsers,
  passwordProblem,
  updateUser,
} from '@/lib/users';
import { normalizePermissions } from '@/lib/permissions';

export const runtime = 'nodejs';

type CreateBody = {
  username?: string;
  password?: string;
  is_admin?: boolean;
  permissions?: unknown;
  must_change_password?: boolean;
};

type UpdateBody = {
  id?: number;
  is_admin?: boolean;
  permissions?: unknown;
  password?: string;
  must_change_password?: boolean;
};

export async function GET(req: Request) {
  const g = requireAdmin(req);
  if (!g.ok) return g.response;
  return NextResponse.json({ users: listUsers() });
}

export async function POST(req: Request) {
  const g = requireAdmin(req);
  if (!g.ok) return g.response;

  let body: CreateBody | null = null;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    body = null;
  }

  const username = String(body?.username ?? '').trim();
  const password = String(body?.password ?? '');
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
    return NextResponse.json(
      { error: 'Username must be 3-32 chars: letters, digits, dot, underscore or dash' },
      { status: 400 },
    );
  }
  const problem = passwordProblem(password, username);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  if (getUserByName(username)) {
    return NextResponse.json({ error: 'That username is already taken' }, { status: 409 });
  }

  const isAdmin = Boolean(body?.is_admin);
  const user = createUser({
    username,
    password,
    is_admin: isAdmin,
    permissions: normalizePermissions(body?.permissions),
    must_change_password: Boolean(body?.must_change_password),
  });
  return NextResponse.json({ ok: true, user });
}

export async function PATCH(req: Request) {
  const g = requireAdmin(req);
  if (!g.ok) return g.response;

  let body: UpdateBody | null = null;
  try {
    body = (await req.json()) as UpdateBody;
  } catch {
    body = null;
  }
  const id = Number(body?.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'valid user id required' }, { status: 400 });
  }

  // Never allow removing the last admin.
  if (body?.is_admin === false) {
    const target = listUsers().find((u) => u.id === id);
    if (target?.is_admin && countAdmins() <= 1) {
      return NextResponse.json({ error: 'cannot demote the last admin' }, { status: 400 });
    }
  }

  if (body?.password) {
    const target = listUsers().find((u) => u.id === id);
    if (!target) return NextResponse.json({ error: 'user not found' }, { status: 404 });
    const problem = passwordProblem(body.password, target.username);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  }

  const user = updateUser(id, {
    is_admin: body?.is_admin,
    permissions: body?.permissions !== undefined ? normalizePermissions(body.permissions) : undefined,
    password: body?.password,
    must_change_password: body?.must_change_password,
  });
  if (!user) return NextResponse.json({ error: 'user not found' }, { status: 404 });
  return NextResponse.json({ ok: true, user });
}

export async function DELETE(req: Request) {
  const g = requireAdmin(req);
  if (!g.ok) return g.response;

  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'valid user id required' }, { status: 400 });
  }
  if (id === g.user.id) {
    return NextResponse.json({ error: 'you cannot delete your own account' }, { status: 400 });
  }
  const target = listUsers().find((u) => u.id === id);
  if (target?.is_admin && countAdmins() <= 1) {
    return NextResponse.json({ error: 'cannot delete the last admin' }, { status: 400 });
  }
  if (!deleteUser(id)) {
    return NextResponse.json({ error: 'user not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
