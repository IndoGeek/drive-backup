use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

#[derive(Clone, Debug)]
pub struct HistoryRow {
    pub id: i64,
    pub run_at: String,
    pub kind: String,
    pub name: String,
    pub size_bytes: Option<i64>,
    pub duration_ms: Option<i64>,
    pub remote: String,
    pub status: String,
    pub error: String,
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct ManifestRow {
    pub name: String,
    pub size_bytes: i64,
    pub md5: String,
    pub remote: String,
    pub uploaded_at: String,
    pub kind: String,
}

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
        }
        let conn = Connection::open(path).map_err(|e| format!("cannot open sqlite {}: {e}", path.display()))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS backups(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_at TEXT NOT NULL,
                kind TEXT NOT NULL,
                name TEXT NOT NULL,
                size_bytes INTEGER,
                duration_ms INTEGER,
                remote TEXT,
                status TEXT NOT NULL,
                error TEXT
            );
            CREATE TABLE IF NOT EXISTS remote_manifest(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                size_bytes INTEGER NOT NULL,
                md5 TEXT NOT NULL,
                remote TEXT NOT NULL,
                uploaded_at TEXT NOT NULL,
                kind TEXT NOT NULL
            );",
        )
        .map_err(|e| format!("sqlite init: {e}"))?;
        Ok(Db { conn: Mutex::new(conn) })
    }

    pub fn record_run(
        &self,
        run_at: &str,
        kind: &str,
        name: &str,
        size: Option<i64>,
        duration_ms: Option<i64>,
        remote: &str,
        status: &str,
        error: &str,
    ) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO backups(run_at, kind, name, size_bytes, duration_ms, remote, status, error)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![run_at, kind, name, size, duration_ms, remote, status, error],
        )
        .map_err(|e| format!("sqlite insert: {e}"))?;
        Ok(())
    }

    pub fn upsert_manifest(
        &self,
        name: &str,
        size: i64,
        md5: &str,
        remote: &str,
        uploaded_at: &str,
        kind: &str,
    ) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO remote_manifest(name, size_bytes, md5, remote, uploaded_at, kind)
             VALUES(?1,?2,?3,?4,?5,?6)
             ON CONFLICT(name) DO UPDATE SET
               size_bytes=excluded.size_bytes,
               md5=excluded.md5,
               remote=excluded.remote,
               uploaded_at=excluded.uploaded_at,
               kind=excluded.kind",
            params![name, size, md5, remote, uploaded_at, kind],
        )
        .map_err(|e| format!("sqlite manifest upsert: {e}"))?;
        Ok(())
    }

    pub fn prune_manifest_removed(&self, names: &[String]) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        for name in names {
            c.execute("DELETE FROM remote_manifest WHERE name=?1", params![name])
                .map_err(|e| format!("sqlite manifest delete: {e}"))?;
        }
        Ok(())
    }

    pub fn manifest(&self, name: &str) -> Option<ManifestRow> {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT name, size_bytes, md5, remote, uploaded_at, kind FROM remote_manifest WHERE name=?1",
            params![name],
            |r| {
                Ok(ManifestRow {
                    name: r.get(0)?,
                    size_bytes: r.get(1)?,
                    md5: r.get(2)?,
                    remote: r.get(3)?,
                    uploaded_at: r.get(4)?,
                    kind: r.get(5)?,
                })
            },
        )
        .ok()
    }

    pub fn history(&self, limit: usize) -> Vec<HistoryRow> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c
            .prepare("SELECT id, run_at, kind, name, size_bytes, duration_ms, remote, status, error FROM backups ORDER BY id DESC LIMIT ?1")
            .unwrap();
        let rows = stmt
            .query_map(params![limit as i64], |r| {
                Ok(HistoryRow {
                    id: r.get(0)?,
                    run_at: r.get(1)?,
                    kind: r.get(2)?,
                    name: r.get(3)?,
                    size_bytes: r.get(4)?,
                    duration_ms: r.get(5)?,
                    remote: r.get(6)?,
                    status: r.get(7)?,
                    error: r.get(8)?,
                })
            })
            .unwrap();
        rows.filter_map(|r| r.ok()).collect()
    }
}