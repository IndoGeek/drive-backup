import { NextResponse } from 'next/server';
import { guard } from '@/lib/auth';
import { pickInstance, requireProvisioned } from '@/lib/routeutil';
import { clearRestoreGrants, encryptionState, restoreUnlockUntil, unlockRestore } from '@/lib/restoregate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const g = guard(req, 'backup.restore');
  if (!g.ok) return g.response;

  const picked = pickInstance(req, g.user);
  if (!picked.ok) return picked.response;
  const inst = picked.inst;

  const notReady = await requireProvisioned(inst);
  if (notReady) return notReady;

  const encryption = await encryptionState(inst);
  return NextResponse.json({
    encryption,
    unlocked_until: restoreUnlockUntil(req, g.user.username, inst.root),
  });
}

export async function POST(req: Request) {
  const g = guard(req, 'backup.restore');
  if (!g.ok) return g.response;

  const picked = pickInstance(req, g.user);
  if (!picked.ok) return picked.response;
  const inst = picked.inst;

  const notReady = await requireProvisioned(inst);
  if (notReady) return notReady;

  let body: { passphrase?: string } | null = null;
  try {
    body = (await req.json()) as { passphrase?: string };
  } catch {
    body = null;
  }

  const result = await unlockRestore(req, g.user, inst, body?.passphrase ?? '');
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({
    ok: true,
    required: result.required,
    unlocked_until: result.until,
    timeout_ms: result.timeout_ms,
  });
}

export async function DELETE(req: Request) {
  const g = guard(req, 'backup.restore');
  if (!g.ok) return g.response;

  const cleared = clearRestoreGrants(req, g.user.username, 'requested');
  return NextResponse.json({ ok: true, cleared });
}
