import { NextResponse } from 'next/server';
import { historyForInstance } from '@/lib/db';
import { getPath, readInstanceConfig, resolveInInstance } from '@/lib/config';
import { guard } from '@/lib/auth';
import { instanceView, pickInstance, requireProvisioned } from '@/lib/routeutil';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const g = guard(req, 'dashboard.view');
  if (!g.ok) return g.response;

  const picked = pickInstance(req, g.user);
  if (!picked.ok) return picked.response;
  const inst = picked.inst;

  const notReady = await requireProvisioned(inst);
  if (notReady) return notReady;

  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 500);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);

  let dbPath: string;
  try {
    const cfg = await readInstanceConfig(inst);
    const rel = getPath(cfg, 'database.file');
    dbPath = resolveInInstance(inst, typeof rel === 'string' && rel ? rel : './history.db');
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'cannot read config.yml' },
      { status: 500 },
    );
  }

  const page = await historyForInstance(inst, dbPath, limit, offset);
  return NextResponse.json({
    runs: page.runs,
    // Paging needs a total; the panel must not have to guess whether another
    // page exists from a short page alone.
    total: page.total,
    limit,
    offset,
    database: dbPath,
    instance: instanceView(inst),
  });
}
