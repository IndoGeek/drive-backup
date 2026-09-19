import { NextResponse } from 'next/server';
import { createB2Remote } from '@/lib/rclone';
import { mutateInstanceConfig, readInstanceConfig } from '@/lib/config';
import { guard } from '@/lib/auth';
import { pickInstanceForMutation, requireProvisioned } from '@/lib/routeutil';

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

  const picked = await pickInstanceForMutation(req, g.user, body);
  if (!picked.ok) return picked.response;
  const inst = picked.inst;

  const notReady = await requireProvisioned(inst);
  if (notReady) return notReady;

  const res = await createB2Remote(inst, { remote, account, key });
  if (!res.ok) {
    return NextResponse.json(
      { error: 'rclone config create failed', output: res.output },
      { status: 502 },
    );
  }

  let dir = 'backup';
  let retention = 3;
  try {
    const cfg = await readInstanceConfig(inst);
    const storage = cfg.storage as Record<string, unknown> | undefined;
    const secondary = storage?.secondary as Record<string, unknown> | undefined;
    if (secondary && typeof secondary.dir === 'string' && secondary.dir) dir = secondary.dir;
    if (secondary && typeof secondary.retention === 'number') retention = secondary.retention;
  } catch {
  }

  try {
    await mutateInstanceConfig(inst, (doc) => {
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
