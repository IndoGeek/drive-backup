import { NextResponse } from 'next/server';
import {
  backupLogDir,
  findLogSource,
  listLogs,
  listLogSources,
  logSourceDefs,
  readLog,
} from '@/lib/logs';
import { guard } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const g = guard(req, 'logs.view');
  if (!g.ok) return g.response;

  let defs;
  try {
    defs = logSourceDefs(await backupLogDir());
  } catch {
    return NextResponse.json({ error: 'cannot read config.yml' }, { status: 500 });
  }

  const url = new URL(req.url);
  const sourceId = url.searchParams.get('source');
  const file = url.searchParams.get('file');

  // No source given: hand back every kind of log with its files, so the Logs
  // page needs a single request to render all its tabs.
  if (!sourceId) {
    return NextResponse.json({ sources: await listLogSources(defs) });
  }

  const def = findLogSource(defs, sourceId);
  if (!def) {
    return NextResponse.json({ error: `unknown log source '${sourceId}'` }, { status: 400 });
  }

  if (!file) {
    return NextResponse.json({
      source: def.id,
      dir: def.dir,
      files: await listLogs(def.dir, def.match),
    });
  }

  try {
    const content = await readLog(def.dir, file);
    return NextResponse.json({ source: def.id, dir: def.dir, file, content });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'cannot read log' },
      { status: 404 },
    );
  }
}
