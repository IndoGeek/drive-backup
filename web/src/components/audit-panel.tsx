'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';

/**
 * The privileged-action trail: who elevated, what changed, when.
 *
 * Unlike the other log tabs this is not a file being tailed — it is the panel's own
 * database — so it polls rather than streaming, and it is only offered to accounts
 * that may manage users.
 */

type Entry = {
  id: number;
  at: string;
  username: string;
  action: string;
  outcome: string;
  detail: Record<string, unknown>;
  via: string | null;
  address: string | null;
  error: string | null;
};

type Variant = 'default' | 'secondary' | 'destructive' | 'success';

const OUTCOME: Record<string, Variant> = {
  elevated: 'success',
  allowed: 'default',
  prompted: 'secondary',
  elevation_ended: 'secondary',
  denied: 'destructive',
  failed: 'destructive',
};

/** One line describing the change, e.g. `target=bob permissions=["dashboard.view"]`. */
function summarise(detail: Record<string, unknown>): string {
  const parts = Object.entries(detail)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return parts.join(' · ');
}

export function AuditPanel() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/audit?limit=200');
      const data = (await res.json().catch(() => ({}))) as {
        entries?: Entry[];
        total?: number;
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? `Could not read the audit trail (HTTP ${res.status})`);
        return;
      }
      setEntries(data.entries ?? []);
      setTotal(data.total ?? 0);
      setError(null);
    } catch {
      setError('Network error — could not reach the panel.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Not a stream: the trail changes only when someone does something privileged.
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Privileged actions
            {total > 0 && <Badge variant="secondary">{total} recorded</Badge>}
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
        <CardDescription>
          Elevation and every change made with it: managing users, reinstalling the binary, and acting
          on another account&apos;s instance. Reads are not recorded, and no password ever is. Newest
          first, refreshed every 10s.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
        {loading && entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading…
          </p>
        ) : entries.length === 0 ? (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            Nothing privileged has happened yet on this panel.
          </p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Account</TH>
                <TH>Action</TH>
                <TH>Outcome</TH>
                <TH>What changed</TH>
              </TR>
            </THead>
            <TBody>
              {entries.map((e) => (
                <TR key={e.id}>
                  <TD className="whitespace-nowrap text-xs text-muted-foreground">
                    {new Date(e.at).toLocaleString()}
                  </TD>
                  <TD className="font-mono text-xs">{e.username}</TD>
                  <TD className="text-xs">
                    {e.action}
                    {e.via && (
                      <span className="ml-1 text-muted-foreground">({e.via})</span>
                    )}
                  </TD>
                  <TD>
                    <Badge variant={OUTCOME[e.outcome] ?? 'secondary'}>{e.outcome}</Badge>
                    {e.address && e.address !== 'local' && (
                      <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                        {e.address}
                      </span>
                    )}
                  </TD>
                  <TD className="max-w-[320px] break-all font-mono text-[11px] text-muted-foreground">
                    {summarise(e.detail) || '—'}
                    {e.error && <span className="block text-destructive">{e.error}</span>}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
