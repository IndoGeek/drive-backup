import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

let cookie = '';
let instanceRoot = '';
let binDir = '';

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
  signal?: string | null;
  ok?: boolean;
  command?: string;
  message?: string;
  id?: string;
  running?: boolean;
  status?: string;
  exit_code?: number | null;
  output?: string;
};

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

    expect(flat[0].type).toBe('start');
    expect(flat[0].command).toContain('check');
    expect(flat[0].command).toContain(instanceRoot);

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

async function readUntilStarted(res: Response): Promise<{
  messages: StreamMessage[];
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  decoder: TextDecoder;
}> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const messages: StreamMessage[] = [];
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { messages, reader: null, decoder };
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (line) messages.push(JSON.parse(line) as StreamMessage);
    }
    const text = messages
      .filter((m) => m.type === 'stdout' || m.type === 'stderr')
      .map((m) => m.data ?? '')
      .join('');
    if (text.includes('started')) return { messages, reader, decoder };
  }
}

async function readAttach(res: Response): Promise<StreamMessage[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const messages: StreamMessage[] = [];
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (line) messages.push(JSON.parse(line) as StreamMessage);
    }
  }
  return messages;
}

async function readRemaining(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
): Promise<StreamMessage[]> {
  const messages: StreamMessage[] = [];
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (line) messages.push(JSON.parse(line) as StreamMessage);
    }
  }
  return messages;
}

describe('persistent actions across disconnects', () => {
  const SLOW = ['#!/bin/sh', 'echo "started"', 'sleep 1.2', 'echo "middle"', 'sleep 1.2', 'echo "done"', 'exit 0'].join(
    '\n',
  );

  async function withBin<T>(name: string, body: string, fn: () => Promise<T>): Promise<T> {
    const bin = path.join(binDir, name);
    fs.writeFileSync(bin, body + '\n', { mode: 0o755 });
    const original = process.env.BACKUP_MGR_BIN;
    process.env.BACKUP_MGR_BIN = bin;
    try {
      return await fn();
    } finally {
      process.env.BACKUP_MGR_BIN = original;
    }
  }

  function attachRequest() {
    return new Request('http://test/api/actions/attach', { headers: { cookie } }) as never;
  }

  function stopRequest() {
    return new Request('http://test/api/actions/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({}),
    }) as never;
  }

  it('serves a snapshot of a finished action instead of dropping it' , { timeout: 15000 }, async () => {
    const { POST } = await import('@/app/api/actions/stream/route');
    const run = (await POST(streamRequest({ action: 'check' }))) as unknown as Response;
    const runFlat = (await readStream(run)).flat();
    const exit = runFlat[runFlat.length - 1];
    expect(exit.type).toBe('exit');
    expect(exit.ok).toBe(true);

    const { GET } = await import('@/app/api/actions/attach/route');
    const res = (await GET(attachRequest())) as unknown as Response;
    expect(res.status).toBe(200);
    const messages = await readAttach(res);
    expect(messages[0].type).toBe('snapshot');
    expect(messages[0].status).toBe('ok');
    expect(messages[0].exit_code).toBe(0);
    expect(messages[0].output ?? '').toContain('finished');
    expect(messages).toHaveLength(1);
  });

  it('keeps a running action alive across a disconnect and lets a new tab re-attach' , { timeout: 20000 }, async () => {
    await withBin('slow-run', SLOW, async () => {
      const { POST } = await import('@/app/api/actions/stream/route');
      const run = (await POST(streamRequest({ action: 'check' }))) as unknown as Response;
      const got = await readUntilStarted(run);
      expect(got.messages.some((m) => m.type === 'stdout')).toBe(true);
      await got.reader!.cancel();

      const { GET } = await import('@/app/api/actions/attach/route');
      const res = (await GET(attachRequest())) as unknown as Response;
      expect(res.status).toBe(200);
      const messages = await readAttach(res);
      const snapshot = messages[0];
      expect(snapshot.type).toBe('snapshot');
      expect(snapshot.status).toBe('running');
      const output = snapshot.output ?? '';
      expect(output).toContain('started');
      expect(output).not.toContain('done');

      const last = messages[messages.length - 1];
      expect(last.type).toBe('exit');
      expect(last.ok).toBe(true);
    });
  });

  it('refuses to start a second action while one is already running' , { timeout: 20000 }, async () => {
    await withBin('doubler', SLOW, async () => {
      const { POST } = await import('@/app/api/actions/stream/route');
      const first = (await POST(streamRequest({ action: 'check' }))) as unknown as Response;
      const got = await readUntilStarted(first);

      const second = (await POST(streamRequest({ action: 'check' }))) as unknown as Response;
      expect(second.status).toBe(409);
      const body = (await (second as unknown as Response).json()) as {
        running?: boolean;
        id?: string;
        error?: string;
      };
      expect(body.running).toBe(true);
      expect(typeof body.id).toBe('string');

      const rest = await readRemaining(got.reader!, got.decoder);
      const last = rest[rest.length - 1];
      expect(last.type).toBe('exit');
    });
  });

  it('stops a running action via the stop endpoint' , { timeout: 20000 }, async () => {
    await withBin('stoppable', SLOW, async () => {
      const { POST } = await import('@/app/api/actions/stream/route');
      const run = (await POST(streamRequest({ action: 'check' }))) as unknown as Response;
      const got = await readUntilStarted(run);

      const { POST: stop } = await import('@/app/api/actions/stop/route');
      const res = (await stop(stopRequest())) as unknown as Response;
      expect(res.status).toBe(200);
      const body = (await res.json()) as { stopped?: boolean; status?: string };
      expect(body.stopped).toBe(true);
      expect(body.status).toBe('running');

      const rest = await readRemaining(got.reader!, got.decoder);
      const last = rest[rest.length - 1];
      expect(last.type).toBe('exit');
      expect(last.ok).toBe(false);
      expect(last.signal).toBe('SIGTERM');

      const { GET } = await import('@/app/api/actions/attach/route');
      const attach = (await GET(attachRequest())) as unknown as Response;
      const snapshot = (await readAttach(attach))[0];
      expect(snapshot.status).toBe('failed');
      expect(snapshot.signal).toBe('SIGTERM');
    });
  });
});
