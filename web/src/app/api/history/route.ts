import { NextResponse } from 'next/server';
import { history } from '@/lib/db';
import { getPath, readConfig, resolveInConfig } from '@/lib/config';
import { guard } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const g = guard(req, 'dashboard.view');
  if (!g.ok) return g.response;

  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 500);

  let dbPath = '';
  try {
    const cfg = await readConfig();
    const rel = getPath(cfg, 'database.file');
    dbPath = resolveInConfig(typeof rel === 'string' && rel ? rel : './history.db');
  } catch {
    return NextResponse.json({ error: 'cannot read config.yml' }, { status: 500 });
  }

  return NextResponse.json({ runs: history(dbPath, limit), database: dbPath });
}
