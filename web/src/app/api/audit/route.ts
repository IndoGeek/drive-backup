import { NextResponse } from 'next/server';
import { guard } from '@/lib/auth';
import { auditDetail, listAudit, type AuditOutcome } from '@/lib/audit';

export const runtime = 'nodejs';

const OUTCOMES: AuditOutcome[] = [
  'elevated',
  'elevation_ended',
  'prompted',
  'denied',
  'allowed',
  'failed',
];

/**
 * The privileged-action trail: who elevated, what changed, and when.
 *
 * Admin-only (`users.manage`), because it covers every account's actions. It is a
 * read, so — like every other read in the panel — it does not itself need sudo.
 */
export async function GET(req: Request) {
  const g = guard(req, 'users.manage');
  if (!g.ok) return g.response;

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit') ?? '200');
  const outcomeParam = url.searchParams.get('outcome');
  const outcome = OUTCOMES.find((o) => o === outcomeParam);

  const { entries, total } = listAudit({
    limit,
    username: url.searchParams.get('user') ?? undefined,
    outcome,
  });

  return NextResponse.json({
    entries: entries.map((e) => ({ ...e, detail: auditDetail(e) })),
    total,
  });
}
