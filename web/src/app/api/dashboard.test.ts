import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

/**
 * The Dashboard's own endpoints: streaming action output, paginated history, and
 * the schedule keys. These run against a fake binary and a fake history.db so they
 * exercise the real routes without a daemon, sudo or a multi-hour backup.
 */

let cookie = '';
let instanceRoot = '';
let binDir = '';

/** A stand-in for backup-mgr that prints, pauses, then exits with `code`. */
function writeFakeBinary(name: string, lines: string[], code = 0, pauseMs = 250): string {
  const file = path.join(binDir, name);
  fs.writeFileSync(
    file,
    [
      '#!/bin/sh',
      ...lines.map((l) => `echo "${l}"`),
      `sleep ${(pauseMs / 1000).toFixed(3)}`,
      `echo "finished"`,
      `exit ${code}`,
    ].join('\n') + '\n',
    { mode: 0o755 },
  );
  return file;
}

beforeAll(async () => {
  const { currentAccount, tmpDir, writePasswdFixture, useSudoFixture } = await import('@/lib/testhelp');
  const account = currentAccount();

  const sandbox = tmpDir('bm-dash-');
  const home = path.join(sandbox, 'home');
  const dataDir = path.join(sandbox, 'data');
  binDir = path.join(sandbox, 'bin');
  instanceRoot = path.join(home, 'backup-mgr');
  fs.mkdirSync(path.join(instanceRoot, 'logs'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  process.env.BACKUP_MGR_PASSWD_FILE = writePasswdFixture([
    { name: account.name, uid: account.uid, gid: account.gid, home },
  ]);
  process.env.BACKUP_MGR_INSTANCE_TEMPLATE = '{home}/backup-mgr';
  process.env.BACKUP_MGR_DATA_DIR = dataDir;
  process.env.BACKUP_MGR_USERS_DB = path.join(dataDir, 'panel.db');
  process.env.BACKUP_MGR_SESSION_SECRET = 'test-secret';
  process.env.BACKUP_MGR_ADMIN_USER = account.name;
  useSudoFixture({ [account.name]: { has_sudo: true, passwordless: true } });

  // A provisioned instance: the routes refuse to act without a config.yml.
  fs.writeFileSync(
    path.join(instanceRoot, 'config.yml'),
    ['backup:', '  time: "03:30"', '  backups_per_day: 1', 'database:', '  file: "./history.db"', ''].join(
      '\n',
    ),
    { mode: 0o600 },
  );

  const { ensureUser } = await import('@/lib/users');
  const { createSession } = await import('@/lib/session');
  const admin = ensureUser(account.name);
  if (!admin) throw new Error('could not mirror the panel account');
  cookie = `bm_session=${createSession(admin.id).value}`;

  writeFakeBinary('backup-ok', ['first line', 'second line'], 0, 250);
  process.env.BACKUP_MGR_BIN = path.join(binDir, 'backup-ok');
});

function streamRequest(body: unknown, withCookie = true) {
  return new Request('http://test/api/actions/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(withCookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }) as never;
}

type StreamMessage = {
  type: string;
  data?: string;
  code?: number | null;
  ok?: boolean;
  command?: string;
  message?: string;
};

/** Read the whole NDJSON response, keeping the chunk boundaries. */
async function readStream(res: Response): Promise<StreamMessage[][]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: StreamMessage[][] = [];
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const messages: StreamMessage[] = [];
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (line) messages.push(JSON.parse(line) as StreamMessage);
    }
    if (messages.length) chunks.push(messages);
  }
  return chunks;
}

describe('streaming action output', () => {
  it('reports progress while the command is still running', async () => {
    const { POST } = await import('@/app/api/actions/stream/route');
    const res = (await POST(streamRequest({ action: 'check' }))) as unknown as Response;
    expect(res.status).toBe(200);

    const chunks = await readStream(res);
    const flat = chunks.flat();

    // The command line is echoed first, so the panel can show what is running.
    expect(flat[0].type).toBe('start');
    expect(flat[0].command).toContain('check');
    expect(flat[0].command).toContain(instanceRoot);

    // Output was delivered progressively: the early lines arrived in a chunk of
    // their own, before the process had finished. That is the whole point — the
    // panel shows progress instead of freezing until the command exits.
    const stdoutChunks = chunks
      .map((c) => c.filter((m) => m.type === 'stdout').map((m) => m.data ?? '').join(''))
      .filter((text) => text.length > 0);
    expect(stdoutChunks.length).toBeGreaterThan(1);
    expect(stdoutChunks[0]).toContain('first line');
    expect(stdoutChunks[0]).not.toContain('finished');

    const exit = flat[flat.length - 1];
    expect(exit.type).toBe('exit');
    expect(exit.ok).toBe(true);
    expect(exit.code).toBe(0);
    expect(stdoutChunks.join('')).toContain('finished');
  });

  it('reports a non-zero exit as unsuccessful rather than as a prompt', async () => {
    const failed = writeFakeBinary('backup-fail', ['boom'], 3, 10);
    const original = process.env.BACKUP_MGR_BIN;
    process.env.BACKUP_MGR_BIN = failed;
    try {
      const { POST } = await import('@/app/api/actions/stream/route');
      const res = (await POST(streamRequest({ action: 'check' }))) as unknown as Response;
      const flat = (await readStream(res)).flat();
      const exit = flat[flat.length - 1];
      expect(exit.type).toBe('exit');
      expect(exit.ok).toBe(false);
      expect(exit.code).toBe(3);
      // Never a sudo prompt: this command failed on its own terms.
      expect(flat.some((m) => m.type === 'error')).toBe(false);
    } finally {
      process.env.BACKUP_MGR_BIN = original;
    }
  });

  it('requires authentication and a known action', async () => {
    const { POST } = await import('@/app/api/actions/stream/route');
    const anon = (await POST(streamRequest({ action: 'check' }, false))) as unknown as Response;
    expect(anon.status).toBe(401);

    const unknown = (await POST(streamRequest({ action: 'not-an-action' }))) as unknown as Response;
    expect(unknown.status).toBe(400);
  });
});

describe('history pagination', () => {
  function seed(dbPath: string, count: number): void {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      size_bytes INTEGER,
      duration_ms INTEGER,
      remote TEXT,
      status TEXT,
      error TEXT
    )`);
    db.exec('DELETE FROM backups');
    for (let i = 1; i <= count; i++) {
      db.prepare(
        `INSERT INTO backups (run_at, kind, name, size_bytes, duration_ms, remote, status, error)
         VALUES (?, 'full', ?, 1000, 5000, 'gdrive:X', 'ok', '')`,
      ).run(`2026-09-19T10:${String(i).padStart(2, '0')}:00Z`, `bund_${String(i).padStart(2, '0')}.tar.zst`);
    }
    db.close();
  }

  it('returns a page plus the total, newest first', async () => {
    seed(path.join(instanceRoot, 'history.db'), 12);
    const { GET } = await import('@/app/api/history/route');

    const first = await GET(
      new Request('http://test/api/history?limit=5&offset=0', { headers: { cookie } }) as never,
    );
    const page1 = (await (first as unknown as Response).json()) as {
      runs: { name: string }[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(first.status).toBe(200);
    expect(page1.total).toBe(12);
    expect(page1.limit).toBe(5);
    expect(page1.runs).toHaveLength(5);
    expect(page1.runs[0].name).toBe('bund_12.tar.zst');

    const second = await GET(
      new Request('http://test/api/history?limit=5&offset=5', { headers: { cookie } }) as never,
    );
    const page2 = (await (second as unknown as Response).json()) as {
      runs: { name: string }[];
      total: number;
    };
    expect(page2.runs).toHaveLength(5);
    expect(page2.runs[0].name).toBe('bund_07.tar.zst');
    expect(page2.total).toBe(12);

    const last = await GET(
      new Request('http://test/api/history?limit=5&offset=10', { headers: { cookie } }) as never,
    );
    const page3 = (await (last as unknown as Response).json()) as { runs: unknown[]; total: number };
    expect(page3.runs).toHaveLength(2);
    expect(page3.total).toBe(12);
  });
});

describe('the schedule keys', () => {
  function readConfig(): Record<string, unknown> {
    const { parse } = require('yaml') as { parse: (s: string) => Record<string, unknown> };
    return parse(fs.readFileSync(path.join(instanceRoot, 'config.yml'), 'utf8'));
  }

  function put(values: Record<string, unknown>) {
    return new Request('http://test/api/schedule', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ values }),
    }) as never;
  }

  it('saves exact times, normalised and sorted', async () => {
    const { PUT } = await import('@/app/api/schedule/route');
    const res = await PUT(put({ 'backup.times': ['15:30', '6:5', '15:30', '03:30'] }));
    expect(res.status).toBe(200);

    const cfg = readConfig() as { backup: { times: string[]; time: string } };
    expect(cfg.backup.times).toEqual(['03:30', '06:05', '15:30']);
  });

  it('refuses a time the daemon would silently ignore', async () => {
    const { PUT } = await import('@/app/api/schedule/route');
    const bad = await PUT(put({ 'backup.times': ['25:00'] }));
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await (bad as unknown as Response).json())).toContain('HH:MM');

    const badSingle = await PUT(put({ 'backup.time': 'half past three' }));
    expect(badSingle.status).toBe(400);
  });

  it('clears the explicit times when going back to even spacing', async () => {
    const { PUT } = await import('@/app/api/schedule/route');
    const res = await PUT(put({ 'backup.times': [], 'backup.time': '03:30', 'backup.backups_per_day': '2' }));
    expect(res.status).toBe(200);
    const cfg = readConfig() as { backup: { times: string[]; backups_per_day: number; time: string } };
    expect(cfg.backup.times).toEqual([]);
    expect(cfg.backup.backups_per_day).toBe(2);
    expect(cfg.backup.time).toBe('03:30');
  });
});
