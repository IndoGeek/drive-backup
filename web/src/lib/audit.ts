import { db } from './panel-db';

/**
 * Who elevated, what they changed, and when.
 *
 * Privileges here come from the OS, so the interesting questions are the ones the
 * OS itself does not answer: which panel login elevated, which privileged action
 * ran, and what happened to it. This is that record — a plain table in the panel's
 * own database, written at the chokepoints in ./sudo.ts and by the routes that
 * actually change something.
 *
 * Deliberately boring, and deliberately narrow:
 *  - it records the *action* and its outcome, never the sudo password or any
 *    secret it may have been used to write;
 *  - it is append-only from the panel's point of view (nothing rewrites history);
 *  - reads are not recorded. Only elevation and work that changes something.
 */

export type AuditOutcome =
  /** A sudo password was accepted; an elevation grant opened. */
  | 'elevated'
  /** An elevation grant ended (requested, sign-out, or sudo rejected the password). */
  | 'elevation_ended'
  /** A privileged action refused to proceed until a password was given. */
  | 'prompted'
  /** Refused outright: no sudo, wrong password, or a rejected action. */
  | 'denied'
  /** A privileged action ran. */
  | 'allowed'
  /** It ran and failed. */
  | 'failed';

export type AuditEntry = {
  username: string;
  action: string;
  outcome: AuditOutcome;
  /** What changed — usernames, permission lists, targets. Never secrets. */
  detail?: Record<string, unknown> | null;
  /** 'passwordless' | 'password' (how the work was authorized), if relevant. */
  via?: string | null;
  /** Client address behind the request, when there is one. */
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

/** How many rows to keep. The trail is for answering questions, not for metrics. */
function maxRows(): number {
  const raw = Number(process.env.BACKUP_MGR_AUDIT_MAX);
  return Number.isFinite(raw) && raw >= 100 ? raw : 5000;
}

const MAX_TEXT = 2000;

function clamp(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/**
 * Record one event. Never throws: an audit write must not be able to fail the
 * action it is describing (though callers that *only* audit may care).
 */
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
    // Trim occasionally rather than on every insert: the check is cheap, but doing
    // it once in a while keeps the write path a single statement.
    if (Math.random() < 0.02) pruneAudit();
  } catch (e) {
    console.error('[audit] could not record an entry:', e);
  }
}

export type AuditQuery = {
  limit?: number;
  /** Only this account's events. */
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

/** Drop the oldest rows past the cap. Returns how many went. */
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

/** Parse a row's `detail` for display, tolerating anything a hand-edit left behind. */
export function auditDetail(row: AuditRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.detail || '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
