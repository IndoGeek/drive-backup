import crypto from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { runAs, spawnAs, type Instance } from './instance';

/**
 * rclone runs as the instance's Linux user, with that user's HOME and
 * RCLONE_CONFIG. Two consequences worth stating:
 *
 *  - a remote created here is visible only to that user's rclone config;
 *  - `rclone authorize`'s 127.0.0.1 callback binds on the server, so the paste
 *    flow exists for browsers that cannot reach it.
 */

export type AuthMethod = 'browser' | 'client';

export type AuthJobView = {
  id: string;
  method: AuthMethod;
  clientId?: string;
  url?: string;
  output: string;
  done: boolean;
  ok: boolean;
  error?: string;
  hasToken: boolean;
  startedAt: number;
};

type AuthJob = AuthJobView & {
  /** Linux user who started it — jobs must not leak across tenants. */
  owner: string;
  token?: Record<string, unknown>;
};

const jobs = new Map<string, AuthJob>();
const procs = new Map<string, ChildProcessWithoutNullStreams>();

function extractUrl(text: string): string | undefined {
  const urls = text.match(/https?:\/\/[^\s"'<>]+/g);
  if (!urls) return undefined;
  return urls.find((u) => u.includes('/auth')) ?? urls[0];
}

function extractToken(text: string): Record<string, unknown> | undefined {
  const m = text.match(/\{[^{}]*"access_token"[^{}]*\}/);
  if (!m) return undefined;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Pull an OAuth token out of text a user pasted from `rclone authorize`
 * (run on another machine). Accepts raw JSON or the full rclone output block.
 */
export function parsePastedToken(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const direct = JSON.parse(trimmed) as Record<string, unknown>;
    if (direct && typeof direct === 'object' && direct.access_token) return direct;
  } catch {
    // not pure JSON; fall through to marker-based extraction
  }
  return extractToken(text) ?? null;
}

export function startAuth(
  inst: Instance,
  opts: { method: AuthMethod; clientId?: string; clientSecret?: string },
): AuthJobView {
  const id = crypto.randomUUID();
  const args = ['authorize', '--auth-no-open-browser', 'drive'];
  // The token must be minted for the same client the instance will refresh with:
  // drive.rs only passes client_id/client_secret to rclone when they are set.
  if (opts.method === 'client' && opts.clientId) {
    args.push(opts.clientId, opts.clientSecret ?? '');
  }
  const proc = spawnAs(inst, 'rclone', args);
  const job: AuthJob = {
    id,
    owner: inst.osUser,
    method: opts.method,
    clientId: opts.clientId,
    output: '',
    done: false,
    ok: false,
    hasToken: false,
    startedAt: Date.now(),
  };
  jobs.set(id, job);
  procs.set(id, proc);

  const onData = (buf: Buffer) => {
    job.output += buf.toString('utf8');
    const u = extractUrl(job.output);
    if (u) job.url = u;
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('error', (e) => {
    job.done = true;
    job.ok = false;
    job.error = e.message;
    procs.delete(id);
  });
  proc.on('close', (code) => {
    job.done = true;
    const token = extractToken(job.output);
    if (token && token.access_token) {
      job.token = token;
      job.ok = true;
      job.hasToken = true;
    } else {
      job.ok = false;
      job.error = job.error || `rclone authorize exited with code ${code}`;
    }
    procs.delete(id);
  });

  return publicView(job);
}

/**
 * Fetch a job only if it belongs to this Linux user, so one tenant cannot read or
 * cancel another's authorization (which would expose a live OAuth token).
 */
export function getAuthJob(id: string | undefined, owner: string): AuthJobView | null {
  if (!id) return null;
  const job = jobs.get(id);
  if (!job || job.owner !== owner) return null;
  return publicView(job);
}

/** The parsed token, once the job finished successfully and belongs to `owner`. */
export function getAuthToken(id: string | undefined, owner: string): Record<string, unknown> | undefined {
  if (!id) return undefined;
  const job = jobs.get(id);
  if (!job || job.owner !== owner) return undefined;
  return job.token;
}

export function cancelAuth(id: string | undefined, owner: string): boolean {
  if (!id) return false;
  const job = jobs.get(id);
  if (!job || job.owner !== owner) return false;
  const proc = procs.get(id);
  if (!proc) return false;
  proc.kill('SIGTERM');
  procs.delete(id);
  job.done = true;
  job.ok = false;
  job.error = 'cancelled';
  return true;
}

function publicView(job: AuthJob): AuthJobView {
  const { token: _token, owner: _owner, ...rest } = job;
  // Hide the raw token from status responses; it is fetched separately on save.
  return { ...rest, hasToken: Boolean(job.token), output: job.output.slice(-8000) };
}

/**
 * Create/update a non-OAuth rclone remote (e.g. Backblaze B2) using rclone's own
 * config tooling as the instance user, so credentials land in that user's rclone
 * config and the backup-mgr `ensure_remote_section` leaves the section untouched.
 */
export async function createB2Remote(
  inst: Instance,
  opts: { remote: string; account: string; key: string },
): Promise<{ ok: boolean; output: string }> {
  const res = await runAs(
    inst,
    'rclone',
    ['config', 'create', opts.remote, 'b2', 'account', opts.account, 'key', opts.key],
    { timeoutMs: 60_000 },
  );
  return { ok: res.ok, output: `${res.stdout}${res.stderr}`.trim() };
}
