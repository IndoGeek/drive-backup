const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// The Next.js control panel (`web/`) — the web frontend.
//
// Sibling of ecosystem.config.cjs, which runs the Rust daemon. Start either
// independently, or both together:
//
//   pm2 start ecosystem.config.cjs                  # daemon (scheduled backups)
//   pm2 start ecosystem.frontend.config.cjs         # panel  <-- note the name
//   pm2 start ecosystem.frontend.config.cjs ecosystem.config.cjs   # both
//   pm2 save                                        # remember across reboots
//
// WHY THE .config.cjs SUFFIX: pm2 decides whether a file is an ecosystem config
// or a script-to-run by its FILENAME. Only `*.config.{js,cjs,mjs,json}` (and
// `ecosystem.{js,cjs}`) are parsed as configs. This file holds the definition,
// and `ecosystem.frontend.config.cjs` re-exports it under a name pm2 accepts —
// see the guard at the bottom, which turns the wrong invocation into a loud
// error instead of a silent no-op.
//
// Next.js must run with `web/` as its cwd: it resolves `.next/` and
// package.json from there, and the panel defaults BACKUP_MGR_ROOT to ".."
// (= this repo root, where config.yml, history.db and logs/ live).
// ---------------------------------------------------------------------------

const ROOT = __dirname;
const WEB = path.join(ROOT, 'web');

// pm2 opens these log files itself, so the directory has to exist first.
const LOG_DIR = path.join(WEB, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

// Only pass through variables that are actually set.
//
// `process.env.X || ''` would define X as an EMPTY STRING, which is not the same
// as leaving it undefined: `Number('')` is 0, so a numeric setting read that way
// silently became 0 instead of its default (SUDO_TIMEOUT_MS = "ask every time"
// rather than 15 minutes; MIN_UID = 0 rather than 1000). Omit blank values.
const pass = (...names) =>
  Object.fromEntries(
    names
      .map((name) => [name, process.env[name]])
      .filter(([, value]) => value !== undefined && value.trim() !== ''),
  );

const PORT = process.env.BACKUP_MGR_WEB_PORT || '3001';
// 0.0.0.0 keeps the panel reachable on the VPS IP — and nginx proxies to it.
// Set BACKUP_MGR_WEB_HOST=127.0.0.1 to expose the panel only through nginx.
const HOST = process.env.BACKUP_MGR_WEB_HOST || '0.0.0.0';

module.exports = {
  apps: [
    {
      name: 'backup-mgr-web',
      script: path.join(WEB, 'node_modules', 'next', 'dist', 'bin', 'next'),
      args: `start -p ${PORT} -H ${HOST}`,
      interpreter: 'node',
      cwd: WEB,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '400M',
      kill_timeout: 10000,
      time: true,
      out_file: path.join(LOG_DIR, 'pm2-web.log'),
      error_file: path.join(LOG_DIR, 'pm2-web-error.log'),
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        ...pass(
          // There are no panel passwords: users sign in with their Linux
          // password, and the panel mirrors /etc/passwd. Sudo decides who is an
          // admin, so ADMIN_USER is only an escape hatch for a host where sudo
          // is unqueryable.
          'BACKUP_MGR_ADMIN_USER',
          // The served checkout: Cargo.toml, target/ and config.example.yml live
          // here. Instance paths are per-user and never come from this.
          'BACKUP_MGR_CHECKOUT',
          // The shared backup-mgr binary (default: "backup-mgr" on PATH).
          'BACKUP_MGR_BIN',
          // Secret signing session cookies (default: web/data/session.secret).
          'BACKUP_MGR_SESSION_SECRET',
          // Where the panel's own data lives (default: web/data).
          'BACKUP_MGR_DATA_DIR',
          // Per-user instance layout. {home} is the account's home directory; an
          // existing deployment keeps its checkout via data/instances.yml.
          'BACKUP_MGR_INSTANCE_TEMPLATE',
          // Sudo: the source of truth for admin and for privileged work. An
          // account that may run sudo is a panel admin; privileged actions run
          // under that account's own sudo (silent when NOPASSWD, else after a
          // password remembered for SUDO_TIMEOUT_MS — 15 min by default — in
          // memory only).
          'BACKUP_MGR_SUDO_TIMEOUT_MS',
          'BACKUP_MGR_SUDO_GROUPS',
          'BACKUP_MGR_SUDO_FIXTURE',
          // Which accounts appear in the panel (all default to "human accounts").
          'BACKUP_MGR_MIN_UID',
          'BACKUP_MGR_INCLUDE_ROOT',
          'BACKUP_MGR_EXCLUDE_USERS',
          // Keeping the mirror of /etc/passwd current: on by default, so
          // `useradd` is enough. Set AUTO_SYNC=0 to reconcile only on demand.
          'BACKUP_MGR_AUTO_SYNC',
          'BACKUP_MGR_AUTO_SYNC_INTERVAL_MS',
          // Write a new account's instance for it (dirs + seeded config.yml).
          // Off unless explicitly enabled: it writes into that user's home.
          'BACKUP_MGR_AUTO_PROVISION',
          'BACKUP_MGR_OSUSER_CACHE_MS',
          // Alternate account database (NIS/LDAP wrappers, or a curated file).
          'BACKUP_MGR_PASSWD_FILE',
          'BACKUP_MGR_SHADOW_FILE',
          'BACKUP_MGR_INSTANCES_FILE',
          'BACKUP_MGR_CONFIG_TEMPLATE',
          // Sign-in throttling (failures before lockout, reply-time floor).
          'BACKUP_MGR_MAX_LOGIN_FAILURES',
          'BACKUP_MGR_MIN_VERIFY_MS',
          // pm2 is invoked per user, as that user, via sudo
          // (deploy/sudoers-backup-mgr).
          'PM2_BIN',
          // Used by the one-click "Rebuild & reinstall" button. pm2 services do
          // not inherit an interactive shell's PATH, so set this if you installed
          // Rust somewhere unusual (default: ~/.cargo/bin/cargo, then PATH).
          'CARGO_BIN',
        ),
      },
    },
  ],
};

// pm2 treats a non-`*.config.*` filename as a script to execute, which would
// quietly run this file and start nothing. Fail loudly instead of silently.
if (require.main === module) {
  console.error(
    [
      'This is a pm2 ecosystem *config* file, not a script — pm2 does not',
      'auto-detect this filename, so it just ran it and started nothing.',
      '',
      'Start the panel with the pm2-detectable name instead:',
      '',
      '    pm2 start ecosystem.frontend.config.cjs',
      '',
      'See the header of this file for why.',
    ].join('\n'),
  );
  process.exit(1);
}
