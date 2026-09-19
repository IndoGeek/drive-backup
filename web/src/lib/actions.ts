import { NextResponse } from 'next/server';
import { guard } from './auth';
import { pickInstanceForMutation, requireProvisioned } from './routeutil';
import { binaryPath } from './panel';
import type { Instance } from './instance';
import type { Permission } from './permissions';

/**
 * The actions the Dashboard can run, in one place.
 *
 * Both routes that run them share this — `/api/actions` collects the output and
 * returns it in one piece, `/api/actions/stream` streams it as it happens — so the
 * two can never disagree about what an action means, which permission it needs,
 * or how long it may take.
 */

export type ActionOptions = {
  world?: boolean;
  noPtero?: boolean;
  force?: boolean;
  dryRun?: boolean;
  user?: string;
  file?: string;
  target?: string;
};

/** Actions whose arguments come straight from a lookup — no flags to build. */
const SIMPLE: Record<string, string[]> = {
  'test-compress': ['test-compress'],
  'restore-list': ['restore'],
  reset: ['reset'],
};

export function buildArgs(action: string, opts: ActionOptions): string[] | null {
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

export function permissionFor(action: string): Permission {
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

/** A full backup of a large source can take a long time; checks and lists do not. */
export function timeoutFor(action: string): number {
  return action === 'run' ? 1000 * 60 * 60 * 2 : 1000 * 60 * 30;
}

export type Prepared =
  | { ok: true; inst: Instance; args: string[]; command: string; timeout: number }
  | { ok: false; response: NextResponse };

/**
 * Authenticate, authorize, resolve the instance and translate the action into an
 * argv — everything a caller must do before running anything.
 *
 * The `--config` flag is added here so a streamed command is complete: the caller
 * sees the exact line that ran, and it can be pasted into a shell to reproduce.
 */
export async function prepareAction(
  req: Request,
  body: { action?: string; options?: ActionOptions } | null,
): Promise<Prepared> {
  if (!body?.action) {
    return { ok: false, response: NextResponse.json({ error: 'missing action' }, { status: 400 }) };
  }

  const g = guard(req, permissionFor(body.action));
  if (!g.ok) return { ok: false, response: g.response };

  const picked = await pickInstanceForMutation(req, g.user, body);
  if (!picked.ok) return { ok: false, response: picked.response };
  const inst = picked.inst;

  const notReady = await requireProvisioned(inst);
  if (notReady) return { ok: false, response: notReady };

  const args = buildArgs(body.action, body.options ?? {});
  if (!args) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `unknown or incomplete action: ${body.action}` },
        { status: 400 },
      ),
    };
  }

  const bin = binaryPath();
  return {
    ok: true,
    inst,
    args,
    command: `${bin} ${[...args, '--config', inst.configPath].join(' ')}`,
    timeout: timeoutFor(body.action),
  };
}
