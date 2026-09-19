import { NextResponse } from 'next/server';
import { backupLogDir, findLogSource, listLogSources, logSourceDefs, readLog } from '@/lib/logs';
import { guard } from '@/lib/auth';
import { instanceView, pickInstance } from '@/lib/routeutil';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const g = guard(req, 'logs.view');
  if (!g.ok) return g.response;

  const picked = pickInstance(req, g.user);
  if (!picked.ok) return picked.response;
  const inst = picked.inst;

  // Not provisioned is fine here: backupLogDir falls back to the conventional
  // location and simply reports no backup logs yet.
  const defs = logSourceDefs(inst, await backupLogDir(inst));

  const url = new URL(req.url);
  const sourceId = url.searchParams.get('source');
  const file = url.searchParams.get('file');

  // No source given: hand back every kind of log with its files, so the Logs
  // page needs a single request to render all its tabs.
  if (!sourceId) {
    return NextResponse.json({
      sources: await listLogSources(inst, defs),
      instance: instanceView(inst),
    });
  }

  const def = findLogSource(defs, sourceId);
  if (!def) {
    return NextResponse.json({ error: `unknown log source '${sourceId}'` }, { status: 400 });
  }

  if (!file) {
    const [{ files }] = await listLogSources(inst, [def]);
    return NextResponse.json({ source: def.id, dir: def.dir, files });
  }

  const content = await readLog(inst, def, file);
  if (content === null) {
    return NextResponse.json({ error: `cannot read ${file}` }, { status: 404 });
  }
  return NextResponse.json({ source: def.id, dir: def.dir, file, content });
}
