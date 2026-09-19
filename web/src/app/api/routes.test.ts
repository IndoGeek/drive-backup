import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { NextResponse } from 'next/server';

let adminCookie = '';
let limitedCookie = '';

let sudoerCookie = '';
let accountName = '';
let accountUid = 0;
let accountGid = 0;
let accountHome = '';
let instanceRoot = '';

const SUDOER = 'sudoer';
const SUDOER_PASSWORD = 'elevate-me-123';

beforeAll(async () => {
  const { currentAccount, tmpDir, writePasswdFixture, writeShadowFixture } = await import(
    '@/lib/testhelp'
  );
  const account = currentAccount();
  accountName = account.name;
  accountUid = account.uid;
  accountGid = account.gid;

  const sandbox = tmpDir('bm-routes-');
  const home = path.join(sandbox, 'home');
  const dataDir = path.join(sandbox, 'data');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  accountHome = home;
  instanceRoot = path.join(home, 'backup-mgr');

  process.env.BACKUP_MGR_PASSWD_FILE = writePasswdFixture([
    { name: account.name, uid: account.uid, gid: account.gid, home },
    { name: 'limited', uid: 2000, gid: 2000, home: path.join(sandbox, 'limited') },
    { name: SUDOER, uid: 2001, gid: 2001, home: path.join(sandbox, 'sudoer') },
  ]);
  process.env.BACKUP_MGR_INSTANCE_TEMPLATE = '{home}/backup-mgr';
  process.env.BACKUP_MGR_DATA_DIR = dataDir;
  process.env.BACKUP_MGR_USERS_DB = path.join(dataDir, 'panel.db');
  process.env.BACKUP_MGR_SESSION_SECRET = 'test-secret';
  process.env.BACKUP_MGR_ADMIN_USER = account.name;

  process.env.BACKUP_MGR_BIN = '/nonexistent/backup-mgr';
  process.env.PM2_BIN = '/nonexistent/pm2';

  const { makeHash, useSudoFixture } = await import('@/lib/testhelp');
  useSudoFixture({
    [account.name]: { has_sudo: true, passwordless: true },
    limited: { has_sudo: false },
    [SUDOER]: { has_sudo: true, passwordless: false },
  });
  process.env.BACKUP_MGR_SHADOW_FILE = writeShadowFixture([
    { name: SUDOER, hash: makeHash(SUDOER_PASSWORD) },
  ]);

  const { ensureUser } = await import('@/lib/users');
  const { createSession } = await import('@/lib/session');

  const admin = ensureUser(account.name);
  if (!admin) throw new Error('could not mirror the panel account');
  if (!admin.is_admin) throw new Error('the panel account should be an admin');
  adminCookie = `bm_session=${createSession(admin.id).value}`;

  const limited = ensureUser('limited');
  if (!limited) throw new Error('could not mirror the limited account');
  const { updateUser } = await import('@/lib/users');
  updateUser(limited.id, { permissions: ['dashboard.view', 'logs.view'] });
  limitedCookie = `bm_session=${createSession(limited.id).value}`;

  const sudoer = ensureUser(SUDOER);
  if (!sudoer) throw new Error('could not mirror the sudoer account');
  sudoerCookie = `bm_session=${createSession(sudoer.id).value}`;
});

function get(url: string, cookie?: string) {
  return new Request(url, { headers: cookie ? { cookie } : {} }) as never;
}

function post(url: string, body: unknown, cookie?: string) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }) as never;
}

async function body<T>(res: NextResponse): Promise<T> {
  return (await (res as unknown as Response).json()) as T;
}

describe('authentication', () => {
  it('rejects unauthenticated requests', async () => {
    for (const mod of [
      '@/app/api/status/route',
      '@/app/api/users/route',
      '@/app/api/restore/route',
      '@/app/api/config/route',
      '@/app/api/daemon/route',
      '@/app/api/logs/route',
      '@/app/api/binary/route',
    ]) {
      const { GET } = await import(mod);
      const res = await GET(get('http://test/api/x'));
      expect(res.status).toBe(401);
    }
  });

  it('rejects a user without the route permission', async () => {
    const { GET } = await import('@/app/api/restore/route');
    const res = await GET(get('http://test/api/restore', limitedCookie));
    expect(res.status).toBe(403);
  });

  it('does not let a non-admin act on another user’s instance', async () => {
    const { GET } = await import('@/app/api/status/route');
    const res = await GET(get(`http://test/api/status?user=${accountName}`, limitedCookie));
    expect(res.status).toBe(403);
  });
});

describe('user management', () => {
  it('refuses a user without users.manage', async () => {
    const { GET } = await import('@/app/api/users/route');
    const res = await GET(get('http://test/api/users', limitedCookie));
    expect(res.status).toBe(403);
  });

  it('lists mirrored accounts for an admin', async () => {
    const { GET } = await import('@/app/api/users/route');
    const res = await GET(get('http://test/api/users', adminCookie));
    expect(res.status).toBe(200);
    const data = await body<{ users: { username: string; instance: { root: string } }[] }>(res);
    expect(data.users.map((u) => u.username)).toContain('limited');

    expect(data.users.find((u) => u.username === accountName)?.instance.root).toBe(instanceRoot);
  });

  it('rejects an unknown management action', async () => {
    const { POST } = await import('@/app/api/users/route');
    const res = await POST(post('http://test/api/users', { action: 'delete' }, adminCookie));
    expect(res.status).toBe(400);
  });

  it('only an admin may change admin status', async () => {
    const { PATCH } = await import('@/app/api/users/route');
    const res = await PATCH(
      new Request('http://test/api/users', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: limitedCookie },
        body: JSON.stringify({ id: 1, is_admin: true }),
      }) as never,
    );
    expect(res.status).toBe(403);
  });
});

describe('instance lifecycle', () => {
  it('reports an unprovisioned instance instead of failing obscurely', async () => {
    const { GET } = await import('@/app/api/status/route');
    const res = await GET(get('http://test/api/status', adminCookie));
    expect(res.status).toBe(409);
    const data = await body<{ needs_provisioning?: boolean; instance?: { root: string } }>(res);
    expect(data.needs_provisioning).toBe(true);
    expect(data.instance?.root).toBe(instanceRoot);
  });

  it('provisions the instance on request', async () => {
    const { POST } = await import('@/app/api/users/route');
    const res = await POST(
      post('http://test/api/users', { action: 'provision', username: accountName }, adminCookie),
    );
    expect(res.status).toBe(200);
    const data = await body<{ ok: boolean; created: string[] }>(res);
    expect(data.ok).toBe(true);
    expect(data.created).toContain('config.yml');
    expect(fs.existsSync(path.join(instanceRoot, 'config.yml'))).toBe(true);
    expect(fs.existsSync(path.join(instanceRoot, 'ecosystem.config.cjs'))).toBe(true);
  });

  it('explains a missing binary rather than returning a bare error', async () => {
    const { GET } = await import('@/app/api/status/route');
    const res = await GET(get('http://test/api/status', adminCookie));
    expect(res.status).toBe(502);
    const data = await body<{ error: string; instance: { os_user: string } }>(res);
    expect(data.instance.os_user).toBe(accountName);
    expect(data.error).toMatch(/out of date|binary/i);
  });

  it('lets an admin act on another user’s instance', async () => {
    const { GET } = await import('@/app/api/status/route');
    const res = await GET(get('http://test/api/status?user=limited', adminCookie));

    expect(res.status).toBe(409);
  });
});

describe('daemon control', () => {
  it('validates the requested action', async () => {
    const { POST } = await import('@/app/api/daemon/route');
    const res = await POST(post('http://test/api/daemon', { action: 'explode' }, adminCookie));
    expect(res.status).toBe(400);
  });

  it('reports the daemon state without throwing when pm2 is unavailable', async () => {
    const { GET } = await import('@/app/api/daemon/route');
    const res = await GET(get('http://test/api/daemon', adminCookie));
    expect(res.status).toBe(200);
    const data = await body<{ available: boolean; instance: { pm2_name: string } }>(res);
    expect(data.available).toBe(false);
    expect(data.instance.pm2_name).toBe(`backup-mgr-${accountName}`);
  });

  it('requires daemon.control to act', async () => {
    const { POST } = await import('@/app/api/daemon/route');
    const res = await POST(post('http://test/api/daemon', { action: 'restart' }, limitedCookie));
    expect(res.status).toBe(403);
    const data = await body<{ permission?: string }>(res);
    expect(data.permission).toBe('daemon.control');
  });
});

describe('logs route', () => {
  it('returns every source for the caller’s instance', async () => {
    const { GET } = await import('@/app/api/logs/route');
    const res = await GET(get('http://test/api/logs', adminCookie));
    expect(res.status).toBe(200);
    const data = await body<{ sources: { id: string }[]; instance: { os_user: string } }>(res);
    expect(data.sources.map((s) => s.id)).toEqual(['backup', 'daemon', 'panel']);
    expect(data.instance.os_user).toBe(accountName);
  });

  it('rejects an unknown log source', async () => {
    const { GET } = await import('@/app/api/logs/route');
    const res = await GET(get('http://test/api/logs?source=nope', adminCookie));
    expect(res.status).toBe(400);
  });
});

describe('rclone routes', () => {
  it('validates a missing job id', async () => {
    const { POST } = await import('@/app/api/rclone/save/route');
    const res = await POST(post('http://test/api/rclone/save', { id: '' }, adminCookie));
    expect(res.status).toBe(400);
  });

  it('requires remote.auth', async () => {
    const { POST } = await import('@/app/api/rclone/save/route');
    const res = await POST(post('http://test/api/rclone/save', { id: 'x' }, limitedCookie));
    expect(res.status).toBe(403);
  });

  it('gates job status on remote.auth before anything else', async () => {
    const { GET } = await import('@/app/api/rclone/status/route');
    const res = await GET(get('http://test/api/rclone/status?id=made-up', limitedCookie));
    expect(res.status).toBe(403);
  });

  it('reports an unknown job id to an authorized user', async () => {
    const { GET } = await import('@/app/api/rclone/status/route');

    const res = await GET(get('http://test/api/rclone/status?id=made-up', adminCookie));
    expect(res.status).toBe(404);
  });
});

describe('binary route (panel-level)', () => {
  it('reports the checkout version even with no binary installed', async () => {
    const { GET } = await import('@/app/api/binary/route');
    const res = await GET(get('http://test/api/binary', adminCookie));
    expect(res.status).toBe(200);
    const data = await body<{
      expected: { version: string | null };
      stale: boolean;
      install_command: string;
    }>(res);
    expect(data.expected.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof data.stale).toBe('boolean');
    expect(data.install_command).toContain('install -m 0755');
  });

  it('refuses an install without binary.install', async () => {
    const { POST } = await import('@/app/api/binary/install/route');
    const res = await POST(post('http://test/api/binary/install', {}, limitedCookie));
    expect(res.status).toBe(403);
    const data = await body<{ permission?: string }>(res);
    expect(data.permission).toBe('binary.install');
  });

  it('requires authentication to install', async () => {
    const { POST } = await import('@/app/api/binary/install/route');
    const res = await POST(post('http://test/api/binary/install', {}));
    expect(res.status).toBe(401);
  });
});

describe('sudo elevation', () => {
  function patchPermissions(cookie: string, id: number) {
    return new Request('http://test/api/users', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ id, permissions: ['dashboard.view'] }),
    }) as never;
  }

  async function idOf(username: string, cookie = adminCookie): Promise<number> {
    const { GET } = await import('@/app/api/users/route');
    const res = await GET(get('http://test/api/users', cookie));
    const data = await body<{ users: { id: number; username: string }[] }>(res);
    const found = data.users.find((u) => u.username === username);
    if (!found) throw new Error(`no such user: ${username}`);
    return found.id;
  }

  it('never asks for a password when sudo is NOPASSWD', async () => {
    const { GET } = await import('@/app/api/sudo/route');
    const res = await GET(get('http://test/api/sudo', adminCookie));
    expect(res.status).toBe(200);
    const data = await body<{ sudo: { has_sudo: boolean; passwordless: boolean } }>(res);
    expect(data.sudo.has_sudo).toBe(true);
    expect(data.sudo.passwordless).toBe(true);
  });

  it('asks for a sudo password when the account has sudo that requires one', async () => {
    const { PATCH } = await import('@/app/api/users/route');
    const id = await idOf('limited', sudoerCookie);
    const res = await PATCH(patchPermissions(sudoerCookie, id));
    expect(res.status).toBe(428);
    const data = await body<{ sudo_required?: boolean; action?: string }>(res);
    expect(data.sudo_required).toBe(true);
    expect(data.action).toContain('manage users');
  });

  it('refuses elevation for an account with no sudo at all', async () => {
    const { POST } = await import('@/app/api/sudo/route');
    const res = await POST(post('http://test/api/sudo', { password: 'whatever' }, limitedCookie));
    expect(res.status).toBe(403);
    const data = await body<{ sudo_denied?: boolean }>(res);
    expect(data.sudo_denied).toBe(true);
  });

  it('rejects the wrong sudo password, and the right one opens the session', async () => {
    const { POST } = await import('@/app/api/sudo/route');
    const wrong = await POST(
      post('http://test/api/sudo', { password: 'not-the-password' }, sudoerCookie),
    );
    expect(wrong.status).toBe(401);

    const right = await POST(post('http://test/api/sudo', { password: SUDOER_PASSWORD }, sudoerCookie));
    expect(right.status).toBe(200);
    const data = await body<{ elevated_until: string; timeout_ms: number }>(right);
    expect(Date.parse(data.elevated_until)).toBeGreaterThan(Date.now());
    expect(data.timeout_ms).toBeGreaterThan(0);
  });

  it('then lets the privileged work through without asking again', async () => {
    const { PATCH } = await import('@/app/api/users/route');
    const id = await idOf('limited', sudoerCookie);
    const res = await PATCH(patchPermissions(sudoerCookie, id));
    expect(res.status).toBe(200);
  });

  it('gives each session its own elevation: one user’s grant is not another’s', async () => {
    const { PATCH } = await import('@/app/api/users/route');

    const { createSession } = await import('@/lib/session');
    const { getUserByName } = await import('@/lib/users');
    const other = getUserByName(SUDOER);
    if (!other) throw new Error('sudoer missing');
    const otherCookie = `bm_session=${createSession(other.id).value}`;
    const res = await PATCH(patchPermissions(otherCookie, await idOf('limited', sudoerCookie)));
    expect(res.status).toBe(428);
  });

  it('ends elevation on request, like sudo -k', async () => {
    const { DELETE } = await import('@/app/api/sudo/route');
    const ended = await DELETE(get('http://test/api/sudo', sudoerCookie));
    expect(ended.status).toBe(200);
    const data = await body<{ sudo: { elevated_until: string | null } }>(ended);
    expect(data.sudo.elevated_until).toBeNull();

    const { PATCH } = await import('@/app/api/users/route');
    const res = await PATCH(patchPermissions(sudoerCookie, await idOf('limited', sudoerCookie)));
    expect(res.status).toBe(428);
  });

  it('ends elevation when the user signs out', async () => {
    const { POST: sudoPost } = await import('@/app/api/sudo/route');
    await sudoPost(post('http://test/api/sudo', { password: SUDOER_PASSWORD }, sudoerCookie));
    const { PATCH } = await import('@/app/api/users/route');
    const id = await idOf('limited', sudoerCookie);
    expect((await PATCH(patchPermissions(sudoerCookie, id))).status).toBe(200);

    const { POST: logout } = await import('@/app/api/auth/logout/route');
    expect((await logout(get('http://test/api/auth/logout', sudoerCookie))).status).toBe(200);

    expect((await PATCH(patchPermissions(sudoerCookie, id))).status).toBe(428);
  });

  it('gates acting on another user’s instance, but not reading it', async () => {
    const { GET } = await import('@/app/api/config/route');
    expect((await GET(get(`http://test/api/config?user=limited`, sudoerCookie))).status).not.toBe(428);

    const { PUT } = await import('@/app/api/config/route');
    const req = new Request('http://test/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: sudoerCookie },
      body: JSON.stringify({ user: 'limited', values: {} }),
    }) as never;
    expect((await PUT(req)).status).toBe(428);
  });
});

describe('mirrored accounts', () => {
  it('reports the live mirror state alongside the users', async () => {
    const { GET } = await import('@/app/api/users/route');
    const res = await GET(get('http://test/api/users', adminCookie));
    expect(res.status).toBe(200);
    const data = await body<{
      sync: { running: boolean; auto_sync: boolean; interval_ms: number; last: unknown };
    }>(res);
    expect(data.sync.auto_sync).toBe(true);
    expect(data.sync.interval_ms).toBeGreaterThanOrEqual(2000);
  });

  it('re-syncs on request and reports what changed', async () => {
    const { POST } = await import('@/app/api/users/route');
    const res = await POST(post('http://test/api/users', { action: 'sync' }, adminCookie));
    expect(res.status).toBe(200);
    const data = await body<{
      report: { sourceOk: boolean; added: string[]; missing: string[] };
      users: unknown[];
    }>(res);
    expect(data.report.sourceOk).toBe(true);
    expect(Array.isArray(data.report.added)).toBe(true);
    expect(Array.isArray(data.users)).toBe(true);
  });

  it('requires users.manage to re-sync', async () => {
    const { POST } = await import('@/app/api/users/route');
    const res = await POST(post('http://test/api/users', { action: 'sync' }, limitedCookie));
    expect(res.status).toBe(403);
  });

  it('accounts for every mirrored user when provisioning all', async () => {
    const { POST } = await import('@/app/api/users/route');
    const res = await POST(post('http://test/api/users', { action: 'provision_all' }, adminCookie));
    expect(res.status).toBe(200);
    const data = await body<{
      created: string[];
      kept: string[];
      failed: { username: string; error: string }[];
    }>(res);

    const seen = new Set([...data.created, ...data.kept, ...data.failed.map((f) => f.username)]);
    expect(seen).toEqual(new Set([accountName, 'limited', SUDOER]));
  });

  it('refuses to prune, rather than emptying the panel, when accounts are unreadable', async () => {
    const { POST } = await import('@/app/api/users/route');
    const { resetOsUserCache } = await import('@/lib/osusers');
    const original = process.env.BACKUP_MGR_PASSWD_FILE;
    process.env.BACKUP_MGR_PASSWD_FILE = '/nonexistent/passwd';
    resetOsUserCache();
    try {
      const res = await POST(post('http://test/api/users', { action: 'prune' }, adminCookie));
      expect(res.status).toBe(503);
      const data = await body<{ error: string }>(res);
      expect(data.error).toMatch(/could not be read/i);

      const listed = await (await import('@/app/api/users/route')).GET(
        get('http://test/api/users', adminCookie),
      );
      const users = await body<{ users: { username: string }[] }>(listed);
      expect(users.users.map((u) => u.username)).toContain(accountName);
    } finally {
      process.env.BACKUP_MGR_PASSWD_FILE = original;
      resetOsUserCache();
    }
  });

  it('reports where admin comes from, and that it cannot be set from here', async () => {
    const { PATCH } = await import('@/app/api/users/route');
    const listed = await (await import('@/app/api/users/route')).GET(
      get('http://test/api/users', adminCookie),
    );
    const data = await body<{
      users: {
        id: number;
        username: string;
        is_admin: boolean;
        sudo: { has_sudo: boolean; source: string };
      }[];
    }>(listed);
    expect(data.users.find((u) => u.username === accountName)?.sudo.has_sudo).toBe(true);
    expect(data.users.find((u) => u.username === 'limited')?.is_admin).toBe(false);

    const limited = data.users.find((u) => u.username === 'limited');
    const res = await PATCH(
      new Request('http://test/api/users', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ id: limited?.id, is_admin: true }),
      }) as never,
    );
    expect(res.status).toBe(409);
    expect((await body<{ admin_from_os?: boolean }>(res)).admin_from_os).toBe(true);
  });

  it('cuts off panel access as soon as the Linux account is deleted', async () => {
    const { writePasswdFixture } = await import('@/lib/testhelp');
    const { resetOsUserCache } = await import('@/lib/osusers');
    const original = process.env.BACKUP_MGR_PASSWD_FILE;

    process.env.BACKUP_MGR_PASSWD_FILE = writePasswdFixture([
      { name: accountName, uid: accountUid, gid: accountGid, home: accountHome },
    ]);
    resetOsUserCache();
    try {
      const { GET } = await import('@/app/api/status/route');
      const res = await GET(get('http://test/api/status', limitedCookie));

      expect(res.status).toBe(401);
    } finally {
      process.env.BACKUP_MGR_PASSWD_FILE = original;
      resetOsUserCache();
    }
  });
});
