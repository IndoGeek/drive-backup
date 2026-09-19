import fs from 'node:fs/promises';
import path from 'node:path';
import { getPath, readInstanceConfig, resolveInInstance } from './config';
import { listFilesAs, readTailAs, type Instance } from './instance';
import { panelDir } from './panel';

export type LogFile = { name: string; size: number; mtime: string };

export type LogSourceDef = {
  id: string;
  label: string;
  description: string;
  access: 'instance' | 'panel';
  dir: string;
  match: (name: string) => boolean;
};

export type LogSourceView = Omit<LogSourceDef, 'match'> & { files: LogFile[] };

export async function backupLogDir(inst: Instance): Promise<string> {
  try {
    const cfg = await readInstanceConfig(inst);
    const rel = getPath(cfg, 'logging.dir');
    return resolveInInstance(inst, typeof rel === 'string' && rel ? rel : './logs');
  } catch {
    return inst.logsDir;
  }
}

function isPm2Pair(name: string, app: string): boolean {
  return name === `${app}.log` || name === `${app}-error.log`;
}

export function logSourceDefs(inst: Instance, backupDir: string): LogSourceDef[] {
  return [
    {
      id: 'backup',
      label: 'Backup',
      description: 'Output of this instance’s backup runs and scheduler, one file per day.',
      access: 'instance',
      dir: backupDir,

      match: (n) => n.endsWith('.log') && !n.startsWith('pm2'),
    },
    {
      id: 'daemon',
      label: 'Daemon (pm2)',
      description: 'stdout/stderr of this instance’s backup-mgr process, captured by pm2.',
      access: 'instance',
      dir: inst.logsDir,
      match: (n) => isPm2Pair(n, 'pm2'),
    },
    {
      id: 'panel',
      label: 'Panel (pm2)',
      description: 'stdout/stderr of the web panel itself — shared by every user.',
      access: 'panel',
      dir: path.join(panelDir(), 'logs'),
      match: (n) => isPm2Pair(n, 'pm2-web'),
    },
  ];
}

async function readPanelTail(full: string, maxBytes: number): Promise<string | null> {
  try {
    const st = await fs.stat(full);
    const start = Math.max(0, st.size - maxBytes);
    const fh = await fs.open(full, 'r');
    try {
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      return buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

async function listPanelLogs(dir: string): Promise<LogFile[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return await Promise.all(
      entries
        .filter((e) => e.isFile())
        .map(async (e) => {
          const st = await fs.stat(path.join(dir, e.name));
          return { name: e.name, size: st.size, mtime: st.mtime.toISOString() };
        }),
    );
  } catch {
    return [];
  }
}

export async function listLogSources(
  inst: Instance,
  defs: LogSourceDef[],
): Promise<LogSourceView[]> {
  return Promise.all(
    defs.map(async ({ match, ...rest }) => {
      let files: LogFile[];
      if (rest.access === 'panel') {
        files = (await listPanelLogs(rest.dir)).filter((f) => f.name.endsWith('.log'));
      } else {
        files = (await listFilesAs(inst, rest.dir)).filter(
          (f) => (f.name.endsWith('.log') || f.name.endsWith('.txt')) && match(f.name),
        );
      }

      files.sort((a, b) =>
        a.mtime === b.mtime ? b.name.localeCompare(a.name) : b.mtime.localeCompare(a.mtime),
      );
      return { ...rest, files };
    }),
  );
}

export function findLogSource(defs: LogSourceDef[], id: string | null): LogSourceDef | null {
  if (!id) return null;
  return defs.find((d) => d.id === id) ?? null;
}

export async function readLog(
  inst: Instance,
  def: LogSourceDef,
  name: string,
  maxBytes = 200_000,
): Promise<string | null> {
  const safe = path.basename(name);
  const full = path.join(def.dir, safe);
  if (def.access === 'panel') return readPanelTail(full, maxBytes);
  return readTailAs(inst, full, maxBytes);
}
