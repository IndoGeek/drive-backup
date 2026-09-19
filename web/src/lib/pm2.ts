import { execFile } from 'node:child_process';
import { projectRoot } from './env';

export const PM2_APP = process.env.BACKUP_MGR_PM2_NAME || 'backup-mgr';

function pm2Bin(): string {
  return process.env.PM2_BIN || 'pm2';
}

export type Pm2Result = { ok: boolean; code: number | null; stdout: string; stderr: string };

function pm2(args: string[], timeoutMs = 30_000): Promise<Pm2Result> {
  return new Promise((resolve) => {
    execFile(
      pm2Bin(),
      args,
      { cwd: projectRoot(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        const raw = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code : 0;
        resolve({
          ok: !err,
          code: typeof raw === 'number' ? raw : 1,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
  });
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
  error?: string;
};

export async function daemonStatus(): Promise<DaemonStatus> {
  const res = await pm2(['jlist']);
  if (!res.ok) {
    return {
      available: false,
      name: PM2_APP,
      error: (res.stderr || res.stdout || 'pm2 is not available').trim(),
    };
  }
  let list: unknown[] = [];
  try {
    list = JSON.parse(res.stdout) as unknown[];
  } catch {
    return { available: false, name: PM2_APP, error: 'cannot parse pm2 output' };
  }
  const app = (list as Array<Record<string, unknown>>).find((a) => a?.name === PM2_APP);
  if (!app) return { available: true, name: PM2_APP, state: 'not-managed' };

  const env = (app.pm2_env ?? {}) as Record<string, unknown>;
  return {
    available: true,
    name: PM2_APP,
    state: String(env.status ?? 'unknown'),
    pid: typeof app.pid === 'number' ? app.pid : undefined,
    restarts: typeof env.restart_time === 'number' ? env.restart_time : undefined,
    // pm_uptime is the start timestamp; report it as a duration from now.
    uptime:
      typeof env.pm_uptime === 'number' ? Math.max(0, Date.now() - env.pm_uptime) : undefined,
    memory: typeof env.memory === 'number' ? env.memory : undefined,
  };
}

export type DaemonAction = 'start' | 'stop' | 'restart' | 'save';

export async function daemonAction(action: DaemonAction): Promise<Pm2Result> {
  switch (action) {
    case 'start':
      return pm2(['start', `${projectRoot()}/ecosystem.config.cjs`], 60_000);
    case 'stop':
      return pm2(['stop', PM2_APP]);
    case 'restart':
      return pm2(['restart', PM2_APP]);
    case 'save':
      return pm2(['save']);
  }
}
