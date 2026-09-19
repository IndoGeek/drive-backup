import { execFile } from 'node:child_process';
import { binary, configPath, projectRoot } from './env';

export type CliResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** Command line, for logging in the UI. */
  command: string;
};

/**
 * Run the backup-mgr binary and capture output. Never throws for a non-zero
 * exit status: callers inspect `.ok` / `.code`.
 */
export function runCli(args: string[], timeoutMs = 1000 * 60 * 30): Promise<CliResult> {
  const bin = binary();
  const fullArgs = [...args, '--config', configPath()];
  const command = `${bin} ${fullArgs.join(' ')}`;

  return new Promise((resolve) => {
    execFile(
      bin,
      fullArgs,
      {
        cwd: projectRoot(),
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 32,
        env: process.env,
      },
      (err, stdout, stderr) => {
        let code: number | null = 0;
        if (err) {
          const raw = (err as NodeJS.ErrnoException & { code?: number | string }).code;
          code = typeof raw === 'number' ? raw : 1;
        }
        resolve({
          ok: !err,
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          command,
        });
      },
    );
  });
}

/**
 * Advice shown when a JSON command cannot be interpreted. Overwhelmingly this is
 * a stale binary on PATH (one built before the command existed), which otherwise
 * fails in confusing, sometimes side-effecting ways.
 */
export function staleBinaryHint(): string {
  return (
    'the backup-mgr binary on PATH may be out of date. Rebuild and install it with ' +
    '`cargo build --release && sudo install -m 0755 target/release/backup-mgr ' +
    '/usr/local/bin/backup-mgr`, or point BACKUP_MGR_BIN at the freshly built one. ' +
    'The Dashboard shows the installed vs expected build.'
  );
}

/**
 * True when the binary on PATH understands the JSON interface. Checked before
 * commands that would otherwise be *destructive* when misparsed — a binary from
 * before `restore --json` treats `--json` as a filename and starts a real
 * restore attempt (logging a failure and firing a notification).
 */
export async function binarySupportsJson(): Promise<boolean> {
  const res = await runCli(['version', '--json'], 15_000);
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
