'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Info,
  Loader2,
  RefreshCw,
  Save,
  ShieldCheck,
  Terminal,
  UserCog,
  Users as UsersIcon,
  Wrench,
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
} from '@/components/ui';
import { PERMISSIONS, type Permission } from '@/lib/permissions';
import { useMe } from '@/lib/use-me';
import { useSudo } from '@/lib/sudo-client';
import { cn } from '@/lib/cn';

type User = {
  id: number;
  username: string;

  is_admin: boolean;
  sudo: { has_sudo: boolean; source: string; nopass_hint: boolean };
  permissions: Permission[];
  enabled: boolean;
  orphaned: boolean;
  instance: { os_user: string; root: string; config_path: string; pm2_name: string } | null;
  created_at: string;
};

type SudoState = {
  has_sudo: boolean;
  passwordless: boolean | null;
  source: string;
  elevated_until: string | null;
  timeout_ms: number;
};

type SyncState = {
  running: boolean;
  auto_sync: boolean;
  auto_provision: boolean;
  interval_ms: number;
  watching_file: string | null;
  last: { at: string; reason: string; added: string[]; missing: string[]; sourceOk: boolean } | null;
  provisioned: string[];
  errors: string[];
};

export default function UsersPage() {
  const { me, loading, can } = useMe();
  const { fetchElevated } = useSudo();
  const [users, setUsers] = useState<User[]>([]);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [mine, setMine] = useState<SudoState | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [formEnabled, setFormEnabled] = useState(true);
  const [formPerms, setFormPerms] = useState<Permission[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canManage = can('users.manage');

  const loadUsers = useCallback(async () => {
    if (!canManage) return;
    const res = await fetch('/api/users');
    if (res.ok) {
      const data = (await res.json()) as { users?: User[]; sync?: SyncState; sudo?: SudoState };
      setUsers(data.users ?? []);
      if (data.sync) setSync(data.sync);
      if (data.sudo) setMine(data.sudo);
    }
  }, [canManage]);

  const loadElevation = useCallback(async () => {
    const res = await fetch('/api/sudo');
    if (res.ok) {
      const data = (await res.json()) as { sudo?: SudoState };
      if (data.sudo) setMine(data.sudo);
    }
  }, []);

  useEffect(() => {
    void loadElevation();
  }, [loadElevation]);

  async function endElevation() {
    await fetch('/api/sudo', { method: 'DELETE' });
    await loadElevation();
  }

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  function startEdit(u: User) {
    setEditId(u.id);
    setFormEnabled(u.enabled);
    setFormPerms(u.permissions);
    setMessage(null);
    setError(null);
  }

  function resetForm() {
    setEditId(null);
    setFormEnabled(true);
    setFormPerms([]);
  }

  function elevationMessage(res: Response, data: { error?: string }): string | null {
    if (res.status !== 428) return null;
    return data.error ?? 'sudo password required — nothing was changed';
  }

  function togglePerm(perm: Permission, on: boolean) {
    setFormPerms((prev) => (on ? [...new Set([...prev, perm])] : prev.filter((p) => p !== perm)));
  }

  async function saveUser(e: React.FormEvent) {
    e.preventDefault();
    if (editId === null) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetchElevated('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },

        body: JSON.stringify({ id: editId, permissions: formPerms, enabled: formEnabled }),
      });
      const data = (await res.json()) as { error?: string; users?: User[] };
      if (!res.ok) {
        setError(elevationMessage(res, data) ?? data.error ?? 'Could not update user');
        return;
      }
      if (data.users) setUsers(data.users);
      setMessage('Saved.');
      await loadElevation();
      resetForm();
    } finally {
      setBusy(false);
    }
  }

  async function provision(username: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetchElevated('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'provision', username }),
      });
      const data = (await res.json()) as {
        error?: string;
        created?: string[];
        keptExisting?: string[];
      };
      if (!res.ok) {
        setError(elevationMessage(res, data) ?? data.error ?? 'Could not provision the instance');
        return;
      }
      const created = data.created ?? [];
      const kept = data.keptExisting ?? [];
      setMessage(
        created.length
          ? `Created ${created.join(', ')} for '${username}'.` +
              (kept.length ? ` Kept existing ${kept.join(', ')}.` : '')
          : `'${username}' was already provisioned (kept existing ${kept.join(', ')}).`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function resync() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync' }),
      });
      const data = (await res.json()) as {
        error?: string;
        users?: User[];
        sync?: SyncState;
        report?: { added: string[]; missing: string[]; sourceOk: boolean };
      };
      if (!res.ok) {
        setError(data.error ?? 'Could not sync');
        return;
      }
      if (data.users) setUsers(data.users);
      if (data.sync) setSync(data.sync);
      const added = data.report?.added ?? [];
      const missing = data.report?.missing ?? [];
      setMessage(
        added.length || missing.length
          ? [
              added.length ? `Added: ${added.join(', ')}` : null,
              missing.length ? `Account gone: ${missing.join(', ')}` : null,
            ]
              .filter(Boolean)
              .join(' · ')
          : 'Already up to date.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function provisionAll() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetchElevated('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'provision_all' }),
      });
      const data = (await res.json()) as {
        error?: string;
        created?: string[];
        kept?: string[];
        failed?: { username: string; error: string }[];
      };
      if (!res.ok) {
        setError(elevationMessage(res, data) ?? data.error ?? 'Could not provision');
        return;
      }
      const failed = data.failed ?? [];
      setMessage(
        [
          data.created?.length ? `Created instances for: ${data.created.join(', ')}` : null,
          data.kept?.length ? `Already set up: ${data.kept.join(', ')}` : null,
          failed.length
            ? `Failed: ${failed.map((f) => `${f.username} (${f.error})`).join(', ')}`
            : null,
        ]
          .filter(Boolean)
          .join(' · ') || 'Nothing to do.',
      );
      await loadUsers();
    } finally {
      setBusy(false);
    }
  }

  async function prune() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetchElevated('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'prune' }),
      });
      const data = (await res.json()) as { error?: string; removed?: string[] };
      if (!res.ok) {
        setError(elevationMessage(res, data) ?? data.error ?? 'Could not prune');
        return;
      }
      setMessage(
        data.removed?.length
          ? `Removed records for: ${data.removed.join(', ')}`
          : 'No orphaned records.',
      );
      await loadUsers();
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Users &amp; instances</h1>
        <p className="text-sm text-muted-foreground">
          Accounts are mirrored from Linux — every account on the server is already listed here, and
          a new one appears on its own, because <code className="font-mono">useradd</code> is the
          only step. Privileges come from the OS too: accounts that may run{' '}
          <code className="font-mono">sudo</code> are administrators, and root holds everything.
          The panel never creates or deletes Linux accounts, and never hands out admin.
        </p>
      </div>

      {}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-primary" /> My account
          </CardTitle>
          <CardDescription>
            Signed in as <span className="font-mono">{me?.username}</span>
            {me?.is_admin ? ' (admin)' : ''} — this is your Linux account on the server.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Instance root</p>
              <p className="break-all font-mono text-xs">{me?.instance?.root ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">pm2 app</p>
              <p className="font-mono text-xs">{me?.instance?.pm2_name ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Sudo</p>
              <p className="text-xs">
                {mine?.has_sudo ? (
                  mine.passwordless ? (
                    <Badge variant="default">allowed, no password</Badge>
                  ) : (
                    <Badge variant="secondary">allowed, password required</Badge>
                  )
                ) : (
                  <Badge variant="secondary">not in sudoers</Badge>
                )}
              </p>
            </div>
          </div>
          <p className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              There is no panel password: you sign in with your Linux password, so change it with{' '}
              <code className="font-mono">passwd</code> on the server. Your backups, logs, history,
              rclone credentials and daemon are separate from every other user&apos;s.
            </span>
          </p>
        </CardContent>
      </Card>

      {mine?.has_sudo && !mine.passwordless && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-4 text-sm">
          <span className="flex items-start gap-2 text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            {mine.elevated_until ? (
              <span>
                Elevated until{' '}
                <span className="font-mono">{new Date(mine.elevated_until).toLocaleTimeString()}</span>{' '}
                — privileged actions won&apos;t ask for your sudo password until then.
              </span>
            ) : (
              <span>
                Privileged actions (managing users, reinstalling the binary, anyone else&apos;s
                instance) will ask for your sudo password. It isn&apos;t asked for again for{' '}
                {Math.round(mine.timeout_ms / 60000)} minutes, like sudo itself.
              </span>
            )}
          </span>
          {mine.elevated_until && (
            <Button variant="outline" size="sm" onClick={() => void endElevation()}>
              End elevation
            </Button>
          )}
        </div>
      )}

      {!canManage && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          Your account does not have the <code className="font-mono">users.manage</code> permission.
        </div>
      )}

      {canManage && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UsersIcon className="h-4 w-4 text-primary" /> Mirrored accounts
              </CardTitle>
              <CardDescription>
                {users.length} account(s), mirrored from the server.{' '}
                {sync?.auto_sync
                  ? `Synced automatically every ${Math.round(sync.interval_ms / 1000)}s${
                      sync.watching_file ? ` and on changes to ${sync.watching_file}` : ''
                    }.`
                  : 'Automatic sync is off (BACKUP_MGR_AUTO_SYNC=0) — use Re-sync.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Table>
                <THead>
                  <TR>
                    <TH>Linux user</TH>
                    <TH>Role</TH>
                    <TH>Access</TH>
                    <TH>Instance</TH>
                    <TH>Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {users.map((u) => (
                    <TR key={u.id}>
                      <TD className="font-mono text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          {u.username}
                          {u.orphaned && <Badge variant="destructive">account gone</Badge>}
                          {u.id === me?.id && <Badge variant="secondary">you</Badge>}
                        </div>
                      </TD>
                      <TD>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={u.is_admin ? 'default' : 'secondary'}>
                            {u.is_admin ? 'admin' : 'user'}
                          </Badge>
                          {u.sudo?.has_sudo && <span className="text-xs text-muted-foreground">sudo</span>}
                        </div>
                      </TD>
                      <TD>
                        {u.enabled ? (
                          <span className="text-xs text-muted-foreground">
                            {u.is_admin ? 'all' : `${u.permissions.length} permission(s)`}
                          </span>
                        ) : (
                          <Badge variant="destructive">blocked</Badge>
                        )}
                      </TD>
                      <TD className="break-all font-mono text-[11px] text-muted-foreground">
                        {u.instance?.root ?? '—'}
                      </TD>
                      <TD>
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" onClick={() => startEdit(u)}>
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy || u.orphaned}
                            onClick={() => void provision(u.username)}
                            title={
                              u.orphaned
                                ? 'the Linux account no longer exists'
                                : 'create this user’s instance directories and seed config.yml'
                            }
                          >
                            <Wrench className="h-3.5 w-3.5" /> Provision
                          </Button>
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>

              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" size="sm" onClick={() => void resync()} disabled={busy}>
                  <RefreshCw className="h-3.5 w-3.5" /> Re-sync from the server
                </Button>
                <Button variant="outline" size="sm" onClick={() => void provisionAll()} disabled={busy}>
                  <Wrench className="h-3.5 w-3.5" /> Provision all missing
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void prune()} disabled={busy}>
                  Remove records for deleted accounts
                </Button>
                {error && <span className="text-sm text-destructive">{error}</span>}
                {message && <span className="text-sm text-success">{message}</span>}
              </div>

              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {sync?.last
                    ? `Last synced ${new Date(sync.last.at).toLocaleTimeString()} (${sync.last.reason}). `
                    : 'The mirror has not synced in this process yet. '}
                  {sync?.auto_provision
                    ? 'New accounts are provisioned automatically.'
                    : 'New accounts get no instance until someone provisions them (set BACKUP_MGR_AUTO_PROVISION=1 to automate that).'}
                </span>
              </p>
              {sync?.errors && sync.errors.length > 0 && (
                <p className="flex items-start gap-2 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>Mirror problem: {sync.errors[sync.errors.length - 1]}</span>
                </p>
              )}
            </CardContent>
          </Card>

          {editId !== null && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <UserCog className="h-4 w-4 text-primary" />
                  Edit {users.find((u) => u.id === editId)?.username}
                </CardTitle>
                <CardDescription>
                  Permissions are scoped. Instance permissions act only on this user&apos;s own
                  backups — they cannot reach anyone else&apos;s, because the OS enforces it.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={saveUser} className="space-y-5">
                  <div className="flex flex-wrap gap-6">
                    <label className="flex items-center gap-2 text-sm">
                      <Switch
                        checked={formEnabled}
                        onCheckedChange={setFormEnabled}
                        disabled={editId === me?.id}
                      />
                      <Ban className="h-3.5 w-3.5" /> Allow panel access
                    </label>
                  </div>
                  {users.find((u) => u.id === editId)?.is_admin && (
                    <p className="flex items-start gap-2 text-xs text-muted-foreground">
                      <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                      <span>
                        This account is an administrator because it may run{' '}
                        <code className="font-mono">sudo</code> on the server, so it already holds
                        every permission. That is not the panel&apos;s to change: use{' '}
                        <code className="font-mono">sudo usermod -aG sudo &lt;user&gt;</code> (or its
                        equivalent) to grant it, and{' '}
                        <code className="font-mono">sudo deluser &lt;user&gt; sudo</code> to take it
                        away.
                      </span>
                    </p>
                  )}
                  {editId === me?.id && (
                    <p className="text-xs text-muted-foreground">
                      You cannot block your own account. Blocking takes effect on the user&apos;s next
                      request; their Linux account is untouched.
                    </p>
                  )}

                  <div>
                    <p className="mb-2 text-sm font-medium">Permissions</p>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {PERMISSIONS.map((p) => (
                        <label
                          key={p.key}
                          className={cn(
                            'flex items-start gap-2 rounded-md border p-2 text-sm',
                            p.scope === 'panel'
                              ? 'border-destructive/40 bg-destructive/5'
                              : 'border-border',
                          )}
                        >
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={
                              users.find((u) => u.id === editId)?.is_admin ||
                              formPerms.includes(p.key)
                            }
                            disabled={users.find((u) => u.id === editId)?.is_admin}
                            onChange={(e) => togglePerm(p.key, e.target.checked)}
                          />
                          <span>
                            <span className="block">{p.label}</span>
                            <span className="font-mono text-[11px] text-muted-foreground">
                              {p.key}
                              {p.scope === 'panel' ? ' · privileged' : ''}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <Button type="submit" disabled={busy}>
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      Save changes
                    </Button>
                    <Button type="button" variant="outline" onClick={resetForm}>
                      Cancel
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Adding and removing users</CardTitle>
              <CardDescription>Accounts live in the OS, not here.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <pre className="overflow-x-auto rounded-md border border-border bg-background/60 p-3 font-mono text-xs">
{`sudo adduser <name>          # appears in the panel within seconds, on its own
sudo usermod -aG sudo <name> # makes them a panel admin (admin follows sudo)
sudo deluser <name> sudo     # ...and this makes them an ordinary user again
sudo passwd -l <name>        # locks the panel login too
sudo userdel -r <name>       # record flagged "account gone"; use Remove records`}
              </pre>
              <p className="flex items-start gap-2 text-xs">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  A new account starts with full control of <strong>its own</strong> instance and no
                  global permissions. Accounts are only mirrored when they have a real login shell
                  and a uid of 1000 or more (plus root); tune that with <code className="font-mono">BACKUP_MGR_MIN_UID</code>,{' '}
                  <code className="font-mono">BACKUP_MGR_INCLUDE_ROOT</code> and{' '}
                  <code className="font-mono">BACKUP_MGR_EXCLUDE_USERS</code>. Deleting an account
                  cuts off panel access on that user&apos;s very next request. Privileged actions
                  need the account&apos;s own sudo: silent when it is NOPASSWD, otherwise a password
                  you won&apos;t be asked for again for a while.
                </span>
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
