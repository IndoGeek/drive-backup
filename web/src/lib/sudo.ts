import { execFile, execFileSync } from 'node:child_process';
import { NextResponse } from 'next/server';
import { adminOverride, sudoFixture, sudoGroups, sudoTimeoutMs } from './panel';
import { getOsUser } from './osusers';
import { clientAddress, sessionKey } from './session';
import { recordAudit } from './audit';
import { authKey, recordFailure, recordSuccess, throttleRemaining, verifySystemPassword } from './systemauth';
import type { User } from './users';

/**
 * Sudo, the way the OS defines it.
 *
 * The panel does not invent privileges: an account that may run sudo is an
 * administrator here, and privileged work is authorized by that account's own
 * sudo. Concretely:
 *
 *  - **Capability** is asked of sudo itself (`sudo -l -U <user>`), which sees
 *    sudoers.d, per-command rules and NOPASSWD. Group membership (`sudo`, `admin`,
 *    `wheel`) is only a fallback for a host where sudo cannot be queried.
 *  - **Signing in always needs the Linux password**, whatever the sudo rules say -
 *    NOPASSWD is about running commands, not about proving who you are.
 *  - **Privileged work** (managing users, reinstalling the shared binary,
 *    provisioning or acting on someone else's instance) runs under that user's
 *    sudo: silently when their rules are NOPASSWD, otherwise after a password.
 *  - **The password is not asked for again for a while** — an elevation grant
 *    lasts `BACKUP_MGR_SUDO_TIMEOUT_MS` (default 15 min, sudo's own default).
 *    Grants live in this process's memory, are scoped to one login, and are wiped
 *    on logout, on expiry, and whenever sudo rejects the password. The password is
 *    never written to disk and never logged.
 */

export type SudoCapability = {
  username: string;
  /** The account may run sudo at all — which is what makes it a panel admin. */
  has_sudo: boolean;
  /** At least one rule is NOPASSWD (a hint; the runner checks per command). */
  nopass_hint: boolean;
  /** 'root' | 'sudo' | 'group' | 'assumed' | 'unknown' */
  source: 'root' | 'sudo' | 'group' | 'assumed' | 'unknown';
};

const CAP_CACHE_MS = Number(process.env.BACKUP_MGR_OSUSER_CACHE_MS ?? 5000);
let capCache = new Map<string, { at: number; cap: SudoCapability }>();

export function resetSudoCache(): void {
  capCache = new Map();
  passwordlessCache = new Map();
}

/** Ask sudo what this account may do. */
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
    // A definitive "no" from sudo: this account is not in sudoers.
    if (/is not allowed to run sudo|not in the sudoers file/i.test(text)) {
      return { known: true, has: false, nopass: false };
    }
    // Anything else (sudo missing, we lack the right to ask) is "we don't know".
    return { known: false, has: false, nopass: false };
  }
}

/** Group names for an account, or null if they cannot be read. */
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

/**
 * May this account run sudo? Cached briefly: it runs for every user we render
 * and for every authenticated request that needs the answer.
 */
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
  // root does not need sudo; it *is* the privilege.
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

  // Could not ask sudo. Group membership is a weaker signal, but it beats
  // demoting an administrator because of an unrelated failure.
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

  // Unknown: callers keep whatever they already believed (see toUser in ./users.ts)
  // rather than locking an administrator out on the strength of a failed probe.
  return { username, has_sudo: false, nopass_hint: false, source: 'unknown' };
}

// ---------------------------------------------------------------------------
// Grants: the sudo password, held in memory for one session
// ---------------------------------------------------------------------------

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

/** A live grant for this session and account, or null. */
export function activeGrant(req: Request, username: string): Grant | null {
  purgeExpired();
  const grant = grants.get(grantKey(req, username));
  if (!grant) return null;
  if (grant.expiresAt <= Date.now()) return null;
  return grant;
}

/**
 * Drop this session's grant — on request (sudo -k), at sign-out, or because sudo
 * rejected the password. Recorded, because "the elevated window closed" is part of
 * the story an audit trail has to tell.
 */
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
  /** Whether sudo runs without a password here (checked, not guessed). */
  passwordless: boolean | null;
  source: SudoCapability['source'];
  /** When the current elevation lapses, if one is active. */
  elevated_until: string | null;
  timeout_ms: number;
};

/**
 * What the UI needs: can this account elevate, is a password needed, and until
 * when is the current grant good for.
 */
export async function sudoStatus(req: Request, username: string): Promise<SudoStatus> {
  const cap = sudoCapability(username);
  const grant = activeGrant(req, username);
  return {
    has_sudo: cap.has_sudo,
    // Only probed when it matters (there is sudo and no grant); `null` = not asked.
    passwordless: cap.has_sudo && !grant ? await probePasswordless(username) : grant ? false : null,
    source: cap.source,
    elevated_until: grant ? new Date(grant.expiresAt).toISOString() : null,
    timeout_ms: sudoTimeoutMs(),
  };
}

// ---------------------------------------------------------------------------
// Running privileged commands under that user's own sudo
// ---------------------------------------------------------------------------

/**
 * The command line that runs `bin args` with `username`'s sudo.
 *
 * The panel is a single service running as one account, so acting as a different
 * user means switching to them first (`sudo -u`), and *then* invoking sudo — the
 * inner sudo is the one that consults that user's rules and asks for their
 * password. When the panel already runs as that user, the switch is skipped.
 */
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
        // `cwd` matters for relative arguments (the binary install runs
        // `install ... target/release/backup-mgr`, relative to the checkout). Left
        // unset, the command would run in the panel's own directory instead.
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 16 * 1024 * 1024,
        // The panel's environment is not the user's; sudo's secure_path supplies
        // the one that matters. Next.js declares NODE_ENV as required on
        // ProcessEnv, hence the cast — this is not an inherited environment.
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

/**
 * Run `bin args` with `username`'s sudo.
 *
 * Passwordless is always tried first, so a host with `NOPASSWD` set never asks for
 * anything — which is the whole point of NOPASSWD. The stored password (if any) is
 * used only when that fails, and is dropped the moment sudo rejects it.
 */
export async function runElevated(
  req: Request,
  username: string,
  bin: string,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number; cwd?: string } = {},
): Promise<ElevatedOutcome> {
  // A caller that repeats the command name (`['install', '-m', ...]` passed as
  // args for `bin = 'install'`) would make the tool read it as a second operand:
  // GNU install then expects a directory target and fails with the baffling
  // "target ...: Not a directory". Drop the duplicate instead of passing it on.
  const inner = [bin, ...(args[0] === bin ? args.slice(1) : args)];

  const passwordless = await execElevated(username, inner, {
    stdin: opts.stdin,
    timeoutMs: opts.timeoutMs,
    cwd: opts.cwd,
  });
  if (passwordless.code === 0) {
    return { ok: true, via: 'passwordless', stdout: passwordless.stdout, stderr: passwordless.stderr };
  }

  // Only a refusal *by sudo itself* means a password would help. A command that
  // failed on its own terms (a missing file, a bad argument) is reported as that:
  // prompting for a password would be useless, and on a NOPASSWD host it would ask
  // for something sudo never wanted.
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
    // The cached password is no longer accepted (changed, or sudo's ticket is
    // gone). Forget it and ask again rather than looping.
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

/**
 * Does this account's sudo run without a password? Checked, then cached briefly.
 *
 * NOPASSWD is per rule, so this is verified by running something small rather than
 * by parsing the rule list: a host that grants NOPASSWD for one command is not a
 * host where nothing is ever asked.
 */
export async function probePasswordless(username: string): Promise<boolean> {
  // A declared answer wins, so a host where the probe cannot run (or a test) can
  // still state the truth.
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

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

function forbidden(message: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error: message, sudo_denied: true, ...extra }, { status: 403 });
}

/**
 * Authorize one piece of privileged work.
 *
 * Returns null when it may proceed, or the response to send instead:
 *  - `403` when the account has no sudo at all (the OS decides, not the panel);
 *  - `428` when a sudo password is needed, so the UI can ask for it and retry.
 *
 * Reading is never gated — only work that changes something beyond the caller's
 * own instance goes through here.
 */
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
  // NOPASSWD means never asking, per the host's own configuration.
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

/**
 * Verify a sudo password and open an elevation grant for this session.
 *
 * The password is checked against the account's real Linux hash — sudo asks for
 * exactly that password — so a wrong one is rejected for certain, rather than
 * relying on sudo's exit status (which a NOPASSWD rule would make meaningless).
 * Throttled like sign-in, and counted separately from it.
 */
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
    // Misconfiguration is not a wrong password.
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
