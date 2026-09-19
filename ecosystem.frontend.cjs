const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const WEB = path.join(ROOT, 'web');

const LOG_DIR = path.join(WEB, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const pass = (...names) =>
  Object.fromEntries(
    names
      .map((name) => [name, process.env[name]])
      .filter(([, value]) => value !== undefined && value.trim() !== ''),
  );

const PORT = process.env.BACKUP_MGR_WEB_PORT || '3001';

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
          'BACKUP_MGR_ADMIN_USER',

          'BACKUP_MGR_CHECKOUT',

          'BACKUP_MGR_BIN',

          'BACKUP_MGR_SESSION_SECRET',

          'BACKUP_MGR_DATA_DIR',

          'BACKUP_MGR_INSTANCE_TEMPLATE',

          'BACKUP_MGR_SUDO_TIMEOUT_MS',
          'BACKUP_MGR_SUDO_GROUPS',
          'BACKUP_MGR_SUDO_FIXTURE',

          'BACKUP_MGR_MIN_UID',
          'BACKUP_MGR_INCLUDE_ROOT',
          'BACKUP_MGR_EXCLUDE_USERS',

          'BACKUP_MGR_AUTO_SYNC',
          'BACKUP_MGR_AUTO_SYNC_INTERVAL_MS',

          'BACKUP_MGR_AUTO_PROVISION',
          'BACKUP_MGR_OSUSER_CACHE_MS',

          'BACKUP_MGR_PASSWD_FILE',
          'BACKUP_MGR_SHADOW_FILE',
          'BACKUP_MGR_INSTANCES_FILE',
          'BACKUP_MGR_CONFIG_TEMPLATE',

          'BACKUP_MGR_MAX_LOGIN_FAILURES',
          'BACKUP_MGR_MIN_VERIFY_MS',

          'PM2_BIN',

          'CARGO_BIN',
        ),
      },
    },
  ],
};

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
