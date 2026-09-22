import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export function envNumber(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function panelDir(): string {
  return process.env.BACKUP_MGR_PANEL_DIR || process.cwd();
}

export function dataDir(): string {
  const dir = process.env.BACKUP_MGR_DATA_DIR || path.join(panelDir(), 'data');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export type InstanceOverride = {
  root?: string;
  pm2_name?: string;
  pm2_home?: string;
};

export function instancesFile(): string {
  return process.env.BACKUP_MGR_INSTANCES_FILE || path.join(dataDir(), 'instances.yml');
}

let cached: Record<string, InstanceOverride> | null = null;

export function instanceOverrides(): Record<string, InstanceOverride> {
  if (cached) return cached;
  try {
    const parsed = parseYaml(fs.readFileSync(instancesFile(), 'utf8')) as
      | Record<string, InstanceOverride>
      | null;
    cached = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    cached = {};
  }
  return cached;
}

export function resetInstanceOverrides(): void {
  cached = null;
}

export function instanceTemplate(): string {
  return process.env.BACKUP_MGR_INSTANCE_TEMPLATE || '{home}/backup-mgr';
}

export function configTemplatePath(): string {
  return process.env.BACKUP_MGR_CONFIG_TEMPLATE || path.join(panelDir(), '..', 'config.example.yml');
}

export function binaryPath(): string {
  return process.env.BACKUP_MGR_BIN || 'backup-mgr';
}

export function pm2Path(): string {
  return process.env.PM2_BIN || 'pm2';
}

export function autoSync(): boolean {
  return process.env.BACKUP_MGR_AUTO_SYNC !== '0';
}

export function syncIntervalMs(): number {
  const raw = envNumber('BACKUP_MGR_AUTO_SYNC_INTERVAL_MS');
  return raw !== undefined && raw >= 2000 ? raw : 15_000;
}

export function autoProvision(): boolean {
  return process.env.BACKUP_MGR_AUTO_PROVISION === '1';
}

export function passwdWatchPath(): string {
  return process.env.BACKUP_MGR_PASSWD_FILE || '/etc/passwd';
}

export function adminOverride(): string | null {
  return process.env.BACKUP_MGR_ADMIN_USER?.trim() || null;
}

export function sudoTimeoutMs(): number {
  const raw = envNumber('BACKUP_MGR_SUDO_TIMEOUT_MS');

  return raw !== undefined && raw >= 0 ? raw : 15 * 60_000;
}

export function restoreUnlockMs(): number {
  const raw = envNumber('BACKUP_MGR_RESTORE_UNLOCK_MS');
  return raw !== undefined && raw >= 0 ? raw : 15 * 60_000;
}

export function sudoGroups(): string[] {
  const raw = process.env.BACKUP_MGR_SUDO_GROUPS;
  const list = (raw ?? 'sudo,admin,wheel')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : ['sudo', 'admin', 'wheel'];
}

export type SudoFixtureEntry = { has_sudo: boolean; passwordless?: boolean };

let sudoFixtureCache: Record<string, SudoFixtureEntry> | null = null;

export function sudoFixture(): Record<string, SudoFixtureEntry> {
  if (sudoFixtureCache) return sudoFixtureCache;
  const file = process.env.BACKUP_MGR_SUDO_FIXTURE;
  try {
    const parsed = JSON.parse(fs.readFileSync(file as string, 'utf8')) as Record<
      string,
      SudoFixtureEntry
    >;
    sudoFixtureCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    sudoFixtureCache = {};
  }
  return sudoFixtureCache;
}

export function resetSudoFixture(): void {
  sudoFixtureCache = null;
}

export function passwdWatchIntervalMs(): number {
  const raw = envNumber('BACKUP_MGR_PASSWD_WATCH_INTERVAL_MS');
  return raw !== undefined && raw >= 100 ? raw : 2000;
}
