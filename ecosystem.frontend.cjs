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
        // Initial admin password — used ONLY when web/data/users.db is first
        // created. Unset means the default "admin", which the panel then forces
        // you to change on first sign-in.
        BACKUP_MGR_PASSWORD: process.env.BACKUP_MGR_PASSWORD || '',
        // Repo root holding config.yml / history.db / logs (default: web/..).
        BACKUP_MGR_ROOT: process.env.BACKUP_MGR_ROOT || '',
        // Path to config.yml (default: $BACKUP_MGR_ROOT/config.yml).
        BACKUP_MGR_CONFIG: process.env.BACKUP_MGR_CONFIG || '',
        // The backup-mgr binary (default: "backup-mgr" on PATH).
        BACKUP_MGR_BIN: process.env.BACKUP_MGR_BIN || '',
        // Secret signing session cookies (default: web/data/session.secret).
        BACKUP_MGR_SESSION_SECRET: process.env.BACKUP_MGR_SESSION_SECRET || '',
        // Where users.db lives (default: web/data).
        BACKUP_MGR_DATA_DIR: process.env.BACKUP_MGR_DATA_DIR || '',
        // The pm2 app the Dashboard starts/stops (default: "backup-mgr").
        BACKUP_MGR_PM2_NAME: process.env.BACKUP_MGR_PM2_NAME || '',
        PM2_BIN: process.env.PM2_BIN || '',
        // Used by the one-click "Rebuild & reinstall" button. pm2 services do
        // not inherit an interactive shell's PATH, so set this if you installed
        // Rust somewhere unusual (default: ~/.cargo/bin/cargo, then PATH).
        CARGO_BIN: process.env.CARGO_BIN || '',
        // rclone config used when the panel creates a remote (e.g. B2).
        RCLONE_CONFIG: process.env.RCLONE_CONFIG || '',
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
