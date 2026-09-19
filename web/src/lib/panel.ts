import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Configuration for the *panel itself* — where its own database lives, and how
 * each user's backup instance is laid out.
 *
 * Do not confuse this with an *instance* (see ./instance.ts): one user's
 * config.yml, logs, history and pm2 daemon. The panel is a single privileged
 * service; instances are what it manages on behalf of Linux users.
 */

/**
 * Read a numeric setting, treating an unset *or blank* variable as absent.
 *
 * Blank matters: a pm2 ecosystem file that passes
 * `BACKUP_MGR_SUDO_TIMEOUT_MS: process.env.X || ''` supplies an empty string, and
 * `Number('')` is 0 — which is a real value here ("ask every time"), not a
 * missing one. Without this, the documented defaults silently became 0.
 */
export function envNumber(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** The panel's own directory (`web/`). */
export function panelDir(): string {
  return process.env.BACKUP_MGR_PANEL_DIR || process.cwd();
}

/** Where the panel keeps its own state: `users.db`, `session.secret`, overrides. */
export function dataDir(): string {
  const dir = process.env.BACKUP_MGR_DATA_DIR || path.join(panelDir(), 'data');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Per-user instance layout overrides, e.g. `tanmay: { root: /opt/drive-backup }`. */
export type InstanceOverride = {
  root?: string;
  pm2_name?: string;
  pm2_home?: string;
};

export function instancesFile(): string {
  return process.env.BACKUP_MGR_INSTANCES_FILE || path.join(dataDir(), 'instances.yml');
}

let cached: Record<string, InstanceOverride> | null = null;

/**
 * Read `data/instances.yml`, which maps a Linux username to a non-default
 * instance location. This exists so an existing deployment can keep its
 * checkout in place instead of being forced under the new default layout.
 */
export function instanceOverrides(): Record<string, InstanceOverride> {
  if (cached) return cached;
  try {
    const parsed = parseYaml(fs.readFileSync(instancesFile(), 'utf8')) as
      | Record<string, InstanceOverride>
      | null;
    cached = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Missing or unreadable file just means "all defaults".
    cached = {};
  }
  return cached;
}

/** Drop the cached override file. Used after writes and by tests. */
export function resetInstanceOverrides(): void {
  cached = null;
}

/**
 * Where a user's instance lives when no override says otherwise. `{home}` is
 * substituted with the account's home directory, which gives per-user ownership
 * for free and keeps one user's archives out of everybody else's reach.
 */
export function instanceTemplate(): string {
  return process.env.BACKUP_MGR_INSTANCE_TEMPLATE || '{home}/backup-mgr';
}

/** Path to the committed template used to seed a brand-new instance's config. */
export function configTemplatePath(): string {
  return process.env.BACKUP_MGR_CONFIG_TEMPLATE || path.join(panelDir(), '..', 'config.example.yml');
}

/** The installed backup-mgr binary, shared read-only by every instance. */
export function binaryPath(): string {
  return process.env.BACKUP_MGR_BIN || 'backup-mgr';
}

/** pm2 binary. Instances each get their own daemon via PM2_HOME, not their own install. */
export function pm2Path(): string {
  return process.env.PM2_BIN || 'pm2';
}

// ---------------------------------------------------------------------------
// Mirroring Linux accounts (see ../lib/userwatch.ts)
// ---------------------------------------------------------------------------

/**
 * Whether the panel keeps its mirror of /etc/passwd up to date by itself.
 *
 * On by default: the point of the model is that `useradd` is the only step — a
 * new account must not wait for an admin to open the Users page. Set
 * `BACKUP_MGR_AUTO_SYNC=0` to make reconciliation happen only on demand.
 */
export function autoSync(): boolean {
  return process.env.BACKUP_MGR_AUTO_SYNC !== '0';
}

/** How often the mirror is reconciled. Clamped to >= 2s; default 15s. */
export function syncIntervalMs(): number {
  const raw = envNumber('BACKUP_MGR_AUTO_SYNC_INTERVAL_MS');
  return raw !== undefined && raw >= 2000 ? raw : 15_000;
}

/**
 * Whether a newly seen account also gets its instance created for it (directory
 * tree, seeded config.yml, ecosystem file) without an admin clicking Provision.
 *
 * Off by default: it writes into someone's home directory, so it should be a
 * deliberate choice. `BACKUP_MGR_AUTO_PROVISION=1` turns it on.
 */
export function autoProvision(): boolean {
  return process.env.BACKUP_MGR_AUTO_PROVISION === '1';
}

/**
 * The file whose changes announce a new account. Watching /etc/passwd directly
 * makes `useradd` visible within seconds instead of at the next poll.
 * (BACKUP_MGR_PASSWD_FILE is honoured so an alternate database is watched too.)
 */
export function passwdWatchPath(): string {
  return process.env.BACKUP_MGR_PASSWD_FILE || '/etc/passwd';
}

// ---------------------------------------------------------------------------
// Sudo (see ../lib/sudo.ts)
// ---------------------------------------------------------------------------

/**
 * Always treat this account as an administrator, on top of sudo detection.
 *
 * Sudo is the usual source of truth for "who is an admin", so this is an escape
 * hatch for the rare host where the panel cannot query sudo at all — not a way to
 * hand out admin.
 */
export function adminOverride(): string | null {
  return process.env.BACKUP_MGR_ADMIN_USER?.trim() || null;
}

/**
 * How long an elevated (sudo-authorized) panel session lasts before the password
 * is asked for again. Default 15 minutes, matching sudo's own timestamp_timeout,
 * because that is the behaviour people already expect.
 */
export function sudoTimeoutMs(): number {
  const raw = envNumber('BACKUP_MGR_SUDO_TIMEOUT_MS');
  // 0 is meaningful ("ask for the password every time"), so it must survive here —
  // only an unset or blank value falls back to sudo's own 15-minute default.
  return raw !== undefined && raw >= 0 ? raw : 15 * 60_000;
}

/** Groups whose membership grants sudo, for when sudo itself cannot be queried. */
export function sudoGroups(): string[] {
  const raw = process.env.BACKUP_MGR_SUDO_GROUPS;
  const list = (raw ?? 'sudo,admin,wheel')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : ['sudo', 'admin', 'wheel'];
}

/** A canned answer for one account, instead of asking sudo. Used by the tests. */
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

/** Drop the cached fixture file. Used after writes and by tests. */
export function resetSudoFixture(): void {
  sudoFixtureCache = null;
}

/** How often the passwd file's stat is checked for changes. Default 2s. */
export function passwdWatchIntervalMs(): number {
  const raw = envNumber('BACKUP_MGR_PASSWD_WATCH_INTERVAL_MS');
  return raw !== undefined && raw >= 100 ? raw : 2000;
}
