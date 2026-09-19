import { db } from './panel-db';

export type AuditOutcome =

  | 'elevated'

  | 'elevation_ended'

  | 'prompted'

  | 'denied'

  | 'allowed'

  | 'failed';

export type AuditEntry = {
  username: string;
  action: string;
  outcome: AuditOutcome;

  detail?: Record<string, unknown> | null;

  via?: string | null;

  address?: string | null;
  error?: string | null;
};

export type AuditRow = {
  id: number;
  at: string;
  username: string;
  action: string;
  outcome: AuditOutcome;
  detail: string;
  via: string | null;
  address: string | null;
  error: string | null;
};

function maxRows(): number {
  const raw = Number(process.env.BACKUP_MGR_AUDIT_MAX);
  return Number.isFinite(raw) && raw >= 100 ? raw : 5000;
}

const MAX_TEXT = 2000;

function clamp(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

export function recordAudit(entry: AuditEntry): void {
  try {
    const d = db();
    d.prepare(
      `INSERT INTO audit_log (at, username, action, outcome, detail, via, address, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      entry.username,
      entry.action,
      entry.outcome,
      clamp(entry.detail),
      entry.via ?? null,
      entry.address ?? null,
      entry.error ? entry.error.slice(0, MAX_TEXT) : null,
    );

    if (Math.random() < 0.02) pruneAudit();
  } catch (e) {
    console.error('[audit] could not record an entry:', e);
  }
}

export type AuditQuery = {
  limit?: number;

  username?: string;
  outcome?: AuditOutcome;
};

export function listAudit(query: AuditQuery = {}): { entries: AuditRow[]; total: number } {
  const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 1000);
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.username) {
    where.push('username = ?');
    params.push(query.username);
  }
  if (query.outcome) {
    where.push('outcome = ?');
    params.push(query.outcome);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const d = db();
  const entries = d
    .prepare(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as AuditRow[];
  const { n } = d.prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).get(...params) as {
    n: number;
  };
  return { entries, total: n };
}

export function pruneAudit(max = maxRows()): number {
  const d = db();
  const { n } = d.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number };
  if (n <= max) return 0;
  const info = d
    .prepare(
      `DELETE FROM audit_log WHERE id IN (
         SELECT id FROM audit_log ORDER BY id ASC LIMIT ?
       )`,
    )
    .run(n - max);
  return info.changes;
}

export function auditDetail(row: AuditRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.detail || '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
