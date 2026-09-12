# Drive Backup

Automatic directory backup tool: archives a folder, uploads it to Google Drive (with an optional second remote for redundancy) and notifies you on Discord. Production-tested on Linux with Pterodactyl/Minecraft servers.

---

## 1. Install dependencies

| Software | Purpose | Install |
|---|---|---|
| `rclone` | Remote storage (Google Drive, B2, ...) | `apt install rclone` |
| `acl` (`setfacl`) | Non-root access to the backup directory | `apt install acl` |
| `gpg` (gnupg) | Archive encryption (only if `encrypt.enabled`) | `apt install gnupg` |
| `tar`, `gzip`/`zstd`/`xz`/`bzip2`/`zip` | Compression backends (match `backup.compression`) | `apt install tar gzip zstd xz-utils zip` |
| `cargo` | Build | [rustup.rs](https://rustup.rs) |
| `node` + `pm2` | Service deployment (optional; systemd also works) | `apt install nodejs npm && npm i -g pm2` |

## 2. Configure

Copy [`config.example.yml`](config.example.yml) to `config.yml` and edit it — every option is documented inline:

```bash
cp config.example.yml config.yml && nano config.yml
```

Key settings (also flagged as **CRITICAL** in the file):

| Option | Notes |
|---|---|
| `backup.prefix`, `backup.timestamp_format` | Archive naming; changing after first run stops old archives being pruned. |
| `backup.path`, `backup.dir` | The folder to archive (remote-safe: you need read access) and the local staging dir. |
| `google_drive.remote` / `dir` | Primary destination. |
| `backup.time` + `timezone` | When the scheduled backup runs. |
| `encrypt.passphrase`, `pterodactyl.api_key`, `refresh_token`, `discord_webhook` | Secrets live in `config.yml` only. `config.yml`, `*.db`, `state.json`, logs and archives are git-ignored — never commit them. |

> The daemon re-reads `config.yml` on every start, so after editing just `pm2 restart backup-mgr` (no reload command).

## 3. Quick start

```bash
# 1. build & install
cargo build --release
sudo install -m 0755 target/release/backup-mgr /usr/local/bin/backup-mgr

# 2. configure (see above)
cp config.example.yml config.yml && nano config.yml

# 3. create the rclone remote (once)
backup-mgr remote-auth --config config.yml

# 4. if running as a NON-ROOT user, grant access to the directory you back up
#    (the ONLY extra sudo step; installs 'acl' if missing):
sudo ./scripts/grant-access.sh $USER /path/to/your-backups-parent-directory

# 5. sanity check, then first backup
backup-mgr check --config config.yml
backup-mgr run --config config.yml

# 6. run as a service (scheduled backups)
pm2 start ecosystem.config.cjs && pm2 save
```

## 4. Commands

`backup-mgr <command> [--config PATH]`

| Command | What it does |
|---|---|
| `daemon` | Scheduled backups (`backup.time`, catch-up, manual-resume handling). |
| `run` | One full backup now (preflight → save-all → compress → encrypt → upload → verify → prune). Flags: `--dry-run`, `--no-upload`, `--keep-local`, `--world`, `--no-ptero`, `--force`. |
| `test-compress` | Local-only compression test, no upload. |
| `restore` | List/pick a remote archive, MD5-verify, download, decrypt, extract. |
| `check` | Verify remote MD5s against the SQLite manifest. |
| `history [N]` | Last N runs from the SQLite database (default 20). |
| `status [N]` | Current state + config; with N also prints the last N runs. |
| `remote-auth` | OAuth-setup the rclone remote. |
| `reset` | Clear the manual-resume/failure state. |

`backup-mgr status` tells you exactly where a failed run stopped; logs live in `./logs/backup_YYYY-MM-DD.log`.

## 5. Running without root (per-user deployment)

- **One-time sudo steps only:** install the binary, and run [`scripts/grant-access.sh`](scripts/grant-access.sh) to grant read+traverse access to the backup directory (it grants per-ACLs on the whole path, so reachability survives permission resets). Run it again if a failed backup shows `cannot read source ... Permission denied`.
- **rclone credentials are per-user:** each run writes your own fresh `~/.config/rclone/rclone.conf` from the `google_drive` credentials in `config.yml` (OAuth tokens auto-refresh). Don't symlink to another user's config.
- **pm2 runs as the user who started it**: `pm2 start ecosystem.config.cjs` uses *your* PM2.

The systemd unit below is the **privileged** alternative, run by the service's own user.

## 6. Systemd (alternative to pm2)

```ini
[Unit]
Description=backup-mgr daemon
After=network-online.target
[Service]
ExecStart=/usr/local/bin/backup-mgr daemon --config /opt/drive-backup/config.yml
WorkingDirectory=/opt/drive-backup
Restart=always
[Install]
WantedBy=multi-user.target
```

## 7. Troubleshooting

- **`backup path is not a directory` / `cannot read source` (non-root)** → permission on `backup.path`; re-run `sudo ./scripts/grant-access.sh $USER /path/to/your-backups-parent-directory`. The path must exist at run time.
- **Upload fails / auth expired** → `backup-mgr remote-auth`, or confirm `rclone lsd gdrive:` works.
- **Preflight refuses** → free disk too small; raise `min_free_disk_gb` headroom or resize.
- **Hash mismatch on `check`** → remote copy differs from manifest; restore from an older intact archive.
- **Passphrase forgotten** → irrecoverable; keep it safe (see `encrypt` notes in the example config).

## Project layout

```
scripts/grant-access.sh   # one-time sudo ACL grant for non-root backups
ecosystem.config.cjs      # per-user pm2 service (loads config.yml from this dir)
src/
  main.rs        # CLI + daemon + run/restore/check/status/history
  config.rs      # typed config + embedded example template
  drive.rs       # rclone remotes: config, upload, list, retention
  backup.rs      # compression, encryption, preflight
  db.rs          # SQLite history + remote-hash manifest
  notify.rs      # Discord webhook embeds
  metrics.rs     # Prometheus endpoint
  ptero.rs       # Pterodactyl CLIENT API websocket (save-all)
  scheduler.rs   # time slots / catch-up
  state.rs       # JSON run-state + manual-resume flag
  logger.rs      # per-day file logging
```