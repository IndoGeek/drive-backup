# Drive Backup

Archive a folder on a schedule, upload it to Google Drive (and optionally a second remote), and get
told on Discord. Built for Linux VPSes, tested against Pterodactyl/Minecraft servers.

- **`backup-mgr`** — Rust CLI and daemon: compress → encrypt → upload → verify → prune → restore.
- **`web/`** — Next.js panel: configure, authorize remotes, run, schedule, restore, watch logs.
  Panel reference: [`web/README.md`](web/README.md).

## Install

```bash
# Debian/Ubuntu — rclone uploads, acl is for non-root access to the source folder
sudo apt update && sudo apt install -y rclone acl

# Rust 1.78+, Node 20+ (only the panel needs Node)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh && . "$HOME/.cargo/env"
```

Download or clone this project, then:

```bash
cargo build --release
sudo install -m 0755 target/release/backup-mgr /usr/local/bin/backup-mgr

cp config.example.yml config.yml     # edit: backup.path, google_drive.dir, timezone, time
nano config.yml

backup-mgr remote-auth --config config.yml            # authorize Google Drive (browser link)
sudo ./scripts/grant-access.sh "$USER" /path/to/data  # non-root only: read the source folder
backup-mgr check --config config.yml                  # listing works, remotes reachable
backup-mgr run --no-upload --config config.yml        # first real run, still without uploading
backup-mgr run --config config.yml                    # now the real thing
```

If `config.yml` is missing, the first command writes a documented default (mode `0600`) and asks you
to review it. `config.yml`, `rclone.conf`, `history.db`, `state.json`, `logs/`, `backup/` and
`web/data/` are git-ignored — they hold your OAuth token, passphrase and webhook, so never commit or
paste them.

Keep it running (optional but recommended):

```bash
npm i -g pm2
pm2 start ecosystem.config.cjs && pm2 save     # backup-mgr
pm2 startup                                    # run the printed command, so it survives a reboot
```

### Web panel

```bash
cd web && npm install && npm run build && cd ..
pm2 start web/ecosystem.config.cjs && pm2 save
```

Open `http://<vps-ip>:3001` and sign in with your **Linux** username and password — the same one you
`ssh` with. There is **no default login and no panel password to change**: accounts and privileges
come from the OS. Every human account (`uid >= 1000`, plus root) is already a panel user, a new one
appears seconds after `sudo adduser`, and **any account that may run `sudo` is an administrator**
(`sudo usermod -aG sudo alice`, effective in seconds).

Privileged panel work — managing users, reinstalling the binary, touching another user's instance —
runs under *that user's own* sudo: silent for `NOPASSWD` rules, otherwise one prompt that remembers
the password for 15 minutes. Your own config, backups and daemon never prompt, because they are
yours. Every elevation and privileged change is written to the audit log on the Logs page.

Two pm2 configs, one per app, each next to the code it starts:

| App | Config | Logs |
| --- | --- | --- |
| `backup-mgr` (daemon) | `ecosystem.config.cjs` | `logs/` |
| `backup-mgr-web` (panel) | `web/ecosystem.config.cjs` | `web/logs/` |

#### A domain instead of `:3001`

[`deploy/nginx-backup-mgr.conf`](deploy/nginx-backup-mgr.conf) is a complete nginx site (HTTPS with
Let's Encrypt, `http` → `https`, Cloudflare-aware). Set your hostname in both `server_name` lines and
the two `ssl_certificate` paths, then:

```bash
sudo ln -sfn /opt/drive-backup/deploy/nginx-backup-mgr.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Reload nginx — creating the symlink alone changes nothing, and until it reloads the hostname is served
by whichever site block comes first. For a certificate: `sudo certbot --nginx -d your.host`.

## Everyday commands

```bash
backup-mgr run                       # back up now
backup-mgr run --dry-run             # show what would happen, change nothing
backup-mgr check                     # verify remote archives against the recorded hashes
backup-mgr restore                   # list what can be restored
backup-mgr restore <file> [dir]      # restore (see below)
backup-mgr status                    # state, next run, remotes
backup-mgr history 20                # last 20 runs
backup-mgr fix-perms [--user u]      # re-apply access to the source folder
backup-mgr reset                     # clear a stuck / failed state
```

`restore` **empties the target directory first**, then extracts, so the result is exactly that
backup and nothing else. Extraction is staged inside the target, so a failure or interruption leaves
the target as it was, and targets that must never be emptied (`/`, the instance directory, the backup
directory, an ancestor of the source) are refused. Use `--merge` to write over the target and keep
files that are not in the archive, e.g. when restoring into a live server directory.

`restore` **aborts when an archive does not match the recorded hash** — a corrupt or tampered copy is
never silently extracted. `--force` overrides that deliberately.

On the panel, restoring from an instance with `encrypt.enabled` asks for the encryption passphrase in
a dialog and then runs the restore; it is remembered for 15 minutes (`BACKUP_MGR_RESTORE_UNLOCK_MS`),
and the CLI needs no prompt because it reads the passphrase from the config itself.

## Scheduling

Set one of these in `config.yml`, or use the Schedule card on the panel's Dashboard (both modes):

```yaml
backup:
  time: "03:30"            # first run of the day
  backups_per_day: 4       # -> 03:30, 09:30, 15:30, 21:30 (evenly spaced)

  times:                   # or exact times; when set, this IS the schedule
    - "03:30"
    - "15:30"
```

The daemon reads `config.yml` at startup, so apply changes with `pm2 restart backup-mgr`.

## Updating

```bash
git pull
cargo build --release && sudo install -m 0755 target/release/backup-mgr /usr/local/bin/backup-mgr
cd web && npm install && npm run build && cd ..
pm2 restart backup-mgr backup-mgr-web
```

The panel drives the `backup-mgr` on `PATH` (or `BACKUP_MGR_BIN`). If it does not match this checkout
it says so: the Dashboard badge turns red with a one-click **Rebuild & reinstall**, and it warns when
the running daemon still has the previous binary in memory (restart it to apply).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `cannot read source … Permission denied` | `sudo ./scripts/grant-access.sh "$USER" <dir>`, or **Fix permissions** on the Dashboard. Re-run after resetting permissions. |
| Config or schedule change does nothing | The daemon reads the file at startup: `pm2 restart backup-mgr`. |
| Dashboard badge red / "out of date" | The installed binary is not this checkout. Rebuild and reinstall (see **Updating**); the panel shows the exact command. |
| Banner asks to restart the daemon | A new binary was installed while it was running. Use **Restart daemon** on the Dashboard. |
| "A previous backup did not finish cleanly" | A run was interrupted. **Reset state** on the Dashboard (or `backup-mgr reset`); it stops a run in progress first. |
| Backup stops after a failure | By design: `run.continue_after_manual_resume` is `false`. Inspect, then reset. |
| Restore refuses the target | The target is a system directory or would take the instance/backups with it. Pick another directory, or `--merge`. |
| Restore refuses the archive | Its hash does not match the recorded manifest. Restore another archive, or `--force` if you know why. |
| Panel: "this account cannot sign in" | Only real OS accounts can sign in; a locked/no-password account cannot. |
| Panel: sign-in says `/etc/shadow` is unreadable | The panel's service account needs the passwordless sudo rules in [`deploy/sudoers-backup-mgr`](deploy/sudoers-backup-mgr). |
| Panel: "no instance yet" | That user has no `config.yml`. An admin can create it from the **Users** page. |
| Live logs don't appear through a proxy | It must not buffer: `proxy_buffering off` (already set in the nginx example). |
| Upload fails with `403`/`insufficientPermissions` | Re-authorize: `backup-mgr remote-auth --config config.yml`. |

Logs are per day in `logs/` (`backup_YYYY-MM-DD.log`) and also visible on the panel's Logs page.

## Development

```bash
cargo test                     # Rust: scheduling, restore integrity and target safety
cd web && npm test             # panel: auth, instances, sudo elevation, API routes
cd web && npx tsc --noEmit     # type-check
cd web && npm run build        # production build
```

Layout: `src/` (Rust), `web/src/app` (pages + API routes), `web/src/lib` (panel logic), `deploy/`,
`scripts/`.
