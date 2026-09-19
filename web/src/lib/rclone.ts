import crypto from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { runAs, spawnAs, type Instance } from './instance';

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

export function parsePastedToken(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const direct = JSON.parse(trimmed) as Record<string, unknown>;
    if (direct && typeof direct === 'object' && direct.access_token) return direct;
  } catch {
  }
  return extractToken(text) ?? null;
}

export function startAuth(
  inst: Instance,
  opts: { method: AuthMethod; clientId?: string; clientSecret?: string },
): AuthJobView {
  const id = crypto.randomUUID();
  const args = ['authorize', '--auth-no-open-browser', 'drive'];

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

export function getAuthJob(id: string | undefined, owner: string): AuthJobView | null {
  if (!id) return null;
  const job = jobs.get(id);
  if (!job || job.owner !== owner) return null;
  return publicView(job);
}

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

  return { ...rest, hasToken: Boolean(job.token), output: job.output.slice(-8000) };
}

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
