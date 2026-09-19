import { NextResponse } from 'next/server';
import { mutateInstanceConfig } from '@/lib/config';
import {
  coerce,
  normalizeTime,
  SCHEDULE_FIELDS,
  SCHEDULE_KEYS,
  validateScheduleValue,
} from '@/lib/schema';
import { guard } from '@/lib/auth';
import { pickInstanceForMutation, requireProvisioned } from '@/lib/routeutil';

export const runtime = 'nodejs';

const SCHEDULE_FIELD_BY_KEY = new Map(SCHEDULE_FIELDS.map((f) => [f.key, f]));

function normalizeScheduleValue(key: string, value: unknown): unknown {
  if (key === 'backup.time') return normalizeTime(value) ?? value;
  if (key === 'backup.times') {
    const list = Array.isArray(value) ? value : [];
    const times = list
      .map((entry) => normalizeTime(entry))
      .filter((t): t is string => t !== null);
    return [...new Set(times)].sort();
  }
  return value;
}

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

  const picked = await pickInstanceForMutation(req, g.user, body);
  if (!picked.ok) return picked.response;
  const inst = picked.inst;

  const notReady = await requireProvisioned(inst);
  if (notReady) return notReady;

  const updates: [string, unknown][] = [];
  for (const [key, value] of Object.entries(body.values)) {
    const field = SCHEDULE_FIELD_BY_KEY.get(key);
    if (!field || !SCHEDULE_KEYS.has(key)) {
      return NextResponse.json({ error: `not a schedule key: ${key}` }, { status: 400 });
    }
    const invalid = validateScheduleValue(key, value);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
    const coerced = coerce(field, value);
    if (coerced === undefined) continue;
    updates.push([key, normalizeScheduleValue(key, coerced)]);
  }

  try {
    await mutateInstanceConfig(inst, (doc) => {
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
