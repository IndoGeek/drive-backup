import { NextResponse } from 'next/server';
import { guard } from '@/lib/auth';
import { authorizeSudo, clearSessionGrant, sudoStatus } from '@/lib/sudo';

export const runtime = 'nodejs';

export async function GET(req: Request) {
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
