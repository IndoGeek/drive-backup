import { NextResponse } from 'next/server';
import { guard } from '@/lib/auth';
import { listUsers, pruneOrphans, updateUser, type User } from '@/lib/users';
import { instanceFor, provision } from '@/lib/instance';
import { normalizePermissions } from '@/lib/permissions';
import { instanceView } from '@/lib/routeutil';
import { syncUsersNow, userWatchState } from '@/lib/userwatch';
import { activeGrant, authorizePrivileged, sudoStatus } from '@/lib/sudo';
import { recordAudit } from '@/lib/audit';
import { clientAddress } from '@/lib/session';

export const runtime = 'nodejs';

type ProvisionBody = { action: 'provision'; username?: string };
type ProvisionAllBody = { action: 'provision_all' };
type SyncBody = { action: 'sync' };
type PruneBody = { action: 'prune' };
type UpdateBody = {
  id?: number;
  is_admin?: boolean;
  permissions?: unknown;
  enabled?: boolean;
};

export async function GET(req: Request) {
  const g = guard(req, 'users.manage');
  if (!g.ok) return g.response;

  await syncUsersNow('request');
  return NextResponse.json({
    users: viewAll(),

    sync: userWatchState(),

    sudo: await sudoStatus(req, g.user.username),
  });
}

async function elevation(req: Request, user: User) {
  return authorizePrivileged(req, user, 'manage users');
}

function audit(
  req: Request,
  user: User,
  action: string,
  detail: Record<string, unknown>,
  outcome: 'allowed' | 'failed' = 'allowed',
) {
  recordAudit({
    username: user.username,
    action,
    outcome,
    via: activeGrant(req, user.username) ? 'password' : 'passwordless',
    detail,
    address: clientAddress(req),
  });
}

export async function POST(req: Request) {
  const g = guard(req, 'users.manage');
  if (!g.ok) return g.response;
  const denial = await elevation(req, g.user);
  if (denial) return denial;

  let body: (ProvisionBody | ProvisionAllBody | SyncBody | PruneBody) | null = null;
  try {
    body = (await req.json()) as ProvisionBody | ProvisionAllBody | SyncBody | PruneBody;
  } catch {
    body = null;
  }

  if (body?.action === 'prune') {
    const { removed, sourceOk } = pruneOrphans();
    if (sourceOk) audit(req, g.user, 'prune deleted accounts', { removed });
    if (!sourceOk) {
      return NextResponse.json(
        {
          error:
            'the account database could not be read, so nothing was pruned — refusing to treat ' +
            'an unreadable /etc/passwd as "every account was deleted"',
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: true, removed });
  }

  if (body?.action === 'sync') {
    const report = await syncUsersNow('request');
    return NextResponse.json({ ok: true, report, sync: userWatchState(), users: viewAll() });
  }

  if (body?.action === 'provision_all') {
    const done: string[] = [];
    const kept: string[] = [];
    const failed: { username: string; error: string }[] = [];
    for (const u of listUsers()) {
      if (u.orphaned) continue;
      const inst = instanceFor(u.username);
      if (!inst) continue;
      const result = await provision(inst);
      if (!result.ok) {
        failed.push({ username: u.username, error: result.error ?? 'unknown error' });
      } else if (result.created.length) {
        done.push(u.username);
      } else {
        kept.push(u.username);
      }
    }
    audit(req, g.user, 'provision all instances', {
      created: done,
      kept,
      failed: failed.map((f) => f.username),
    }, failed.length ? 'failed' : 'allowed');
    return NextResponse.json({ ok: failed.length === 0, created: done, kept, failed });
  }

  if (body?.action === 'provision') {
    const username = String((body as ProvisionBody).username ?? '').trim();
    const inst = instanceFor(username);
    if (!inst) {
      return NextResponse.json({ error: `no such mirrored account: ${username}` }, { status: 404 });
    }

    const result = await provision(inst);
    audit(
      req,
      g.user,
      'provision instance',
      { username, created: result.created, kept: result.keptExisting, error: result.error ?? null },
      result.ok ? 'allowed' : 'failed',
    );
    return NextResponse.json(
      { ...result, username, instance: instanceView(inst) },
      { status: result.ok ? 200 : 500 },
    );
  }

  return NextResponse.json(
    {
      error:
        'action must be "sync", "provision", "provision_all" or "prune" — Linux accounts are ' +
        'created with useradd, and the panel mirrors them automatically',
    },
    { status: 400 },
  );
}

export async function PATCH(req: Request) {
  const g = guard(req, 'users.manage');
  if (!g.ok) return g.response;
  const denial = await elevation(req, g.user);
  if (denial) return denial;

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

  if (body?.is_admin !== undefined) {
    return NextResponse.json(
      {
        error:
          'admin follows sudo on this server, so the panel cannot grant or revoke it — ' +
          'use `sudo usermod -aG sudo <user>` (or the equivalent on your distro)',
        admin_from_os: true,
      },
      { status: 409 },
    );
  }

  try {
    const user = updateUser(id, {
      permissions:
        body?.permissions !== undefined ? normalizePermissions(body.permissions) : undefined,
      enabled: body?.enabled,
    });
    if (!user) return NextResponse.json({ error: 'user not found' }, { status: 404 });
    audit(req, g.user, 'update user access', {
      username: user.username,
      enabled: user.enabled,
      permissions: body?.permissions !== undefined ? user.permissions : undefined,
    });
    return NextResponse.json({ ok: true, user: view(user), users: viewAll() });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'cannot update user' },
      { status: 400 },
    );
  }
}

function viewAll() {
  return listUsers().map(view);
}

function view(u: ReturnType<typeof listUsers>[number]) {
  return {
    ...u,
    instance: u.instance ? instanceView(u.instance) : null,

    sudo: { has_sudo: u.sudo.has_sudo, source: u.sudo.source, nopass_hint: u.sudo.nopass_hint },
  };
}
