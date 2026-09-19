import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runAs, type Instance } from './instance';

export type RunRow = {
  id: number;
  run_at: string;
  kind: string;
  name: string;
  size_bytes: number | null;
  duration_ms: number | null;
  remote: string;
  status: string;
  error: string;
};

export type HistoryPage = {
  runs: RunRow[];

  total: number;
};

export function history(dbPath: string, limit = 50, offset = 0): HistoryPage {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return { runs: [], total: 0 };
  }
  try {
    db.pragma('busy_timeout = 3000');
    const runs = db
      .prepare(
        `SELECT id, run_at, kind, name, size_bytes, duration_ms, remote, status, error
         FROM backups ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, Math.max(offset, 0)) as RunRow[];
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM backups').get() as { n: number };
    return { runs, total: n };
  } catch {
    return { runs: [], total: 0 };
  } finally {
    db.close();
  }
}

export async function historyForInstance(
  inst: Instance,
  dbPath: string,
  limit = 50,
  offset = 0,
): Promise<HistoryPage> {
  try {
    const st = fs.statSync(dbPath);
    if (st.isFile() && fs.accessSync(dbPath, fs.constants.R_OK) === undefined) {
      return history(dbPath, limit, offset);
    }
  } catch {
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-hist-'));
  try {
    const copies = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    let gotMain = false;
    for (const src of copies) {
      const res = await runAs(inst, 'sh', ['-c', 'base64 < "$1"', 'sh', src], { timeoutMs: 30_000 });
      if (!res.ok) continue;
      const bytes = Buffer.from(res.stdout, 'base64');
      if (bytes.length === 0) continue;
      fs.writeFileSync(path.join(tmp, path.basename(src)), bytes, { mode: 0o600 });
      if (src === dbPath) gotMain = true;
    }
    if (!gotMain) return { runs: [], total: 0 };
    return history(path.join(tmp, 'history.db'), limit, offset);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
