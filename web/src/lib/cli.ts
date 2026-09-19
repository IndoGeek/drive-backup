import { execFile } from 'node:child_process';
import { runAs, type Instance } from './instance';
import { binaryPath } from './panel';

export type CliResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** Command line, for logging in the UI. Credentials never appear here. */
  command: string;
  /** Set when the process could not be started — e.g. sudo refused. */
  spawnError?: string;
  viaSudo: boolean;
};

/**
 * Run the shared backup-mgr binary against one instance's config, as that
 * instance's Linux user. Never throws for a non-zero exit status: callers inspect
 * `.ok` / `.code`.
 *
 * The binary is installed once and read-only for everyone; what makes the tenants
 * separate is which user runs it and which config it is pointed at.
 */
export async function runCli(
  inst: Instance,
  args: string[],
  timeoutMs = 1000 * 60 * 30,
): Promise<CliResult> {
  const bin = binaryPath();
  const fullArgs = [...args, '--config', inst.configPath];
  const res = await runAs(inst, bin, fullArgs, { timeoutMs, maxBuffer: 1024 * 1024 * 32 });
  if (res.spawnError && !res.ok) {
    return {
      ok: false,
      code: null,
      stdout: '',
      stderr: res.stderr,
      command: `${bin} ${fullArgs.join(' ')}`,
      spawnError: res.spawnError,
      viaSudo: res.viaSudo,
    };
  }
  return {
    ok: res.ok,
    code: res.code,
    stdout: res.stdout,
    stderr: res.stderr,
    command: `${bin} ${fullArgs.join(' ')}`,
    viaSudo: res.viaSudo,
  };
}

/**
 * Advice shown when a JSON command cannot be interpreted. Overwhelmingly this is
 * a stale binary on PATH (one built before the command existed), which otherwise
 * fails in confusing, sometimes side-effecting ways.
 */
export function staleBinaryHint(): string {
  return (
    'the shared backup-mgr binary may be out of date. Rebuild and install it with ' +
    '`cargo build --release && sudo install -m 0755 target/release/backup-mgr ' +
    '/usr/local/bin/backup-mgr`, or point BACKUP_MGR_BIN at the freshly built one. ' +
    'The Dashboard shows the installed vs expected build.'
  );
}

/**
 * Run the shared binary as the panel's own user, with no instance and no config.
 *
 * The binary is installed once for everyone, so questions about *it* — what build
 * is installed, does it understand the JSON interface — are panel-level and must
 * not be asked through a user's instance.
 */
export function runBinary(args: string[], timeoutMs = 15_000): Promise<CliResult> {
  const bin = binaryPath();
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd: '/', timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException).code as number | undefined) : 0;
        resolve({
          ok: !err,
          code: typeof code === 'number' ? code : err ? 1 : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          command: `${bin} ${args.join(' ')}`,
          spawnError: err && code === undefined ? err.message : undefined,
          viaSudo: false,
        });
      },
    );
  });
}

/**
 * True when the binary understands the JSON interface. Checked before commands
 * that would otherwise be *destructive* when misparsed — a binary from before
 * `restore --json` treats `--json` as a filename and starts a real restore
 * attempt (logging a failure and firing a notification).
 */
export async function binarySupportsJson(inst: Instance): Promise<boolean> {
  const res = await runCli(inst, ['version', '--json'], 15_000);
  return parseTrailingJson<{ version?: string }>(res.stdout) !== null;
}

/** backup-mgr logs to stdout too, so the JSON payload is the last line. */
export function parseTrailingJson<T>(stdout: string): T | null {
  const lines = stdout.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      return JSON.parse(line) as T;
    } catch {
      // keep looking
    }
  }
  return null;
}
