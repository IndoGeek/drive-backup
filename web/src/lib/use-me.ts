'use client';

import { useEffect, useState } from 'react';
import type { Permission } from './permissions';

export type Me = {
  id: number;
  username: string;
  is_admin: boolean;
  permissions: Permission[];
  must_change_password: boolean;
} | null;

export function useMe(): { me: Me; loading: boolean; can: (p: Permission) => boolean } {
  const [me, setMe] = useState<Me>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/auth/me');
        if (res.ok) {
          const data = (await res.json()) as { user: Me };
          if (alive) setMe(data.user);
        } else if (alive) {
          setMe(null);
        }
      } catch {
        if (alive) setMe(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const can = (p: Permission) => !!me && (me.is_admin || me.permissions.includes(p));
  return { me, loading, can };
}
