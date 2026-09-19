import { NextResponse } from 'next/server';
import { cancelAuth } from '@/lib/rclone';
import { guard } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const g = guard(req, 'remote.auth');
  if (!g.ok) return g.response;

  let body: { id?: string } | null = null;
  try {
    body = (await req.json()) as { id?: string };
  } catch {
    body = null;
  }
  if (!body?.id) return NextResponse.json({ error: 'missing id' }, { status: 400 });
  return NextResponse.json({ ok: cancelAuth(body.id) });
}
