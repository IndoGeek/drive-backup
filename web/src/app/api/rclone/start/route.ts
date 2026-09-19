import { NextResponse } from 'next/server';
import { startAuth, type AuthMethod } from '@/lib/rclone';
import { guard } from '@/lib/auth';
import { pickInstanceForMutation, requireProvisioned } from '@/lib/routeutil';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const g = guard(req, 'remote.auth');
  if (!g.ok) return g.response;

  let body: { method?: string; clientId?: string; clientSecret?: string } | null = null;
  try {
    body = (await req.json()) as { method?: string; clientId?: string; clientSecret?: string };
  } catch {
    body = null;
  }

  const method: AuthMethod = body?.method === 'client' ? 'client' : 'browser';
  if (method === 'client' && !body?.clientId?.trim()) {
    return NextResponse.json(
      { error: 'client-id is required for the client-id/secret method' },
      { status: 400 },
    );
  }

  const picked = await pickInstanceForMutation(req, g.user, body);
  if (!picked.ok) return picked.response;
  const inst = picked.inst;

  const notReady = await requireProvisioned(inst);
  if (notReady) return notReady;

  try {
    // rclone runs as this instance's user, so the browser callback and the token it
    // writes belong to that account's instance.
    const job = startAuth(inst, {
      method,
      clientId: body?.clientId?.trim() || undefined,
      clientSecret: body?.clientSecret?.trim() || undefined,
    });
    return NextResponse.json(job);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'cannot start rclone authorize' },
      { status: 500 },
    );
  }
}
