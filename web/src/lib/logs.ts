import fs from 'node:fs/promises';
import path from 'node:path';
import { getPath, readConfig, resolveInConfig } from './config';
import { projectRoot } from './env';

export type LogFile = { name: string; size: number; mtime: string };

/**
 * A distinct kind of log. Several kinds can share one directory — the backup
 * logs and the daemon's pm2 logs both default to `<root>/logs` — so each source
 * filters by filename rather than by directory alone.
 */
export type LogSourceDef = {
  id: string;
  label: string;
  description: string;
  dir: string;
  match: (name: string) => boolean;
};

export type LogSourceView = Omit<LogSourceDef, 'match'> & { files: LogFile[] };

/** The backup log directory, from `logging.dir` in config.yml. */
export async function backupLogDir(): Promise<string> {
  const cfg = await readConfig();
  const rel = getPath(cfg, 'logging.dir');
  return resolveInConfig(typeof rel === 'string' && rel ? rel : './logs');
}

/** pm2's own stdout/stderr capture is `<name>.log` and `<name>-error.log`. */
function isPm2Pair(name: string, app: string): boolean {
  return name === `${app}.log` || name === `${app}-error.log`;
}

export function logSourceDefs(backupDir: string, root = projectRoot()): LogSourceDef[] {
  return [
    {
      id: 'backup',
      label: 'Backup',
      description: 'Output of backup runs and the scheduler, one file per day.',
      dir: backupDir,
      // `!pm2` matters: the daemon's pm2 capture lives in this same directory.
      match: (n) => n.endsWith('.log') && !n.startsWith('pm2'),
    },
    {
      id: 'daemon',
      label: 'Daemon (pm2)',
      description: 'stdout/stderr of the backup-mgr process, captured by pm2.',
      dir: path.join(root, 'logs'),
      match: (n) => isPm2Pair(n, 'pm2'),
    },
    {
      id: 'panel',
      label: 'Panel (pm2)',
      description: 'stdout/stderr of the web panel process, captured by pm2.',
      dir: path.join(root, 'web', 'logs'),
      match: (n) => isPm2Pair(n, 'pm2-web'),
    },
  ];
}

export async function listLogs(
  dir: string,
  match: (name: string) => boolean = () => true,
): Promise<LogFile[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((e) => e.isFile() && (e.name.endsWith('.log') || e.name.endsWith('.txt')))
        .filter((e) => match(e.name))
        .map(async (e) => {
          const st = await fs.stat(path.join(dir, e.name));
          return { name: e.name, size: st.size, mtime: st.mtime.toISOString() };
        }),
    );
    // Newest first, so the most recent log is the default selection.
    return files.sort((a, b) =>
      a.mtime === b.mtime ? b.name.localeCompare(a.name) : b.mtime.localeCompare(a.mtime),
    );
  } catch {
    return [];
  }
}

/** Every source with its current files, in one pass (one request for the UI). */
export async function listLogSources(defs: LogSourceDef[]): Promise<LogSourceView[]> {
  return Promise.all(
    defs.map(async ({ match, ...rest }) => ({ ...rest, files: await listLogs(rest.dir, match) })),
  );
}

export function findLogSource(defs: LogSourceDef[], id: string | null): LogSourceDef | null {
  if (!id) return null;
  return defs.find((d) => d.id === id) ?? null;
}

export async function readLog(dir: string, name: string, maxBytes = 200_000): Promise<string> {
  const safe = path.basename(name); // no traversal
  const full = path.join(dir, safe);
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
}
