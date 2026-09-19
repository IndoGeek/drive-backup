import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { getOsUser } from './osusers';

export type VerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'invalid'
        | 'throttled'
        | 'locked'
        | 'no-password'
        | 'unknown-user'
        | 'sudo'
        | 'tooling';
      message: string;
    };

const PERL_SCRIPT = [
  'use MIME::Base64 qw(decode_base64);',
  'chomp(my $h64 = <STDIN>);',
  'chomp(my $p64 = <STDIN>);',
  'my $h = decode_base64($h64);',
  'my $p = decode_base64($p64);',
  'print crypt($p, $h) eq $h ? "OK" : "NO";',
].join('');

const PYTHON_SCRIPT = [
  'import sys, base64, crypt',
  'h = base64.b64decode(sys.stdin.readline().strip()).decode()',
  'p = base64.b64decode(sys.stdin.readline().strip()).decode()',
  'sys.stdout.write("OK" if crypt.crypt(p, h) == h else "NO")',
].join(';');

function run(
  bin: string,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { timeout: opts.timeoutMs ?? 15_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException).code as number | undefined) ?? 1 : 0;
        resolve({ ok: !err, code: typeof code === 'number' ? code : 1, stdout, stderr });
      },
    );
    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    }
  });
}

async function shadowHash(username: string): Promise<
  { ok: true; hash: string } | { ok: false; reason: 'sudo' | 'unknown-user'; message: string }
> {
  const override = process.env.BACKUP_MGR_SHADOW_FILE;
  if (override) {
    let raw = '';
    try {
      raw = readFileSync(override, 'utf8');
    } catch (e) {
      return {
        ok: false,
        reason: 'sudo',
        message: `cannot read BACKUP_MGR_SHADOW_FILE (${override}): ${
          e instanceof Error ? e.message : 'unknown error'
        }`,
      };
    }
    const line = raw.split('\n').find((l) => l.startsWith(`${username}:`));
    if (!line) {
      return { ok: false, reason: 'unknown-user', message: `no shadow entry for '${username}'` };
    }
    return { ok: true, hash: (line.split(':')[1] ?? '').trim() };
  }

  const res = await run('sudo', ['-n', 'getent', 'shadow', username]);
  if (!res.ok) {
    const err = (res.stderr || res.stdout).trim();
    if (/password is required|a password is required|no tty/i.test(err)) {
      return {
        ok: false,
        reason: 'sudo',
        message:
          'Cannot read /etc/shadow: passwordless sudo is not configured. Add the ' +
          'sudoers rule from deploy/sudoers-backup-mgr and restart the panel.',
      };
    }
    return {
      ok: false,
      reason: 'unknown-user',
      message: err || `no shadow entry for '${username}'`,
    };
  }
  const hash = (res.stdout.split(':')[1] ?? '').trim();
  return { ok: true, hash };
}

async function cryptMatches(hash: string, password: string): Promise<boolean | null> {
  const payload = `${Buffer.from(hash).toString('base64')}\n${Buffer.from(password).toString(
    'base64',
  )}\n`;
  const interpreters: [string, string[]][] = [
    ['perl', ['-e', PERL_SCRIPT]],
    ['python3', ['-c', PYTHON_SCRIPT]],
  ];
  for (const [bin, args] of interpreters) {
    const res = await run(bin, args, { stdin: payload });
    const out = res.stdout.trim();
    if (out === 'OK') return true;
    if (out === 'NO') return false;
  }
  return null;
}

function unusableHash(hash: string): { reason: 'locked' | 'no-password'; message: string } | null {
  if (!hash || hash === 'x' || hash.startsWith('*')) {
    return {
      reason: 'no-password',
      message: 'This account has no password set. Ask an administrator to set one.',
    };
  }
  if (hash.startsWith('!')) {
    return {
      reason: 'locked',
      message: 'This account is locked (passwd -l). Ask an administrator to unlock it.',
    };
  }
  return null;
}

const MAX_FAILURES = Number(process.env.BACKUP_MGR_MAX_LOGIN_FAILURES ?? 5);
const BASE_LOCK_MS = 2_000;
const MAX_LOCK_MS = 15 * 60_000;

type Attempt = { failures: number; lockedUntil: number };
const attempts = new Map<string, Attempt>();

export function authKey(username: string, address: string): string {
  return `${username.toLowerCase()}@${address}`;
}

export function resetThrottle(): void {
  attempts.clear();
}

export function throttleRemaining(key: string): number {
  const a = attempts.get(key);
  if (!a) return 0;
  return Math.max(0, a.lockedUntil - Date.now());
}

export function recordFailure(key: string): void {
  const a = attempts.get(key) ?? { failures: 0, lockedUntil: 0 };
  a.failures += 1;
  if (a.failures >= MAX_FAILURES) {
    const over = a.failures - MAX_FAILURES;
    a.lockedUntil = Date.now() + Math.min(BASE_LOCK_MS * 2 ** over, MAX_LOCK_MS);
  }
  attempts.set(key, a);
}

export function recordSuccess(key: string): void {
  attempts.delete(key);
}

const MIN_VERIFY_MS = Number(process.env.BACKUP_MGR_MIN_VERIFY_MS ?? 350);

export async function verifySystemPassword(
  username: string,
  password: string,
): Promise<VerifyResult> {
  const started = Date.now();
  const settle = async (result: VerifyResult): Promise<VerifyResult> => {
    const elapsed = Date.now() - started;
    if (elapsed < MIN_VERIFY_MS) {
      await new Promise((r) => setTimeout(r, MIN_VERIFY_MS - elapsed));
    }
    return result;
  };

  const osUser = getOsUser(username);
  if (!osUser) {
    return settle({ ok: false, reason: 'unknown-user', message: 'Invalid username or password' });
  }
  if (!password) {
    return settle({ ok: false, reason: 'invalid', message: 'Invalid username or password' });
  }

  const shadow = await shadowHash(username);
  if (!shadow.ok) {
    return settle({
      ok: false,
      reason: shadow.reason === 'sudo' ? 'sudo' : 'unknown-user',
      message: shadow.reason === 'sudo' ? shadow.message : 'Invalid username or password',
    });
  }

  const unusable = unusableHash(shadow.hash);
  if (unusable) {
    return settle({ ok: false, reason: unusable.reason, message: unusable.message });
  }

  const matched = await cryptMatches(shadow.hash, password);
  if (matched === null) {
    return settle({
      ok: false,
      reason: 'tooling',
      message:
        'Cannot verify passwords: neither perl nor python3 could call crypt(3). ' +
        'Install perl on the host running the panel.',
    });
  }

  if (!matched) {
    return settle({ ok: false, reason: 'invalid', message: 'Invalid username or password' });
  }
  return settle({ ok: true });
}
