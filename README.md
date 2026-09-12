# backup-mgr

Automatic game-server backup tool that archives your Pterodactyl server volume and pushes encrypted copies to Google Drive (with an optional second remote for redundancy), then notifies you on Discord.

Built and battle-tested for Linux servers. The current deployment runs on a Pterodactyl host (`panel.electropool.online`) backing up a Minecraft volume every night at 03:30 and pushing to Google Drive.

> **Status: production.** Full test suite verified against a local rclone remote and a fake webhook sink: fallback remote, AES256 encryption, restore, integrity check, world-only snapshots, retention, Discord embeds, metrics and dry-run all pass end-to-end.

---

## Features

- **Daily scheduled backups** — configurable `time` / `backups_per_day`, timezone-aware, with catch-up if the process was down.
- **Compression** — `tar`, `tar.gz`, `tar.zst`, `tar.xz`, `tar.bz2`, `zip`.
- **Encryption** — gpg symmetric AES256 (`gpg -c`), producing `*.tar.gz.gpg` archives. The passphrase lives **only** in your local `config.yml`; it is never sent to the remote.
- **Dual storage / fallback** — primary remote (e.g. Google Drive) plus an optional secondary remote (e.g. B2). If primary upload fails, the archive is automatically pushed to the secondary instead. Set `storage.upload_to_all: true` to mirror to every remote and abort on any failure.
- **Remote integrity check** — every run stores the remote MD5 hash in a SQLite manifest. `backup-mgr check` re-downloads hashes and verifies all archived manifests are intact.
- **Restore** — `backup-mgr restore` lists remote archives, verifies MD5 before download, decrypts and extracts (honors `exclude_patterns`).
- **World-only snapshots (Minecraft)** — fast, frequent backups of just the `world` folder (`mcworld_*.tar.gz.gpg`).
- **Pterodactyl save-all** — before compressing a live server, sends `save-all` through the panel CLIENT API websocket so the world is flushed to disk.
- **Discord notifications** — embedded messages for success/failure, restore, preflight failures, manual-resume and integrity checks.
- **Preflight disk check** — refuses to start if free disk is insufficient for the estimated archive size.
- **Prometheus metrics** — HTTP endpoint (`127.0.0.1:9101/metrics`) for monitoring/scraping.
- **SQLite history** — every run logged with archive name, hashes, sizes and result; used by `history` and `check`.
- **Dry-run** — `backup-mgr run --dry-run` walks the whole pipeline (preflight, compression to a temp archive, remote check + spec) but uploads nothing.

---

## Requirements (dependencies)

What you need on the host before installing:

| Software | Purpose | Install |
|---|---|---|
| `rclone` | Remote storage (Google Drive, B2, ...) | `apt install rclone` or [rclone.org](https://rclone.org/downloads/) |
| `gpg` (gnupg) | Archive encryption/decryption | `apt install gnupg` |
| `tar`, `gzip` / `zstd` / `xz` / `bzip2` / `zip` | Compression backends (install per your `backup.compression`) | `apt install tar gzip zstd xz-utils zip` |
| Rust toolchain (`cargo`) | Build | [rustup.rs](https://rustup.rs) |
| `node` + `pm2` (only for service deployment) | Process manager | `apt install nodejs npm && npm i -g pm2` |
| Cron/systemd (alternative to pm2) | Scheduling | built into the OS |

Networking: the host must reach the Pterodactyl panel websocket **and** Google Drive (or your chosen remote).

---

## Quick start

```bash
# 1. clone
git clone <your-repo-url> drive-backup && cd drive-backup

# 2. build (release)
cargo build --release
sudo install -m 0755 target/release/backup-mgr /usr/local/bin/backup-mgr

# 3. configure
cp config.example.yml config.yml                   # adjust for your deployment
nano config.yml

# 4. make sure the compression tools you chose are installed (see table above)

# 5. create the rclone remote (Google Drive)
backup-mgr remote-auth --config config.yml
#    opens the OAuth browser flow and writes the remote into ~/.config/rclone/rclone.conf

# 6. sanity checks
backup-mgr check --config config.yml          # verifies remote + local integrity
backup-mgr status --config config.yml         # shows current/last/history state

# 7. first backup (upload /tmp testing or for real):
backup-mgr run --config config.yml            # manual single run
# or a purely local archive (no upload) to test compression:
backup-mgr test-compress --config config.yml

# 8. run as a service
pm2 start ecosystem.config.cjs                # daemon: runs scheduled backups
pm2 save                                      # persist across reboots
```

The daemon reads `config.yml` **fresh on every start**, so after **any** config edit just:

```bash
pm2 restart backup-mgr
```

---

## Configuration

Every option is documented inline in [`config.example.yml`](config.example.yml). Copy it to `config.yml` and edit. A few that are **critical** (changing them can break backups or recovery):

| Option | Why it is critical |
|---|---|
| `backup.prefix` / `backup.timestamp_format` | Archive naming everywhere. Changing them makes retention pruning unable to recognise old archives (they are never auto-deleted). Only change before the first run. |
| `backup.path` | The exact folder that gets archived. Wrong folder = wrong data. |
| `encrypt.passphrase` | If `encrypt.enabled`, this MUST be set and kept safe. Lose it and no archive can ever be decrypted again. |
| `google_drive.remote` / `google_drive.dir` | Primary destination. Wrong name = every upload fails. |
| `database.file` / `state.file` | Changing the paths orphans history, hashes and failure-state tracking. |
| `pterodactyl.api_key` | Needed for the `save-all` webhook. |
| `timezone` | Affects scheduling (`backup.time`, `world_backup.times`). |

Secret material (`encrypt.passphrase`, `pterodactyl.api_key`, `refresh_token`, `discord_webhook`) lives in `config.yml` only. `config.yml`, `*.db`, `state.json`, logs and archives are **git-ignored** — never commit them to the repo.

---

## CLI commands

```
backup-mgr <command> [--config PATH]
```

| Command | What it does |
|---|---|
| `daemon --config PATH` | Scheduled backups: sleeps between slots, runs the day's backups (`0500` = first slot only, `050` spacing honoured), handles catch-up and manual-resume state. |
| `run` | Run one backup now (full pipeline: preflight → save-all → compress → encrypt → upload → verify → prune). `--dry-run` walks it without uploading. |
| `test-compress` | Local-only archive + compression test, no upload. |
| `restore` | Interactive/arg-driven remote restore: list, pick archive, MD5 check, download, decrypt, extract into destination. |
| `check` | Integrity: verifies remote MD5s against the SQLite manifest for all archives; also local disk checks. |
| `history [N]` | Show the last N runs from the SQLite database. |
| `remote-auth` | Interactively create/authenticate the primary (and secondary) rclone remote. |
| `status` | Current stage, failure state, next scheduled backup, resolved paths. |
| `reset` | Clear the manual-resume/failure state and resume scheduling. |

Run `backup-mgr` with no arguments for usage. Logs: `./logs/backup_YYYY-MM-DD.log` (configurable in `logging`).

---

## How a backup works (end to end)

1. **Preflight** — estimate source size and refuse if free disk is below the required slack.
2. **Save-all** (if `pterodactyl.enabled`) — send the console command and wait `pre_backup_delay_seconds`.
3. **Compress** the configured `backup.path` into a staging archive in `backup.dir` (prefix + timestamp, excluding `exclude_patterns`). World-only backups produce a second small archive when enabled.
4. **Encrypt** (if `encrypt.enabled`) — `gpg -c --cipher-algo AES256` → `.tar.gz.gpg`.
5. **Upload** to primary remote; verify each file's size; on failure, push to the secondary remote instead (or to every remote with `upload_to_all`).
6. **Verify** post-upload and store the remote MD5 in the SQLite manifest.
7. **Prune** — keep `retention` archives on the remote and `max_local_backups` locally; stale manifest rows and old logs are cleaned too.
8. **Notify** via Discord webhook (if set).

---

## Restore example

```bash
backup-mgr status --config config.yml            # see last good run name
backup-mgr restore --config config.yml --list     # list available archives
backup-mgr restore --config config.yml --archive mc_12-09-26_01-14.tar.gz.gpg --dest /var/lib/pterodactyl/volumes/<uuid>/
```

Restore verifies the MD5 against the manifest before downloading and decrypts/extracts automatically. Returned archive contents go into `--dest`.

---

## Encryption notes

- Encryption is **symmetric** (`gpg -c`). The exact passphrase is required at restore time.
- Encrypted archives are named `...tar.gz.gpg`; retention and restore handle the `.gpg` suffix automatically.
- The passphrase is resolved relative to nothing — it is pure config text. Store it in your password manager **in addition** to `config.yml`.
- Encryption is CPU-cheap for typical server volumes but your mileage varies with size.

---

## World-only backups (Minecraft)

```yaml
world_backup:
  enabled: true
  world_folder: "world"        # relative to backup.path
  prefix: "mcworld"
  times: ["06:00", "12:00", "18:00"]
```

Produces `mcworld_*.tar.gz.gpg` snapshots at the listed times, independent of the daily full backup. Intended for Minecraft servers only (`minecraft_only: true`).

---

## Discord notifications

Set `notifications.discord_webhook` to any channel webhook URL. You get rich embeds with live status, archive size/hash, error details and the exact log/state/db file paths for debugging. Nothing is sent when the URL is empty.

---

## Metrics

```bash
curl http://127.0.0.1:9101/metrics
```

Exposes Prometheus-format counters/gauges (runs, failures, last durations, upload bytes, encrypt times, etc.). Bind the host/port in `metrics` (default `127.0.0.1:9101`).

---

## Deployment as a systemd service (alternative to pm2)

If you prefer systemd, a minimal unit:

```ini
[Unit]
Description=backup-mgr daemon
After=network-online.target

[Service]
ExecStart=/usr/local/bin/backup-mgr daemon --config /opt/drive-backup/config.yml
WorkingDirectory=/opt/drive-backup
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
```

---

## Troubleshooting

- **Upload fails / auth expired** → re-run `backup-mgr remote-auth`. Check `gdrive:` resolves via `rclone lsd gdrive:`.
- **passphrase forgotten** → there is no recovery. Keep it safe (see Encryption notes).
- **preflight refuses to run** → free disk too small; lower `min_free_disk_gb` or resize the volume.
- **`check` reports a hash mismatch** → the remote copy differs from the manifest; re-download/re-upload or restore from an older intact archive.
- **Not enough disk during compression** → ensure `backup.dir` is on a volume with headroom equal to the source size.

---

## Project layout

```
src/
  main.rs        # CLI + daemon orchestration + run/restore/check commands
  config.rs      # typed config, serde defaults, embedded template (config.example.yml source of truth)
  drive.rs       # rclone remote discovery, upload/download lists, retention
  backup.rs      # compression, encryption, world-only archives, preflight
  db.rs          # SQLite history + remote-hash manifest, pruning
  notify.rs      # Discord webhook embeds
  metrics.rs     # Prometheus HTTP endpoint
  ptero.rs       # Pterodactyl CLIENT API websocket (save-all)
  scheduler.rs   # slot logic (time, backups_per_day, catch-up)
  state.rs       # JSON run-state / manual-resume flag
  logger.rs      # per-day file logging with rotation
```

---