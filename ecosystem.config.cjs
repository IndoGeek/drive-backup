const path = require('path');

// Project root = the directory containing this file. Everything (config.yml,
// logs, backup dir) resolves against it, so this works for any user and any
// checkout location: `pm2 start ecosystem.config.cjs` / `pm2 restart
// ecosystem.config.cjs` always load THIS project root's config.yml.
const ROOT = __dirname;

module.exports = {
  apps: [
    {
      name: 'backup-mgr',
      script: '/usr/local/bin/backup-mgr',
      args: 'daemon --config ' + path.join(ROOT, 'config.yml'),
      cwd: ROOT,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 30000,
      max_memory_restart: '300M',
      time: true,
      out_file: path.join(ROOT, 'logs', 'pm2.log'),
      error_file: path.join(ROOT, 'logs', 'pm2-error.log'),
      merge_logs: true,
      kill_timeout: 20000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};