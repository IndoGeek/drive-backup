import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findLogSource, listLogSources, listLogs, logSourceDefs } from './logs';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('logSourceDefs', () => {
  it('exposes the three kinds of log', () => {
    const defs = logSourceDefs('/var/backup-logs', '/srv/proj');
    expect(defs.map((d) => d.id)).toEqual(['backup', 'daemon', 'panel']);
    expect(findLogSource(defs, 'backup')?.dir).toBe('/var/backup-logs');
    expect(findLogSource(defs, 'daemon')?.dir).toBe('/srv/proj/logs');
    expect(findLogSource(defs, 'panel')?.dir).toBe(path.join('/srv/proj', 'web', 'logs'));
  });

  it('keeps the pm2 logs out of the backup tab', () => {
    // The backup logs and the daemon's pm2 capture both default to <root>/logs,
    // so filename filtering is the only thing separating them.
    const [backup, daemon, panel] = logSourceDefs('/srv/proj/logs', '/srv/proj');

    expect(backup.match('backup_2026-09-19.log')).toBe(true);
    expect(backup.match('pm2.log')).toBe(false);
    expect(backup.match('pm2-error.log')).toBe(false);
    expect(backup.match('pm2-web.log')).toBe(false);

    expect(daemon.match('pm2.log')).toBe(true);
    expect(daemon.match('pm2-error.log')).toBe(true);
    expect(daemon.match('backup_2026-09-19.log')).toBe(false);
    expect(daemon.match('pm2-web.log')).toBe(false);

    expect(panel.match('pm2-web.log')).toBe(true);
    expect(panel.match('pm2-web-error.log')).toBe(true);
    expect(panel.match('pm2.log')).toBe(false);
  });

  it('returns null for an unknown source', () => {
    expect(findLogSource(logSourceDefs('/x'), 'nope')).toBeNull();
    expect(findLogSource(logSourceDefs('/x'), null)).toBeNull();
  });
});

describe('listLogs', () => {
  it('filters by the source predicate', async () => {
    const dir = tmpDir('bm-logs-');
    for (const n of ['backup_2026-09-19.log', 'pm2.log', 'pm2-error.log', 'notes.txt']) {
      fs.writeFileSync(path.join(dir, n), n);
    }

    const all = await listLogs(dir);
    expect(all.map((f) => f.name).sort()).toEqual(
      ['backup_2026-09-19.log', 'notes.txt', 'pm2-error.log', 'pm2.log'].sort(),
    );

    const [, daemon] = logSourceDefs(dir, dir);
    const pm2Only = await listLogs(dir, daemon.match);
    expect(pm2Only.map((f) => f.name).sort()).toEqual(['pm2-error.log', 'pm2.log']);
  });

  it('returns an empty list for a missing directory', async () => {
    expect(await listLogs('/definitely/not/here')).toEqual([]);
  });
});

describe('listLogSources', () => {
  it('reports each source with its own files', async () => {
    const root = tmpDir('bm-root-');
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'web', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'logs', 'backup_2026-09-19.log'), 'x');
    fs.writeFileSync(path.join(root, 'logs', 'pm2-error.log'), 'x');
    fs.writeFileSync(path.join(root, 'web', 'logs', 'pm2-web.log'), 'x');

    const views = await listLogSources(logSourceDefs(path.join(root, 'logs'), root));
    const byId = Object.fromEntries(views.map((v) => [v.id, v.files.map((f) => f.name)]));
    expect(byId.backup).toEqual(['backup_2026-09-19.log']);
    expect(byId.daemon).toEqual(['pm2-error.log']);
    expect(byId.panel).toEqual(['pm2-web.log']);
  });
});
