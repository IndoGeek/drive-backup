export const PERMISSIONS = [
  { key: 'dashboard.view', label: 'View dashboard, status and history' },
  { key: 'backup.run', label: 'Run backups, dry runs and compression tests' },
  { key: 'backup.schedule', label: 'Edit the backup schedule' },
  { key: 'backup.check', label: 'Run integrity checks' },
  { key: 'backup.restore', label: 'Restore backups' },
  { key: 'backup.fix_perms', label: 'Fix file permissions' },
  { key: 'remote.auth', label: 'Authorize storage remotes (rclone)' },
  { key: 'config.view', label: 'View configuration' },
  { key: 'config.edit', label: 'Edit configuration' },
  { key: 'logs.view', label: 'View logs' },
  { key: 'daemon.control', label: 'Start / stop / restart the daemon' },
  { key: 'binary.install', label: 'Rebuild and reinstall the backup-mgr binary' },
  { key: 'users.manage', label: 'Manage users (admin only)' },
] as const;

export type Permission = (typeof PERMISSIONS)[number]['key'];

export const ALL_PERMISSIONS: Permission[] = PERMISSIONS.map((p) => p.key);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (ALL_PERMISSIONS as string[]).includes(value);
}

export function normalizePermissions(input: unknown): Permission[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(input.filter((v): v is string => typeof v === 'string').filter(isPermission)),
  );
}
