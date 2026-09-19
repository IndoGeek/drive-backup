import { NextResponse } from 'next/server';
import { runCli } from '@/lib/cli';
import { guard } from '@/lib/auth';
import type { Permission } from '@/lib/permissions';

export const runtime = 'nodejs';

type Options = {
  world?: boolean;
  noPtero?: boolean;
  force?: boolean;
  dryRun?: boolean;
  user?: string;
  file?: string;
  target?: string;
};

const SIMPLE: Record<string, string[]> = {
  'test-compress': ['test-compress'],
  'restore-list': ['restore'],
  reset: ['reset'],
};

function buildArgs(action: string, opts: Options): string[] | null {
  switch (action) {
    case 'run': {
      const args = ['run'];
      if (opts.world) args.push('--world');
      if (opts.dryRun) args.push('--dry-run');
      if (opts.noPtero) args.push('--no-ptero');
      if (opts.force) args.push('--force');
      return args;
    }
    case 'restore': {
      if (!opts.file) return null;
      const args = ['restore'];
      if (opts.force) args.push('--force');
      args.push(String(opts.file));
      if (opts.target) args.push(String(opts.target));
      return args;
    }
    case 'check': {
      const args = ['check'];
      if (opts.file) args.push(String(opts.file));
      return args;
    }
    case 'fix-perms': {
      const args = ['fix-perms'];
      if (opts.user) args.push('--user', String(opts.user));
      return args;
    }
    default:
      return SIMPLE[action] ?? null;
  }
}

function permissionFor(action: string): Permission {
  switch (action) {
    case 'check':
      return 'backup.check';
    case 'restore':
    case 'restore-list':
      return 'backup.restore';
    case 'fix-perms':
      return 'backup.fix_perms';
    default:
      return 'backup.run';
  }
}

export async function POST(req: Request) {
  let body: { action?: string; options?: Options } | null = null;
  try {
    body = (await req.json()) as { action?: string; options?: Options };
  } catch {
    body = null;
  }
  if (!body?.action) {
    return NextResponse.json({ error: 'missing action' }, { status: 400 });
  }

  const g = guard(req, permissionFor(body.action));
  if (!g.ok) return g.response;

  const args = buildArgs(body.action, body.options ?? {});
  if (!args) {
    return NextResponse.json(
      { error: `unknown or incomplete action: ${body.action}` },
      { status: 400 },
    );
  }

  const timeout = body.action === 'run' ? 1000 * 60 * 60 * 2 : 1000 * 60 * 30;
  const res = await runCli(args, timeout);

  return NextResponse.json({
    ok: res.ok,
    code: res.code,
    command: res.command,
    output: (res.stdout + (res.stderr ? `\n${res.stderr}` : '')).slice(-100_000),
  });
}
