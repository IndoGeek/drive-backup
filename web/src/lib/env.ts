import path from 'node:path';

/** Root of the backup-mgr checkout (config.yml, history.db, logs/ live here). */
export function projectRoot(): string {
  return process.env.BACKUP_MGR_ROOT || path.resolve(process.cwd(), '..');
}

/** Path to config.yml. */
export function configPath(): string {
  return process.env.BACKUP_MGR_CONFIG || path.join(projectRoot(), 'config.yml');
}

/** The backup-mgr binary (name on PATH or an absolute path). */
export function binary(): string {
  return process.env.BACKUP_MGR_BIN || 'backup-mgr';
}
