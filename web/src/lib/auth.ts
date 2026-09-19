import { NextResponse } from 'next/server';
import { COOKIE_NAME, parseSession } from './session';
import { getUserById, type User } from './users';
import type { Permission } from './permissions';

export function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

export function currentUser(req: Request): User | null {
  const parsed = parseSession(cookieValue(req, COOKIE_NAME));
  if (!parsed) return null;
  return getUserById(parsed.userId);
}

export function hasPermission(user: User | null, perm: Permission): boolean {
  if (!user) return false;
  if (user.is_admin) return true;
  return user.permissions.includes(perm);
}

export type GuardResult = { ok: true; user: User } | { ok: false; response: NextResponse };

/**
 * While an account still carries a default / admin-assigned password every
 * guarded route is refused, so the prompt cannot be bypassed by calling the API
 * directly. `/api/auth/me`, `/api/auth/logout` and `/api/account` stay reachable
 * (they use `currentUser`, not `guard`) so the user can actually change it.
 */
function passwordChangeRequired(): NextResponse {
  return NextResponse.json(
    { error: 'password change required', must_change_password: true },
    { status: 403 },
  );
}

/** Authenticate + authorize a route handler request. */
export function guard(req: Request, perm: Permission): GuardResult {
  const user = currentUser(req);
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    };
  }
  if (user.must_change_password) {
    return { ok: false, response: passwordChangeRequired() };
  }
  if (!hasPermission(user, perm)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'forbidden', permission: perm }, { status: 403 }),
    };
  }
  return { ok: true, user };
}

export function requireAdmin(req: Request): GuardResult {
  const user = currentUser(req);
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  }
  if (user.must_change_password) {
    return { ok: false, response: passwordChangeRequired() };
  }
  if (!user.is_admin) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'forbidden', admin_required: true }, { status: 403 }),
    };
  }
  return { ok: true, user };
}

export function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    is_admin: user.is_admin,
    permissions: user.permissions,
    must_change_password: user.must_change_password,
  };
}
