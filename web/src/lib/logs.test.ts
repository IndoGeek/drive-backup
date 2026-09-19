import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  backupLogDir,
  findLogSource,
  listLogSources,
  logSourceDefs,
  readLog,
  type LogSourceDef,
} from './logs';
import { instanceFor, writeFileAs, type Instance } from './instance';
import { panelDir } from './panel';
import { useSoloInstance } from './testhelp';

let inst: Instance;

beforeAll(() => {
  const { account, root } = useSoloInstance();
  inst = instanceFor(account.name)!;
  // writeFileAs shells out, so the parent directories must already exist.
  fs.mkdirSync(inst.logsDir, { recursive: true });
  expect(root).toBe(inst.root);
});

function defs(): LogSourceDef[] {
  return logSourceDefs(inst, inst.logsDir);
}

describe('logSourceDefs', () => {
  it('exposes the three kinds of log', () => {
    expect(defs().map((d) => d.id)).toEqual(['backup', 'daemon', 'panel']);
  });

  it('routes each source through the right access mode', () => {
    const [backup, daemon, panel] = defs();
    // Backup and daemon logs belong to the user, so they need that identity.
    expect(backup.access).toBe('instance');
    expect(daemon.access).toBe('instance');
    expect(daemon.dir).toBe(inst.logsDir);
    // The panel's own logs are the panel's to read.
    expect(panel.access).toBe('panel');
    expect(panel.dir).toBe(path.join(panelDir(), 'logs'));
  });

  it('keeps the pm2 logs out of the backup tab', () => {
    // The backup logs and the daemon's pm2 capture share one directory, so
    // filename filtering is the only thing separating them.
    const [backup, daemon, panel] = defs();

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
    expect(findLogSource(defs(), 'nope')).toBeNull();
    expect(findLogSource(defs(), null)).toBeNull();
  });
});

describe('backupLogDir', () => {
  it('falls back to the instance log dir when the config is unreadable', async () => {
    expect(await backupLogDir(inst)).toBe(inst.logsDir);
  });
});

describe('listLogSources', () => {
  it('reports each source with its own files from a shared directory', async () => {
    await writeFileAs(inst, path.join(inst.logsDir, 'backup_2026-09-19.log'), 'run output\n', '600');
    await writeFileAs(inst, path.join(inst.logsDir, 'pm2-error.log'), 'daemon stderr\n', '600');

    const views = await listLogSources(inst, defs());
    const byId = Object.fromEntries(views.map((v) => [v.id, v.files.map((f) => f.name)]));
    // The invariant is the filename filter, not the exact directory contents.
    expect(byId.backup).toContain('backup_2026-09-19.log');
    expect(byId.backup).not.toContain('pm2-error.log');
    expect(byId.daemon).toEqual(['pm2-error.log']);
  });

  it('returns an empty list for a directory that does not exist', async () => {
    const views = await listLogSources(inst, [
      { id: 'x', label: 'x', description: '', access: 'instance', dir: '/definitely/not/here', match: () => true },
    ]);
    expect(views[0].files).toEqual([]);
  });
});

describe('readLog', () => {
  it('reads an instance log through the owning user', async () => {
    const file = 'backup_read.log';
    await writeFileAs(inst, path.join(inst.logsDir, file), 'line one\nline two\n', '600');
    const def = defs()[0];
    expect(await readLog(inst, def, file)).toContain('line two');
  });

  it('only returns the tail of a large file', async () => {
    const file = 'big.log';
    await writeFileAs(inst, path.join(inst.logsDir, file), `${'x'.repeat(5000)}END`, '600');
    const content = await readLog(inst, defs()[0], file, 10);
    // Exactly the last 10 bytes: 7 x's plus END.
    expect(content).toBe(`${'x'.repeat(7)}END`);
    expect(content).toHaveLength(10);
  });

  it('contains path traversal to the log directory', async () => {
    const content = await readLog(inst, defs()[0], '../../etc/passwd');
    // basename() reduces that to the directory's own 'passwd', which does not exist.
    expect(content).toBeNull();
  });

  it('returns null for a missing file', async () => {
    expect(await readLog(inst, defs()[0], 'nope.log')).toBeNull();
  });
});
