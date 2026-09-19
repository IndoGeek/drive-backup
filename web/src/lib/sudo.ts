import { execFile, execFileSync } from 'node:child_process';
import { NextResponse } from 'next/server';
import { adminOverride, sudoFixture, sudoGroups, sudoTimeoutMs } from './panel';
import { getOsUser } from './osusers';
import { clientAddress, sessionKey } from './session';
import { recordAudit } from './audit';
import { authKey, recordFailure, recordSuccess, throttleRemaining, verifySystemPassword } from './systemauth';
import type { User } from './users';

export type SudoCapability = {
  username: string;

  has_sudo: boolean;

  nopass_hint: boolean;

  source: 'root' | 'sudo' | 'group' | 'assumed' | 'unknown';
};

const CAP_CACHE_MS = Number(process.env.BACKUP_MGR_OSUSER_CACHE_MS ?? 5000);
let capCache = new Map<string, { at: number; cap: SudoCapability }>();

export function resetSudoCache(): void {
  capCache = new Map();
  passwordlessCache = new Map();
}

function probeSudoList(username: string): { known: boolean; has: boolean; nopass: boolean } {
  try {
    const out = execFileSync('sudo', ['-n', '-l', '-U', username], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      known: true,
      has: /may run the following commands/i.test(out),
      nopass: /NOPASSWD:/i.test(out),
    };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    const text = `${err.stdout ?? ''}${err.stderr ?? ''}`;

    if (/is not allowed to run sudo|not in the sudoers file/i.test(text)) {
      return { known: true, has: false, nopass: false };
    }

    return { known: false, has: false, nopass: false };
  }
}

function groupsOf(username: string): Set<string> | null {
  try {
    const out = execFileSync('id', ['-nG', username], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Set(out.trim().split(/\s+/).filter(Boolean));
  } catch {
    return null;
  }
}

export function sudoCapability(username: string): SudoCapability {
  const now = Date.now();
  const hit = capCache.get(username);
  if (hit && now - hit.at < CAP_CACHE_MS) return hit.cap;

  const cap = computeCapability(username);
  capCache.set(username, { at: now, cap });
  return cap;
}

function computeCapability(username: string): SudoCapability {
  const fixture = sudoFixture()[username];
  if (fixture) {
    return {
      username,
      has_sudo: fixture.has_sudo,
      nopass_hint: fixture.passwordless === true,
      source: 'assumed',
    };
  }

  if (username === 'root') {
    return { username, has_sudo: true, nopass_hint: true, source: 'root' };
  }
  if (adminOverride() === username) {
    return { username, has_sudo: true, nopass_hint: false, source: 'assumed' };
  }

  const list = probeSudoList(username);
  if (list.known) {
    return { username, has_sudo: list.has, nopass_hint: list.nopass, source: 'sudo' };
  }

  const groups = groupsOf(username);
  if (groups) {
    const wanted = sudoGroups();
    return {
      username,
      has_sudo: wanted.some((g) => groups.has(g)),
      nopass_hint: false,
      source: 'group',
    };
  }

  return { username, has_sudo: false, nopass_hint: false, source: 'unknown' };
}

type Grant = { password: Buffer; expiresAt: number; username: string };

const grants = new Map<string, Grant>();
let passwordlessCache = new Map<string, { at: number; ok: boolean }>();

function grantKey(req: Request, username: string): string {
  return `${sessionKey(req)}:${username}`;
}

function purgeExpired(now = Date.now()): void {
  for (const [key, grant] of grants) {
    if (grant.expiresAt <= now) {
      grant.password.fill(0);
      grants.delete(key);
    }
  }
}

export function activeGrant(req: Request, username: string): Grant | null {
  purgeExpired();
  const grant = grants.get(grantKey(req, username));
  if (!grant) return null;
  if (grant.expiresAt <= Date.now()) return null;
  return grant;
}

export function clearSessionGrant(
  req: Request,
  username?: string,
  reason: 'requested' | 'sign-out' | 'rejected' | 'other' = 'other',
): void {
  const prefix = `${sessionKey(req)}:`;
  for (const [key, grant] of grants) {
    if (key.startsWith(prefix) && (!username || grant.username === username)) {
      grant.password.fill(0);
      grants.delete(key);
      recordAudit({
        username: grant.username,
        action: 'elevation ended',
        outcome: 'elevation_ended',
        detail: { reason },
        address: clientAddress(req),
      });
    }
  }
}

export type SudoStatus = {
  has_sudo: boolean;

  passwordless: boolean | null;
  source: SudoCapability['source'];

  elevated_until: string | null;
  timeout_ms: number;
};

export async function sudoStatus(req: Request, username: string): Promise<SudoStatus> {
  const cap = sudoCapability(username);
  const grant = activeGrant(req, username);
  return {
    has_sudo: cap.has_sudo,

    passwordless: cap.has_sudo && !grant ? await probePasswordless(username) : grant ? false : null,
    source: cap.source,
    elevated_until: grant ? new Date(grant.expiresAt).toISOString() : null,
    timeout_ms: sudoTimeoutMs(),
  };
}

function sudoArgv(username: string, innerArgs: string[], password: boolean): string[] {
  const osUser = getOsUser(username);
  const sameUser =
    osUser !== null && typeof process.getuid === 'function' && process.getuid() === osUser.uid;
  const outer = sameUser ? [] : ['-n', '-u', username, '-H'];
  const inner = password ? ['sudo', '-S', '-p', '', ...innerArgs] : ['sudo', '-n', ...innerArgs];
  return [...outer, ...inner];
}

function execElevated(
  username: string,
  innerArgs: string[],
  opts: { password?: Buffer; stdin?: string; timeoutMs?: number; cwd?: string },
): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: string }> {
  const argv = sudoArgv(username, innerArgs, opts.password !== undefined);
  return new Promise((resolve) => {
    const child = execFile(
      'sudo',
      argv,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 16 * 1024 * 1024,

        env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' } as unknown as NodeJS.ProcessEnv,
      },
      (err, stdout, stderr) => {
        const raw = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code : 0;
        resolve({
          code: typeof raw === 'number' ? raw : err ? 1 : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          spawnError: err && typeof raw !== 'number' ? (err as Error).message : undefined,
        });
      },
    );
    const payload =
      opts.password !== undefined
        ? Buffer.concat([opts.password, Buffer.from('\n'), Buffer.from(opts.stdin ?? '')])
        : opts.stdin;
    if (payload !== undefined && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(payload);
    }
  });
}

const NEEDS_PASSWORD = /a password is required|no tty present|a terminal is required|sorry, try again|incorrect password|authentication failure/i;

export type ElevatedOutcome =
  | { ok: true; via: 'passwordless' | 'password'; stdout: string; stderr: string }
  | { ok: false; needs_password: true; stderr: string }
  | { ok: false; needs_password: false; error: string; stderr: string };

export async function runElevated(
  req: Request,
  username: string,
  bin: string,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number; cwd?: string } = {},
): Promise<ElevatedOutcome> {
  const inner = [bin, ...(args[0] === bin ? args.slice(1) : args)];

  const passwordless = await execElevated(username, inner, {
    stdin: opts.stdin,
    timeoutMs: opts.timeoutMs,
    cwd: opts.cwd,
  });
  if (passwordless.code === 0) {
    return { ok: true, via: 'passwordless', stdout: passwordless.stdout, stderr: passwordless.stderr };
  }

  if (!NEEDS_PASSWORD.test(passwordless.stderr)) {
    return {
      ok: false,
      needs_password: false,
      error: passwordless.stderr.trim() || 'the privileged command failed',
      stderr: passwordless.stderr,
    };
  }

  const grant = activeGrant(req, username);
  if (!grant) return { ok: false, needs_password: true, stderr: passwordless.stderr };

  const withPassword = await execElevated(username, inner, {
    password: grant.password,
    stdin: opts.stdin,
    timeoutMs: opts.timeoutMs,
    cwd: opts.cwd,
  });
  if (withPassword.code === 0) {
    return { ok: true, via: 'password', stdout: withPassword.stdout, stderr: withPassword.stderr };
  }
  if (NEEDS_PASSWORD.test(withPassword.stderr)) {
    clearSessionGrant(req, username, 'rejected');
    return { ok: false, needs_password: true, stderr: withPassword.stderr };
  }
  return {
    ok: false,
    needs_password: false,
    error: withPassword.stderr.trim() || 'the privileged command failed',
    stderr: withPassword.stderr,
  };
}

export async function probePasswordless(username: string): Promise<boolean> {
  const declared = sudoFixture()[username];
  if (declared) return declared.passwordless === true;

  const now = Date.now();
  const hit = passwordlessCache.get(username);
  if (hit && now - hit.at < 30_000) return hit.ok;
  const res = await execElevated(username, ['true'], { timeoutMs: 10_000 });
  const ok = res.code === 0;
  passwordlessCache.set(username, { at: now, ok });
  return ok;
}

function forbidden(message: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error: message, sudo_denied: true, ...extra }, { status: 403 });
}

export async function authorizePrivileged(
  req: Request,
  user: User,
  action: string,
): Promise<NextResponse | null> {
  const cap = sudoCapability(user.username);
  if (!cap.has_sudo) {
    recordAudit({
      username: user.username,
      action,
      outcome: 'denied',
      detail: { reason: 'not in sudoers' },
      address: clientAddress(req),
    });
    return forbidden(
      `'${user.username}' is not in sudoers on this server, so it cannot perform '${action}'. ` +
        'Administrators are the accounts with sudo — on most systems: sudo usermod -aG sudo ' +
        `${user.username}`,
      { action },
    );
  }
  if (activeGrant(req, user.username)) return null;

  if (await probePasswordless(user.username)) return null;
  recordAudit({
    username: user.username,
    action,
    outcome: 'prompted',
    detail: { reason: 'sudo password required' },
    address: clientAddress(req),
  });
  return NextResponse.json(
    {
      error: 'a sudo password is required for this action',
      sudo_required: true,
      action,
      timeout_ms: sudoTimeoutMs(),
    },
    { status: 428 },
  );
}

export type AuthorizeSudoResult =
  | { ok: true; elevated_until: string; timeout_ms: number }
  | { ok: false; status: number; error: string; retry_after?: number };

export async function authorizeSudo(
  req: Request,
  user: User,
  password: string,
): Promise<AuthorizeSudoResult> {
  const cap = sudoCapability(user.username);
  if (!cap.has_sudo) {
    recordAudit({
      username: user.username,
      action: 'elevation requested',
      outcome: 'denied',
      detail: { reason: 'not in sudoers' },
      address: clientAddress(req),
    });
    return {
      ok: false,
      status: 403,
      error: `'${user.username}' is not in sudoers, so there is nothing to elevate`,
    };
  }
  const key = authKey(user.username, 'sudo');
  const waitMs = throttleRemaining(key);
  if (waitMs > 0) {
    return {
      ok: false,
      status: 429,
      error: `too many attempts — try again in ${Math.ceil(waitMs / 1000)}s`,
      retry_after: Math.ceil(waitMs / 1000),
    };
  }
  if (!password) return { ok: false, status: 400, error: 'password is required' };

  const verified = await verifySystemPassword(user.username, password);
  if (!verified.ok) {
    if (verified.reason === 'sudo' || verified.reason === 'tooling') {
      return { ok: false, status: 500, error: verified.message };
    }
    recordFailure(key);
    recordAudit({
      username: user.username,
      action: 'elevation requested',
      outcome: 'denied',
      detail: { reason: 'wrong password' },
      address: clientAddress(req),
    });
    return { ok: false, status: 401, error: 'That is not your sudo password' };
  }
  recordSuccess(key);

  purgeExpired();
  const expiresAt = Date.now() + sudoTimeoutMs();
  grants.set(grantKey(req, user.username), {
    password: Buffer.from(password, 'utf8'),
    expiresAt,
    username: user.username,
  });
  recordAudit({
    username: user.username,
    action: 'elevation granted',
    outcome: 'elevated',
    via: 'password',
    detail: { until: new Date(expiresAt).toISOString(), timeout_ms: sudoTimeoutMs() },
    address: clientAddress(req),
  });
  return { ok: true, elevated_until: new Date(expiresAt).toISOString(), timeout_ms: sudoTimeoutMs() };
}
