'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Download,
  HardDriveDownload,
  Loader2,
  Minus,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldCheck,
  Square,
  Terminal,
  Wrench,
  XCircle,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Switch,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@/components/ui';
import { RestoreDialog } from '@/components/restore-dialog';
import { cleanTimes, evenSpacing, fmtMinute, minuteOf, normalizeTime } from '@/lib/schedule';
import { cn } from '@/lib/cn';
import { useMe } from '@/lib/use-me';
import { useSudo } from '@/lib/sudo-client';

type DaemonBinaryCheck = {
  restart_needed: boolean;
  reason: string | null;
  running_exe: string | null;
  disk_path: string | null;
};

type DaemonInfo = {
  available: boolean;
  name: string;
  state?: string;
  pid?: number;
  restarts?: number;
  uptime?: number;
  error?: string;
  binary?: DaemonBinaryCheck;
};

type Status = {
  state: {
    stage: string;
    status: string;
    current_backup: string;
    finished_at: string | null;
    last_error: string;
    requires_manual_resume: boolean;
    last_run_at: string | null;
    generation: number;
  };
  config: {
    backup_path: string;
    backup_dir: string;
    log_dir: string;
    compression: string;
    time: string;
    backups_per_day: number;
    timezone: string;
    encrypt_enabled: boolean;
    upload_to_all: boolean;
    /** Exact run times, set only by a binary that understands `backup.times`. */
    times?: string[];
    /** The effective daily schedule, in HH:MM — what this build will actually do. */
    schedule?: string[];
  };
  remotes: { label: string; retention: number }[];
  next_run_at?: string | null;
  next_run_local?: string | null;
  next_run_seconds?: number | null;
};

type BinaryInfo = {
  binary: string;
  resolved_path: string | null;
  file: { size: number; mtime: string } | null;
  installed: { name?: string; version?: string; commit?: string; built_at?: string } | null;
  expected: { version: string | null; commit: string | null };
  stale: boolean;
  reasons: string[];
  install_command: string;
};

type RunRow = {
  id: number;
  run_at: string;
  kind: string;
  name: string;
  size_bytes: number | null;
  duration_ms: number | null;
  remote: string;
  status: string;
  error: string;
};

/** A second destination as it appears in config.yml (may be configured but off). */
type SecondaryRemote = { enabled: boolean; remote: string; dir: string; retention: number };

function human(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${bytes} B` : `${v.toFixed(2)} ${units[u]}`;
}

function countdown(ms: number): string {
  if (ms <= 0) return 'due now';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

function readPath(obj: Record<string, unknown>, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

const PAGE_SIZES = [5, 10, 25];

export default function DashboardPage() {
  const { loading: meLoading, can } = useMe();
  // Privileged actions (reinstalling the shared binary) run under this user's own
  // sudo; fetchElevated asks for the password only when sudo would.
  const { fetchElevated } = useSudo();

  const [status, setStatus] = useState<Status | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [runTotal, setRunTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [busy, setBusy] = useState<string | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [daemon, setDaemon] = useState<DaemonInfo | null>(null);
  const [bin, setBin] = useState<BinaryInfo | null>(null);
  const [secondary, setSecondary] = useState<SecondaryRemote | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const [world, setWorld] = useState(false);
  const [noPtero, setNoPtero] = useState(true);
  const [force, setForce] = useState(false);

  // Terminal
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<{ ok: boolean; code: number | null } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const consoleRef = useRef<HTMLPreElement | null>(null);

  // Schedule
  const [mode, setMode] = useState<'even' | 'times'>('even');
  const [time, setTime] = useState('03:30');
  const [perDay, setPerDay] = useState('1');
  const [times, setTimes] = useState<string[]>(['03:30']);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleMsg, setScheduleMsg] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    const res = await fetch('/api/status');
    if (res.ok) setStatus((await res.json()) as Status);
  }, []);

  const loadRuns = useCallback(async () => {
    const res = await fetch(`/api/history?limit=${pageSize}&offset=${page * pageSize}`);
    if (res.ok) {
      const data = (await res.json()) as { runs?: RunRow[]; total?: number };
      setRuns(data.runs ?? []);
      setRunTotal(data.total ?? data.runs?.length ?? 0);
    }
  }, [page, pageSize]);

  const loadSchedule = useCallback(async () => {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const data = (await res.json()) as { config?: Record<string, unknown> };
    const cfg = data.config ?? {};

    const explicit = readPath(cfg, 'backup.times');
    const list = Array.isArray(explicit)
      ? explicit.map((t) => String(t)).filter((t) => t.trim() !== '')
      : [];
    const baseTime = String(readPath(cfg, 'backup.time') ?? '03:30');
    const basePerDay = String(readPath(cfg, 'backup.backups_per_day') ?? '1');
    setTime(baseTime);
    setPerDay(basePerDay);
    setTimes(list.length ? list : [baseTime]);
    // Which rule the file currently uses decides which mode opens.
    setMode(list.length ? 'times' : 'even');
    // "configured but not used" is the state worth surfacing: a second destination
    // that exists in the file but is switched off explains a Remotes card showing
    // one entry on a server that looks like it has two.
    const sec = readPath(cfg, 'storage.secondary');
    if (sec && typeof sec === 'object') {
      const s = sec as Record<string, unknown>;
      setSecondary({
        enabled: s.enabled === true,
        remote: String(s.remote ?? ''),
        dir: String(s.dir ?? ''),
        retention: Number(s.retention ?? 0),
      });
    } else {
      setSecondary(null);
    }
  }, []);

  const loadDaemon = useCallback(async () => {
    const res = await fetch('/api/daemon');
    if (res.ok) setDaemon((await res.json()) as DaemonInfo);
  }, []);

  const loadBinary = useCallback(async () => {
    const res = await fetch('/api/binary');
    if (res.ok) setBin((await res.json()) as BinaryInfo);
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadSchedule();
    void loadDaemon();
    void loadBinary();
    const t = setInterval(() => void loadStatus(), 5000);
    const t3 = setInterval(() => void loadDaemon(), 15000);
    const t4 = setInterval(() => void loadBinary(), 60000);
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      clearInterval(t);
      clearInterval(t3);
      clearInterval(t4);
      clearInterval(tick);
    };
  }, [loadStatus, loadSchedule, loadDaemon, loadBinary]);

  // History has its own effect so paging re-fetches without resetting the timers
  // above, and so the poll always reloads the page the user is actually on.
  useEffect(() => {
    void loadRuns();
    const t2 = setInterval(() => void loadRuns(), 20000);
    return () => clearInterval(t2);
  }, [loadRuns]);

  // Keep the newest output in view as it streams in.
  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  function append(text: string) {
    setOutput((prev) => (prev + text).slice(-200_000));
  }

  /**
   * Run an action and show its output as it arrives.
   *
   * The response is newline-delimited JSON, one message per line, so the panel can
   * render progress instead of freezing until the process exits.
   */
  async function streamAction(
    action: string,
    options: Record<string, unknown> = {},
    label?: string,
  ) {
    setBusy(label ?? action);
    setRunning(true);
    setLastResult(null);
    setOutput('');
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/actions/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, options }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        append(`! ${data.error ?? `HTTP ${res.status}`}\n`);
        setLastResult({ ok: false, code: null });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
          if (!line) continue;
          let msg: {
            type?: string;
            data?: string;
            code?: number | null;
            ok?: boolean;
            command?: string;
            message?: string;
            signal?: string | null;
          };
          try {
            msg = JSON.parse(line) as typeof msg;
          } catch {
            continue;
          }
          if (msg.type === 'start' && msg.command) append(`$ ${msg.command}\n\n`);
          else if (msg.type === 'stdout' && msg.data) append(msg.data);
          else if (msg.type === 'stderr' && msg.data) append(msg.data);
          else if (msg.type === 'error') append(`\n! ${msg.message ?? 'the command could not run'}\n`);
          else if (msg.type === 'exit') {
            setLastResult({ ok: msg.code === 0, code: msg.code ?? null });
          }
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') append('\n[stopped]\n');
      else append(`\n! ${e instanceof Error ? e.message : 'the panel could not reach the server'}\n`);
      setLastResult((prev) => prev ?? { ok: false, code: null });
    } finally {
      setRunning(false);
      setBusy(null);
      abortRef.current = null;
      await loadStatus();
      await loadRuns();
    }
  }

  async function controlDaemon(action: 'start' | 'stop' | 'restart') {
    setBusy(`daemon-${action}`);
    setOutput('');
    try {
      const res = await fetch('/api/daemon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json()) as {
        output?: string;
        code?: number | null;
        status?: DaemonInfo;
        error?: string;
      };
      setOutput(`$ pm2 ${action}\n${data.output ?? data.error ?? ''}\n`);
      setLastResult({ ok: (data.code ?? 1) === 0, code: data.code ?? null });
      if (data.status) setDaemon(data.status);
    } finally {
      setBusy(null);
    }
  }

  async function rebuildBinary() {
    setBusy('rebuild');
    setRunning(true);
    setLastResult(null);
    setOutput('$ cargo build --release && sudo install -m 0755 target/release/backup-mgr …\n\n');
    try {
      // fetchElevated handles the sudo prompt: this installs under *your* sudo, so
      // a host with NOPASSWD never asks and one that prompts asks once.
      const res = await fetchElevated('/api/binary/install', { method: 'POST' });
      const data = (await res.json()) as {
        ok?: boolean;
        steps?: { step: string; ok: boolean; code: number | null; output: string }[];
        install_command?: string;
        hint?: string;
        error?: string;
      };
      if (data.error) {
        append(
          res.status === 428
            ? '! sudo password required — nothing was installed.\n'
            : `! ${data.error}\n`,
        );
        setLastResult({ ok: false, code: null });
      } else {
        const body = (data.steps ?? [])
          .map((s) => `${s.ok ? '✓' : '✗'} ${s.step}\n${s.output}`.trim())
          .join('\n\n');
        append(`${body}\n\n${data.hint ?? ''}\n\nmanual fallback:\n  ${data.install_command ?? ''}`.trim() + '\n');
        setLastResult({ ok: data.ok === true, code: data.ok ? 0 : 1 });
      }
      await loadBinary();
      await loadDaemon();
    } finally {
      setRunning(false);
      setBusy(null);
    }
  }

  function stopRun() {
    abortRef.current?.abort();
  }

  async function saveSchedule() {
    setScheduleMsg(null);
    setScheduleError(null);

    const payload: Record<string, unknown> = {};
    if (mode === 'times') {
      const list = cleanTimes(times);
      if (!list) {
        const bad = times.find((t) => normalizeTime(t) === null) ?? '';
        setScheduleError(`"${bad}" is not a 24-hour time (HH:MM).`);
        return;
      }
      if (list.length === 0) {
        setScheduleError('Add at least one time, or switch to evenly spaced backups.');
        return;
      }
      payload['backup.times'] = list;
      // Kept in step so switching back to even spacing does not need retyping, and
      // so a daemon that predates `backup.times` still gets a sane schedule.
      payload['backup.time'] = list[0];
      payload['backup.backups_per_day'] = String(list.length);
    } else {
      const norm = normalizeTime(time);
      if (!norm) {
        setScheduleError(`"${time}" is not a 24-hour time (HH:MM).`);
        return;
      }
      const n = Number(perDay);
      if (!Number.isFinite(n) || n < 1 || n > 24) {
        setScheduleError('Backups per day must be between 1 and 24.');
        return;
      }
      payload['backup.times'] = [];
      payload['backup.time'] = norm;
      payload['backup.backups_per_day'] = String(Math.floor(n));
    }

    setSavingSchedule(true);
    try {
      const res = await fetch('/api/schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: payload }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setScheduleError(data.error ?? 'Save failed');
        return;
      }
      await loadStatus();
      setScheduleMsg('Saved. Restart the daemon to apply.');
    } finally {
      setSavingSchedule(false);
    }
  }

  const state = status?.state;
  const failed = Boolean(state?.requires_manual_resume) || state?.status === 'failed';
  const inFlight = state?.status === 'running';
  const nextMs = status?.next_run_at ? new Date(status.next_run_at).getTime() : null;

  // What the daemon will actually run, from the daemon itself when it can say.
  const daemonSchedule = status?.config.schedule ?? null;
  const localPreview = mode === 'times' ? times.filter((t) => normalizeTime(t) !== null) : evenSpacing(time, Number(perDay));
  const scheduleDrifted =
    daemonSchedule !== null &&
    localPreview.length > 0 &&
    [...localPreview].sort().join(',') !== [...daemonSchedule].sort().join(',');
  const binaryUnderstandsTimes = Array.isArray(status?.config.times);

  if (!meLoading && !can('dashboard.view')) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        Your account does not have the <code className="font-mono">dashboard.view</code>{' '}
        permission. Ask an admin to grant it.
      </div>
    );
  }

  const pageCount = Math.max(1, Math.ceil(runTotal / pageSize));
  const firstRow = runTotal === 0 ? 0 : page * pageSize + 1;
  const lastRow = Math.min((page + 1) * pageSize, runTotal);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">Dashboard</h1>
            {bin?.installed && (
              <Badge
                variant={bin.stale ? 'destructive' : 'secondary'}
                title={bin.resolved_path ?? bin.binary}
              >
                backup-mgr {bin.installed.version ?? '?'}
                {bin.installed.commit ? ` · ${bin.installed.commit}` : ''}
                {bin.stale ? ' · out of date' : ''}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Manual runs, integrity checks and scheduling.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void loadStatus();
            void loadRuns();
            void loadDaemon();
            void loadBinary();
            void loadSchedule();
          }}
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      {bin?.stale && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="space-y-1">
            <p className="font-medium text-destructive">The backup-mgr binary is out of date</p>
            {bin.reasons.map((r) => (
              <p key={r} className="text-muted-foreground">
                {r}
              </p>
            ))}
            <p className="text-muted-foreground">
              Running <code className="font-mono">{bin.resolved_path ?? bin.binary}</code>
              {bin.file?.mtime
                ? ` (file dated ${new Date(bin.file.mtime).toLocaleString()})`
                : ''}{' '}
              while the checkout is at {bin.expected.version ?? '?'}
              {bin.expected.commit ? ` (${bin.expected.commit})` : ''}.
            </p>
            <pre className="overflow-x-auto rounded bg-secondary px-2 py-1 font-mono text-[11px]">
              {bin.install_command}
            </pre>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void rebuildBinary()}
                disabled={busy !== null || !can('binary.install')}
              >
                {busy === 'rebuild' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                Rebuild &amp; reinstall
              </Button>
              {!can('binary.install') && (
                <span className="text-xs text-muted-foreground">
                  needs the <code className="font-mono">binary.install</code> permission
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {daemon?.binary?.restart_needed && (
        <div className="flex items-start gap-2 rounded-lg border border-primary/40 bg-primary/10 p-3 text-sm">
          <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="space-y-2">
            <div>
              <p className="font-medium">The daemon is still running an older backup-mgr</p>
              <p className="text-muted-foreground">
                {daemon.binary.reason}. A running process keeps the code it started with, so the
                daemon needs a restart to pick up the new build.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void controlDaemon('restart')}
              disabled={busy !== null || !can('daemon.control')}
            >
              {busy === 'daemon-restart' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Restart daemon
            </Button>
          </div>
        </div>
      )}

      {state?.requires_manual_resume && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium text-destructive">Manual resume required</p>
            <p className="text-muted-foreground">
              Failed at stage <code className="font-mono">{state.stage}</code>: {state.last_error}
            </p>
          </div>
        </div>
      )}

      {/* Status */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>State</CardDescription>
            <CardTitle className="flex items-center gap-2 text-lg">
              {/*
                A cross means "something is wrong". Work in progress is not wrong —
                a run that is currently checking or backing up shows as in progress,
                and only a failure (or a run waiting on a human) is marked failed.
              */}
              {failed ? (
                <XCircle className="h-5 w-5 shrink-0 text-destructive" />
              ) : inFlight ? (
                <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" />
              ) : (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
              )}
              <span className="truncate">{state?.stage ?? '—'}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            <Badge variant={failed ? 'destructive' : inFlight ? 'secondary' : 'success'}>
              {failed ? (state?.status ?? 'failed') : inFlight ? 'in progress' : (state?.status ?? 'ok')}
            </Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Last run</CardDescription>
            <CardTitle className="text-sm">
              {state?.last_run_at ? new Date(state.last_run_at).toLocaleString() : 'never'}
            </CardTitle>
          </CardHeader>
          <CardContent className="truncate text-xs text-muted-foreground" title={state?.current_backup}>
            {state?.current_backup || '—'}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1">
              <CalendarClock className="h-3.5 w-3.5" /> Next backup
            </CardDescription>
            <CardTitle className="text-sm">
              {status?.next_run_local ?? (nextMs ? new Date(nextMs).toLocaleString() : '—')}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {nextMs ? <span className="text-primary">in {countdown(nextMs - nowMs)}</span> : '—'}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Source</CardDescription>
            <CardTitle className="flex items-center gap-2 text-sm">
              <HardDriveDownload className="h-4 w-4 shrink-0 text-primary" />
              {status?.config.compression ?? '—'}
            </CardTitle>
          </CardHeader>
          <CardContent
            className="truncate text-xs text-muted-foreground"
            title={status?.config.backup_path}
          >
            {status?.config.backup_path ?? '—'}
          </CardContent>
        </Card>

        <Card className="sm:col-span-2 lg:col-span-1">
          <CardHeader className="pb-2">
            <CardDescription>Remotes</CardDescription>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Cloud className="h-4 w-4 shrink-0 text-primary" />
              {status?.remotes.length ?? 0} in use
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs text-muted-foreground">
            {status?.remotes.map((r) => (
              <div key={r.label} className="truncate" title={r.label}>
                {r.label} · keep {r.retention}
              </div>
            ))}
            {/*
              A destination that is configured but switched off is the reason a
              server that "has two remotes" shows one: say so instead of hiding it.
            */}
            {secondary?.remote && !secondary.enabled && (
              <div
                className="truncate text-muted-foreground/80"
                title={`${secondary.remote}:${secondary.dir} is configured but storage.secondary.enabled is false`}
              >
                {secondary.remote}:{secondary.dir} · off
              </div>
            )}
            {secondary?.enabled && (
              <div className="truncate" title={`${secondary.remote}:${secondary.dir}`}>
                {secondary.remote}:{secondary.dir} · keep {secondary.retention}
              </div>
            )}
            {status?.config.upload_to_all && (
              <div className="text-primary">uploading to every enabled remote</div>
            )}
            {secondary?.remote && !secondary.enabled && (
              <a className="inline-block pt-1 text-primary underline" href="/config">
                enable it on the Config page
              </a>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Run actions</CardTitle>
          <CardDescription>Start a backup or run a check right now.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-5 text-sm">
            <label className="flex items-center gap-2">
              <Switch checked={world} onCheckedChange={setWorld} /> World only
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={noPtero} onCheckedChange={setNoPtero} /> Skip Pterodactyl
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={force} onCheckedChange={setForce} /> Force
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void streamAction('run', { world, noPtero, force })}
              disabled={busy !== null || !can('backup.run')}
            >
              {busy === 'run' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Run backup now
            </Button>
            <Button
              variant="secondary"
              onClick={() => void streamAction('run', { world, noPtero, dryRun: true }, 'dry-run')}
              disabled={busy !== null || !can('backup.run')}
            >
              <Terminal className="h-4 w-4" /> Dry run
            </Button>
            <Button
              variant="secondary"
              onClick={() => void streamAction('test-compress')}
              disabled={busy !== null || !can('backup.run')}
            >
              Test compression
            </Button>
            <Button
              variant="secondary"
              onClick={() => void streamAction('check')}
              disabled={busy !== null || !can('backup.check')}
            >
              <ShieldCheck className="h-4 w-4" /> Check integrity
            </Button>
            <Button
              variant="secondary"
              onClick={() => void streamAction('restore-list')}
              disabled={busy !== null || !can('backup.restore')}
            >
              List backups
            </Button>
            <Button
              variant="secondary"
              onClick={() => setRestoreOpen(true)}
              disabled={busy !== null || !can('backup.restore')}
            >
              <RotateCcw className="h-4 w-4" /> Restore…
            </Button>
            <Button
              variant="outline"
              onClick={() => void streamAction('fix-perms')}
              disabled={busy !== null || !can('backup.fix_perms')}
            >
              <Wrench className="h-4 w-4" /> Fix permissions
            </Button>
            <Button
              variant="outline"
              onClick={() => void streamAction('reset')}
              disabled={busy !== null || !can('backup.run')}
            >
              Reset state
            </Button>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {running && (
                <>
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span className="text-sm text-muted-foreground">Running…</span>
                  <Button size="sm" variant="outline" onClick={stopRun}>
                    <Square className="h-3.5 w-3.5" /> Stop
                  </Button>
                </>
              )}
              {!running && lastResult && (
                <Badge variant={lastResult.ok ? 'success' : 'destructive'}>
                  {lastResult.ok
                    ? 'SUCCESSFUL'
                    : `UNSUCCESSFUL${lastResult.code !== null ? ` (exit ${lastResult.code})` : ''}`}
                </Badge>
              )}
            </div>
            <pre
              ref={consoleRef}
              className="h-64 overflow-auto rounded-md border border-input bg-secondary/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap"
              aria-live="polite"
            >
              {output || 'Action output will appear here as it runs…'}
              {!running && lastResult && (
                <>
                  {'\n\n'}
                  {lastResult.ok
                    ? 'SUCCESSFUL'
                    : `UNSUCCESSFUL${lastResult.code !== null ? ` (exit ${lastResult.code})` : ''}`}
                </>
              )}
            </pre>
          </div>
        </CardContent>
      </Card>

      {/* Daemon control */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-4 w-4 text-primary" /> Daemon
          </CardTitle>
          <CardDescription>The scheduled backup service (pm2 app “backup-mgr”).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {daemon && !daemon.available ? (
            <p className="text-sm text-muted-foreground">
              pm2 is not available on this host{daemon.error ? `: ${daemon.error}` : ''}.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <Badge
                  variant={
                    daemon?.state === 'online'
                      ? 'success'
                      : daemon?.state === 'not-managed'
                        ? 'secondary'
                        : 'destructive'
                  }
                >
                  {daemon?.state ?? 'unknown'}
                </Badge>
                {daemon?.pid ? <span className="text-muted-foreground">pid {daemon.pid}</span> : null}
                {typeof daemon?.restarts === 'number' ? (
                  <span className="text-muted-foreground">restarts {daemon.restarts}</span>
                ) : null}
                {daemon?.uptime ? (
                  <span className="text-muted-foreground">
                    up {Math.floor(daemon.uptime / 3_600_000)}h
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => void controlDaemon('start')}
                  disabled={busy !== null || !can('daemon.control')}
                >
                  <Power className="h-4 w-4" /> Start
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void controlDaemon('restart')}
                  disabled={busy !== null || !can('daemon.control')}
                >
                  <RefreshCw className="h-4 w-4" /> Restart
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void controlDaemon('stop')}
                  disabled={busy !== null || !can('daemon.control')}
                >
                  <Square className="h-4 w-4" /> Stop
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Schedule */}
      <Card>
        <CardHeader>
          <CardTitle>Schedule</CardTitle>
          <CardDescription>When the daemon runs backups.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={mode === 'even' ? 'default' : 'outline'}
              onClick={() => setMode('even')}
              disabled={!can('backup.schedule')}
            >
              Evenly spaced
            </Button>
            <Button
              size="sm"
              variant={mode === 'times' ? 'default' : 'outline'}
              onClick={() => setMode('times')}
              disabled={!can('backup.schedule')}
            >
              Specific times
            </Button>
          </div>

          {mode === 'even' ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="time">First daily backup (HH:MM)</Label>
                <Input
                  id="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  placeholder="03:30"
                  disabled={!can('backup.schedule')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="perDay">Backups per day</Label>
                <Input
                  id="perDay"
                  type="number"
                  min="1"
                  max="24"
                  value={perDay}
                  onChange={(e) => setPerDay(e.target.value)}
                  disabled={!can('backup.schedule')}
                />
              </div>
              <div className="space-y-2">
                <Label>Runs at</Label>
                <p className="rounded-md border border-border bg-secondary/40 px-3 py-2 font-mono text-xs text-muted-foreground">
                  {evenSpacing(time, Number(perDay)).join('  ') || '—'}
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <Label>Backup times</Label>
              {times.map((t, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={t}
                    onChange={(e) =>
                      setTimes((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                    }
                    placeholder="03:30"
                    inputMode="numeric"
                    className="max-w-[10rem]"
                    disabled={!can('backup.schedule')}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Remove backup time ${i + 1}`}
                    onClick={() => setTimes((prev) => prev.filter((_, j) => j !== i))}
                    disabled={!can('backup.schedule') || times.length <= 1}
                  >
                    <Minus className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setTimes((prev) => {
                    // A sensible next slot: an hour after the last one.
                    const last = prev.length ? (minuteOf(prev[prev.length - 1]) ?? 210) : 210;
                    return [...prev, fmtMinute((last + 60) % 1440)];
                  })
                }
                disabled={!can('backup.schedule') || times.length >= 24}
              >
                <Plus className="h-4 w-4" /> Add another backup
              </Button>
              <p className="text-xs text-muted-foreground">
                Each entry is one backup a day, at exactly that time.
              </p>
            </div>
          )}

          {daemonSchedule && daemonSchedule.length > 0 && (
            <p className="text-xs text-muted-foreground">
              The daemon is scheduling:{' '}
              <span className="font-mono text-foreground">{daemonSchedule.join('  ')}</span>
            </p>
          )}
          {scheduleDrifted && (
            <p className="flex items-start gap-2 text-xs text-primary">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              The running daemon is still using the previous times — restart it to apply.
            </p>
          )}
          {mode === 'times' && !binaryUnderstandsTimes && (
            <p className="flex items-start gap-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              The installed backup-mgr predates per-time schedules, so it ignores these and uses
              the even-spacing rule instead. Rebuild &amp; reinstall, then restart the daemon.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={saveSchedule} disabled={savingSchedule || !can('backup.schedule')}>
              {savingSchedule && <Loader2 className="h-4 w-4 animate-spin" />}
              Save schedule
            </Button>
            {scheduleError && <span className="text-sm text-destructive">{scheduleError}</span>}
            {scheduleMsg && <span className="text-sm text-muted-foreground">{scheduleMsg}</span>}
          </div>
        </CardContent>
      </Card>

      {/* History */}
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle>Recent runs</CardTitle>
            <CardDescription>
              {runTotal === 0
                ? 'Nothing recorded yet.'
                : `Showing ${firstRow}–${lastRow} of ${runTotal}.`}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={String(pageSize)}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(0);
              }}
              className="w-[5.5rem]"
              aria-label="Runs per page"
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s} / page
                </option>
              ))}
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              <ChevronLeft className="h-4 w-4" /> Prev
            </Button>
            <span className="text-xs text-muted-foreground">
              {page + 1} / {pageCount}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => (p + 1 < pageCount ? p + 1 : p))}
              disabled={page + 1 >= pageCount}
            >
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Kind</TH>
                <TH>Name</TH>
                <TH>Size</TH>
                <TH>Duration</TH>
                <TH>Remote</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {runs.length === 0 && (
                <TR>
                  <TD colSpan={7} className="py-6 text-center text-muted-foreground">
                    No runs recorded yet.
                  </TD>
                </TR>
              )}
              {runs.map((r) => (
                <TR key={r.id}>
                  <TD className="whitespace-nowrap font-mono text-xs">
                    {new Date(r.run_at).toLocaleString()}
                  </TD>
                  <TD>{r.kind}</TD>
                  <TD className="max-w-[220px] truncate font-mono text-xs" title={r.name}>
                    {r.name}
                  </TD>
                  <TD>{human(r.size_bytes)}</TD>
                  <TD>{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</TD>
                  <TD className="max-w-[160px] truncate text-xs" title={r.remote}>
                    {r.remote}
                  </TD>
                  <TD>
                    <Badge
                      variant={
                        r.status === 'ok'
                          ? 'success'
                          : r.status === 'failed'
                            ? 'destructive'
                            : 'secondary'
                      }
                    >
                      {r.status}
                    </Badge>
                    {r.error && (
                      <span className={cn('ml-2 text-xs text-muted-foreground')} title={r.error}>
                        {r.error.slice(0, 40)}
                      </span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <RestoreDialog open={restoreOpen} onClose={() => setRestoreOpen(false)} />
    </div>
  );
}
