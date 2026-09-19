import { NextResponse } from 'next/server';
import { cookieValue, COOKIE_NAME, parseSession } from './session';
import { getUserById, type User } from './users';
import type { Permission } from './permissions';
import { instanceFor, type Instance } from './instance';

/**
 * Resolve the signed-in user.
 *
 * Authentication itself happened against Linux; this only maps the session to an
 * authorization record. An account an admin has disabled resolves to null, so
 * blocking someone takes effect on their very next request rather than when their
 * cookie expires — and so does deleting their Linux account (`orphaned`), because
 * the OS is the source of truth for who exists.
 */
export function currentUser(req: Request): User | null {
  const parsed = parseSession(cookieValue(req, COOKIE_NAME));
  if (!parsed) return null;
  const user = getUserById(parsed.userId);
  if (!user || !user.enabled || user.orphaned) return null;
  return user;
}

export function hasPermission(user: User | null, perm: Permission): boolean {
  if (!user) return false;
  if (user.is_admin) return true;
  return user.permissions.includes(perm);
}

export type GuardResult = { ok: true; user: User } | { ok: false; response: NextResponse };

/** Authenticate + authorize a route handler request. */
export function guard(req: Request, perm: Permission): GuardResult {
  const user = currentUser(req);
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    };
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
  if (!user.is_admin) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'forbidden', admin_required: true }, { status: 403 }),
    };
  }
  return { ok: true, user };
}

/**
 * Which instance a request operates on.
 *
 * Defaults to the caller's own, which is the only one a normal user can reach.
 * An admin may name another with `?user=` / `{"user": …}`, because someone has to
 * be able to repair a user's instance — but that is an explicit, audited choice
 * rather than an ambient power, and the OS still enforces that the panel runs the
 * work as that account.
 */
export function instanceForRequest(user: User, target?: string | null): Instance | null {
  const wanted = target?.trim();
  if (!wanted || wanted === user.username) return user.instance;
  if (!user.is_admin) return null;
  return instanceFor(wanted);
}

/** Read an optional `user` target from the query string or a JSON body. */
export function targetUsername(req: Request, body?: { user?: unknown } | null): string | null {
  try {
    const fromQuery = new URL(req.url).searchParams.get('user');
    if (fromQuery) return fromQuery;
  } catch {
    // ignore malformed URLs
  }
  return typeof body?.user === 'string' ? body.user : null;
}

export function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    is_admin: user.is_admin,
    // Where admin comes from: sudo on the server (see lib/sudo.ts).
    sudo: { has_sudo: user.sudo.has_sudo, source: user.sudo.source },
    permissions: user.permissions,
    enabled: user.enabled,
    orphaned: user.orphaned,
    // Surfaced so the UI can show whose instance is on screen and where it lives.
    instance: user.instance
      ? { os_user: user.instance.osUser, root: user.instance.root, pm2_name: user.instance.pm2Name }
      : null,
  };
}
