import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

let adminCookie = '';
let viewerCookie = '';
let flaggedCookie = '';

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-routes-'));
  process.env.BACKUP_MGR_DATA_DIR = dir;
  process.env.BACKUP_MGR_USERS_DB = path.join(dir, 'users.db');
  process.env.BACKUP_MGR_SESSION_SECRET = 'test-secret';
  delete process.env.BACKUP_MGR_PASSWORD;

  const { authenticate, createUser, updateOwnAccount } = await import('@/lib/users');
  const { createSession } = await import('@/lib/session');

  const admin = authenticate('admin', 'admin');
  if (!admin) throw new Error('default admin was not bootstrapped');
  // The bootstrap admin starts flagged; clear it the way a real user would so
  // the other guard tests below exercise permissions rather than this gate.
  updateOwnAccount(admin.id, { password: 'admin-test-password' });
  adminCookie = `bm_session=${createSession(admin.id).value}`;

  const viewer = createUser({
    username: 'viewer',
    password: 'pw',
    is_admin: false,
    permissions: ['dashboard.view', 'logs.view'],
  });
  viewerCookie = `bm_session=${createSession(viewer.id).value}`;

  const flagged = createUser({
    username: 'flagged',
    password: 'temp-password',
    is_admin: false,
    permissions: ['dashboard.view', 'backup.restore'],
    must_change_password: true,
  });
  flaggedCookie = `bm_session=${createSession(flagged.id).value}`;
});

function post(url: string, body: unknown, cookie?: string) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }) as never;
}

function get(url: string, cookie?: string) {
  return new Request(url, {
    headers: cookie ? { cookie } : {},
  }) as never;
}

describe('auth guards', () => {
  it('rejects unauthenticated restore listing', async () => {
    const { GET } = await import('@/app/api/restore/route');
    const res = await GET(get('http://test/api/restore'));
    expect(res.status).toBe(401);
  });

  it('rejects users without the required permission', async () => {
    const { GET } = await import('@/app/api/restore/route');
    const res = await GET(get('http://test/api/restore', viewerCookie));
    expect(res.status).toBe(403);
  });

  it('rejects non-admins from user management', async () => {
    const { GET } = await import('@/app/api/users/route');
    const res = await GET(get('http://test/api/users', viewerCookie));
    expect(res.status).toBe(403);
  });
});

describe('forced password change', () => {
  it('blocks a flagged account even when it holds the permission', async () => {
    const { GET } = await import('@/app/api/restore/route');
    const res = await GET(get('http://test/api/restore', flaggedCookie));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { must_change_password?: boolean };
    expect(body.must_change_password).toBe(true);
  });

  it('still lets the flagged account read its own profile', async () => {
    const { GET } = await import('@/app/api/auth/me/route');
    const res = await GET(get('http://test/api/auth/me', flaggedCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { must_change_password: boolean } };
    expect(body.user.must_change_password).toBe(true);
  });

  it('unlocks the account once the password is changed', async () => {
    const { updateOwnAccount, getUserByName } = await import('@/lib/users');
    const me = getUserByName('flagged');
    if (!me) throw new Error('flagged user missing');
    updateOwnAccount(me.id, { password: 'a-real-password' });

    const { GET } = await import('@/app/api/restore/route');
    // Guard now passes; the route proceeds (no backups configured -> empty list).
    const res = await GET(get('http://test/api/restore', flaggedCookie));
    expect(res.status).not.toBe(403);
  });
});

describe('daemon route', () => {
  it('validates the requested action', async () => {
    const { POST } = await import('@/app/api/daemon/route');
    const res = await POST(post('http://test/api/daemon', { action: 'explode' }, adminCookie));
    expect(res.status).toBe(400);
  });

  it('reports the installed binary build stamp', async () => {
    const { GET } = await import('@/app/api/binary/route');
    const res = await GET(get('http://test/api/binary', adminCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stale: boolean;
      expected: { version: string | null };
      install_command: string;
    };
    // In the repo the checkout is always parseable, even with no binary present.
    expect(body.expected.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof body.stale).toBe('boolean');
    expect(body.install_command).toContain('install -m 0755');
  });

  it('requires authentication', async () => {
    const { POST } = await import('@/app/api/daemon/route');
    const res = await POST(post('http://test/api/daemon', { action: 'start' }));
    expect(res.status).toBe(401);
  });
});

describe('binary install route', () => {
  // Only the refusal paths are exercised: a successful POST would run a real
  // `cargo build` and install over the system binary.
  it('requires authentication', async () => {
    const { POST } = await import('@/app/api/binary/install/route');
    const res = await POST(post('http://test/api/binary/install', {}));
    expect(res.status).toBe(401);
  });

  it('refuses a user without binary.install', async () => {
    const { POST } = await import('@/app/api/binary/install/route');
    const res = await POST(post('http://test/api/binary/install', {}, viewerCookie));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { permission?: string };
    expect(body.permission).toBe('binary.install');
  });
});

describe('daemon route', () => {
  it('reports whether the daemon runs a replaced binary', async () => {
    const { GET } = await import('@/app/api/daemon/route');
    const res = await GET(get('http://test/api/daemon', adminCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { binary?: { restart_needed: boolean } };
    expect(body.binary).toBeTruthy();
    expect(typeof body.binary?.restart_needed).toBe('boolean');
  });
});

describe('rclone save route', () => {
  it('rejects a missing remote id', async () => {
    const { POST } = await import('@/app/api/rclone/save/route');
    const res = await POST(post('http://test/api/rclone/save', { id: '' }, adminCookie));
    expect(res.status).toBe(400);
  });

  it('requires the config-edit permission', async () => {
    const { POST } = await import('@/app/api/rclone/save/route');
    const res = await POST(post('http://test/api/rclone/save', { id: 'x' }, viewerCookie));
    expect(res.status).toBe(403);
  });
});
