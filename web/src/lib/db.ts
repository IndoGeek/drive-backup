import Database from 'better-sqlite3';

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
