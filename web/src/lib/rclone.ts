import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';

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

export function startAuth(opts: {
  method: AuthMethod;
  clientId?: string;
  clientSecret?: string;
}): AuthJobView {
  const id = crypto.randomUUID();
  const args = ['authorize', '--auth-no-open-browser', 'drive'];
  if (opts.method === 'client' && opts.clientId) {
    args.push(opts.clientId, opts.clientSecret ?? '');
  }
  const proc = spawn('rclone', args, { env: process.env });
  const job: AuthJob = {
    id,
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

export function getAuthJob(id: string): AuthJobView | null {
  const job = jobs.get(id);
  return job ? publicView(job) : null;
}

/** The parsed token, once the job finished successfully. */
export function getAuthToken(id: string): Record<string, unknown> | undefined {
  return jobs.get(id)?.token;
}

export function cancelAuth(id: string): boolean {
  const proc = procs.get(id);
  if (!proc) return false;
  proc.kill('SIGTERM');
  procs.delete(id);
  const job = jobs.get(id);
  if (job) {
    job.done = true;
    job.ok = false;
    job.error = 'cancelled';
  }
  return true;
}

function publicView(job: AuthJob): AuthJobView {
  const { token: _token, ...rest } = job;
  // Hide the raw token from status responses; it is fetched separately on save.
  return { ...rest, hasToken: Boolean(job.token), output: job.output.slice(-8000) };
}

/**
 * Create/update a non-OAuth rclone remote (e.g. Backblaze B2) using rclone's
 * own config tooling, so credentials are stored the way rclone expects and the
 * backup-mgr `ensure_remote_section` leaves the section untouched.
 */
export function createB2Remote(opts: {
  remote: string;
  account: string;
  key: string;
}): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      'rclone',
      ['config', 'create', opts.remote, 'b2', 'account', opts.account, 'key', opts.key],
      { env: process.env, timeout: 60_000 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          output: (String(stdout ?? '') + String(stderr ?? '')).trim(),
        });
      },
    );
  });
}
