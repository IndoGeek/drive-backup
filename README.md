# Drive Backup

Automatically archive a folder, upload it to Google Drive (optionally a second remote too) and get
told on Discord. Built for Linux VPSes, tested against Pterodactyl/Minecraft servers.

Two parts:

- **`backup-mgr`** — the Rust CLI and scheduler daemon: compress → encrypt (optional) → upload →
  verify → prune → restore.
- **`web/`** — a Next.js control panel: configure, authorize remotes, run and schedule backups,
  restore, and watch logs from any browser.

Full panel documentation is in [`web/README.md`](web/README.md).

## 1. Requirements

| | |
| --- | --- |
| Linux, **Rust 1.78+** (`rustup update stable`) | the committed `Cargo.lock` is v4; older cargo refuses it |
| **Node 20+** and `npm` | the panel |
| `rclone` | uploads — `apt install rclone` |
| `acl` | non-root access to the source folder — `apt install acl` |
| `pm2` (optional) | keeps the daemon and panel running — `npm i -g pm2` |
| `gnupg` (optional) | only for `encrypt.enabled` |
| `build-essential python3` (optional) | only if `npm install` fails building `better-sqlite3` |

## 2. Install

```bash
git clone <this-repo> drive-backup && cd drive-backup

# Rust binary
cargo build --release
sudo install -m 0755 target/release/backup-mgr /usr/local/bin/backup-mgr

# Configuration — the file is documented inline, line by line
cp config.example.yml config.yml
nano config.yml          # set backup.path, google_drive.dir, timezone, time, …

# Authorize the Google Drive remote (opens a browser link, then writes rclone.conf)
backup-mgr remote-auth --config config.yml

# Non-root only: grant read access to the folder you back up
sudo ./scripts/grant-access.sh "$USER" /path/to/backups-parent-dir

# First checks, then a real run
backup-mgr check --config config.yml
backup-mgr run   --config config.yml

# Run it on a schedule
pm2 start ecosystem.config.cjs && pm2 save
```

If `config.yml` is missing, the first command creates a fully commented default (mode `0600`) and
tells you to review it. `config.yml`, `rclone.conf`, `history.db`, `state.json`, `logs/`, `backup/`
and the panel's `web/data/` are all git-ignored — **never commit or paste them**, they hold your
OAuth token, encryption passphrase and Discord webhook.

### The web panel

```bash
cd web && npm install && npm run build && cd ..
pm2 start ecosystem.frontend.config.cjs   # app name: backup-mgr-web
pm2 save
```

Open `http://<vps-ip>:3001` and sign in with your **Linux** username and password — the same one you
`ssh` with. **There is no default panel login to change**: there are no panel passwords at all, you
authenticate against the OS, and every human account on the server (`uid >= 1000`, plus root) is
already a panel user. A new account appears seconds after `sudo adduser`.

**`sudo` decides who is an administrator.** An account that may run `sudo` is a panel admin;
`sudo usermod -aG sudo <user>` is how you promote someone. Privileged panel work — managing users,
reinstalling the shared binary, touching someone else's instance — runs under *that user's* own
sudo: silent when their rules are `NOPASSWD`, otherwise one prompt remembering the password for
15 minutes, exactly like sudo itself. Your own config, backups and daemon never prompt, because they
are yours. Every elevation and privileged change is written to an audit log on the Logs page.

To serve it on port 80 / a domain instead of `:3001`, see
[`deploy/nginx-backup-mgr.conf`](deploy/nginx-backup-mgr.conf). Note that an existing nginx site with
`listen 80 default_server` wins over a plain `listen 80` block — give this one its own port or a real
`server_name`. Set `BACKUP_MGR_WEB_HOST=127.0.0.1` to bind the panel to localhost only.

> **pm2 decides by filename:** it parses a file as a config only when the name matches
> `*.config.{js,cjs,mjs}`. So the panel starts as `ecosystem.frontend.config.cjs`, which re-exports
> `ecosystem.frontend.cjs`. Starting the latter directly makes pm2 run it as a script and start
> nothing — it detects that and exits with an explanation.

## 3. Everyday commands

```bash
backup-mgr run                     # back up now
backup-mgr run --dry-run           # show what would happen
backup-mgr check                   # verify remote archives against the recorded hashes
backup-mgr restore                 # list backups
backup-mgr restore <file> [dir]    # restore one (--force to override a hash mismatch)
backup-mgr status                  # current state, next run, remotes
backup-mgr history 20              # last 20 runs
backup-mgr fix-perms               # re-apply access to the source folder
backup-mgr reset                   # clear a stuck / failed state
```

`restore` **refuses to proceed when a downloaded archive does not match the recorded hash**. That is
the point: a corrupt or tampered copy is not silently extracted. `--force` overrides it deliberately.

**After every update of this repo, rebuild and reinstall the binary:**

```bash
cargo build --release && sudo install -m 0755 target/release/backup-mgr /usr/local/bin/backup-mgr
pm2 restart backup-mgr
```

The panel drives whichever `backup-mgr` is on `PATH` (or `BACKUP_MGR_BIN`), and an old binary lacks
the `--json` output it needs. It tells you rather than guessing: the Dashboard shows the installed
version and commit, turns the badge red when it does not match the checkout, offers a one-click
**Rebuild & reinstall**, and warns when the daemon is still running a since-replaced binary.

## 4. Scheduling

Set one of these in `config.yml`, or use the Dashboard's Schedule card (both modes are there):

```yaml
backup:
  time: "03:30"            # first run of the day
  backups_per_day: 4       # -> 03:30, 09:30, 15:30, 21:30 (evenly spaced)

  times:                   # or exact times; when set, it IS the schedule
    - "03:30"
    - "15:30"
```

World-only snapshots (`world_backup.times`) are separate, and are configured on the panel's Config
page with the rest of the world-backup settings. The daemon reads `config.yml` at startup, so
`pm2 restart backup-mgr` applies changes.

## 5. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `cannot read source … Permission denied` | Run `sudo ./scripts/grant-access.sh "$USER" <dir>` or press **Fix permissions** in the panel. Re-run after resetting permissions. |
| Config or schedule change does nothing | The daemon reads the file at startup: `pm2 restart backup-mgr`. |
| Dashboard badge is red / "out of date" | The installed binary is not this checkout. Rebuild and reinstall (see above); the panel prints the exact command. |
| Panel says the account has no instance | That user has no `config.yml` yet — an admin can create it from the **Users** page. |
| Backup stops after a failure | By design: `run.continue_after_manual_resume` is `false`. Inspect, then `backup-mgr reset`. |
| Sign-in says `/etc/shadow` is unreadable | The panel's service account needs passwordless sudo for `ge…`/`env`; see [`deploy/sudoers-backup-mgr`](deploy/sudoers-backup-mgr). |

## 6. Development

```bash
cargo test                    # Rust: scheduler/schedule rules, restore integrity gate  (12 tests)
cd web && npm test            # Panel: auth, instances, sudo elevation, API routes  (208 tests)
cd web && npx tsc --noEmit    # Type-check
```

Layout: `src/` (`main.rs`, `backup.rs`, `config.rs`, `scheduler.rs`, `drive.rs`, `db.rs`,
`state.rs`, `notify.rs`, `perms.rs`, `ptero.rs`, `metrics.rs`), `web/src/app` (pages + API routes),
`web/src/lib` (panel logic), `deploy/` (nginx + sudoers), `scripts/grant-access.sh`.
