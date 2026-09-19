'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Download,
  FileText,
  Loader2,
  Radio,
  RefreshCw,
  ScrollText,
  ShieldCheck,
} from 'lucide-react';
import { AuditPanel } from '@/components/audit-panel';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Switch,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMe } from '@/lib/use-me';

type LogFile = { name: string; size: number; mtime: string };
type LogSource = {
  id: string;
  label: string;
  description: string;
  dir: string;
  files: LogFile[];
};

function human(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${bytes} B` : `${v.toFixed(1)} ${units[u]}`;
}

const isErrorLog = (name: string) => /error/i.test(name);

/** The one tab that is not a file: the privileged-action audit trail. */
const AUDIT_TAB = 'audit';
const isAuditTab = (id: string | undefined) => id === AUDIT_TAB;

export default function LogsPage() {
  const { loading: meLoading, can } = useMe();
  const [sources, setSources] = useState<LogSource[]>([]);
  const [activeId, setActiveId] = useState<string>('backup');
  /** Remember the chosen file per tab. */
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [content, setContent] = useState('');
  const [live, setLive] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);

  const loadSources = useCallback(async () => {
    const res = await fetch('/api/logs');
    if (!res.ok) return;
    const data = (await res.json()) as { sources?: LogSource[] };
    setSources(data.sources ?? []);
  }, []);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  // The audit trail is not a file: it is a tab of its own, for admins only.
  const canAudit = can('users.manage');
  const auditTabs: LogSource[] = canAudit
    ? [
        {
          id: AUDIT_TAB,
          label: 'Privileged',
          description: 'Who elevated, and what they changed with it.',
          dir: 'panel database',
          files: [],
        },
      ]
    : [];
  const active = isAuditTab(activeId)
    ? auditTabs[0]
    : (sources.find((s) => s.id === activeId) ?? sources[0]);
  // Placeholder tab so the bar renders while the first request is in flight.
  const tabs: LogSource[] = [...(sources.length
    ? sources
    : [{ id: 'backup', label: 'Backup', description: '', dir: '', files: [] }]), ...auditTabs];
  const files = active?.files ?? [];
  // Derived, so a refresh doesn't clobber the user's choice; falls back to the
  // newest file in the tab until they pick one.
  const selected = (active && selection[active.id]) || files[0]?.name || null;

  // Open/close the stream when the tab, the file, or live mode changes.
  useEffect(() => {
    esRef.current?.close();
    esRef.current = null;
    setConnected(false);
    // The audit tab is rendered by AuditPanel; it has no file and no stream.
    if (!active || !selected || isAuditTab(active.id)) {
      setContent('');
      return;
    }

    const query = `source=${encodeURIComponent(active.id)}&file=${encodeURIComponent(selected)}`;

    if (!live) {
      setError(null);
      void (async () => {
        const res = await fetch(`/api/logs?${query}`);
        const data = (await res.json()) as { content?: string; error?: string };
        setContent(data.content ?? '');
        setError(data.error ?? null);
      })();
      return;
    }

    setContent('');
    setError(null);
    const es = new EventSource(`/api/logs/stream?${query}`);
    esRef.current = es;
    es.addEventListener('open', () => setConnected(true));
    es.addEventListener('data', (ev) => {
      setContent((prev) => {
        const next = prev + (ev as MessageEvent).data;
        return next.length > 400_000 ? next.slice(-400_000) : next;
      });
    });
    es.addEventListener('error', () => setConnected(false));
    es.onerror = () => setConnected(false);
    return () => {
      es.close();
      esRef.current = null;
    };
  }, [active, selected, live]);

  // Keep the view scrolled to the newest lines.
  useEffect(() => {
    if (live && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [content, live]);

  function download() {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = selected ?? 'log.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!meLoading && !can('logs.view')) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        Your account does not have the <code className="font-mono">logs.view</code> permission.
      </div>
    );
  }

  const onAuditTab = isAuditTab(activeId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">Logs</h1>
          <p className="text-sm text-muted-foreground">{active?.description ?? '—'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          {!onAuditTab && (
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={live} onCheckedChange={setLive} /> Live tail
            </label>
          )}
          <Button variant="outline" size="sm" onClick={() => void loadSources()}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        </div>
      </div>

      {/* One tab per kind of log. */}
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map((s) => {
          const on = s.id === active?.id;
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={on}
              onClick={() => setActiveId(s.id)}
              className={cn(
                '-mb-px flex items-center gap-2 rounded-t-md border-b-2 px-4 py-2 text-sm transition-colors',
                on
                  ? 'border-b-primary bg-secondary/40 text-foreground'
                  : 'border-b-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {isAuditTab(s.id) ? <ShieldCheck className="h-4 w-4" /> : <ScrollText className="h-4 w-4" />}
              {s.label}
              {!isAuditTab(s.id) && (
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {s.files.length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {onAuditTab ? (
        <AuditPanel />
      ) : (
      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-sm">Files</CardTitle>
            <CardDescription className="break-all font-mono text-[11px]">
              {active?.dir ?? '—'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 p-2 pt-0">
            {files.length === 0 && (
              <p className="px-3 py-2 text-sm text-muted-foreground">
                No files here yet.
              </p>
            )}
            {files.map((f) => (
              <button
                key={f.name}
                onClick={() => active && setSelection((prev) => ({ ...prev, [active.id]: f.name }))}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
                  selected === f.name ? 'bg-secondary' : 'hover:bg-accent',
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <FileText
                    className={cn(
                      'h-4 w-4 shrink-0',
                      isErrorLog(f.name) ? 'text-destructive' : 'text-muted-foreground',
                    )}
                  />
                  <span className="truncate">{f.name}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{human(f.size)}</span>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                {selected ?? 'Select a log file'}
                {isErrorLog(selected ?? '') && <Badge variant="destructive">errors</Badge>}
                {live && selected && (
                  <Badge variant={connected ? 'success' : 'secondary'}>
                    <Radio className="mr-1 h-3 w-3" />
                    {connected ? 'live' : 'connecting…'}
                  </Badge>
                )}
              </CardTitle>
              {selected && (
                <Button variant="outline" size="sm" onClick={download}>
                  <Download className="h-3.5 w-3.5" /> Download
                </Button>
              )}
            </div>
            <CardDescription>
              {live ? 'Streaming new lines as they are written.' : 'Showing the end of the file.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
            {!selected ? (
              <p className="text-sm text-muted-foreground">
                <Loader2 className="mr-2 inline h-4 w-4" />
                Pick a file on the left to view it.
              </p>
            ) : (
              <pre
                ref={preRef}
                className="max-h-[65vh] overflow-auto rounded-md border border-border bg-background/60 p-3 font-mono text-xs leading-relaxed"
              >
                {content || '(no output yet)'}
              </pre>
            )}
          </CardContent>
        </Card>
      </div>
      )}
    </div>
  );
}
