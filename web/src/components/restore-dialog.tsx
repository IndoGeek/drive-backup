'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, KeyRound, Loader2, Lock, RotateCcw, ShieldCheck, X } from 'lucide-react';
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

type EncryptionState = { enabled: boolean; has_passphrase: boolean; cipher: string | null };

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
  const [merge, setMerge] = useState(false);
  const [encryption, setEncryption] = useState<EncryptionState | null>(null);
  const [unlockedUntil, setUnlockedUntil] = useState<string | null>(null);
  const [askingPassphrase, setAskingPassphrase] = useState(false);
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/restore');
    const data = (await res.json()) as {
      backups?: BackupEntry[];
      error?: string;
      encryption?: EncryptionState;
      unlocked_until?: string | null;
    };
    const list = data.backups ?? [];
    setBackups(list);
    setSelected((prev) => prev || list[0]?.name || '');
    setEncryption(data.encryption ?? null);
    setUnlockedUntil(data.unlocked_until ?? null);
    if (data.error) setOutput(`error: ${data.error}`);
  }, []);

  const encrypted = Boolean(encryption?.enabled && encryption.has_passphrase);

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
      const data = (await res.json()) as {
        output?: string;
        error?: string;
        code?: number | null;
        passphrase_required?: boolean;
      };
      if (res.status === 428 && data.passphrase_required) {
        setUnlockedUntil(null);
        setAskingPassphrase(true);
        setOutput(`${data.error ?? 'the encryption passphrase is required again'}\n`);
        return;
      }
      setOutput(`${data.output ?? data.error ?? '(no output)'}\n\n[exit ${data.code ?? '?'}]`);
    } finally {
      setBusy(null);
    }
  }

  async function confirmPassphrase(passphrase: string): Promise<string | null> {
    try {
      const res = await fetch('/api/restore/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        required?: boolean;
        unlocked_until?: string | null;
      };
      if (!res.ok) return data.error ?? `Could not confirm it (HTTP ${res.status})`;
      setUnlockedUntil(data.required ? (data.unlocked_until ?? null) : null);
      setAskingPassphrase(false);
      setOutput(`$ passphrase confirmed — starting the restore\n`);
      await runAction('restore', {
        file: selected,
        target: target.trim() || undefined,
        force,
        merge,
      });
      return null;
    } catch {
      return 'Network error — could not reach the panel.';
    }
  }

  if (!open) return null;

  const current = backups.find((b) => b.name === selected);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <Card
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
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

            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={merge} onCheckedChange={setMerge} /> Merge (keep files that are
                not in the backup)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={force} onCheckedChange={setForce} /> Force (ignore hash mismatch)
              </label>
            </div>
          </div>

          {merge ? (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>
                The archive&apos;s files are written over the target and anything else in it is left
                in place, so the result can be a mix of the backup and whatever was there before.
              </span>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              <span>
                The target is <strong>emptied first</strong> and then refilled from the archive, so
                what you get is exactly this backup — nothing else. Extraction happens in a staging
                directory inside the target, so a failure or an interruption leaves the target as it
                was.
              </span>
            </div>
          )}

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
              onClick={() => {
                if (encrypted && !unlockedUntil) {
                  setAskingPassphrase(true);
                  return;
                }
                void runAction('restore', {
                  file: selected,
                  target: target.trim() || undefined,
                  force,
                  merge,
                });
              }}
            >
              {busy === 'restore' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : encrypted && !unlockedUntil ? (
                <Lock className="h-4 w-4" />
              ) : (
                <RotateCcw className="h-4 w-4" />
              )}
              {encrypted && !unlockedUntil ? 'Restore…' : 'Restore'}
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

      {askingPassphrase && (
        <PassphraseDialog
          cipher={encryption?.cipher ?? null}
          onCancel={() => setAskingPassphrase(false)}
          onSubmit={confirmPassphrase}
        />
      )}
    </div>
  );
}

function PassphraseDialog({
  cipher,
  onCancel,
  onSubmit,
}: {
  cipher: string | null;
  onCancel: () => void;
  onSubmit: (passphrase: string) => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const value =
      (e.currentTarget.elements.namedItem('restore_passphrase') as HTMLInputElement | null)?.value ??
      '';
    if (!value) {
      setError('Enter the passphrase.');
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await onSubmit(value);
    setBusy(false);
    if (failure) setError(failure);
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="encryption passphrase required"
      onClick={(e) => e.stopPropagation()}
    >
      <form
        onSubmit={submit}
        className="max-h-[90vh] w-full max-w-sm space-y-4 overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-xl"
      >
        <div className="flex items-center gap-2 text-primary">
          <KeyRound className="h-5 w-5" />
          <h2 className="text-sm font-semibold uppercase tracking-wide">Passphrase required</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          This account encrypts its archives{cipher ? ` with ${cipher}` : ''}, so restoring one needs
          the encryption passphrase from <code className="font-mono">config.yml</code>. Enter it to
          continue — the restore starts as soon as it is confirmed.
        </p>
        <div className="space-y-2">
          <Label htmlFor="restore_passphrase">Passphrase</Label>
          <Input
            id="restore_passphrase"
            name="restore_passphrase"
            type="password"
            autoFocus
            autoComplete="off"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Confirm
          </Button>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          It is checked against this instance&apos;s config and only remembered in the panel&apos;s
          memory for your login, the same way a sudo password is.
        </p>
      </form>
    </div>
  );
}
