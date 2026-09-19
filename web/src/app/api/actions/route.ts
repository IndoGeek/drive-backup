import { NextResponse } from 'next/server';
import { runCli } from '@/lib/cli';
import { prepareAction, type ActionOptions } from '@/lib/actions';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let body: { action?: string; options?: ActionOptions } | null = null;
  try {
    body = (await req.json()) as { action?: string; options?: ActionOptions };
  } catch {
    body = null;
  }

  const prepared = await prepareAction(req, body);
  if (!prepared.ok) return prepared.response;

  const res = await runCli(prepared.inst, prepared.args, prepared.timeout);
  return NextResponse.json({
    ok: res.ok,
    code: res.code,
    command: res.command,
    output: (res.stdout + (res.stderr ? `\n${res.stderr}` : '')).slice(-100_000),
  });
}
