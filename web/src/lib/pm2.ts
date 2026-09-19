import path from 'node:path';
import { existsAs, runAs, type Instance } from './instance';
import { pm2Path } from './panel';

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

  state?: string;
  pid?: number;
  restarts?: number;
  uptime?: number;
  memory?: number;

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
