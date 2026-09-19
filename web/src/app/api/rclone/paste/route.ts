import { NextResponse } from 'next/server';
import { parsePastedToken } from '@/lib/rclone';
import { getPath, mutateInstanceConfig, readInstanceConfig } from '@/lib/config';
import { guard } from '@/lib/auth';
import { pickInstance, pickInstanceForMutation, requireProvisioned } from '@/lib/routeutil';

export const runtime = 'nodejs';

function targetPath(target: string): string[] {
  return target === 'secondary' ? ['storage', 'secondary'] : ['google_drive'];
}

/**
 * Which OAuth client this instance will refresh its token with.
 *
 * The token must be issued for the SAME client: `drive.rs` only copies
 * `client_id`/`client_secret` into the rclone config when they are non-empty, so
 * a blank pair means rclone's built-in client. A token minted for one client is
 * rejected by the other once the one-hour access token expires, which makes the
 * mismatch show up long after authorization appeared to succeed — so the UI
 * shows the exact command to run. Only the client id is returned; it is public
 * (it appears in consent URLs) and never the secret.
 */
export async function GET(req: Request) {
  const g = guard(req, 'remote.auth');
  if (!g.ok) return g.response;

  const target =
    new URL(req.url).searchParams.get('target') === 'secondary' ? 'secondary' : 'primary';

  const picked = pickInstance(req, g.user);
  if (!picked.ok) return picked.response;
  const inst = picked.inst;

  const notReady = await requireProvisioned(inst);
  if (notReady) return notReady;

  const path = targetPath(target);
  try {
    const cfg = await readInstanceConfig(inst);
    const clientId = String(getPath(cfg, [...path, 'client_id'].join('.')) ?? '').trim();
    const clientSecret = String(getPath(cfg, [...path, 'client_secret'].join('.')) ?? '').trim();
    return NextResponse.json({
      target,
      client_id: clientId,
      has_client_secret: clientSecret.length > 0,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'cannot read config.yml' },
      { status: 500 },
    );
  }
}

/**
 * Remote-friendly auth: the browser is often on a different machine than the
 * panel, where rclone's 127.0.0.1 callback is unreachable. Users can run
 * `rclone authorize` on any machine that has a browser — including their own
 * laptop — and paste the resulting token here. The token is not tied to the OS
 * user or host that produced it, only to the Google account and the OAuth
 * client used.
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

  const picked = await pickInstanceForMutation(req, g.user, body);
  if (!picked.ok) return picked.response;
  const inst = picked.inst;

  const notReady = await requireProvisioned(inst);
  if (notReady) return notReady;

  const target = body?.target === 'secondary' ? 'secondary' : 'primary';
  const path = targetPath(target);

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

  return NextResponse.json({ ok: true, target });
}
