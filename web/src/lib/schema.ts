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
  min?: number;
  max?: number;
  step?: number;
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
        help: 'IANA timezone name (e.g. UTC, Europe/London, Asia/Kolkata).\n\nEvery schedule time (backup time, exact times, world backup times) is interpreted in this timezone. A wrong value makes runs happen at unexpected hours, so check it against the server’s clock.',
      },
    ],
  },
  {
    id: 'backup',
    title: 'Backup',
    description: 'What gets archived, how, and where it is staged locally.',
    fields: [
      {
        key: 'backup.prefix',
        label: 'Archive prefix',
        type: 'string',
        help: "First part of every full-archive name.\n\nWith prefix \"mc\" a backup becomes mc_12-09-26_03-30.tar.gz. Use it to tell your own archives apart on the remote, and to avoid clashing with other servers that share the same Drive folder.\n\nLocal keep and remote retention count your backups by this prefix, so archives stay counted even if you switch compression later.",
      },
      {
        key: 'backup.path',
        label: 'Source directory',
        type: 'string',
        help: 'The folder that gets archived. EVERYTHING inside it is backed up unless excluded.\n\nMust be readable by the user the backups run as. For a Pterodactyl server this is usually the server volume under /var/lib/pterodactyl/volumes/.',
      },
      {
        key: 'backup.dir',
        label: 'Local staging dir',
        type: 'string',
        help: 'Local folder where archives are created before upload.\n\nRelative paths are resolved against the folder that contains config.yml. The staging dir needs enough free space for at least one archive; the disk preflight enforces this.',
      },
      {
        key: 'backup.compression',
        label: 'Compression',
        type: 'select',
        options: COMPRESSION_OPTIONS,
        help: 'Archive format.\n\n- tar — no compression: fastest but largest files\n- tar.gz — gzip: fast, well supported (recommended)\n- tar.zst — zstd: better ratio with modern tooling\n- tar.xz, tar.bz2 — smaller archives, slower to create\n- zip — interoperable with other tools\n\nThe same files stay consistent (a valid archive) for all of these.',
      },
      {
        key: 'backup.compression_level',
        label: 'Compression level',
        type: 'number',
        min: 0,
        max: 9,
        step: 1,
        help: 'How hard to compress the archive: 0-9.\n\n• Lower = FASTER to create, but LARGER archives\n• Higher = SLOWER to create, but SMALLER archives\n• 0 = store only (no compression at all, where supported)\n\nLeave EMPTY to use each tool’s built-in default.\n\nSpeed vs size grows smoothly both ways: pick 1-3 when speed matters, 7-9 when size/upload time matters more.\n\nWhat each compression type does with your level:\n\n• tar — no compression; the level is ignored entirely\n• tar.gz (gzip) — native levels 0-9, default 6: gzip -0 (store) … -6 (default balance) … -9 (best, noticeably slower than -1)\n• zip — native levels 0-9, default 6: zip -0 (store) … -6 (default) … -9 (best)\n• tar.xz (xz) — native levels 0-9, default 6: xz -0 (store) … -6 (default) … -9 (best; very slow at high levels)\n• tar.bz2 (bzip2) — native levels 1-9, default 9 (level 0 is treated as 1): -1 fastest … -9 slowest/best\n• tar.zst (zstd) — native levels 1-19, default 3. Our 0-9 scale maps to native zstd: 0-1 → 1, 2 → 3, 3 → 5, 4 → 7, 5 → 9, 6 → 11, 7 → 13, 8 → 16, 9 → 19',
      },
      {
        key: 'backup.timestamp_format',
        label: 'Timestamp format',
        type: 'string',
        help: 'strftime-like tokens used in archive names.\n\nSupported tokens: %Y (year), %y (short year), %m (month), %d (day), %H (24h hour), %M (minute), %S (second).\n\nExample %d-%m-%y_%H-%M produces 12-09-26_03-30.',
      },
      {
        key: 'backup.max_local_backups',
        label: 'Max local backups',
        type: 'number',
        help: 'How many of the most recent backups stay on this server.\n\nKeep 1 → the newest archive stays, every older one is deleted after a successful backup. Keep 3 → the 3 newest archives stay, everything older is pruned.\n\nWorks across compression types, so switching from tar.zst to tar.gz still keeps only the newest ones. This only affects disk space here — the remote uses its own retention setting. 0 is normalised to 1.',
      },
      {
        key: 'backup.exclude_patterns',
        label: 'Exclude patterns',
        type: 'string[]',
        help: 'Glob patterns excluded from the archive, one per line.\n\nUses tar --exclude semantics, e.g. \"*.zip\", \"cache/*\", or \"logs/*.tmp\". Empty means everything under the source directory is included.',
      },
      {
        key: 'backup.catch_up_on_start',
        label: 'Catch up on start',
        type: 'boolean',
        help: 'When the daemon starts, check whether a scheduled slot was missed while it was offline, and run it if it falls inside the catch-up window.\n\nKeeps your remote cadence intact after restarts or brief downtime.',
      },
      {
        key: 'backup.catch_up_window_minutes',
        label: 'Catch-up window (minutes)',
        type: 'number',
        help: 'How old a missed scheduled slot may be for catch-up to still run it.\n\nOlder missed slots are skipped instead of triggering a late backup.',
      },
      {
        key: 'backup.min_free_disk_gb',
        label: 'Min free disk (GB)',
        type: 'number',
        help: 'Extra free-disk buffer for the disk-space preflight.\n\nThe run refuses to start unless free disk is at least estimated archive size × slack-factor + this many GB. 0 disables the extra buffer (the size estimation still applies).',
      },
      {
        key: 'backup.preflight_slack_factor',
        label: 'Preflight slack factor',
        type: 'number',
        help: 'Safety multiplier applied to the estimated source size during the disk-space preflight.\n\nAccounts for the difference between the estimated uncompressed size and the archive being written mid-run, plus other processes growing the disk. The default 1.1 means 10% headroom.',
      },
    ],
  },
  {
    id: 'world',
    title: 'World backups (Minecraft)',
    description: 'Frequent snapshots of just the world folder.',
    fields: [
      {
        key: 'world_backup.enabled',
        label: 'Enabled',
        type: 'boolean',
        help: 'Turn on frequent snapshots of just the world folder.\n\nIntended for Minecraft servers, where periodic small spot-backups are useful alongside day-level full backups.',
      },
      {
        key: 'world_backup.minecraft_only',
        label: 'Minecraft only',
        type: 'boolean',
        help: 'Confirms this feature is meant for Minecraft servers only.\n\nLeave it on unless you deliberately use world snapshots for something else.',
      },
      {
        key: 'world_backup.world_folder',
        label: 'World folder',
        type: 'string',
        help: 'Sub-folder inside backup.path that holds the world (usually \"world\").\n\nUsed to locate the folder to snapshot and to warn if the game world looks misplaced.',
      },
      {
        key: 'world_backup.prefix',
        label: 'World archive prefix',
        type: 'string',
        help: 'Archive prefix for world snapshots.\n\nExample: with prefix \"mcworld\" a snapshot becomes mcworld_12-09-26_06-00.tar.gz.',
      },
      {
        key: 'world_backup.times',
        label: 'World backup times',
        type: 'string[]',
        help: 'Exact times for world snapshots, one HH:MM per line, in the configured timezone.\n\nEmpty = no world snapshots are taken.',
      },
    ],
  },
  {
    id: 'encryption',
    title: 'Encryption',
    fields: [
      {
        key: 'encrypt.enabled',
        label: 'Encrypt archives (gpg)',
        type: 'boolean',
        help: 'Encrypt each archive with gpg -c (symmetric encryption) before upload.\n\nEncrypted archives cannot be read without the passphrase, so the folder name/timestamps stay visible but the content does not. Downloads and restores decrypt automatically, provided the passphrase in this file still matches.',
      },
      {
        key: 'encrypt.passphrase',
        label: 'Passphrase',
        type: 'password',
        help: 'Passphrase used to encrypt and decrypt archives.\n\nLosing or changing this makes existing encrypted archives unrecoverable — there is no recovery path. It is stored in config.yml (file permissions are restricted to 0600).',
      },
      {
        key: 'encrypt.cipher',
        label: 'Cipher',
        type: 'select',
        options: CIPHERS,
        help: 'Symmetric cipher used by gpg.\n\nAES256 is the default and recommended; AES192/AES128 exist for compatibility with older tooling.',
      },
    ],
  },
  {
    id: 'google_drive',
    title: 'Primary remote (Google Drive)',
    description: 'OAuth tokens are managed on the Auth page, not here.',
    fields: [
      {
        key: 'google_drive.remote',
        label: 'rclone remote name',
        type: 'string',
        help: 'Name of the rclone remote used as the primary destination (e.g. \"gdrive\").\n\nIt must already exist in the rclone config. OAuth tokens are managed on the Auth page, not here.',
      },
      {
        key: 'google_drive.dir',
        label: 'Destination folder',
        type: 'string',
        help: 'Folder on the primary remote where archives are uploaded (created if missing).',
      },
      {
        key: 'google_drive.retention',
        label: 'Retention (archives kept)',
        type: 'number',
        help: 'How many of the most recent archives to keep on the primary remote.\n\nCounted by prefix, regardless of the compression format — so switching from tar.zst to tar.gz still prunes to this number overall. After a successful run, older archives beyond this number are pruned from the remote.',
      },
      {
        key: 'google_drive.client_id',
        label: 'OAuth client ID',
        type: 'string',
        help: 'Optional Google OAuth client ID.\n\nWhen set, it is written into the rclone config and used for the token exchange. Leave blank to use browser-based authentication on the Auth page instead.',
      },
      {
        key: 'google_drive.client_secret',
        label: 'OAuth client secret',
        type: 'password',
        help: 'OAuth client secret matching the client ID above. Only relevant when you supply your own OAuth client.',
      },
      {
        key: 'google_drive.scope',
        label: 'Scope',
        type: 'string',
        help: 'OAuth scope for the remote. The default is full Google Drive access (https://www.googleapis.com/auth/drive).',
      },
      {
        key: 'google_drive.token_uri',
        label: 'Token URI',
        type: 'string',
        help: 'OAuth token endpoint URL used for the refresh flow.\n\nLeave the default unless you know you need a custom identity provider.',
      },
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
        help: 'Off = the archive is uploaded to the primary remote; the secondary is only used as a fallback if the primary fails.\n\nOn = the archive is uploaded to EVERY enabled remote, and any failure aborts the run.',
      },
      {
        key: 'storage.secondary.enabled',
        label: 'Secondary enabled',
        type: 'boolean',
        help: 'Enable a second rclone remote (for example Backblaze B2) as a fallback or parallel destination.',
      },
      {
        key: 'storage.secondary.remote',
        label: 'Secondary remote',
        type: 'string',
        help: 'rclone remote name of the secondary destination. Must exist in the rclone config.',
      },
      {
        key: 'storage.secondary.dir',
        label: 'Secondary folder',
        type: 'string',
        help: 'Folder on the secondary remote where uploads go.',
      },
      {
        key: 'storage.secondary.retention',
        label: 'Secondary retention',
        type: 'number',
        help: 'How many of the most recent archives to keep on the secondary remote.\n\nAlso counted by prefix regardless of compression format, just like the primary retention.',
      },
      {
        key: 'storage.secondary.client_id',
        label: 'Secondary client ID',
        type: 'string',
        help: 'Optional OAuth client ID for the secondary remote (same rules as the primary).',
      },
      {
        key: 'storage.secondary.client_secret',
        label: 'Secondary client secret',
        type: 'password',
        help: 'OAuth client secret for the secondary remote, if you use your own client.',
      },
      {
        key: 'storage.secondary.scope',
        label: 'Secondary scope',
        type: 'string',
        help: 'OAuth scope for the secondary remote. Default is full Google Drive access.',
      },
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
        help: 'Discord webhook URL. Empty disables notifications.\n\nWhen set, embedded messages are sent for: backup success/failure, restore results, preflight failures, manual-resume situations and integrity checks. Every message includes the relevant log, state and database file paths.',
      },
    ],
  },
  {
    id: 'monitoring',
    title: 'Monitoring',
    fields: [
      {
        key: 'metrics.enabled',
        label: 'Prometheus endpoint enabled',
        type: 'boolean',
        help: 'Expose Prometheus-style metrics on a local HTTP endpoint for monitoring and scraping.',
      },
      {
        key: 'metrics.host',
        label: 'Metrics host',
        type: 'string',
        help: 'Bind address of the metrics endpoint.\n\nKeep 127.0.0.1 unless you sit behind a proxy that forwards the port.',
      },
      {
        key: 'metrics.port',
        label: 'Metrics port',
        type: 'number',
        help: 'TCP port of the metrics endpoint (default 9101).\n\nTry: curl http://127.0.0.1:9101/metrics',
      },
    ],
  },
  {
    id: 'paths',
    title: 'Logging & internal paths',
    fields: [
      {
        key: 'logging.dir',
        label: 'Log directory',
        type: 'string',
        help: 'Where the per-day backup log files live (one file per day). View them on the Logs page.',
      },
      {
        key: 'logging.level',
        label: 'Log level',
        type: 'select',
        options: LOG_LEVELS,
        help: 'Verbosity of the logs: debug | info | warn | error.\n\ndebug is the most detailed (useful when reporting problems); error only logs failures.',
      },
      {
        key: 'logging.keep_days',
        label: 'Keep logs (days)',
        type: 'number',
        help: 'How many days of log files to keep. Older files are rotated away on a schedule.',
      },
      {
        key: 'state.file',
        label: 'State file',
        type: 'string',
        help: 'JSON file holding the current run state.\n\nThe daemon uses it to track progress, resume after restarts and know when a manual reset is required.',
      },
      {
        key: 'database.file',
        label: 'History database',
        type: 'string',
        help: 'SQLite database storing the run history and the remote hash manifest used by integrity checks (backup-mgr check).',
      },
    ],
  },
  {
    id: 'pterodactyl',
    title: 'Pterodactyl integration',
    description:
      'Controls the game server during backups. Leave disabled unless you run a Pterodactyl panel.',
    fields: [
      {
        key: 'pterodactyl.enabled',
        label: 'Enabled',
        type: 'boolean',
        help: 'Enable controlling the game server through a Pterodactyl panel during backups.\n\nRequires a Pterodactyl CLIENT API key (see below). Leave disabled unless you run a Pterodactyl panel.',
      },
      {
        key: 'pterodactyl.panel_url',
        label: 'Panel URL',
        type: 'string',
        help: 'Base URL of the Pterodactyl panel, e.g. https://panel.example.com.',
      },
      {
        key: 'pterodactyl.api_key',
        label: 'Client API key (ptlc_)',
        type: 'password',
        help: 'Pterodactyl CLIENT API key (Account → API Credentials on the panel).\n\nIt must be a client key (starts with ptlc_), not a server or admin key.',
      },
      {
        key: 'pterodactyl.server_id',
        label: 'Server UUID',
        type: 'string',
        help: 'The server UUID to control, as shown in the panel URL for that server.',
      },
      {
        key: 'pterodactyl.pre_backup_command',
        label: 'Pre-backup command',
        type: 'string',
        help: 'Console command sent before the backup starts, e.g. \"save-all\".\n\nFor Minecraft, save-all forces the world to flush pending chunks to disk so the archive right after contains the exact current world. It does NOT stop the server.',
      },
      {
        key: 'pterodactyl.pre_backup_delay_seconds',
        label: 'Pre-backup delay (s)',
        type: 'number',
        help: 'Pause AFTER the pre-backup command is sent and BEFORE stopping/archiving.\n\nGives the world write-out time to finish. It is NOT the time after compression starts.',
      },
      {
        key: 'pterodactyl.shutdown_server',
        label: 'Stop server before backup',
        type: 'boolean',
        help: 'Stop the server completely before archiving.\n\nWith the server fully stopped, every file is consistent and nothing is mid-write — recommended for a fully reliable backup.',
      },
      {
        key: 'pterodactyl.shutdown_signal',
        label: 'Shutdown signal',
        type: 'select',
        options: SHUTDOWN_SIGNALS,
        help: '"stop" sends a graceful shutdown: the server saves and exits cleanly (safest).\n\n"kill" force-kills the process and carries a data-loss risk.',
      },
      {
        key: 'pterodactyl.stop_timeout_seconds',
        label: 'Stop timeout (s)',
        type: 'number',
        help: 'Maximum time to wait for the panel to report the server OFFLINE after the stop signal before giving up.',
      },
      {
        key: 'pterodactyl.start_server_after',
        label: 'Start server after backup',
        type: 'boolean',
        help: 'Start the server again automatically once the backup finishes — on success AND on failure (if it was stopped).',
      },
      {
        key: 'pterodactyl.start_timeout_seconds',
        label: 'Start timeout (s)',
        type: 'number',
        help: 'Maximum time to wait for the panel to report the server RUNNING after startup before giving up.',
      },
      {
        key: 'pterodactyl.fail_on_error',
        label: 'Abort run on Pterodactyl error',
        type: 'boolean',
        help: 'Off = Pterodactyl problems log a warning and the archive still happens.\n\nOn = the run is aborted (the server is restarted first if it was stopped).',
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
        help: 'Off = after a mid-way failure that needs a manual resume, scheduled backups pause until you run a reset (the panel shows a banner when this happens).\n\nOn = a warning is logged and scheduled backups keep running after a failure.',
      },
      {
        key: 'run.check_state_seconds',
        label: 'State check interval (s)',
        type: 'number',
        help: 'How often the daemon re-checks state and the schedule (seconds).\n\nLower is more responsive to schedule changes; higher touches the disk less.',
      },
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
      if (!Number.isFinite(n)) return undefined;
      if (field.min !== undefined && n < field.min) return field.min;
      if (field.max !== undefined && n > field.max) return field.max;
      return n;
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
