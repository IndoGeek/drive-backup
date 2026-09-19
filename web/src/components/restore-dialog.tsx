'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RotateCcw, ShieldCheck, X } from 'lucide-react';
import {
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
  Textarea,
} from '@/components/ui';

type BackupEntry = { name: string; source: string; size: number; modified?: string };

function human(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${bytes} B` : `${v.toFixed(2)} ${units[u]}`;
}

export function RestoreDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [selected, setSelected] = useState('');
  const [target, setTarget] = useState('');
  const [force, setForce] = useState(false);
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/restore');
    const data = (await res.json()) as { backups?: BackupEntry[]; error?: string };
    const list = data.backups ?? [];
    setBackups(list);
    setSelected((prev) => prev || list[0]?.name || '');
    if (data.error) setOutput(`error: ${data.error}`);
  }, []);

  useEffect(() => {
    if (open) {
      setOutput('');
      void load();
    }
  }, [open, load]);

  async function runAction(action: string, options: Record<string, unknown>) {
    setBusy(action);
    setOutput(`$ ${action} …\n`);
    try {
      const res = await fetch('/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, options }),
      });
      const data = (await res.json()) as { output?: string; error?: string; code?: number | null };
      setOutput(`${data.output ?? data.error ?? '(no output)'}\n\n[exit ${data.code ?? '?'}]`);
    } finally {
      setBusy(null);
    }
  }

  if (!open) return null;

  const current = backups.find((b) => b.name === selected);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <Card className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <RotateCcw className="h-4 w-4 text-primary" /> Restore a backup
              </CardTitle>
              <CardDescription>
                Pick a remote or local archive, verify it, then restore it.
              </CardDescription>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="backup">Backup</Label>
              <Select
                id="backup"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                disabled={backups.length === 0}
              >
                {backups.length === 0 && <option value="">(no backups found)</option>}
                {backups.map((b) => (
                  <option key={`${b.source}:${b.name}`} value={b.name}>
                    {b.name} — {b.source} ({human(b.size)})
                  </option>
                ))}
              </Select>
              {current && (
                <p className="text-xs text-muted-foreground">
                  Source: <span className="font-mono">{current.source}</span>
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="target">Target directory (optional)</Label>
              <Input
                id="target"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="defaults to <backup-dir>/restore"
              />
            </div>

            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={force} onCheckedChange={setForce} /> Force (ignore hash mismatch)
              </label>
            </div>
          </div>

          {force && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <span>
                <strong className="text-destructive">--force</strong> extracts even when the archive
                hash does not match the manifest. Only use this if you understand the risk.
              </span>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={!selected || busy !== null}
              onClick={() => void runAction('check', { file: selected })}
            >
              {busy === 'check' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Verify
            </Button>
            <Button
              disabled={!selected || busy !== null}
              onClick={() =>
                void runAction('restore', {
                  file: selected,
                  target: target.trim() || undefined,
                  force,
                })
              }
            >
              {busy === 'restore' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              Restore
            </Button>
            <Button variant="outline" onClick={() => void load()} disabled={busy !== null}>
              Refresh list
            </Button>
          </div>

          <Textarea
            readOnly
            value={output}
            placeholder="Verification / restore output will appear here…"
            className="min-h-[150px] font-mono text-xs"
          />
        </CardContent>
      </Card>
    </div>
  );
}
