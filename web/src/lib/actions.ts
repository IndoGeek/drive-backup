import { NextResponse } from 'next/server';
import { guard } from './auth';
import { pickInstanceForMutation, requireProvisioned } from './routeutil';
import { binaryPath } from './panel';
import { encryptionState, restoreUnlocked } from './restoregate';
import type { Instance } from './instance';
import type { Permission } from './permissions';

export type ActionOptions = {
  world?: boolean;
  noPtero?: boolean;
  force?: boolean;
  dryRun?: boolean;
  merge?: boolean;
  user?: string;
  file?: string;
  target?: string;
};

const SIMPLE: Record<string, string[]> = {
  'test-compress': ['test-compress'],
  'restore-list': ['restore'],
  reset: ['reset'],
};

export function buildArgs(
  action: string,
  opts: ActionOptions,
  defaultUser?: string,
): string[] | null {
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
      if (opts.merge) args.push('--merge');
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
      const user = opts.user ?? defaultUser;
      if (user) args.push('--user', String(user));
      return args;
    }
    default:
      return SIMPLE[action] ?? null;
  }
}

const LABELS: Record<string, string> = {
  run: 'Run',
  check: 'Integrity check',
  'test-compress': 'Test compression',
  'restore-list': 'List backups',
  restore: 'Restore',
  'fix-perms': 'Fix permissions',
  reset: 'Reset state',
};

export function labelFor(action: string, opts: ActionOptions = {}): string {
  if (action === 'run' && opts.dryRun) return 'Dry run';
  if (action === 'run' && opts.world) return 'World backup';
  return LABELS[action] ?? action;
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

export function timeoutFor(action: string): number {
  return action === 'run' ? 1000 * 60 * 60 * 2 : 1000 * 60 * 30;
}

export type Prepared =
  | { ok: true; inst: Instance; args: string[]; command: string; timeout: number; label: string }
  | { ok: false; response: NextResponse };

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

  if (body.action === 'restore') {
    const encryption = await encryptionState(inst);
    if (encryption.enabled && encryption.has_passphrase && !restoreUnlocked(req, g.user.username, inst.root)) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: `'${inst.osUser}' encrypts its archives — confirm the encryption passphrase to restore one`,
            passphrase_required: true,
            encryption,
          },
          { status: 428 },
        ),
      };
    }
  }

  const args = buildArgs(body.action, body.options ?? {}, inst.osUser);
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
    label: labelFor(body.action, body.options ?? {}),
  };
}
