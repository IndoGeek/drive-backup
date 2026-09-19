import { NextResponse } from 'next/server';
import { createB2Remote } from '@/lib/rclone';
import { mutateConfig, readConfig } from '@/lib/config';
import { guard } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const g = guard(req, 'remote.auth');
  if (!g.ok) return g.response;

  let body: { remote?: string; account?: string; key?: string } | null = null;
  try {
    body = (await req.json()) as { remote?: string; account?: string; key?: string };
  } catch {
    body = null;
  }

  const remote = body?.remote?.trim();
  const account = body?.account?.trim();
  const key = body?.key?.trim();
  if (!remote || !account || !key) {
    return NextResponse.json(
      { error: 'remote, account and key are all required' },
      { status: 400 },
    );
  }

  const res = await createB2Remote({ remote, account, key });
  if (!res.ok) {
    return NextResponse.json(
      { error: 'rclone config create failed', output: res.output },
      { status: 502 },
    );
  }

  // backup-mgr requires secondary.dir and secondary.retention to parse the
  // config, so carry over the existing values (or sensible defaults) instead of
  // writing a partial section.
  let dir = 'backup';
  let retention = 3;
  try {
    const cfg = await readConfig();
    const storage = cfg.storage as Record<string, unknown> | undefined;
    const secondary = storage?.secondary as Record<string, unknown> | undefined;
    if (secondary && typeof secondary.dir === 'string' && secondary.dir) dir = secondary.dir;
    if (secondary && typeof secondary.retention === 'number') retention = secondary.retention;
  } catch {
    // config missing/partial: defaults are fine
  }

  try {
    await mutateConfig((doc) => {
      doc.setIn(['storage', 'secondary', 'remote'], remote);
      doc.setIn(['storage', 'secondary', 'enabled'], true);
      doc.setIn(['storage', 'secondary', 'dir'], dir);
      doc.setIn(['storage', 'secondary', 'retention'], retention);
    });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error ? e.message : 'created the remote but could not update config.yml',
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, remote, output: res.output.slice(-2000) });
}
