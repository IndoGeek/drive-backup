import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { getOsUser } from './osusers';

/**
 * Verify a Linux account's password, so panel access is governed by the OS
 * account rather than a second password store. Locking an account with
 * `passwd -l` therefore locks the panel too, and there is no panel password to
 * leak or forget.
 *
 * How it works, and why:
 *
 *  - `/etc/shadow` is not readable by the panel's user, so the hash is read with
 *    `sudo -n getent shadow <user>`.
 *  - The hash is compared using the system's own crypt(3), not reimplemented in
 *    Node. Real accounts on a modern distro use yescrypt (`$y$`), which cannot be
 *    reproduced in JavaScript; delegating to crypt(3) also means sha512crypt and
 *    anything else the host supports just works.
 *  - Perl is preferred over Python because Python's `crypt` module is deprecated
 *    and removed in 3.13, while Perl's `crypt` is not going anywhere.
 *  - Nothing sensitive ever reaches argv — both the hash and the password travel
 *    on stdin, base64-encoded so newlines cannot break the framing. Process
 *    arguments are world-readable via `ps`.
 *  - crypt() is only run when a hash was actually retrieved, and never as root:
 *    sudo is used for exactly one read.
 */

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

/**
 * Read the shadow hash for a user. Requires a passwordless sudo rule, because
 * /etc/shadow is not readable by the panel's user.
 *
 * BACKUP_MGR_SHADOW_FILE substitutes a file, which is how the tests exercise the
 * real crypt(3) path without root.
 */
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

/**
 * Compare `password` against a shadow hash using the host's crypt(3).
 * Returns null when neither perl nor python3 is usable.
 */
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
    // Anything else (missing interpreter, broken crypt module) -> try the next.
  }
  return null;
}

/**
 * Hashes that can never match, because there is no password to match against.
 *
 * shadow(5) uses `!` for a locked account and `*` for one that has no password at
 * all (or `!!` for a locked account that never had one). The distinction matters to
 * an operator: "locked" means `passwd -u` fixes it, "no password" means `passwd`
 * is required.
 */
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

// ---------------------------------------------------------------------------
// Throttling
//
// System passwords are the only barrier in front of a privileged panel, and
// crypt(3) gives us no server-side rate limiting. Failures are counted per
// account+address with an exponential lockout. State is per process: it survives
// between requests but not a restart, which is acceptable for a single-process
// panel and documented in the README. Any success clears the counter.
// ---------------------------------------------------------------------------

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

/** Milliseconds remaining before another attempt is allowed (0 = allowed now). */
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

/** Floor every attempt at a similar duration so reply time can't reveal whether a user exists. */
const MIN_VERIFY_MS = Number(process.env.BACKUP_MGR_MIN_VERIFY_MS ?? 350);

/**
 * Authenticate `username` against the Linux account database, then verify the
 * supplied password.
 */
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

  // Only mirrored accounts may authenticate — an account that is not eligible to
  // appear in the panel must not be probeable through it either.
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
