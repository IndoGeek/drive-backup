import { NextResponse } from 'next/server';
import { getAuthJob } from '@/lib/rclone';
import { guard } from '@/lib/auth';
import { pickInstance } from '@/lib/routeutil';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const g = guard(req, 'remote.auth');
  if (!g.ok) return g.response;

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 });

  const picked = pickInstance(req, g.user);
  const owner = picked.ok ? picked.inst.osUser : g.user.username;

  const job = getAuthJob(id, owner);
  if (!job) return NextResponse.json({ error: 'unknown job' }, { status: 404 });
  return NextResponse.json(job);
}
