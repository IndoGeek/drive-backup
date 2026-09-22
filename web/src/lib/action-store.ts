import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnAs, type Instance } from './instance';
import { binaryPath } from './panel';

export const MAX_ACTION_BUFFER = 1_000_000;

export const KEEP_FINISHED_MS = 36 * 60_000;

export type ActionStatus = 'running' | 'ok' | 'failed';

export type StoredAction = {
  id: string;
  root: string;
  osUser: string;
  action: string;
  label: string;
  command: string;
  startedAt: number;
  status: ActionStatus;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  output: string;
};

export type ActionLine =
  | { type: 'start'; id: string; command: string }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; code: number | null; signal: string | null; ok: boolean };

type Entry = {
  info: StoredAction;
  child: ChildProcessWithoutNullStreams | null;
  timer: NodeJS.Timeout | null;
  sinks: Set<(line: ActionLine) => void>;
  done: boolean;
};

const entries = new Map<string, Entry>();

function reconcile(entry: Entry): void {
  if (entry.info.status !== 'running') return;
  const child = entry.child;
  if (child && child.exitCode === null && child.signalCode === null) return;
  finish(entry, child?.exitCode ?? null, child?.signalCode ?? null);
}

function prune(root: string): Entry | null {
  const entry = entries.get(root);
  if (!entry) return null;
  reconcile(entry);
  if (entry.info.status !== 'running' && Date.now() - entry.info.startedAt > KEEP_FINISHED_MS) {
    clearSinkless(entry);
    entries.delete(root);
    return null;
  }
  return entry;
}

function clearSinkless(entry: Entry): void {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (entry.child && entry.child.exitCode === null) {
    try {
      entry.child.kill('SIGTERM');
    } catch {
    }
  }
  entry.child = null;
  entry.sinks.clear();
}

export function currentAction(root: string): StoredAction | null {
  const entry = prune(root);
  return entry ? entry.info : null;
}

function append(entry: Entry, chunk: string, kind: 'stdout' | 'stderr'): void {
  entry.info.output = (entry.info.output + chunk).slice(-MAX_ACTION_BUFFER);
  const line: ActionLine =
    kind === 'stdout' ? { type: 'stdout', data: chunk } : { type: 'stderr', data: chunk };
  for (const sink of [...entry.sinks]) {
    try {
      sink(line);
    } catch {
    }
  }
}

function finish(entry: Entry, code: number | null, signal: string | null): void {
  if (entry.done) return;
  entry.done = true;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.child = null;
  entry.info.exitCode = code;
  entry.info.signal = signal;
  entry.info.status = code === 0 ? 'ok' : 'failed';
  const line: ActionLine = { type: 'exit', code, signal, ok: code === 0 };
  for (const sink of [...entry.sinks]) {
    try {
      sink(line);
    } catch {
    }
  }
}

function fail(entry: Entry, message: string): void {
  if (entry.done) return;
  entry.done = true;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.child = null;
  entry.info.status = 'failed';
  entry.info.error = message;
  entry.info.output = (entry.info.output + `\n! ${message}\n`).slice(-MAX_ACTION_BUFFER);
  const line: ActionLine = { type: 'exit', code: null, signal: null, ok: false };
  for (const sink of [...entry.sinks]) {
    try {
      sink(line);
    } catch {
    }
  }
}

export type StartActionOptions = {
  action: string;
  label?: string;
  args: string[];
  command: string;
  timeout: number;
};

export function startAction(
  inst: Instance,
  opts: StartActionOptions,
): { action: StoredAction; alreadyRunning: boolean } {
  const existing = prune(inst.root);
  if (existing?.info.status === 'running') {
    return { action: existing.info, alreadyRunning: true };
  }
  const previous = entries.get(inst.root);
  if (previous) clearSinkless(previous);
  const entry: Entry = {
    info: {
      id: randomUUID(),
      root: inst.root,
      osUser: inst.osUser,
      action: opts.action,
      label: opts.label ?? opts.action,
      command: opts.command,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      signal: null,
      error: null,
      output: '',
    },
    child: null,
    timer: null,
    sinks: new Set(),
    done: false,
  };
  entries.set(inst.root, entry);

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnAs(inst, binaryPath(), [...opts.args, '--config', inst.configPath]);
  } catch (e) {
    fail(entry, e instanceof Error ? e.message : String(e));
    return { action: entry.info, alreadyRunning: false };
  }
  entry.child = child;

  entry.timer = setTimeout(() => {
    append(entry, `\n[timed out after ${opts.timeout / 1000}s]\n`, 'stderr');
    if (entry.child && entry.child.exitCode === null) entry.child.kill('SIGTERM');
  }, opts.timeout);

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => append(entry, chunk, 'stdout'));
  child.stderr.on('data', (chunk: string) => append(entry, chunk, 'stderr'));
  child.on('error', (err) => fail(entry, err.message));
  child.on('close', (code, signal) => finish(entry, code, signal));

  return { action: entry.info, alreadyRunning: false };
}

export function subscribeAction(
  root: string,
  sink: (line: ActionLine) => void,
): (() => void) | null {
  const entry = prune(root);
  if (!entry) return null;
  entry.sinks.add(sink);
  return () => {
    entry.sinks.delete(sink);
  };
}

export function stopAction(root: string): boolean {
  const entry = entries.get(root);
  if (!entry || entry.info.status !== 'running') return false;
  const child = entry.child;
  if (!child) {
    fail(entry, 'the run is no longer attached to the panel');
    return true;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    finish(entry, child.exitCode, child.signalCode);
    return true;
  }
  try {
    child.kill('SIGTERM');
  } catch {
  }
  return true;
}