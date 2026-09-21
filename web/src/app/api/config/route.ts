import { NextResponse } from 'next/server';
import { mutateInstanceConfig, readInstanceConfig } from '@/lib/config';
import { coerce, CONFIG_KEYS, FIELD_BY_KEY } from '@/lib/schema';
import { guard } from '@/lib/auth';
import { instanceView, pickInstance, pickInstanceForMutation, requireProvisioned } from '@/lib/routeutil';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const g = guard(req, 'config.view');
  if (!g.ok) return g.response;

  const picked = pickInstance(req, g.user);
  if (!picked.ok) return picked.response;
  const inst = picked.inst;

  const notReady = await requireProvisioned(inst);
  if (notReady) return notReady;

  try {
    const cfg = await readInstanceConfig(inst);
    return NextResponse.json({ config: cfg, path: inst.configPath, instance: instanceView(inst) });
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

  const picked = await pickInstanceForMutation(req, g.user, body);
  if (!picked.ok) return picked.response;
  const inst = picked.inst;

  const notReady = await requireProvisioned(inst);
  if (notReady) return notReady;

  const updates: [string, unknown][] = [];
  const removals: string[] = [];
  for (const [key, value] of Object.entries(body.values)) {
    const field = FIELD_BY_KEY.get(key);
    if (!field || !CONFIG_KEYS.has(key)) {
      return NextResponse.json({ error: `not an editable config key: ${key}` }, { status: 400 });
    }
    const coerced = coerce(field, value);
    if (coerced === undefined) {
      if (key === 'backup.compression_level') removals.push(key);
      continue;
    }
    updates.push([key, coerced]);
  }

  try {
    await mutateInstanceConfig(inst, (doc) => {
      for (const [key, value] of updates) doc.setIn(key.split('.'), value);
      for (const key of removals) doc.deleteIn(key.split('.'));
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'cannot write config.yml' },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, updated: updates.map(([k]) => k) });
}
