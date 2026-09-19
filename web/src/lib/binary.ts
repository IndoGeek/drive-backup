import { execFile } from 'node:child_process';
import { existsSync, readlinkSync, statSync, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_INSTALL_TARGET = '/usr/local/bin/backup-mgr';

export function resolveBinaryPath(bin: string): string | null {
  const candidates = bin.includes('/')
    ? [bin]
    : (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, bin));
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
    }
  }
  return null;
}

export function installTarget(root: string, resolvedPath: string | null): string {
  if (!resolvedPath) return DEFAULT_INSTALL_TARGET;
  const buildTree = path.join(root, 'target');
  if (resolvedPath === buildTree || resolvedPath.startsWith(`${buildTree}${path.sep}`)) {
    return DEFAULT_INSTALL_TARGET;
  }
  return resolvedPath;
}

export function resolveCargo(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  if (env.CARGO_BIN) return env.CARGO_BIN;
  const home = env.HOME || os.homedir();
  if (home) {
    const rustup = path.join(home, '.cargo', 'bin', 'cargo');
    if (existsSync(rustup)) return rustup;
  }
  return 'cargo';
}

export function installCommandText(target: string): string {
  return `cargo build --release && sudo install -m 0755 target/release/backup-mgr ${target}`;
}

function statOrNull(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

export type RunningBinary = {
  exe_path: string;

  deleted: boolean;
  dev: number;
  ino: number;
};

export function runningBinary(pid: number | undefined): RunningBinary | null {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return null;
  const link = `/proc/${pid}/exe`;
  let exePath: string;
  try {
    exePath = readlinkSync(link);
  } catch {
    return null;
  }
  const st = statOrNull(link);
  if (!st) return null;
  return {
    exe_path: exePath,
    deleted: exePath.endsWith(' (deleted)'),
    dev: st.dev,
    ino: st.ino,
  };
}

export type DaemonBinaryCheck = {
  restart_needed: boolean;
  reason: string | null;
  running_exe: string | null;
  disk_path: string | null;
};

export function compareRunningBinary(
  running: RunningBinary | null,
  disk: { path: string; dev: number; ino: number } | null,
): DaemonBinaryCheck {
  const base = { running_exe: running?.exe_path ?? null, disk_path: disk?.path ?? null };
  if (!running) return { ...base, restart_needed: false, reason: null };

  if (running.deleted) {
    return {
      ...base,
      restart_needed: true,
      reason: `the file the daemon is running (${running.exe_path}) has since been replaced on disk`,
    };
  }
  if (disk && running.exe_path === disk.path && (running.dev !== disk.dev || running.ino !== disk.ino)) {
    return {
      ...base,
      restart_needed: true,
      reason: `the binary at ${disk.path} was replaced after the daemon started`,
    };
  }
  return { ...base, restart_needed: false, reason: null };
}

export function daemonBinaryCheck(pid: number | undefined, bin: string): DaemonBinaryCheck {
  const diskPath = resolveBinaryPath(bin);
  const st = diskPath ? statOrNull(diskPath) : null;
  return compareRunningBinary(
    runningBinary(pid),
    diskPath && st ? { path: diskPath, dev: st.dev, ino: st.ino } : null,
  );
}

export type InstallStep = {
  step: string;
  ok: boolean;
  code: number | null;
  output: string;
};

function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 16 }, (err, stdout, stderr) => {
      let code: number | null = 0;
      if (err) {
        const raw = (err as NodeJS.ErrnoException & { code?: number | string }).code;
        code = typeof raw === 'number' ? raw : 1;
      }
      resolve({ code, output: `${stdout ?? ''}${stderr ?? ''}`.trim() });
    });
  });
}

export function installArgs(source: string, target: string): string[] {
  return ['-m', '0755', source, target];
}

export type InstallRunner = (
  target: string,
  root: string,
) => Promise<{ code: number | null; output: string; step: string }>;

export const defaultInstallRunner: InstallRunner = async (target, root) => {
  const install = await run(
    'sudo',
    ['-n', 'install', ...installArgs('target/release/backup-mgr', target)],
    root,
    120_000,
  );
  return {
    code: install.code,
    output: install.output,
    step: `sudo -n install -m 0755 target/release/backup-mgr ${target}`,
  };
};

export async function rebuildAndInstall(
  root: string,
  target: string,
  installRunner: InstallRunner = defaultInstallRunner,
): Promise<InstallStep[]> {
  const steps: InstallStep[] = [];
  const cargo = resolveCargo();

  const build = await run(cargo, ['build', '--release'], root, 20 * 60_000);
  steps.push({
    step: `${cargo} build --release`,
    ok: build.code === 0,
    code: build.code,
    output: build.output,
  });
  if (build.code !== 0) return steps;

  const install = await installRunner(target, root);
  steps.push({
    step: install.step,
    ok: install.code === 0,
    code: install.code,
    output: install.output,
  });
  return steps;
}
