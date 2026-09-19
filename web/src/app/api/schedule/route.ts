import { NextResponse } from 'next/server';
import { mutateConfig } from '@/lib/config';
import { coerce, SCHEDULE_FIELDS, SCHEDULE_KEYS } from '@/lib/schema';
import { guard } from '@/lib/auth';

export const runtime = 'nodejs';

const SCHEDULE_FIELD_BY_KEY = new Map(SCHEDULE_FIELDS.map((f) => [f.key, f]));

export async function PUT(req: Request) {
  const g = guard(req, 'backup.schedule');
  if (!g.ok) return g.response;

  let body: { values?: Record<string, unknown> } | null = null;
  try {
    body = (await req.json()) as { values?: Record<string, unknown> };
  } catch {
    body = null;
  }
  if (!body?.values) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const updates: [string, unknown][] = [];
  for (const [key, value] of Object.entries(body.values)) {
    const field = SCHEDULE_FIELD_BY_KEY.get(key);
    if (!field || !SCHEDULE_KEYS.has(key)) {
      return NextResponse.json({ error: `not a schedule key: ${key}` }, { status: 400 });
    }
    const coerced = coerce(field, value);
    if (coerced === undefined) continue;
    updates.push([key, coerced]);
  }

  try {
    await mutateConfig((doc) => {
      for (const [key, value] of updates) doc.setIn(key.split('.'), value);
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'cannot write config.yml' },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, updated: updates.map(([k]) => k) });
}
