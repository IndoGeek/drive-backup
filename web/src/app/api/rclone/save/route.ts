import { NextResponse } from 'next/server';
import { getAuthToken } from '@/lib/rclone';
import { mutateInstanceConfig } from '@/lib/config';
import { guard } from '@/lib/auth';
import { pickInstanceForMutation, requireProvisioned } from '@/lib/routeutil';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const g = guard(req, 'remote.auth');
  if (!g.ok) return g.response;

  let body: { id?: string; target?: string } | null = null;
  try {
    body = (await req.json()) as { id?: string; target?: string };
  } catch {
    body = null;
  }
  if (!body?.id) return NextResponse.json({ error: 'missing job id' }, { status: 400 });

  const picked = await pickInstanceForMutation(req, g.user, body);
  if (!picked.ok) return picked.response;
  const inst = picked.inst;

  const notReady = await requireProvisioned(inst);
  if (notReady) return notReady;

  const target = body.target === 'secondary' ? 'secondary' : 'primary';
  const path = target === 'secondary' ? ['storage', 'secondary'] : ['google_drive'];

  const token = getAuthToken(body.id, inst.osUser);
  if (!token) {
    return NextResponse.json(
      { error: 'no completed token for this job (has authorization finished?)' },
      { status: 400 },
    );
  }

  const refresh = String(token.refresh_token ?? '');
  const access = String(token.access_token ?? '');
  const expiry = String(token.expiry ?? '');

  if (!refresh) {
    return NextResponse.json(
      { error: 'token has no refresh_token; re-run authorization' },
      { status: 400 },
    );
  }

  try {
    // Written into this instance's config.yml, as its owner, mode 0600.
    await mutateInstanceConfig(inst, (doc) => {
      doc.setIn([...path, 'refresh_token'], refresh);
      doc.setIn([...path, 'access_token'], access);
      doc.setIn([...path, 'expiry'], expiry);
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'cannot write config.yml' },
      { status: 500 },
    );
  }

  // Do not echo the token back to the client.
  return NextResponse.json({
    ok: true,
    target,
    saved: [
      `${path.join('.')}.refresh_token`,
      `${path.join('.')}.access_token`,
      `${path.join('.')}.expiry`,
    ],
  });
}
