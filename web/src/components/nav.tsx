'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  DatabaseBackup,
  KeyRound,
  LayoutDashboard,
  LogOut,
  ScrollText,
  Settings,
  ShieldCheck,
  ShieldOff,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui';
import { useMe } from '@/lib/use-me';
import { useSudo } from '@/lib/sudo-client';

/**
 * The header, plus the one piece of state that changes what happens next: whether a
 * sudo prompt is coming.
 *
 * Layout: a wrapping row rather than a fixed one — the brand and the account
 * controls sit on the first line and the nav drops to its own full-width,
 * horizontally scrollable line below `lg`. Icons stay, labels return at `sm`.
 */
export function Nav() {
  const pathname = usePathname();
  const { me, loading, can } = useMe();
  const { sudo, requestElevation, endElevation } = useSudo();

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
    <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 sm:px-4 lg:h-14 lg:flex-nowrap lg:py-0">
        <Link href="/" className="flex shrink-0 items-center gap-2 font-semibold">
          <DatabaseBackup className="h-5 w-5 text-primary" />
          <span>backup-mgr</span>
        </Link>

        <div className="ml-auto flex items-center gap-2">
          <ElevationChip
            sudo={sudo}
            onElevate={() => void requestElevation('elevate this session')}
            onEnd={() => void endElevation()}
          />
          {!loading && me && (
            <span className="hidden max-w-[12rem] truncate text-xs text-muted-foreground md:inline">
              {me.username}
              {me.is_admin ? ' (admin)' : ''}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={logout} title="Sign out">
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </div>

        {/* Its own line on small screens; inline from lg up. */}
        <nav
          className={cn(
            'order-last -mb-2 flex w-full items-center gap-1 overflow-x-auto pb-2',
            '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
            'lg:order-none lg:mb-0 lg:w-auto lg:overflow-visible lg:pb-0',
          )}
        >
          {items.map(({ href, label, icon: Icon }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="hidden sm:inline">{label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}

/**
 * Whether privileged work will ask for a password.
 *
 * Clicking it does the useful thing for its state: ask now (rather than being
 * surprised mid-task), or end elevation early like `sudo -k`.
 */
function ElevationChip({
  sudo,
  onElevate,
  onEnd,
}: {
  sudo: ReturnType<typeof useSudo>['sudo'];
  onElevate: () => void;
  onEnd: () => void;
}) {
  if (!sudo) return null;

  if (!sudo.has_sudo) {
    return (
      <span
        className="hidden items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground sm:flex"
        title="This Linux account has no sudo, so privileged actions (managing users, reinstalling the binary, another user's instance) will be refused."
      >
        <ShieldOff className="h-3.5 w-3.5" />
        no sudo
      </span>
    );
  }

  if (sudo.passwordless) {
    return (
      <span
        className="hidden items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground sm:flex"
        title="sudo for this account is NOPASSWD, so privileged actions run without ever asking for a password."
      >
        <ShieldCheck className="h-3.5 w-3.5 text-success" />
        sudo: no password
      </span>
    );
  }

  if (sudo.elevated_until) {
    const until = new Date(sudo.elevated_until).toLocaleTimeString();
    return (
      <button
        type="button"
        onClick={onEnd}
        className="flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-xs text-primary transition-colors hover:bg-primary/20"
        title={`Elevated until ${until} — click to end it now (like sudo -k).`}
      >
        <ShieldCheck className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">elevated until</span> {until}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onElevate}
      className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title="Privileged actions will ask for your sudo password. Click to enter it now."
    >
      <ShieldCheck className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">sudo: password required</span>
      <span className="sm:hidden">sudo</span>
    </button>
  );
}
