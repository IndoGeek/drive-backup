import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getOsUser } from './osusers';
import {
  binaryPath,
  configTemplatePath,
  instanceOverrides,
  instanceTemplate,
  pm2Path,
} from './panel';

export type Instance = {
  osUser: string;
  uid: number;
  gid: number;
  home: string;

  root: string;
  configPath: string;
  logsDir: string;
  backupDir: string;
  historyDb: string;
  stateFile: string;

  pm2Name: string;

  pm2Home: string;
  rcloneConfig: string;
};

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

export function instanceFor(username: string): Instance | null {
  const osUser = getOsUser(username);
  if (!osUser) return null;
  const ov = instanceOverrides()[username] ?? {};

  const root = path.resolve(
    expandHome(ov.root ?? instanceTemplate().replace('{home}', osUser.home), osUser.home),
  );

  return {
    osUser: osUser.username,
    uid: osUser.uid,
    gid: osUser.gid,
    home: osUser.home,
    root,
    configPath: path.join(root, 'config.yml'),
    logsDir: path.join(root, 'logs'),
    backupDir: path.join(root, 'backup'),
    historyDb: path.join(root, 'history.db'),
    stateFile: path.join(root, 'state.json'),
    pm2Name: ov.pm2_name ?? `backup-mgr-${osUser.username}`,
    pm2Home: path.resolve(expandHome(ov.pm2_home ?? '~/.pm2', osUser.home)),
    rcloneConfig: path.join(osUser.home, '.config', 'rclone', 'rclone.conf'),
  };
}

export function needsSudo(inst: Instance): boolean {
  return typeof process.getuid === 'function' && process.getuid() !== inst.uid;
}

function childPath(): string {
  const base = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];
  const extra = (process.env.PATH || '').split(':').filter(Boolean);
  return Array.from(new Set([...base, ...extra])).join(':');
}

type ChildEnv = Record<string, string>;

function childEnv(inst: Instance): ChildEnv {
  return {
    HOME: inst.home,
    USER: inst.osUser,
    LOGNAME: inst.osUser,
    PATH: childPath(),

    PM2_HOME: inst.pm2Home,
    RCLONE_CONFIG: inst.rcloneConfig,
    LANG: 'C.UTF-8',
  };
}

export type RunResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;

  spawnError?: string;

  viaSudo: boolean;
};

export function runAs(
  inst: Instance,
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; stdin?: string; maxBuffer?: number } = {},
): Promise<RunResult> {
  const env = childEnv(inst);
  const useSudo = needsSudo(inst);
  const file = useSudo ? 'sudo' : bin;
  const argv = useSudo
    ? [
        '-n',
        '-u',
        inst.osUser,
        '-H',
        'env',
        ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
        bin,
        ...args,
      ]
    : args;

  return new Promise((resolve) => {
    const child = execFile(
      file,
      argv,
      {
        cwd: '/',
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,

        env: (useSudo ? { PATH: childPath() } : env) as NodeJS.ProcessEnv,
      },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException).code as number | undefined) : 0;
        resolve({
          ok: !err,
          code: typeof code === 'number' ? code : err ? 1 : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          spawnError: err && code === undefined ? err.message : undefined,
          viaSudo: useSudo,
        });
      },
    );
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(opts.stdin);
    }
  });
}

export function spawnAs(
  inst: Instance,
  bin: string,
  args: string[],
): ChildProcessWithoutNullStreams {
  const env = childEnv(inst);
  const useSudo = needsSudo(inst);
  const file = useSudo ? 'sudo' : bin;
  const argv = useSudo
    ? ['-n', '-u', inst.osUser, '-H', 'env', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), bin, ...args]
    : args;
  return spawn(file, argv, {
    cwd: '/',

    env: (useSudo ? { PATH: childPath() } : env) as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function absoluteBinary(): string {
  const bin = binaryPath();
  if (bin.includes('/')) return bin;
  try {
    const found = execFileSync('sh', ['-c', 'command -v "$1"', 'sh', bin], {
      encoding: 'utf8',
    }).trim();
    if (found) return found;
  } catch {
  }
  return `/usr/local/bin/${bin}`;
}

export function absolutePm2(): string {
  const bin = pm2Path();
  if (bin.includes('/')) return bin;
  try {
    const found = execFileSync('sh', ['-c', 'command -v "$1"', 'sh', bin], {
      encoding: 'utf8',
    }).trim();
    if (found) return found;
  } catch {
  }
  return bin;
}

export async function existsAs(inst: Instance, p: string): Promise<boolean> {
  const res = await runAs(inst, 'sh', ['-c', 'test -e "$1"', 'sh', p]);
  return res.ok;
}

export async function readFileAs(inst: Instance, p: string): Promise<string | null> {
  const res = await runAs(inst, 'cat', ['--', p]);
  if (!res.ok) return null;
  return res.stdout;
}

export async function writeFileAs(
  inst: Instance,
  p: string,
  content: string,
  mode?: string,
): Promise<void> {
  const res = await runAs(inst, 'sh', ['-c', 'umask 077; cat > "$1"', 'sh', p], { stdin: content });
  if (!res.ok) {
    throw new Error(`cannot write ${p} as ${inst.osUser}: ${(res.stderr || '').trim()}`);
  }
  if (mode) await runAs(inst, 'chmod', [mode, p]);
}

export async function writeFileAtomicAs(
  inst: Instance,
  p: string,
  content: string,
  mode = '600',
): Promise<void> {
  const tmp = `${p}.panel-${process.pid}.tmp`;
  await writeFileAs(inst, tmp, content, mode);
  const res = await runAs(inst, 'mv', ['-f', '--', tmp, p]);
  if (!res.ok) {
    await runAs(inst, 'rm', ['-f', '--', tmp]);
    throw new Error(`cannot replace ${p} as ${inst.osUser}: ${(res.stderr || '').trim()}`);
  }
}

export type RemoteFileEntry = { name: string; size: number; mtime: string };

export async function listFilesAs(inst: Instance, dir: string): Promise<RemoteFileEntry[]> {
  const script =
    'cd "$1" || exit 1; for f in *; do [ -f "$f" ] || continue; ' +
    'printf "%s\\0%s\\0%s\\0" "$f" "$(stat -c %s -- "$f")" "$(stat -c %Y -- "$f")"; done';
  const res = await runAs(inst, 'sh', ['-c', script, 'sh', dir]);
  if (!res.ok) return [];
  const parts = res.stdout.split('\0');
  const out: RemoteFileEntry[] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const name = parts[i];
    if (!name) continue;
    out.push({
      name,
      size: Number(parts[i + 1]) || 0,
      mtime: new Date((Number(parts[i + 2]) || 0) * 1000).toISOString(),
    });
  }
  return out;
}

export async function readTailAs(
  inst: Instance,
  p: string,
  maxBytes = 200_000,
): Promise<string | null> {
  const res = await runAs(inst, 'tail', ['-c', String(maxBytes), '--', p]);
  if (!res.ok) return null;
  return res.stdout;
}

export async function mkdirAs(inst: Instance, p: string, mode = '700'): Promise<void> {
  const res = await runAs(inst, 'mkdir', ['-p', '-m', mode, p]);
  if (!res.ok) {
    throw new Error(`cannot create ${p} as ${inst.osUser}: ${(res.stderr || '').trim()}`);
  }
}

export function ecosystemFor(inst: Instance): string {
  return `const path = require('path');

// Generated by the backup-mgr panel for the '${inst.osUser}' instance.
// Do not edit by hand: the panel rewrites nothing here, but deleting it only
// means the Dashboard can no longer start the daemon.
const ROOT = __dirname;

module.exports = {
  apps: [
    {
      name: ${JSON.stringify(inst.pm2Name)},
      script: ${JSON.stringify(absoluteBinary())},
      args: 'daemon --config ' + path.join(ROOT, 'config.yml'),
      cwd: ROOT,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 30000,
      max_memory_restart: '300M',
      time: true,
      out_file: path.join(ROOT, 'logs', 'pm2.log'),
      error_file: path.join(ROOT, 'logs', 'pm2-error.log'),
      merge_logs: true,
      kill_timeout: 20000,
      env: { NODE_ENV: 'production' },
    },
  ],
};
`;
}

export type ProvisionResult = {
  ok: boolean;
  created: string[];

  keptExisting: string[];
  error?: string;
};

export async function provision(inst: Instance): Promise<ProvisionResult> {
  const created: string[] = [];
  const keptExisting: string[] = [];
  try {
    await mkdirAs(inst, inst.root, '700');
    await mkdirAs(inst, inst.logsDir, '700');
    await mkdirAs(inst, inst.backupDir, '700');

    for (const [p, label] of [
      [inst.configPath, 'config.yml'],
      [path.join(inst.root, 'ecosystem.config.cjs'), 'ecosystem.config.cjs'],
    ] as const) {
      if (await existsAs(inst, p)) {
        keptExisting.push(label);
        continue;
      }
      if (label === 'config.yml') {
        let template = '';
        try {
          template = fs.readFileSync(configTemplatePath(), 'utf8');
        } catch {
          template = 'backup:\n  prefix: "backup"\n  path: "/path/to/your/data"\n';
        }
        await writeFileAs(inst, p, template, '600');
      } else {
        await writeFileAs(inst, p, ecosystemFor(inst), '600');
      }
      created.push(label);
    }
    return { ok: true, created, keptExisting };
  } catch (e) {
    return {
      ok: false,
      created,
      keptExisting,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
