'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Cloud,
  Download,
  HardDriveDownload,
  Loader2,
  Play,
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
  Switch,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  Textarea,
} from '@/components/ui';
import { RestoreDialog } from '@/components/restore-dialog';
import { cn } from '@/lib/cn';
import { useMe } from '@/lib/use-me';

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

/** Build output is verbose; keep the tail so the failure is still visible. */
function trimOutput(text: string, max = 3000): string {
  if (text.length <= max) return text;
  return `…(${text.length - max} earlier characters omitted)\n${text.slice(-max)}`;
}

function readPath(obj: Record<string, unknown>, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

export default function DashboardPage() {
  const { me, loading: meLoading, can } = useMe();

  const [status, setStatus] = useState<Status | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [daemon, setDaemon] = useState<DaemonInfo | null>(null);
  const [bin, setBin] = useState<BinaryInfo | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const [world, setWorld] = useState(false);
  const [noPtero, setNoPtero] = useState(true);
  const [force, setForce] = useState(false);

  const [time, setTime] = useState('03:30');
  const [perDay, setPerDay] = useState('1');
  const [worldTimes, setWorldTimes] = useState('');
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleMsg, setScheduleMsg] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    const res = await fetch('/api/status');
    if (res.ok) setStatus((await res.json()) as Status);
  }, []);

  const loadRuns = useCallback(async () => {
    const res = await fetch('/api/history?limit=25');
    if (res.ok) {
      const data = (await res.json()) as { runs?: RunRow[] };
      setRuns(data.runs ?? []);
    }
  }, []);

  const loadSchedule = useCallback(async () => {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const data = (await res.json()) as { config?: Record<string, unknown> };
    const cfg = data.config ?? {};
    setTime(String(readPath(cfg, 'backup.time') ?? '03:30'));
    setPerDay(String(readPath(cfg, 'backup.backups_per_day') ?? '1'));
    const times = readPath(cfg, 'world_backup.times');
    setWorldTimes(Array.isArray(times) ? times.join('\n') : '');
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
    void loadRuns();
    void loadSchedule();
    void loadDaemon();
    void loadBinary();
    const t = setInterval(() => void loadStatus(), 5000);
    const t2 = setInterval(() => void loadRuns(), 20000);
    const t3 = setInterval(() => void loadDaemon(), 15000);
    const t4 = setInterval(() => void loadBinary(), 60000);
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      clearInterval(t);
      clearInterval(t2);
      clearInterval(t3);
      clearInterval(t4);
      clearInterval(tick);
    };
  }, [loadStatus, loadRuns, loadSchedule, loadDaemon, loadBinary]);

  async function doAction(action: string, options: Record<string, unknown> = {}) {
    setBusy(action);
    setOutput(`$ ${action} …\n`);
    try {
      const res = await fetch('/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, options }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        code?: number | null;
        output?: string;
        error?: string;
      };
      setOutput(`${data.output ?? data.error ?? '(no output)'}\n\n[exit ${data.code ?? '?'}]`);
      await loadStatus();
      await loadRuns();
    } finally {
      setBusy(null);
    }
  }

  async function controlDaemon(action: 'start' | 'stop' | 'restart') {
    setBusy(`daemon-${action}`);
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
      setOutput(`$ pm2 ${action}\n${data.output ?? data.error ?? ''}\n\n[exit ${data.code ?? '?'}]`);
      if (data.status) setDaemon(data.status);
    } finally {
      setBusy(null);
    }
  }

  async function rebuildBinary() {
    setBusy('rebuild');
    setOutput('$ cargo build --release && sudo -n install -m 0755 target/release/backup-mgr …\n');
    try {
      const res = await fetch('/api/binary/install', { method: 'POST' });
      const data = (await res.json()) as {
        ok?: boolean;
        steps?: { step: string; ok: boolean; code: number | null; output: string }[];
        install_command?: string;
        hint?: string;
        error?: string;
      };
      if (data.error) {
        setOutput(`${data.error}\n`);
      } else {
        const body = (data.steps ?? [])
          .map(
            (s) =>
              `${s.ok ? '✓' : '✗'} ${s.step}  [exit ${s.code ?? '?'}]\n${trimOutput(s.output)}`,
          )
          .join('\n\n');
        setOutput(
          `${body}\n\n${data.hint ?? ''}\n\nmanual fallback:\n  ${data.install_command ?? ''}`.trim(),
        );
      }
      await loadBinary();
      await loadDaemon();
    } finally {
      setBusy(null);
    }
  }

  async function saveSchedule() {
    setSavingSchedule(true);
    setScheduleMsg(null);
    try {
      const res = await fetch('/api/schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          values: {
            'backup.time': time,
            'backup.backups_per_day': perDay,
            'world_backup.times': worldTimes
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          },
        }),
      });
      const data = (await res.json()) as { error?: string; updated?: string[] };
      setScheduleMsg(
        res.ok ? 'Schedule saved. Restart the daemon to apply.' : data.error ?? 'Save failed',
      );
    } finally {
      setSavingSchedule(false);
    }
  }

  const state = status?.state;
  const ok = state?.status === 'ok' && !state?.requires_manual_resume;
  const nextMs = status?.next_run_at ? new Date(status.next_run_at).getTime() : null;

  if (!meLoading && !can('dashboard.view')) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        Your account does not have the <code className="font-mono">dashboard.view</code>{' '}
        permission. Ask an admin to grant it.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
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
                : ''}
              {' '}
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
              <p className="font-medium">
                The daemon is still running an older backup-mgr
              </p>
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
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>State</CardDescription>
            <CardTitle className="flex items-center gap-2 text-lg">
              {ok ? (
                <CheckCircle2 className="h-5 w-5 text-success" />
              ) : (
                <XCircle className="h-5 w-5 text-destructive" />
              )}
              {state?.stage ?? '—'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            <Badge variant={ok ? 'success' : 'destructive'}>{state?.status ?? 'unknown'}</Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Last run</CardDescription>
            <CardTitle className="text-sm">
              {state?.last_run_at ? new Date(state.last_run_at).toLocaleString() : 'never'}
            </CardTitle>
          </CardHeader>
          <CardContent className="truncate text-xs text-muted-foreground">
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
              <HardDriveDownload className="h-4 w-4 text-primary" />
              {status?.config.compression ?? '—'}
            </CardTitle>
          </CardHeader>
          <CardContent className="truncate text-xs text-muted-foreground">
            {status?.config.backup_path ?? '—'}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Remotes</CardDescription>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Cloud className="h-4 w-4 text-primary" />
              {status?.remotes.length ?? 0}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs text-muted-foreground">
            {status?.remotes.map((r) => (
              <div key={r.label} className="truncate">
                {r.label} · keep {r.retention}
              </div>
            ))}
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
              onClick={() => void doAction('run', { world, noPtero, force })}
              disabled={busy !== null || !can('backup.run')}
            >
              {busy === 'run' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Run backup now
            </Button>
            <Button
              variant="secondary"
              onClick={() => void doAction('run', { world, noPtero, dryRun: true })}
              disabled={busy !== null || !can('backup.run')}
            >
              <Terminal className="h-4 w-4" /> Dry run
            </Button>
            <Button
              variant="secondary"
              onClick={() => void doAction('test-compress')}
              disabled={busy !== null || !can('backup.run')}
            >
              Test compression
            </Button>
            <Button
              variant="secondary"
              onClick={() => void doAction('check')}
              disabled={busy !== null || !can('backup.check')}
            >
              <ShieldCheck className="h-4 w-4" /> Check integrity
            </Button>
            <Button
              variant="secondary"
              onClick={() => void doAction('restore-list')}
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
              onClick={() => void doAction('fix-perms')}
              disabled={busy !== null || !can('backup.fix_perms')}
            >
              <Wrench className="h-4 w-4" /> Fix permissions
            </Button>
            <Button
              variant="outline"
              onClick={() => void doAction('reset')}
              disabled={busy !== null || !can('backup.run')}
            >
              Reset state
            </Button>
          </div>

          <Textarea
            readOnly
            value={output}
            placeholder="Action output will appear here…"
            className="min-h-[160px] font-mono text-xs"
          />
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
          <CardDescription>
            When the daemon runs backups. (All other settings are on the Config page.)
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 md:grid-cols-3">
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
              value={perDay}
              onChange={(e) => setPerDay(e.target.value)}
              disabled={!can('backup.schedule')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="worldTimes">World backup times</Label>
            <Textarea
              id="worldTimes"
              value={worldTimes}
              onChange={(e) => setWorldTimes(e.target.value)}
              placeholder={'06:00\n12:00\n18:00'}
              className="min-h-[76px] font-mono text-xs"
              disabled={!can('backup.schedule')}
            />
          </div>
          <div className="flex items-center gap-3 md:col-span-3">
            <Button
              onClick={saveSchedule}
              disabled={savingSchedule || !can('backup.schedule')}
            >
              {savingSchedule && <Loader2 className="h-4 w-4 animate-spin" />}
              Save schedule
            </Button>
            {scheduleMsg && <span className="text-sm text-muted-foreground">{scheduleMsg}</span>}
          </div>
        </CardContent>
      </Card>

      {/* History */}
      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
          <CardDescription>Last 25 entries from the history database.</CardDescription>
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
