import { NextResponse } from 'next/server';
import { guard } from '@/lib/auth';
import { pickInstanceForMutation, requireProvisioned } from '@/lib/routeutil';
import { currentAction, stopAction } from '@/lib/action-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const g = guard(req, 'backup.run');
  if (!g.ok) return g.response;

  const picked = await pickInstanceForMutation(req, g.user, null);
  if (!picked.ok) return picked.response;
  const inst = picked.inst;

  const notReady = await requireProvisioned(inst);
  if (notReady) return notReady;

  const action = currentAction(inst.root);
  if (!action) {
    return NextResponse.json({ ok: true, stopped: false, reason: 'nothing running' }, { status: 200 });
  }

  const stopped = stopAction(inst.root);
  return NextResponse.json({
    ok: true,
    stopped,
    status: action.status,
    id: action.id,
  });
}