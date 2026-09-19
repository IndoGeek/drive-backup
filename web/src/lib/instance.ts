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

/**
 * One user's backup world: their own config.yml, logs, archives, history, state,
 * rclone config and pm2 daemon. Nothing here is shared with another user, and
 * every command runs as that Linux account — so the OS enforces the isolation,
 * not the panel.
 *
 * The panel itself is a single privileged service. It never reads an instance's
 * files directly: config.yml is 0600 and owned by the user, so all access goes
 * through `sudo -u <user>`. A bug in a route therefore cannot read another
 * user's OAuth token or gpg passphrase.
 */

export type Instance = {
  osUser: string;
  uid: number;
  gid: number;
  home: string;
  /** Directory holding config.yml, logs/, backup/, history.db, state.json. */
  root: string;
  configPath: string;
  logsDir: string;
  backupDir: string;
  historyDb: string;
  stateFile: string;
  /** pm2 application name for this instance's daemon. */
  pm2Name: string;
  /** Separate pm2 daemon per user, so `pm2 restart` only touches their own app. */
  pm2Home: string;
  rcloneConfig: string;
};

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** Resolve the instance for an OS user, applying data/instances.yml overrides. */
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

/** True when the instance belongs to a different account than the panel's. */
export function needsSudo(inst: Instance): boolean {
  return typeof process.getuid === 'function' && process.getuid() !== inst.uid;
}

/**
 * PATH for instance commands. The panel's own PATH is appended so `pm2`,
 * `rclone` and `backup-mgr` resolve exactly as they do for the deploy user,
 * while the standard system locations come first.
 */
function childPath(): string {
  const base = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];
  const extra = (process.env.PATH || '').split(':').filter(Boolean);
  return Array.from(new Set([...base, ...extra])).join(':');
}

/**
 * The child's environment is deliberately a fixed, minimal set — never
 * `process.env`, which holds the panel's own secrets and paths. Next.js declares
 * `NODE_ENV` as required on ProcessEnv, so this is a plain string map and the one
 * cast below is where it meets execFile.
 */
type ChildEnv = Record<string, string>;

function childEnv(inst: Instance): ChildEnv {
  return {
    HOME: inst.home,
    PATH: childPath(),
    // Each user gets their own daemon and rclone credentials. These are set
    // explicitly so nothing leaks in from the panel's own environment.
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
  /** Set when the command could not be started at all (e.g. sudo refused). */
  spawnError?: string;
  /** True when this specific run had to go through sudo. */
  viaSudo: boolean;
};

/**
 * Run a command as the instance's Linux user, with a minimal environment.
 *
 * When the panel already runs as that user (the common single-owner case) sudo is
 * skipped entirely. Otherwise sudo is required — see deploy/sudoers-backup-mgr.
 */
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
        // Config-relative paths are resolved by backup-mgr itself, so the working
        // directory does not need to be the instance root — and `/` always exists.
        cwd: '/',
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
        // Never hand the panel's environment to another user.
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
      // Commands that never read stdin (tail, cat, test) exit and close the pipe
      // before the payload is flushed, which surfaces as EPIPE. That is expected
      // here, not an error worth crashing the panel over.
      child.stdin.on('error', () => {});
      child.stdin.end(opts.stdin);
    }
  });
}

/**
 * Start a long-lived command as the instance user, streaming its output.
 *
 * `runAs` buffers until exit, which is wrong for `rclone authorize`: it prints an
 * authorization URL and then stays alive until the user completes it in a
 * browser, so the panel must read output as it arrives. stdout and stderr are
 * merged because rclone writes its prompts to whichever it prefers.
 */
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
    // Never hand the panel's environment (or its secrets) to another user.
    env: (useSudo ? { PATH: childPath() } : env) as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** A bare command name is not usable from another user's PATH in the pm2 config. */
export function absoluteBinary(): string {
  const bin = binaryPath();
  if (bin.includes('/')) return bin;
  try {
    const found = execFileSync('sh', ['-c', 'command -v "$1"', 'sh', bin], {
      encoding: 'utf8',
    }).trim();
    if (found) return found;
  } catch {
    // fall through
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
    // fall through
  }
  return bin;
}

// ---------------------------------------------------------------------------
// File access, always as the owning user
// ---------------------------------------------------------------------------

export async function existsAs(inst: Instance, p: string): Promise<boolean> {
  const res = await runAs(inst, 'sh', ['-c', 'test -e "$1"', 'sh', p]);
  return res.ok;
}

export async function readFileAs(inst: Instance, p: string): Promise<string | null> {
  const res = await runAs(inst, 'cat', ['--', p]);
  if (!res.ok) return null;
  return res.stdout;
}

/**
 * Write a file as the owning user. `umask 077` means the file is never briefly
 * world-readable, unlike create-then-chmod.
 */
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

/** Atomic replace within the same directory, so a reader never sees a partial file. */
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

/**
 * List a directory as the owning user. Emits NUL-separated fields from a single
 * shell invocation so filenames containing spaces cannot be mis-parsed, and so
 * listing a directory costs one process rather than one per file.
 */
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

/** Read the last `maxBytes` of a file as the owning user. */
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

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/** pm2 config for one instance, generated so it references only that user's paths. */
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
  /** config.yml already existed, so it was deliberately left alone. */
  keptExisting: string[];
  error?: string;
};

/**
 * Create an instance's directories and seed a config.yml + ecosystem file.
 *
 * Idempotent, and never overwrites an existing config.yml: that file holds the
 * gpg passphrase, the OAuth token and the Discord webhook, so replacing it would
 * be destructive.
 */
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
