'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  KeyRound,
  Loader2,
  Plus,
  Save,
  Trash2,
  UserPlus,
  Users as UsersIcon,
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

type User = {
  id: number;
  username: string;
  is_admin: boolean;
  permissions: Permission[];
  must_change_password: boolean;
  created_at: string;
};

export default function UsersPage() {
  const { me, loading, can } = useMe();

  // account (self)
  const [currentPassword, setCurrentPassword] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [accountMsg, setAccountMsg] = useState<string | null>(null);
  const [accountErr, setAccountErr] = useState<string | null>(null);
  const [savingAccount, setSavingAccount] = useState(false);

  /** True while the account is still on its default / admin-assigned password. */
  const mustChange = !!me?.must_change_password;

  useEffect(() => {
    if (me) setNewUsername(me.username);
  }, [me]);

  // admin management
  const [users, setUsers] = useState<User[]>([]);
  const [editId, setEditId] = useState<number | null>(null);
  const [formUsername, setFormUsername] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formAdmin, setFormAdmin] = useState(false);
  const [formRequireChange, setFormRequireChange] = useState(true);
  const [formPerms, setFormPerms] = useState<Permission[]>(['dashboard.view']);
  const [userMsg, setUserMsg] = useState<string | null>(null);
  const [userErr, setUserErr] = useState<string | null>(null);
  const [savingUser, setSavingUser] = useState(false);

  const loadUsers = useCallback(async () => {
    if (!me?.is_admin) return;
    const res = await fetch('/api/users');
    if (res.ok) {
      const data = (await res.json()) as { users?: User[] };
      setUsers(data.users ?? []);
    }
  }, [me]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  async function saveAccount(e: React.FormEvent) {
    e.preventDefault();
    setSavingAccount(true);
    setAccountErr(null);
    setAccountMsg(null);
    try {
      const res = await fetch('/api/account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword,
          username: newUsername || undefined,
          password: newPassword || undefined,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setAccountErr(data.error ?? 'Could not update account');
        return;
      }
      setCurrentPassword('');
      setNewPassword('');
      if (newUsername !== me?.username) {
        setAccountMsg('Account updated — signing you in again.');
        setTimeout(() => (window.location.href = '/login'), 800);
      } else if (mustChange) {
        // The forced change is done: reload so the API stops refusing requests.
        setAccountMsg('Password changed.');
        setTimeout(() => (window.location.href = '/'), 800);
      } else {
        setAccountMsg('Account updated.');
      }
    } finally {
      setSavingAccount(false);
    }
  }

  function resetForm() {
    setEditId(null);
    setFormUsername('');
    setFormPassword('');
    setFormAdmin(false);
    setFormRequireChange(true);
    setFormPerms(['dashboard.view']);
  }

  function startEdit(u: User) {
    setEditId(u.id);
    setFormUsername(u.username);
    setFormPassword('');
    setFormAdmin(u.is_admin);
    setFormRequireChange(u.must_change_password);
    setFormPerms(u.permissions);
    setUserMsg(null);
    setUserErr(null);
  }

  async function saveUser(e: React.FormEvent) {
    e.preventDefault();
    setSavingUser(true);
    setUserErr(null);
    setUserMsg(null);
    try {
      if (editId === null) {
        const res = await fetch('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: formUsername,
            password: formPassword,
            is_admin: formAdmin,
            permissions: formPerms,
            must_change_password: formRequireChange,
          }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          setUserErr(data.error ?? 'Could not create user');
          return;
        }
        setUserMsg(`Created user '${formUsername}'.`);
      } else {
        const res = await fetch('/api/users', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: editId,
            is_admin: formAdmin,
            permissions: formPerms,
            password: formPassword || undefined,
            must_change_password: formRequireChange,
          }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          setUserErr(data.error ?? 'Could not update user');
          return;
        }
        setUserMsg('User updated.');
      }
      resetForm();
      await loadUsers();
    } finally {
      setSavingUser(false);
    }
  }

  async function removeUser(id: number) {
    setUserErr(null);
    const res = await fetch(`/api/users?id=${id}`, { method: 'DELETE' });
    const data = (await res.json()) as { error?: string };
    if (!res.ok) {
      setUserErr(data.error ?? 'Could not delete user');
      return;
    }
    await loadUsers();
  }

  function togglePerm(perm: Permission, on: boolean) {
    setFormPerms((prev) => (on ? [...new Set([...prev, perm])] : prev.filter((p) => p !== perm)));
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
        <h1 className="text-xl font-semibold">Account &amp; users</h1>
        <p className="text-sm text-muted-foreground">
          Everyone can manage their own account; only admins can manage other users.
        </p>
      </div>

      {mustChange && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium text-destructive">Change your password to continue</p>
            <p className="text-muted-foreground">
              This account still uses its default password. Every other page and action stays
              locked until you set a new one below.
            </p>
          </div>
        </div>
      )}

      {/* Self account */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" /> My account
          </CardTitle>
          <CardDescription>
            Signed in as <span className="font-mono">{me?.username}</span>
            {me?.is_admin ? ' (admin)' : ''}.
            {mustChange && ' A new password is required before you can use the panel.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveAccount} className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="cur">Current password</Label>
              <Input
                id="cur"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="nuser">New username</Label>
              <Input
                id="nuser"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="npass">
                New password{mustChange ? ' (required)' : ''}
              </Label>
              <Input
                id="npass"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="leave blank to keep"
              />
            </div>
            <div className="flex items-center gap-3 md:col-span-3">
              <Button
                type="submit"
                disabled={savingAccount || !currentPassword || (mustChange && !newPassword)}
              >
                {savingAccount ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save account
              </Button>
              {accountErr && <span className="text-sm text-destructive">{accountErr}</span>}
              {accountMsg && <span className="text-sm text-success">{accountMsg}</span>}
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Admin management */}
      {me?.is_admin && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UserPlus className="h-4 w-4 text-primary" />
                {editId === null ? 'Create user' : `Edit user #${editId}`}
              </CardTitle>
              <CardDescription>
                Grant exactly the permissions this user should have.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={saveUser} className="space-y-5">
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="fuser">Username</Label>
                    <Input
                      id="fuser"
                      value={formUsername}
                      onChange={(e) => setFormUsername(e.target.value)}
                      disabled={editId !== null}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="fpass">{editId === null ? 'Password' : 'New password'}</Label>
                    <Input
                      id="fpass"
                      type="password"
                      value={formPassword}
                      onChange={(e) => setFormPassword(e.target.value)}
                      placeholder={editId === null ? '' : 'leave blank to keep'}
                    />
                  </div>
                  <div className="flex flex-col justify-end gap-2">
                    <label className="flex items-center gap-2 text-sm">
                      <Switch checked={formAdmin} onCheckedChange={setFormAdmin} /> Administrator
                      (all permissions)
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <Switch checked={formRequireChange} onCheckedChange={setFormRequireChange} />
                      Require a password change at first sign-in
                    </label>
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-sm font-medium">Permissions</p>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {PERMISSIONS.map((p) => (
                      <label
                        key={p.key}
                        className="flex items-start gap-2 rounded-md border border-border p-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={formAdmin || formPerms.includes(p.key)}
                          disabled={formAdmin}
                          onChange={(e) => togglePerm(p.key, e.target.checked)}
                        />
                        <span>
                          <span className="block">{p.label}</span>
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {p.key}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <Button type="submit" disabled={savingUser || !formUsername}>
                    {savingUser ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : editId === null ? (
                      <Plus className="h-4 w-4" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    {editId === null ? 'Create user' : 'Save changes'}
                  </Button>
                  {editId !== null && (
                    <Button type="button" variant="outline" onClick={resetForm}>
                      Cancel
                    </Button>
                  )}
                  {userErr && <span className="text-sm text-destructive">{userErr}</span>}
                  {userMsg && <span className="text-sm text-success">{userMsg}</span>}
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UsersIcon className="h-4 w-4 text-primary" /> Users
              </CardTitle>
              <CardDescription>{users.length} account(s).</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <THead>
                  <TR>
                    <TH>User</TH>
                    <TH>Role</TH>
                    <TH>Permissions</TH>
                    <TH>Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {users.map((u) => (
                    <TR key={u.id}>
                      <TD className="font-mono text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          {u.username}
                          {u.must_change_password && (
                            <Badge variant="destructive">must change password</Badge>
                          )}
                        </div>
                      </TD>
                      <TD>
                        <Badge variant={u.is_admin ? 'default' : 'secondary'}>
                          {u.is_admin ? 'admin' : 'user'}
                        </Badge>
                      </TD>
                      <TD className="max-w-[420px]">
                        <div className="flex flex-wrap gap-1">
                          {u.is_admin ? (
                            <span className="text-xs text-muted-foreground">all</span>
                          ) : u.permissions.length === 0 ? (
                            <span className="text-xs text-muted-foreground">none</span>
                          ) : (
                            u.permissions.map((p) => (
                              <span
                                key={p}
                                className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px]"
                              >
                                {p}
                              </span>
                            ))
                          )}
                        </div>
                      </TD>
                      <TD>
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" onClick={() => startEdit(u)}>
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={u.id === me?.id}
                            onClick={() => void removeUser(u.id)}
                            title={u.id === me?.id ? 'you cannot delete yourself' : 'delete'}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
