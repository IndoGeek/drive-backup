import { NextResponse } from 'next/server';
import { parsePastedToken } from '@/lib/rclone';
import { mutateConfig } from '@/lib/config';
import { guard } from '@/lib/auth';

export const runtime = 'nodejs';

/**
 * Remote-friendly auth: the browser is often on a different machine than the
 * panel, where rclone's 127.0.0.1 callback is unreachable. Users can run
 * `rclone authorize drive` locally and paste the resulting token here.
 */
export async function POST(req: Request) {
  const g = guard(req, 'remote.auth');
  if (!g.ok) return g.response;

  let body: { target?: string; token?: string } | null = null;
  try {
    body = (await req.json()) as { target?: string; token?: string };
  } catch {
    body = null;
  }

  const target = body?.target === 'secondary' ? 'secondary' : 'primary';
  const path = target === 'secondary' ? ['storage', 'secondary'] : ['google_drive'];

  const token = parsePastedToken(String(body?.token ?? ''));
  if (!token) {
    return NextResponse.json(
      { error: 'could not find a token in the pasted text' },
      { status: 400 },
    );
  }

  const refresh = String(token.refresh_token ?? '');
  const access = String(token.access_token ?? '');
  const expiry = String(token.expiry ?? '');
  if (!access) {
    return NextResponse.json({ error: 'token is missing access_token' }, { status: 400 });
  }
  if (!refresh) {
    return NextResponse.json(
      {
        error:
          'token is missing refresh_token. Re-run `rclone authorize` and make sure offline access is granted.',
      },
      { status: 400 },
    );
  }

  try {
    await mutateConfig((doc) => {
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

  return NextResponse.json({ ok: true, target });
}
