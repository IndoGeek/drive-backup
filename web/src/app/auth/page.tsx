'use client';

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardPaste,
  Copy,
  ExternalLink,
  HardDrive,
  KeyRound,
  Loader2,
  Server,
  XCircle,
} from 'lucide-react';
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
  Textarea,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMe } from '@/lib/use-me';

type Job = {
  id: string;
  method: 'browser' | 'client';
  url?: string;
  output: string;
  done: boolean;
  ok: boolean;
  error?: string;
  hasToken: boolean;
};

type Target = 'primary' | 'secondary';
type Backend = 'drive' | 'b2';
type Method = 'browser' | 'client' | 'paste';
type PasteInfo = { client_id: string; has_client_secret: boolean };

export default function AuthPage() {
  const { loading: meLoading, can } = useMe();

  const [target, setTarget] = useState<Target>('primary');
  const [backend, setBackend] = useState<Backend>('drive');
  const [method, setMethod] = useState<Method>('browser');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [pasteToken, setPasteToken] = useState('');
  const [pasteInfo, setPasteInfo] = useState<PasteInfo | null>(null);

  const [b2Remote, setB2Remote] = useState('b2');
  const [b2Account, setB2Account] = useState('');
  const [b2Key, setB2Key] = useState('');

  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const isDrive = target === 'primary' || backend === 'drive';

  // Must match `google_drive.client_id` / `storage.secondary.client_id` in
  // config.yml: drive.rs only passes client creds to rclone when they are
  // non-empty, so a blank pair means rclone's own built-in client.
  const pasteCmd = pasteInfo?.client_id
    ? `rclone authorize "drive" "${pasteInfo.client_id}" "<client_secret>"`
    : 'rclone authorize "drive"';

  useEffect(() => {
    if (!job || job.done) return;
    const t = setInterval(async () => {
      const res = await fetch(`/api/rclone/status?id=${encodeURIComponent(job.id)}`);
      if (res.ok) setJob((await res.json()) as Job);
    }, 2000);
    return () => clearInterval(t);
  }, [job]);

  /**
   * The paste flow only works if the token was minted for the same OAuth client
   * this remote will refresh with, so ask the server which one that is.
   */
  useEffect(() => {
    if (!isDrive || method !== 'paste') return;
    let alive = true;
    (async () => {
      const res = await fetch(`/api/rclone/paste?target=${target}`);
      if (!res.ok) return;
      const data = (await res.json()) as PasteInfo;
      if (alive) setPasteInfo(data);
    })();
    return () => {
      alive = false;
    };
  }, [isDrive, method, target]);

  function resetMessages() {
    setError(null);
    setMessage(null);
  }

  async function start() {
    setBusy(true);
    resetMessages();
    try {
      const res = await fetch('/api/rclone/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          method === 'client' ? { method, clientId, clientSecret } : { method },
        ),
      });
      const data = (await res.json()) as Job & { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'Could not start authorization');
        return;
      }
      setJob(data);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!job) return;
    setBusy(true);
    resetMessages();
    try {
      const res = await fetch('/api/rclone/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.id, target }),
      });
      const data = (await res.json()) as { error?: string; saved?: string[] };
      if (!res.ok) {
        setError(data.error ?? 'Could not save token');
        return;
      }
      setMessage(`Token saved to config.yml (${data.saved?.join(', ')}).`);
    } finally {
      setBusy(false);
    }
  }

  async function savePaste() {
    setBusy(true);
    resetMessages();
    try {
      const res = await fetch('/api/rclone/paste', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, token: pasteToken }),
      });
      const data = (await res.json()) as { error?: string; target?: string };
      if (!res.ok) {
        setError(data.error ?? 'Could not save token');
        return;
      }
      setMessage(`Token saved to config.yml for ${data.target}.`);
      setPasteToken('');
    } finally {
      setBusy(false);
    }
  }

  async function saveB2() {
    setBusy(true);
    resetMessages();
    try {
      const res = await fetch('/api/rclone/b2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remote: b2Remote, account: b2Account, key: b2Key }),
      });
      const data = (await res.json()) as { error?: string; remote?: string };
      if (!res.ok) {
        setError(data.error ?? 'Could not create the B2 remote');
        return;
      }
      setMessage(`Created rclone remote '${data.remote}:'. Secondary storage enabled.`);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!job) return;
    await fetch('/api/rclone/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: job.id }),
    });
    setJob({ ...job, done: true, ok: false, error: 'cancelled' });
  }

  async function copyCmd() {
    await navigator.clipboard.writeText(pasteCmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function copyUrl() {
    if (!job?.url) return;
    await navigator.clipboard.writeText(job.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (!meLoading && !can('remote.auth')) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        Your account does not have the <code className="font-mono">remote.auth</code> permission.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Remote authorization</h1>
        <p className="text-sm text-muted-foreground">
          Authorize a storage remote. Drive tokens are written into{' '}
          <code className="font-mono">config.yml</code>; B2 credentials are stored by rclone.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Destination</CardTitle>
          <CardDescription>
            Authorize the primary remote, or the optional secondary (redundancy) remote.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              onClick={() => {
                setTarget('primary');
                setBackend('drive');
                setJob(null);
                resetMessages();
              }}
              className={cn(
                'rounded-lg border p-4 text-left transition-colors',
                target === 'primary'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-accent',
              )}
            >
              <div className="flex items-center gap-2 font-medium">
                <HardDrive className="h-4 w-4 text-primary" /> Primary (Google Drive)
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                The main destination for your backups.
              </p>
            </button>
            <button
              onClick={() => {
                setTarget('secondary');
                setJob(null);
                resetMessages();
              }}
              className={cn(
                'rounded-lg border p-4 text-left transition-colors',
                target === 'secondary'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-accent',
              )}
            >
              <div className="flex items-center gap-2 font-medium">
                <Server className="h-4 w-4 text-primary" /> Secondary (redundancy)
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                A second Drive, or Backblaze B2 / another object store.
              </p>
            </button>
          </div>

          {target === 'secondary' && (
            <div className="space-y-2">
              <Label htmlFor="backend">Secondary backend</Label>
              <Select
                id="backend"
                value={backend}
                onChange={(e) => {
                  setBackend(e.target.value as Backend);
                  setJob(null);
                  resetMessages();
                }}
              >
                <option value="drive">Google Drive (OAuth)</option>
                <option value="b2">Backblaze B2 (account + key)</option>
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      {isDrive ? (
        <Card>
          <CardHeader>
            <CardTitle>Method</CardTitle>
            <CardDescription>
              Browser auth if the panel is reachable from your browser, or paste a token from
              another machine.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <button
                onClick={() => setMethod('browser')}
                className={cn(
                  'rounded-lg border p-4 text-left transition-colors',
                  method === 'browser'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-accent',
                )}
              >
                <div className="flex items-center gap-2 font-medium">
                  <KeyRound className="h-4 w-4 text-primary" /> Browser auth
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  No client ID; uses rclone&apos;s built-in Google client.
                </p>
              </button>
              <button
                onClick={() => setMethod('client')}
                className={cn(
                  'rounded-lg border p-4 text-left transition-colors',
                  method === 'client'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-accent',
                )}
              >
                <div className="flex items-center gap-2 font-medium">
                  <KeyRound className="h-4 w-4 text-primary" /> Client ID &amp; secret
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Use your own Google Cloud OAuth client.
                </p>
              </button>
              <button
                onClick={() => setMethod('paste')}
                className={cn(
                  'rounded-lg border p-4 text-left transition-colors',
                  method === 'paste'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-accent',
                )}
              >
                <div className="flex items-center gap-2 font-medium">
                  <ClipboardPaste className="h-4 w-4 text-primary" /> Paste token
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Run <code className="font-mono">rclone authorize</code> on any machine with a
                  browser (your laptop is fine) and paste the token.
                </p>
              </button>
            </div>

            {method === 'client' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="cid">Client ID</Label>
                  <Input
                    id="cid"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder="xxxxxxxx.apps.googleusercontent.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="csecret">Client secret</Label>
                  <Input
                    id="csecret"
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                  />
                </div>
              </div>
            )}

            {method === 'paste' ? (
              <div className="space-y-3">
                <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
                  <p className="font-medium">
                    Run this on any machine with a browser — it does not have to be the VPS, and the
                    shell user does not matter:
                  </p>
                  <div className="mt-2 flex items-start gap-2">
                    <pre className="flex-1 overflow-x-auto rounded bg-background/70 p-2 font-mono text-[11px]">
                      {pasteCmd}
                    </pre>
                    <Button variant="outline" size="sm" onClick={copyCmd}>
                      <Copy className="h-3.5 w-3.5" /> {copied ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                  {pasteInfo?.client_id ? (
                    <p className="mt-2 text-muted-foreground">
                      This remote has a client ID in <code className="font-mono">config.yml</code>,
                      so it <strong>must</strong> be passed above — replace{' '}
                      <code className="font-mono">&lt;client_secret&gt;</code> with the matching
                      secret from the Config page. A token issued with rclone&apos;s built-in client
                      authorizes fine but stops working about an hour later, when it first tries to
                      refresh.
                    </p>
                  ) : (
                    <p className="mt-2 text-muted-foreground">
                      No client ID is set for this remote, so rclone&apos;s built-in client is used
                      and no extra arguments are needed. If you later add a client ID on the Config
                      page, re-run authorization with it.
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="paste">Pasted token (JSON or full rclone output)</Label>
                  <Textarea
                    id="paste"
                    value={pasteToken}
                    onChange={(e) => setPasteToken(e.target.value)}
                    placeholder='{"access_token":"…","token_type":"Bearer","refresh_token":"…","expiry":"…"}'
                    className="min-h-[120px] font-mono text-xs"
                  />
                </div>
                <Button onClick={savePaste} disabled={busy || !pasteToken.trim()}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Save pasted token
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <Button onClick={start} disabled={busy || (job !== null && !job.done)}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Start authorization
                </Button>
                {job && !job.done && (
                  <Button variant="outline" onClick={cancel}>
                    Cancel
                  </Button>
                )}
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
            {message && <p className="text-sm text-success">{message}</p>}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Backblaze B2 credentials</CardTitle>
            <CardDescription>
              Creates the rclone remote and enables the secondary destination.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="b2remote">rclone remote name</Label>
                <Input id="b2remote" value={b2Remote} onChange={(e) => setB2Remote(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="b2acct">Application key ID</Label>
                <Input id="b2acct" value={b2Account} onChange={(e) => setB2Account(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="b2key">Application key</Label>
                <Input
                  id="b2key"
                  type="password"
                  value={b2Key}
                  onChange={(e) => setB2Key(e.target.value)}
                />
              </div>
            </div>
            <Button onClick={saveB2} disabled={busy || !b2Remote || !b2Account || !b2Key}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Save B2 credentials
            </Button>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {message && <p className="text-sm text-success">{message}</p>}
          </CardContent>
        </Card>
      )}

      {job && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {job.done ? (
                job.ok ? (
                  <CheckCircle2 className="h-4 w-4 text-success" />
                ) : (
                  <XCircle className="h-4 w-4 text-destructive" />
                )
              ) : (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              )}
              {job.done ? (job.ok ? 'Authorized' : 'Authorization failed') : 'Waiting for authorization'}
            </CardTitle>
            <CardDescription>
              Open the link below, sign in, and approve access. rclone completes automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {job.url && (
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={job.url}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all font-mono text-xs text-primary underline"
                >
                  {job.url} <ExternalLink className="inline h-3 w-3" />
                </a>
                <Button variant="outline" size="sm" onClick={copyUrl}>
                  <Copy className="h-3.5 w-3.5" /> {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            )}

            {!job.url && !job.done && (
              <p className="text-sm text-muted-foreground">
                Waiting for rclone to print the authorization URL…
              </p>
            )}

            {job.done && job.ok && (
              <Button onClick={save} disabled={busy}>
                Save token to config.yml (
                {target === 'secondary' ? 'storage.secondary' : 'google_drive'})
              </Button>
            )}

            {job.error && <p className="text-sm text-destructive">{job.error}</p>}

            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">rclone output</summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-background/60 p-3 font-mono text-[11px]">
                {job.output || '(no output yet)'}
              </pre>
            </details>

            <p className="text-xs text-muted-foreground">
              Tip: rclone&apos;s callback is <code className="font-mono">127.0.0.1:53682</code> on
              the <strong>server</strong>, so a browser on your own machine cannot reach it unless
              you tunnel it (
              <code className="font-mono">ssh -L 53682:127.0.0.1:53682 you@vps</code>). Otherwise
              use the <strong>Paste token</strong> method.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
