module.exports = {
  apps: [
    {
      name: 'backup-mgr',
      script: '/usr/local/bin/backup-mgr',
      args: 'daemon --config /opt/drive-backup/config.yml',
      cwd: '/opt/drive-backup',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 30000,
      max_memory_restart: '300M',
      time: true,
      out_file: '/opt/drive-backup/logs/pm2.log',
      error_file: '/opt/drive-backup/logs/pm2-error.log',
      merge_logs: true,
      kill_timeout: 20000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};