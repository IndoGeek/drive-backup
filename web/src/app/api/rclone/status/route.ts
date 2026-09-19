import { NextResponse } from 'next/server';
import { getAuthJob } from '@/lib/rclone';
import { guard } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const g = guard(req, 'remote.auth');
  if (!g.ok) return g.response;

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 });
  const job = getAuthJob(id);
  if (!job) return NextResponse.json({ error: 'unknown job' }, { status: 404 });
  return NextResponse.json(job);
}
