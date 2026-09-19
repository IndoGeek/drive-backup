export type FieldType =
  | 'string'
  | 'password'
  | 'number'
  | 'boolean'
  | 'text'
  | 'select'
  | 'string[]';

export type Field = {
  key: string;
  label: string;
  type: FieldType;
  help?: string;
  options?: string[];
  placeholder?: string;
};

export type Section = {
  id: string;
  title: string;
  description?: string;
  fields: Field[];
};

export const COMPRESSION_OPTIONS = [
  'tar',
  'tar.gz',
  'tar.zst',
  'tar.xz',
  'tar.bz2',
  'zip',
];
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
export const CIPHERS = ['AES256', 'AES192', 'AES128'];
export const SHUTDOWN_SIGNALS = ['stop', 'kill'];

export const CONFIG_SECTIONS: Section[] = [
  {
    id: 'general',
    title: 'General',
    fields: [
      {
        key: 'timezone',
        label: 'Timezone',
        type: 'string',
        placeholder: 'UTC',
        help: 'IANA name (e.g. UTC, Europe/London, Asia/Kolkata). Schedule times use it.',
      },
    ],
  },
  {
    id: 'backup',
    title: 'Backup',
    description: 'What gets archived, how, and where it is staged locally.',
    fields: [
      { key: 'backup.prefix', label: 'Archive prefix', type: 'string' },
      {
        key: 'backup.path',
        label: 'Source directory',
        type: 'string',
        help: 'The folder to archive. Must be readable by the run user.',
      },
      { key: 'backup.dir', label: 'Local staging dir', type: 'string' },
      {
        key: 'backup.compression',
        label: 'Compression',
        type: 'select',
        options: COMPRESSION_OPTIONS,
      },
      { key: 'backup.timestamp_format', label: 'Timestamp format', type: 'string' },
      { key: 'backup.max_local_backups', label: 'Max local backups', type: 'number' },
      {
        key: 'backup.exclude_patterns',
        label: 'Exclude patterns',
        type: 'string[]',
        help: 'Glob patterns, one per line (tar --exclude semantics).',
      },
      { key: 'backup.catch_up_on_start', label: 'Catch up on start', type: 'boolean' },
      {
        key: 'backup.catch_up_window_minutes',
        label: 'Catch-up window (minutes)',
        type: 'number',
      },
      { key: 'backup.min_free_disk_gb', label: 'Min free disk (GB)', type: 'number' },
      { key: 'backup.preflight_slack_factor', label: 'Preflight slack factor', type: 'number' },
    ],
  },
  {
    id: 'world',
    title: 'World backups (Minecraft)',
    description: 'Frequent snapshots of just the world folder.',
    fields: [
      { key: 'world_backup.enabled', label: 'Enabled', type: 'boolean' },
      {
        key: 'world_backup.minecraft_only',
        label: 'Minecraft only',
        type: 'boolean',
      },
      { key: 'world_backup.world_folder', label: 'World folder', type: 'string' },
      { key: 'world_backup.prefix', label: 'World archive prefix', type: 'string' },
      {
        key: 'world_backup.times',
        label: 'World backup times',
        type: 'string[]',
        help: 'One HH:MM per line, in the timezone above. Empty = no world snapshots.',
      },
    ],
  },
  {
    id: 'encryption',
    title: 'Encryption',
    fields: [
      { key: 'encrypt.enabled', label: 'Encrypt archives (gpg)', type: 'boolean' },
      {
        key: 'encrypt.passphrase',
        label: 'Passphrase',
        type: 'password',
        help: 'Losing or changing this makes existing archives unrecoverable.',
      },
      { key: 'encrypt.cipher', label: 'Cipher', type: 'select', options: CIPHERS },
    ],
  },
  {
    id: 'google_drive',
    title: 'Primary remote (Google Drive)',
    description: 'OAuth tokens are managed on the Auth page, not here.',
    fields: [
      { key: 'google_drive.remote', label: 'rclone remote name', type: 'string' },
      { key: 'google_drive.dir', label: 'Destination folder', type: 'string' },
      { key: 'google_drive.retention', label: 'Retention (archives kept)', type: 'number' },
      {
        key: 'google_drive.client_id',
        label: 'OAuth client ID',
        type: 'string',
        help: 'Optional. Leave blank to use browser-based auth on the Auth page.',
      },
      { key: 'google_drive.client_secret', label: 'OAuth client secret', type: 'password' },
      { key: 'google_drive.scope', label: 'Scope', type: 'string' },
      { key: 'google_drive.token_uri', label: 'Token URI', type: 'string' },
    ],
  },
  {
    id: 'storage',
    title: 'Storage / secondary remote',
    fields: [
      {
        key: 'storage.upload_to_all',
        label: 'Upload to every enabled remote',
        type: 'boolean',
        help: 'Off = primary first, fall back to secondary on failure.',
      },
      { key: 'storage.secondary.enabled', label: 'Secondary enabled', type: 'boolean' },
      { key: 'storage.secondary.remote', label: 'Secondary remote', type: 'string' },
      { key: 'storage.secondary.dir', label: 'Secondary folder', type: 'string' },
      { key: 'storage.secondary.retention', label: 'Secondary retention', type: 'number' },
      { key: 'storage.secondary.client_id', label: 'Secondary client ID', type: 'string' },
      { key: 'storage.secondary.client_secret', label: 'Secondary client secret', type: 'password' },
      { key: 'storage.secondary.scope', label: 'Secondary scope', type: 'string' },
    ],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    fields: [
      {
        key: 'notifications.discord_webhook',
        label: 'Discord webhook URL',
        type: 'password',
        help: 'Empty disables notifications.',
      },
    ],
  },
  {
    id: 'monitoring',
    title: 'Monitoring',
    fields: [
      { key: 'metrics.enabled', label: 'Prometheus endpoint enabled', type: 'boolean' },
      { key: 'metrics.host', label: 'Metrics host', type: 'string' },
      { key: 'metrics.port', label: 'Metrics port', type: 'number' },
    ],
  },
  {
    id: 'paths',
    title: 'Logging & internal paths',
    fields: [
      { key: 'logging.dir', label: 'Log directory', type: 'string' },
      { key: 'logging.level', label: 'Log level', type: 'select', options: LOG_LEVELS },
      { key: 'logging.keep_days', label: 'Keep logs (days)', type: 'number' },
      { key: 'state.file', label: 'State file', type: 'string' },
      { key: 'database.file', label: 'History database', type: 'string' },
    ],
  },
  {
    id: 'pterodactyl',
    title: 'Pterodactyl integration',
    description:
      'Controls the game server during backups. Leave disabled unless you run a Pterodactyl panel.',
    fields: [
      { key: 'pterodactyl.enabled', label: 'Enabled', type: 'boolean' },
      { key: 'pterodactyl.panel_url', label: 'Panel URL', type: 'string' },
      { key: 'pterodactyl.api_key', label: 'Client API key (ptlc_)', type: 'password' },
      { key: 'pterodactyl.server_id', label: 'Server UUID', type: 'string' },
      { key: 'pterodactyl.pre_backup_command', label: 'Pre-backup command', type: 'string' },
      { key: 'pterodactyl.pre_backup_delay_seconds', label: 'Pre-backup delay (s)', type: 'number' },
      { key: 'pterodactyl.shutdown_server', label: 'Stop server before backup', type: 'boolean' },
      {
        key: 'pterodactyl.shutdown_signal',
        label: 'Shutdown signal',
        type: 'select',
        options: SHUTDOWN_SIGNALS,
      },
      { key: 'pterodactyl.stop_timeout_seconds', label: 'Stop timeout (s)', type: 'number' },
      { key: 'pterodactyl.start_server_after', label: 'Start server after backup', type: 'boolean' },
      { key: 'pterodactyl.start_timeout_seconds', label: 'Start timeout (s)', type: 'number' },
      {
        key: 'pterodactyl.fail_on_error',
        label: 'Abort run on Pterodactyl error',
        type: 'boolean',
      },
    ],
  },
  {
    id: 'run',
    title: 'Run behaviour',
    fields: [
      {
        key: 'run.continue_after_manual_resume',
        label: 'Continue after failure',
        type: 'boolean',
        help: 'Off = pause scheduled backups until reset.',
      },
      { key: 'run.check_state_seconds', label: 'State check interval (s)', type: 'number' },
    ],
  },
];

export const CONFIG_FIELDS: Field[] = CONFIG_SECTIONS.flatMap((s) => s.fields);
export const CONFIG_KEYS = new Set(CONFIG_FIELDS.map((f) => f.key));
export const FIELD_BY_KEY = new Map(CONFIG_FIELDS.map((f) => [f.key, f]));

export const SCHEDULE_KEYS = new Set([
  'backup.time',
  'backup.backups_per_day',

  'backup.times',
]);

export const SCHEDULE_FIELDS: Field[] = [
  {
    key: 'backup.times',
    label: 'Backup times',
    type: 'string[]',
    help: 'Exact daily run times, one per line. Empty = use the even-spacing rule below.',
  },
  {
    key: 'backup.time',
    label: 'First daily backup (HH:MM)',
    type: 'string',
    placeholder: '03:30',
  },
  {
    key: 'backup.backups_per_day',
    label: 'Backups per day',
    type: 'number',
    help: '1 = once/day; N = N evenly spaced runs starting at the time above.',
  },
];

export function normalizeTime(value: unknown): string | null {
  const text = String(value ?? '').trim();
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function validateScheduleValue(key: string, value: unknown): string | null {
  if (key === 'backup.time') {
    return normalizeTime(value) ? null : `'backup.time' must be a 24-hour HH:MM time, got '${String(value)}'`;
  }
  if (key === 'backup.times') {
    const list = Array.isArray(value) ? value : [];
    for (const entry of list) {
      if (String(entry).trim() === '') continue;
      if (!normalizeTime(entry)) {
        return `'backup.times' entries must be 24-hour HH:MM times, got '${String(entry)}'`;
      }
    }
    return null;
  }
  return null;
}

export function coerce(field: Field, value: unknown): unknown {
  switch (field.type) {
    case 'number': {
      if (value === '' || value === null || value === undefined) return undefined;
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      return value === true || value === 'true' || value === 'on' || value === 1;
    case 'string[]':
      if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
      return String(value ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    default:
      return value === null || value === undefined ? '' : String(value);
  }
}
