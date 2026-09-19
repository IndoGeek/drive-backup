import { NextResponse } from 'next/server';
import { daemonAction, daemonStatus, type DaemonAction } from '@/lib/pm2';
import { daemonBinaryCheck } from '@/lib/binary';
import { binary } from '@/lib/env';
import { guard } from '@/lib/auth';

export const runtime = 'nodejs';

const ACTIONS: DaemonAction[] = ['start', 'stop', 'restart', 'save'];

export async function GET(req: Request) {
  const g = guard(req, 'dashboard.view');
  if (!g.ok) return g.response;
  const status = await daemonStatus();
  // Flag a daemon that is still running a binary since replaced on disk.
  return NextResponse.json({ ...status, binary: daemonBinaryCheck(status.pid, binary()) });
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

  const res = await daemonAction(action);
  const status = await daemonStatus();
  return NextResponse.json({
    ok: res.ok,
    code: res.code,
    output: (res.stdout + res.stderr).trim().slice(-4000),
    status,
  });
}
