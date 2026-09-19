'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  DatabaseBackup,
  KeyRound,
  LayoutDashboard,
  LogOut,
  ScrollText,
  Settings,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui';
import { useMe } from '@/lib/use-me';

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const { me, loading, can } = useMe();

  // An account still on its default password can only reach the account page
  // until it picks a new one. The API enforces this too — this is just the UI.
  const mustChange = !!me?.must_change_password;
  useEffect(() => {
    if (mustChange && !pathname.startsWith('/users')) router.replace('/users');
  }, [mustChange, pathname, router]);

  if (pathname.startsWith('/login')) return null;

  const items = [
    { href: '/', label: 'Dashboard', icon: LayoutDashboard, show: can('dashboard.view') },
    { href: '/config', label: 'Config', icon: Settings, show: can('config.view') },
    { href: '/auth', label: 'Auth', icon: KeyRound, show: can('remote.auth') },
    { href: '/logs', label: 'Logs', icon: ScrollText, show: can('logs.view') },
    { href: '/users', label: 'Users', icon: Users, show: !!me },
  ].filter((i) => i.show);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  }

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <DatabaseBackup className="h-5 w-5 text-primary" />
          <span>backup-mgr</span>
        </Link>
        <nav className="flex items-center gap-1">
          {items.map(({ href, label, icon: Icon }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {!loading && me && (
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {me.username}
              {me.is_admin ? ' (admin)' : ''}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={logout}>
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}
