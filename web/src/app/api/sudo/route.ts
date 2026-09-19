import { NextResponse } from 'next/server';
import { guard } from '@/lib/auth';
import { authorizeSudo, clearSessionGrant, sudoStatus } from '@/lib/sudo';

export const runtime = 'nodejs';

/**
 * Elevation for the signed-in user, mirroring how sudo behaves on the server.
 *
 *  - `GET`    — can this account use sudo, does it need a password, and until when
 *               is the current elevation good for?
 *  - `POST`   — verify the sudo password once and open a grant for this session.
 *               Privileged routes then stop asking until it lapses.
 *  - `DELETE` — end it now, the equivalent of `sudo -k`.
 *
 * The password is verified against the account's real Linux hash and kept **in
 * this process's memory, scoped to this login** until it lapses. It is never
 * written to disk and never logged. Signing out drops it (see the logout route).
 */
export async function GET(req: Request) {
  // Any signed-in user may ask about their own elevation; elevation is only ever
  // granted to the account making the request, never to someone named in a body.
  const g = guard(req, 'dashboard.view');
  if (!g.ok) return g.response;
  return NextResponse.json({ sudo: await sudoStatus(req, g.user.username) });
}

export async function POST(req: Request) {
  const g = guard(req, 'dashboard.view');
  if (!g.ok) return g.response;

  let body: { password?: unknown } | null = null;
  try {
    body = (await req.json()) as { password?: unknown };
  } catch {
    body = null;
  }
  const password = typeof body?.password === 'string' ? body.password : '';

  const result = await authorizeSudo(req, g.user, password);
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        sudo_required: true,
        // Distinguishes "you may not elevate at all" from "that password was wrong".
        ...(result.status === 403 ? { sudo_denied: true } : {}),
      },
      {
        status: result.status,
        ...(result.retry_after ? { headers: { 'Retry-After': String(result.retry_after) } } : {}),
      },
    );
  }
  return NextResponse.json({
    ok: true,
    elevated_until: result.elevated_until,
    timeout_ms: result.timeout_ms,
    sudo: await sudoStatus(req, g.user.username),
  });
}

export async function DELETE(req: Request) {
  const g = guard(req, 'dashboard.view');
  if (!g.ok) return g.response;
  clearSessionGrant(req, g.user.username, 'requested');
  return NextResponse.json({ ok: true, sudo: await sudoStatus(req, g.user.username) });
}
