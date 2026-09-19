import { NextResponse } from 'next/server';
import { mutateConfig, readConfig } from '@/lib/config';
import { coerce, CONFIG_KEYS, FIELD_BY_KEY } from '@/lib/schema';
import { configPath } from '@/lib/env';
import { guard } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const g = guard(req, 'config.view');
  if (!g.ok) return g.response;
  try {
    const cfg = await readConfig();
    return NextResponse.json({ config: cfg, path: configPath() });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'cannot read config.yml' },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  const g = guard(req, 'config.edit');
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
    const field = FIELD_BY_KEY.get(key);
    if (!field || !CONFIG_KEYS.has(key)) {
      return NextResponse.json({ error: `not an editable config key: ${key}` }, { status: 400 });
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
