'use client';

import { useState } from 'react';
import { DatabaseBackup, Loader2 } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@/components/ui';

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;

    // Read the values off the DOM rather than from React state. Password
    // managers autofill inputs *without* firing the events state is synced on,
    // which used to leave the fields looking filled while state stayed empty —
    // so the button never enabled. Values are only ever read on submit.
    const form = e.currentTarget;
    const username = (form.elements.namedItem('username') as HTMLInputElement | null)?.value.trim() ?? '';
    const password = (form.elements.namedItem('password') as HTMLInputElement | null)?.value ?? '';
    if (!username || !password) {
      setError('Enter your username and password.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        user?: { must_change_password?: boolean };
      };
      if (res.ok) {
        // A default/admin-assigned password must be replaced before anything else.
        window.location.href = data.user?.must_change_password ? '/users' : '/';
        return;
      }
      setError(data.error ?? `Sign-in failed (HTTP ${res.status})`);
    } catch {
      setError('Network error — could not reach the panel.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm items-center">
      <Card className="w-full">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2 text-primary">
            <DatabaseBackup className="h-5 w-5" />
            <span className="text-sm font-semibold uppercase tracking-wide">backup-mgr</span>
          </div>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Enter your username and password to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                name="username"
                autoFocus
                autoComplete="username"
                defaultValue="admin"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Sign in
            </Button>
          </form>
          <p className="mt-4 text-xs text-muted-foreground">
            First run creates a default admin — username <code className="font-mono">admin</code>,
            password <code className="font-mono">admin</code>. You will be required to choose a new
            password before the panel will do anything else.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
