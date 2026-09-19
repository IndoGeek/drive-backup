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

/** Read the most recent runs. Returns [] when the DB does not exist yet. */
export function history(dbPath: string, limit = 50): RunRow[] {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return [];
  }
  try {
    db.pragma('busy_timeout = 3000');
    return db
      .prepare(
        `SELECT id, run_at, kind, name, size_bytes, duration_ms, remote, status, error
         FROM backups ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as RunRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * Read an instance's history database.
 *
 * An instance's history.db is mode 0600 and owned by that user, so the panel
 * usually cannot open it at all — which is the point of the multi-user model. When
 * it cannot, the file (plus its -wal, so recent commits are not missed) is fetched
 * through the owning user's identity into a private temp directory and read there.
 *
 * The direct path is tried first so the common case — a user viewing their own
 * instance — costs nothing.
 */
export async function historyForInstance(
  inst: Instance,
  dbPath: string,
  limit = 50,
): Promise<RunRow[]> {
  try {
    const st = fs.statSync(dbPath);
    if (st.isFile() && fs.accessSync(dbPath, fs.constants.R_OK) === undefined) {
      return history(dbPath, limit);
    }
  } catch {
    // Not readable as the panel user; fall through to the copy.
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-hist-'));
  try {
    const copies = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    let gotMain = false;
    for (const src of copies) {
      // `base64` avoids any binary/text mangling over a pipe; Buffer.from tolerates
      // the newlines it emits.
      const res = await runAs(inst, 'sh', ['-c', 'base64 < "$1"', 'sh', src], { timeoutMs: 30_000 });
      if (!res.ok) continue;
      const bytes = Buffer.from(res.stdout, 'base64');
      if (bytes.length === 0) continue;
      fs.writeFileSync(path.join(tmp, path.basename(src)), bytes, { mode: 0o600 });
      if (src === dbPath) gotMain = true;
    }
    if (!gotMain) return [];
    return history(path.join(tmp, 'history.db'), limit);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
