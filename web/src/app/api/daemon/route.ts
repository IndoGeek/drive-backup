import { NextResponse } from 'next/server';
import { daemonAction, daemonStatus, type DaemonAction } from '@/lib/pm2';
import { daemonBinaryCheck } from '@/lib/binary';
import { binaryPath } from '@/lib/panel';
import { guard } from '@/lib/auth';
import { instanceView, pickInstance, pickInstanceForMutation } from '@/lib/routeutil';

export const runtime = 'nodejs';

const ACTIONS: DaemonAction[] = ['start', 'stop', 'restart', 'save'];

export async function GET(req: Request) {
  const g = guard(req, 'dashboard.view');
  if (!g.ok) return g.response;

  const picked = pickInstance(req, g.user);
  if (!picked.ok) return picked.response;
  const inst = picked.inst;

  const status = await daemonStatus(inst);
  // Each instance has its own pm2 daemon and app name, so this reports — and can
  // only affect — the caller's own backups.
  return NextResponse.json({
    ...status,
    instance: instanceView(inst),
    binary: daemonBinaryCheck(status.pid, binaryPath()),
  });
}

export async function POST(req: Request) {
  const g = guard(req, 'daemon.control');
  if (!g.ok) return g.response;

  let body: { action?: string } | null = null;
  try {
    body = (await req.json()) as { action?: string };
  } catch {
    body = null;
  }
  const action = body?.action as DaemonAction | undefined;
  if (!action || !ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: `action must be one of: ${ACTIONS.join(', ')}` },
      { status: 400 },
    );
  }

  const picked = await pickInstanceForMutation(req, g.user, body);
  if (!picked.ok) return picked.response;
  const inst = picked.inst;

  const res = await daemonAction(inst, action);
  const status = await daemonStatus(inst);
  return NextResponse.json({
    ok: res.ok,
    code: res.code,
    output: (res.stdout + res.stderr).trim().slice(-4000),
    status,
  });
}
