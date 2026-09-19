'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { Button, Input, Label } from '@/components/ui';

/**
 * The sudo prompt, client side.
 *
 * Privileged routes answer `428 { sudo_required }` when the acting account's sudo
 * would ask for a password. One dialog lives here (mounted by the layout), and
 * `fetchElevated` turns that into: ask → POST /api/sudo → retry once. When the
 * account's sudo is NOPASSWD the route never answers 428, so nothing is ever asked
 * — the OS decides, not the panel.
 */

type Pending = { action: string; resolve: (ok: boolean) => void };

/** What `/api/sudo` reports about the signed-in account. */
export type SudoState = {
  has_sudo: boolean;
  passwordless: boolean | null;
  source: string;
  elevated_until: string | null;
  timeout_ms: number;
};

type ElevationContext = {
  /** fetch, but with the sudo prompt handled: ask once, then retry. */
  fetchElevated: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Ask for the sudo password now, without waiting for a privileged action. */
  requestElevation: (action: string) => Promise<boolean>;
  /** End the grant early, like `sudo -k`. */
  endElevation: () => Promise<void>;
  /** True while an elevation grant is active (until it lapses or is ended). */
  elevated: boolean;
  /** The live status, or null before it has been read. */
  sudo: SudoState | null;
  refresh: () => void;
};

const Ctx = createContext<ElevationContext | null>(null);

export function SudoProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [sudo, setSudo] = useState<SudoState | null>(null);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const res = await fetch('/api/sudo');
        if (!res.ok) return;
        const data = (await res.json()) as { sudo?: SudoState };
        if (data.sudo) setSudo(data.sudo);
      } catch {
        // The dialog reports real failures; this is only a status chip.
      }
    })();
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Open the dialog and resolve with whether a grant was opened. */
  const promptFor = useCallback(
    (action: string) =>
      new Promise<boolean>((resolve) => {
        setPending({ action, resolve });
      }),
    [],
  );

  const requestElevation = useCallback(
    async (action: string) => {
      const granted = await promptFor(action);
      if (granted) refresh();
      return granted;
    },
    [promptFor, refresh],
  );

  const endElevation = useCallback(async () => {
    await fetch('/api/sudo', { method: 'DELETE' });
    refresh();
  }, [refresh]);

  const fetchElevated = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const first = await fetch(input, init);
      if (first.status !== 428) return first;

      const data = (await first
        .clone()
        .json()
        .catch(() => ({}))) as { sudo_required?: boolean; action?: string; error?: string };
      if (!data.sudo_required) return first;

      const granted = await promptFor(data.action ?? 'this action');
      if (!granted) return first;
      refresh();

      // The request body is a plain string in every caller here, so retrying it is
      // safe. A stream body would need to be rebuilt, hence the check.
      if (init?.body && typeof init.body !== 'string' && !(init.body instanceof FormData)) {
        return first;
      }
      return fetch(input, init);
    },
    [promptFor, refresh],
  );

  const value = useMemo(
    () => ({
      fetchElevated,
      requestElevation,
      endElevation,
      elevated: Boolean(sudo?.elevated_until),
      sudo,
      refresh,
    }),
    [fetchElevated, requestElevation, endElevation, sudo, refresh],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {pending && (
        <SudoDialog
          action={pending.action}
          onDone={(ok) => {
            setPending(null);
            if (ok) refresh();
            pending.resolve(ok);
          }}
        />
      )}
    </Ctx.Provider>
  );
}

export function useSudo(): ElevationContext {
  const ctx = useContext(Ctx);
  if (!ctx) {
    // Pages rendered outside the provider (or during a static export) still work,
    // they just cannot elevate.
    return {
      fetchElevated: (input, init) => fetch(input, init),
      requestElevation: async () => false,
      endElevation: async () => {},
      elevated: false,
      sudo: null,
      refresh: () => {},
    };
  }
  return ctx;
}

function SudoDialog({ action, onDone }: { action: string; onDone: (ok: boolean) => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    // Read from the DOM: password managers autofill without firing React's onChange.
    const value =
      (e.currentTarget.elements.namedItem('sudo_password') as HTMLInputElement | null)?.value ?? '';
    if (!value) {
      setError('Enter your password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/sudo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: value }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setPassword('');
        onDone(true);
        return;
      }
      setError(data.error ?? `Could not elevate (HTTP ${res.status})`);
    } catch {
      setError('Network error — could not reach the panel.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="sudo password required"
    >
      <form
        onSubmit={submit}
        className="max-h-[90vh] w-full max-w-sm space-y-4 overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-xl"
      >
        <div className="flex items-center gap-2 text-primary">
          <ShieldCheck className="h-5 w-5" />
          <h2 className="text-sm font-semibold uppercase tracking-wide">sudo required</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          To {action}, the panel runs the command under <strong>your</strong> sudo. Enter your Linux
          password — the same one sudo asks for. You won&apos;t be asked again for a while.
        </p>
        <div className="space-y-2">
          <Label htmlFor="sudo_password">Password</Label>
          <Input
            id="sudo_password"
            name="sudo_password"
            type="password"
            autoFocus
            autoComplete="current-password"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Elevate
          </Button>
          <Button type="button" variant="outline" onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The password is verified against your account on this server and held only in the panel&apos;s
          memory, for this login, until the sudo timeout lapses or you sign out.
        </p>
      </form>
    </div>
  );
}
