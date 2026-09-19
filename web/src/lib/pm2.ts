import path from 'node:path';
import { existsAs, runAs, type Instance } from './instance';
import { pm2Path } from './panel';

/**
 * Each user gets their own pm2 daemon, selected by PM2_HOME (see
 * instance.pm2Home) and run as their own account. That is what makes `pm2
 * restart` in one user's panel touch only their own app — there is no shared
 * process table to fight over, and no user can stop someone else's backups.
 */

export type Pm2Result = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
};

function pm2(inst: Instance, args: string[], timeoutMs = 30_000): Promise<Pm2Result> {
  return runAs(inst, pm2Path(), args, { timeoutMs, maxBuffer: 8 * 1024 * 1024 });
}

export type DaemonStatus = {
  available: boolean;
  name: string;
  /** pm2 status: online | stopped | errored | not-managed */
  state?: string;
  pid?: number;
  restarts?: number;
  uptime?: number;
  memory?: number;
  /** The instance has no generated ecosystem file yet. */
  provisioned: boolean;
  error?: string;
};

function pm2Env(app: Record<string, unknown>): Record<string, unknown> {
  return (app.pm2_env ?? {}) as Record<string, unknown>;
}

export async function daemonStatus(inst: Instance): Promise<DaemonStatus> {
  const ecosystem = path.join(inst.root, 'ecosystem.config.cjs');
  const provisioned = await existsAs(inst, ecosystem);
  const res = await pm2(inst, ['jlist']);
  const base = { name: inst.pm2Name, provisioned };

  if (!res.ok) {
    // A missing pm2 for this account is reported as an error, not as "no daemon":
    // without pm2 the panel cannot start backups at all.
    return {
      ...base,
      available: false,
      error: (res.spawnError || res.stderr || res.stdout || 'pm2 is not available').trim(),
    };
  }

  let list: unknown[] = [];
  try {
    list = JSON.parse(res.stdout) as unknown[];
  } catch {
    return { ...base, available: false, error: 'cannot parse pm2 output' };
  }
  const app = (list as Array<Record<string, unknown>>).find((a) => a?.name === inst.pm2Name);
  if (!app) return { ...base, available: true, state: 'not-managed' };

  const env = pm2Env(app);
  return {
    ...base,
    available: true,
    state: String(env.status ?? 'unknown'),
    pid: typeof app.pid === 'number' ? app.pid : undefined,
    restarts: typeof env.restart_time === 'number' ? env.restart_time : undefined,
    // pm_uptime is the start timestamp; report it as a duration from now.
    uptime:
      typeof env.pm_uptime === 'number' ? Math.max(0, Date.now() - env.pm_uptime) : undefined,
    memory: typeof app.memory === 'number' ? app.memory : undefined,
  };
}

export type DaemonAction = 'start' | 'stop' | 'restart' | 'save';

export async function daemonAction(inst: Instance, action: DaemonAction): Promise<Pm2Result> {
  switch (action) {
    case 'start': {
      const ecosystem = path.join(inst.root, 'ecosystem.config.cjs');
      // Without this check a missing instance produces an opaque pm2 error.
      if (!(await existsAs(inst, ecosystem))) {
        return {
          ok: false,
          code: null,
          stdout: '',
          stderr:
            `no ${ecosystem} for '${inst.osUser}'. Provision the instance first ` +
            '(Users page → Provision), then start the daemon.',
        };
      }
      return pm2(inst, ['start', ecosystem], 60_000);
    }
    case 'stop':
      return pm2(inst, ['stop', inst.pm2Name]);
    case 'restart':
      return pm2(inst, ['restart', inst.pm2Name]);
    case 'save':
      return pm2(inst, ['save']);
  }
}
