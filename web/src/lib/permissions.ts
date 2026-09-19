export const PERMISSIONS = [
  { key: 'dashboard.view', label: 'View dashboard, status and history', scope: 'instance' },
  { key: 'backup.run', label: 'Run backups, dry runs and compression tests', scope: 'instance' },
  { key: 'backup.schedule', label: 'Edit the backup schedule', scope: 'instance' },
  { key: 'backup.check', label: 'Run integrity checks', scope: 'instance' },
  { key: 'backup.restore', label: 'Restore backups', scope: 'instance' },
  { key: 'backup.fix_perms', label: 'Fix file permissions', scope: 'instance' },
  { key: 'remote.auth', label: 'Authorize storage remotes (rclone)', scope: 'instance' },
  { key: 'config.view', label: 'View configuration', scope: 'instance' },
  { key: 'config.edit', label: 'Edit configuration', scope: 'instance' },
  { key: 'logs.view', label: 'View logs', scope: 'instance' },
  { key: 'daemon.control', label: 'Start / stop / restart the daemon', scope: 'instance' },
  {
    key: 'users.manage',
    label: 'Manage users: permissions, admins, access',
    scope: 'panel',
  },
  {
    key: 'binary.install',
    label: 'Rebuild and reinstall the shared backup-mgr binary',
    scope: 'panel',
  },
] as const;

export type Permission = (typeof PERMISSIONS)[number]['key'];
export type PermissionScope = (typeof PERMISSIONS)[number]['scope'];

export const ALL_PERMISSIONS: Permission[] = PERMISSIONS.map((p) => p.key);

export const INSTANCE_PERMISSIONS: Permission[] = PERMISSIONS.filter(
  (p) => p.scope === 'instance',
).map((p) => p.key);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (ALL_PERMISSIONS as string[]).includes(value);
}

export function normalizePermissions(input: unknown): Permission[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(input.filter((v): v is string => typeof v === 'string').filter(isPermission)),
  );
}
