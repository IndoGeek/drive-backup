import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The audit trail answers "who elevated, what changed, when" — so these cover the
 * record, the ordering, the filters, the cap, and the promise that recording can
 * never break the action it describes.
 */

beforeAll(async () => {
  const { tmpDir } = await import('./testhelp');
  const dataDir = path.join(tmpDir('bm-audit-'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.BACKUP_MGR_DATA_DIR = dataDir;
  process.env.BACKUP_MGR_USERS_DB = path.join(dataDir, 'panel.db');
});

async function auditApi() {
  return import('./audit');
}

describe('the audit trail', () => {
  it('records an entry and reads it back with its detail', async () => {
    const { listAudit, recordAudit } = await auditApi();
    recordAudit({
      username: 'alice',
      action: 'update user access',
      outcome: 'allowed',
      via: 'password',
      detail: { username: 'bob', enabled: true, permissions: ['dashboard.view'] },
      address: '203.0.113.7',
    });

    const { entries } = listAudit({ limit: 10 });
    const entry = entries[0];
    expect(entry).toMatchObject({
      username: 'alice',
      action: 'update user access',
      outcome: 'allowed',
      via: 'password',
      address: '203.0.113.7',
    });
    expect(JSON.parse(entry.detail)).toMatchObject({ username: 'bob', enabled: true });
  });

  it('is newest first, so the most recent thing is what you see', async () => {
    const { listAudit, recordAudit } = await auditApi();
    recordAudit({ username: 'alice', action: 'elevation granted', outcome: 'elevated' });
    recordAudit({ username: 'root', action: 'prune deleted accounts', outcome: 'allowed' });
    const { entries } = listAudit({ limit: 5 });
    expect(entries[0].username).toBe('root');
    expect(entries[1].username).toBe('alice');
  });

  it('filters by account and by outcome', async () => {
    const { listAudit, recordAudit } = await auditApi();
    recordAudit({ username: 'carol', action: 'reinstall the shared binary', outcome: 'failed' });

    expect(listAudit({ username: 'carol' }).entries.map((e) => e.action)).toEqual([
      'reinstall the shared binary',
    ]);
    expect(listAudit({ outcome: 'elevated' }).entries.every((e) => e.outcome === 'elevated')).toBe(
      true,
    );
    expect(listAudit({ username: 'carol', outcome: 'elevated' }).entries).toEqual([]);
  });

  it('reports a total, and clamps the limit rather than trusting the caller', async () => {
    const { listAudit } = await auditApi();
    const { entries, total } = listAudit({ limit: 100_000 });
    expect(total).toBeGreaterThanOrEqual(entries.length);
    expect(entries.length).toBeLessThanOrEqual(1000);
    // A limit that is not a positive number is a caller mistake: too small means
    // one row, too large means the cap, and nothing means the default page.
    expect(listAudit({ limit: -5 }).entries.length).toBe(1);
    expect(listAudit({ limit: 0 }).entries.length).toBe(total);
  });

  it('keeps the trail bounded, dropping the oldest first', async () => {
    const { listAudit, pruneAudit, recordAudit } = await auditApi();
    for (let i = 0; i < 12; i++) {
      recordAudit({ username: 'alice', action: `action ${i}`, outcome: 'allowed' });
    }
    const before = listAudit({ limit: 1000 }).total;
    const removed = pruneAudit(5);
    expect(removed).toBe(before - 5);
    const after = listAudit({ limit: 1000 });
    expect(after.total).toBe(5);
    // The survivors are the newest ones, which is the point of a trail.
    expect(after.entries[0].action).toBe('action 11');
    expect(pruneAudit(5)).toBe(0);
  });

  it('never throws, even when the entry cannot be serialised', async () => {
    const { listAudit, recordAudit } = await auditApi();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const before = listAudit({ limit: 1000 }).total;
    // A circular detail cannot be JSON-encoded; recording must swallow that rather
    // than failing the privileged action it was describing.
    expect(() =>
      recordAudit({ username: 'alice', action: 'odd', outcome: 'allowed', detail: circular }),
    ).not.toThrow();
    expect(listAudit({ limit: 1000 }).total).toBe(before);
  });

  it('truncates a runaway error message instead of storing it whole', async () => {
    const { listAudit, recordAudit } = await auditApi();
    recordAudit({
      username: 'alice',
      action: 'reinstall the shared binary',
      outcome: 'failed',
      error: 'x'.repeat(5000),
    });
    const entry = listAudit({ limit: 1 }).entries[0];
    expect(entry.error?.length).toBeLessThan(3000);
  });
});
