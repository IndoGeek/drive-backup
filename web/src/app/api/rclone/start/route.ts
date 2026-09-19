import { NextResponse } from 'next/server';
import { startAuth, type AuthMethod } from '@/lib/rclone';
import { guard } from '@/lib/auth';

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

  try {
    const job = startAuth({
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
