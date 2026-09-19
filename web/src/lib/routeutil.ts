import { NextResponse } from 'next/server';
import { instanceForRequest, targetUsername } from './auth';
import { existsAs, type Instance } from './instance';
import { activeGrant, authorizePrivileged } from './sudo';
import { recordAudit } from './audit';
import { clientAddress } from './session';
import type { User } from './users';

/**
 * Resolve which instance a request operates on, or the response to send instead.
 *
 * Routes default to the caller's own instance. Only an admin may name another via
 * `?user=` / `{"user": …}`, because someone has to be able to repair a user's
 * instance — but that is explicit rather than ambient.
 */
export function pickInstance(
  req: Request,
  user: User,
  body?: unknown,
): { ok: true; inst: Instance } | { ok: false; response: NextResponse } {
  const target =
    targetUsername(req, body && typeof body === 'object' ? (body as { user?: unknown }) : null) ??
    null;
  const inst = instanceForRequest(user, target);
  if (!inst) {
    const wanted = target?.trim();
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            wanted && wanted !== user.username
              ? `no instance for '${wanted}' — only admins may act on another user's instance, and the account must exist`
              : `no backup instance could be resolved for '${user.username}'`,
        },
        { status: wanted && wanted !== user.username ? 403 : 404 },
      ),
    };
  }
  return { ok: true, inst };
}

/**
 * Resolve the instance for a *mutation*.
 *
 * Everything `pickInstance` does, plus one rule from the multi-user model: acting
 * on another account's instance is privileged work, so it needs the caller's own
 * sudo — silently when their rules are NOPASSWD, otherwise after a password. Reads
 * of another user's instance stay ungated for an admin.
 */
export async function pickInstanceForMutation(
  req: Request,
  user: User,
  body?: unknown,
): Promise<{ ok: true; inst: Instance } | { ok: false; response: NextResponse }> {
  const picked = pickInstance(req, user, body);
  if (!picked.ok) return picked;
  if (picked.inst.osUser === user.username) return picked;
  const denial = await authorizePrivileged(
    req,
    user,
    `change something in ${picked.inst.osUser}'s instance`,
  );
  if (denial) return { ok: false, response: denial };
  // Cross-user changes are the interesting half of an audit trail, and every one
  // of them comes through here — so this is where they are recorded. The endpoint
  // is enough to say *what* was changed; the target says whose.
  const method = req.method || 'POST';
  let path = '';
  try {
    path = new URL(req.url).pathname;
  } catch {
    path = 'unknown';
  }
  recordAudit({
    username: user.username,
    action: `${method} ${path}`,
    outcome: 'allowed',
    via: activeGrant(req, user.username) ? 'password' : 'passwordless',
    detail: { target: picked.inst.osUser, instance: picked.inst.root },
    address: clientAddress(req),
  });
  return picked;
}

export function instanceView(inst: Instance) {
  return {
    os_user: inst.osUser,
    root: inst.root,
    config_path: inst.configPath,
    logs_dir: inst.logsDir,
    pm2_name: inst.pm2Name,
    pm2_home: inst.pm2Home,
  };
}

/**
 * Refuse with a 409 when the instance has not been created yet, rather than
 * letting the command fail with an opaque error about a missing config file.
 */
export async function requireProvisioned(inst: Instance): Promise<NextResponse | null> {
  if (await existsAs(inst, inst.configPath)) return null;
  return NextResponse.json(
    {
      error: `'${inst.osUser}' has no instance yet (${inst.configPath} is missing). An administrator can create it from the Users page.`,
      needs_provisioning: true,
      instance: instanceView(inst),
    },
    { status: 409 },
  );
}
