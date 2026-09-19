# Drive Backup

Automatic directory backup tool: archives a folder, uploads it to Google Drive (with an optional
second remote for redundancy) and notifies you on Discord. Production-tested on Linux with
Pterodactyl/Minecraft servers.

It ships two parts:

- **`backup-mgr`** — a Rust CLI/daemon that does the actual work (compress → encrypt → upload → verify → prune).
- **`web/`** — a Next.js control panel for everything above: configure, authorize remotes, run
  backups, schedule them, restore them, and watch the logs — from any browser, including over a
  plain VPS IP.

---

## 0. Read this first (new clones)

| | |
|---|---|
| **Rust version** | **1.78 or newer** — the committed `Cargo.lock` is lockfile v4, which older toolchains refuse to parse (`cargo 1.75` fails with "lock file version 4 requires `-Znext-lockfile-bump`"). `rustup update stable` if unsure. |
| **Secrets never go in git** | `config.yml` (encryption passphrase, Pterodactyl key, OAuth refresh token, Discord webhook), `history.db` (plus its `-wal`/`-shm` and `history.db.bak*` copies), `state.json`, `logs/`, `backup/`, and the panel's `web/data/` are all git-ignored. Never commit or paste them. |
| **`config.yml` is generated for you** | If it's missing, the first `backup-mgr` command writes a fully-commented default config (mode `0600`) and tells you to review it. |
| **Secrets are readable only by you** | `config.yml`, `rclone.conf` and the panel's session secret are `chmod 0600`ed automatically — on creation and again on load, so an older world-readable file gets fixed on the next run. |
| **Written atomically** | Config rewrites go through a temp file + `rename`, so a crash or power loss can't leave a truncated `config.yml` that stops the daemon from starting. |
| **The panel has no passwords of its own** | You sign in with your **Linux** username and password. Every human account on the server (`uid >= 1000`, plus root) is already a panel user, and a new one appears within seconds of `sudo adduser`. **There is no default login to change** — no bootstrap `admin`/`admin` account, because your Linux account already is your panel account. `sudo passwd -l <user>` locks the panel login too. |
| **Privileges come from sudo, not from the panel** | An account that may run `sudo` is a panel **administrator**; root holds everything. Privileged work (managing users, reinstalling the shared binary, provisioning or acting on someone else's instance) runs under *that user's* own sudo — silent when their rules are `NOPASSWD`, otherwise one password prompt that is remembered for 15 minutes (`sudo`'s own default). Grant admin with `sudo usermod -aG sudo <user>`. |
| **Non-root users need one ACL grant** | Run [`scripts/grant-access.sh`](scripts/grant-access.sh) once with `sudo`, or press **Fix permissions** in the panel. Both are idempotent. |
| **`restore` refuses a hash mismatch by default** | Pass `--force` to override deliberately. |
| **Keep the installed binary in sync with the repo** | After every update, re-run `cargo build --release && sudo install -m 0755 target/release/backup-mgr /usr/local/bin/backup-mgr`. The panel talks to whichever `backup-mgr` is on `PATH` (or `BACKUP_MGR_BIN`), and an older binary lacks the `--json` output it needs. **The Dashboard tells you**: it shows the running version + commit, turns that badge red when it doesn't match the checkout, and offers a one-click **Rebuild & reinstall**. |

## 1. Install dependencies

| Software | Purpose | Install |
|---|---|---|
| `rclone` | Remote storage (Google Drive, B2, ...) | `apt install rclone` |
| `acl` (`setfacl`) | Non-root access to the backup directory | `apt install acl` |
| `gpg` (gnupg) | Archive encryption (only if `encrypt.enabled`) | `apt install gnupg` |
| `tar`, `gzip`/`zstd`/`xz`/`bzip2`/`zip` | Compression backends (match `backup.compression`) | `apt install tar gzip zstd xz-utils zip` |
| `cargo` ≥ 1.78 | Build the Rust binary | [rustup.rs](https://rustup.rs) |
| `node` ≥ 20 + `npm` | Build/run the web panel | `apt install nodejs npm` |
| `pm2` | Service deployment for both the daemon and the panel (optional; systemd works too) | `npm i -g pm2` |
| `nginx` | Expose the panel on the VPS IP / a domain (see [`deploy/`](deploy/nginx-backup-mgr.conf)) | `apt install nginx` |

Building `web/` needs a C toolchain (`make`, `g++`) for the bundled `better-sqlite3` native module —
`apt install build-essential python3` if the npm install fails.

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
| `encrypt.passphrase`, `pterodactyl.api_key`, `refresh_token`, `discord_webhook` | Secrets live in `config.yml` only. |

You can edit all of this by hand, **or** through the panel's Config tab (which preserves comments).

> The daemon re-reads `config.yml` on every start, so after editing just `pm2 restart backup-mgr`
> (there is no reload command).

## 3. Quick start

```bash
# 1. build & install the CLI
cargo build --release
sudo install -m 0755 target/release/backup-mgr /usr/local/bin/backup-mgr

# 2. configure (see above)
cp config.example.yml config.yml && nano config.yml

# 3. create the rclone remote (once)
backup-mgr remote-auth --config config.yml

# 4. non-root only: grant read access to the directory you back up
sudo ./scripts/grant-access.sh $USER /path/to/your-backups-parent-directory

# 5. sanity check, then first backup
backup-mgr check --config config.yml
backup-mgr run   --config config.yml

# 6. run the scheduled daemon
pm2 start ecosystem.config.cjs && pm2 save
```

### Adding the web panel

```bash
cd web && npm install && npm run build
cd ..                                    # back to the repo root
pm2 start ecosystem.frontend.config.cjs  # the panel — app name: backup-mgr-web
pm2 save                                 # remember both apps across reboots
```

The panel binds `0.0.0.0:3001`, so it's reachable at `http://<vps-ip>:3001` directly *and* through
nginx. Set `BACKUP_MGR_WEB_HOST=127.0.0.1` to bind it to localhost only and expose it *only* via
nginx.

> **pm2 decides by filename.** pm2 parses a file as an ecosystem *config* only when the name matches
> `*.config.{js,cjs,mjs}` (or `ecosystem.{js,cjs}`); anything else it treats as a *script to run*. So
> the panel is started as **`ecosystem.frontend.config.cjs`**, which re-exports
> [`ecosystem.frontend.cjs`](ecosystem.frontend.cjs) — the file that actually holds the settings.
> Starting `ecosystem.frontend.cjs` directly makes pm2 run it as a script and quietly start
> *nothing*; that file now detects this and exits with an explanatory error instead.

Then sign in at `http://<vps-ip>:3001` (or through nginx, below) with your **Linux** username and
password — anything you could `ssh` in with. There is no panel password to create or change. Full
details, page-by-page, are in [`web/README.md`](web/README.md).

### Exposing it on the VPS IP (nginx)

The panel is a normal web app — it does **not** have to be reached from localhost, so a headless VPS
works fine.

```bash
sudo cp deploy/nginx-backup-mgr.conf /etc/nginx/sites-available/backup-mgr
sudo ln -s /etc/nginx/sites-available/backup-mgr /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

The file documents both options (`listen 80` or a custom port such as `8080`) and already sets the
`X-Forwarded-Proto`, websocket and **`proxy_buffering off`** bits the panel needs for live logs.
For anything public, add TLS: `sudo certbot --nginx -d panel.example.com`.

## 4. Commands

`backup-mgr <command> [--config PATH]`

| Command | What it does |
|---|---|
| `daemon` | Scheduled backups (`backup.time`, catch-up, manual-resume handling). |
| `run` | One full backup now (preflight → save-all → compress → encrypt → upload → verify → prune). Flags: `--dry-run`, `--no-upload`, `--keep-local`, `--world`, `--no-ptero`, `--force`. |
| `test-compress` | Local-only compression test, no upload. |
| `restore [file] [dir] [--force]` | List/pick a remote archive, MD5-verify, download, decrypt, extract. **Aborts if a hash doesn't match**; `--force` proceeds anyway. |
| `restore --json` | Machine-readable archive list (used by the panel's Restore dialog). |
| `check [file]` | Verify remote MD5s against the SQLite manifest (optionally only one file). |
| `history [N]` | Last N runs from the SQLite database (default 20). |
| `status [N]` | Current state + config, **including the next scheduled run**; with N also prints the last N runs. |
| `status --json` | Machine-readable status (used by the panel). Includes the build stamp. |
| `version [--json]` | Print the version, git commit and build time baked in at compile time. Works **without** a `config.yml` (it never creates one) — this is what the panel uses to detect a stale binary. |
| `remote-auth` | OAuth-setup the rclone remote. |
| `fix-perms [--user <name>]` | Grant the run user read+traverse ACLs on the backup source (via `sudo -n`); also attempted automatically when a run cannot read the source. |
| `reset` | Clear the manual-resume/failure state. |

`backup-mgr status` tells you exactly where a failed run stopped; logs live in `./logs/backup_YYYY-MM-DD.log`.

## 5. The web panel in one screen

| Page | Contents |
|---|---|
| **Dashboard** `/` | Status cards, next-run countdown, actions (Run / Dry run / Test compression / Check / List / Fix permissions / Reset), guided **Restore** dialog (pick → verify → restore, optional `--force`), schedule editor, **daemon control** (start/stop/restart pm2), run history, and a **binary build badge** that turns red with the exact fix command — plus a one-click **Rebuild & reinstall** button — when the installed `backup-mgr` is out of date. It also warns when the **daemon is still running a binary that has since been replaced**, with a Restart button. |
| **Config** `/config` | Every *non-schedule* `config.yml` value, grouped. Comments preserved, atomic `0600` writes. |
| **Auth** `/auth` | rclone Google Drive OAuth — plain browser auth **or** your own client ID/secret — plus secondary-remote authorization (a second Drive or Backblaze B2). Works headless via the **paste token** flow, which prints the exact `rclone authorize` command for your config. |
| **Logs** `/logs` | A **tab per log type** — **Backup** (per-day run logs), **Daemon (pm2)** and **Panel (pm2)** — each with its own file list, a **live SSE tail** and download. |
| **Users** `/users` | Every account on the server, mirrored from Linux (admins: role, permissions, block, provision an instance; everyone: their own instance details). |

The dashboard, config and auth options are deliberately **non-overlapping** — schedule editing is on
the Dashboard, everything else that lives in `config.yml` is on Config.

### Multiple users: one isolated instance per Linux account

Identity **is** the Linux account. The panel holds no passwords: signing in verifies your password
against `/etc/shadow` using the host's own `crypt(3)`, so locking an account (`sudo passwd -l`) locks
the panel login with it, and there is no second credential store to leak.

**Adding a user is `sudo adduser alice` — nothing else.** The panel keeps a live mirror of the account
database:

- it reconciles at startup, on a timer (default 15s) and whenever `/etc/passwd` changes, so a new
  account becomes a panel user within seconds with nobody opening the panel;
- a first-time sign-in also records the account, so it works even with auto-sync disabled;
- the panel **never** creates, edits or deletes an OS account, and it never deletes a record either —
  deleting the account flags it `account gone` (and cuts off access on that user's next request), so
  re-creating it restores the same permissions. Prune the stale row when you're sure.

**Each user gets their own instance** — their own `config.yml`, `logs/`, `history.db`, rclone config
and their own pm2 daemon — defaulting to `~/backup-mgr`. The panel runs every command through
`sudo -u <user>`, so the **operating system** enforces the isolation: a permission bug in the panel
cannot read another user's OAuth token or passphrase, because `config.yml` is `0600` and owned by its
user. A new account starts with full control of *its own* instance and no panel-wide permissions.

**Provisioning** (creating the directory, seeding `config.yml`, writing the pm2 ecosystem file) is a
button on the Users page — `Provision`, or `Provision all missing` after adding several accounts. It
never overwrites an existing `config.yml`. To make it automatic: `BACKUP_MGR_AUTO_PROVISION=1`.

**One-time setup on the server.** The panel needs sudo to verify passwords and to act as each user:

```bash
sudo install -m 0440 deploy/sudoers-backup-mgr /etc/sudoers.d/backup-mgr
sudo visudo -c        # validate before relying on it
```

Replace `backup-mgr` in that file with the account that runs the panel. Read the comments at the top
of it: because the panel executes commands *as other users*, it is effectively a privileged service,
so put it behind TLS, restrict who may reach it, and grant `users.manage` / `binary.install` only to
people you would trust with sudo. A single-user deployment (panel and instance share one account)
needs only the `getent shadow` line — the runner skips sudo entirely.

### Administrators are whatever sudo says

There is no admin switch in the panel, because there is nothing to keep in sync: the panel asks sudo
itself (`sudo -l -U <user>`), so `sudoers.d` entries, per-command rules and the `sudo`/`admin`/`wheel`
groups are all seen (groups are only a fallback for a host where sudo cannot be queried). An account
with sudo is an administrator and holds every permission; root always does. Adding someone to sudo
promotes them within seconds, and removing them demotes them just as fast — the OS stays the source of
truth. Granting admin is:

```bash
sudo usermod -aG sudo alice     # alice becomes a panel admin  (Del: `sudo deluser alice sudo`)
```

### Privileged work needs that user's sudo

Reading is never gated — but work that changes something which is not yours runs under **your own**
sudo, exactly as it would on the command line:

| Action | Needs elevation |
|---|---|
| Managing users: permissions, blocking, provisioning, pruning records | yes |
| Rebuild & reinstall the shared `backup-mgr` binary | yes |
| Changing anything in another user's instance (config, schedule, daemon, restore, rclone) | yes |
| Your own instance: config, schedule, backups, checks, restores, your own daemon | no — it is yours |
| Reading any instance, including another user's (admins) | no |

When sudo would ask for a password, the panel shows one dialog and then remembers it for
`BACKUP_MGR_SUDO_TIMEOUT_MS` (default 15 minutes), the way an interactive `sudo` session works. The
password is verified against your real `/etc/shadow` hash — the same check sign-in uses — and held
**only in the panel process's memory, scoped to that one login**.

| Where it lives | Detail |
|---|---|
| Memory, per login | Never written to disk; wiped on sign-out, when the timeout lapses, and after any rejected attempt |
| Not a credential store | It is the same Linux password you already have; nothing new to leak or rotate |
| Turn the cache off | `BACKUP_MGR_SUDO_TIMEOUT_MS=0` makes every privileged action ask again |
| NOPASSWD stays silent | If the host grants `NOPASSWD`, no password is ever requested — the OS decides, not the panel |

Sign-out ends elevation immediately (the equivalent of `sudo -k`), and the Users page has an **End
elevation** button for the same thing mid-session.

### Permissions

Administrators hold every permission implicitly; for everyone else you tick exactly what they may do,
enforced **server-side** on every API route:

| Permission | Grants |
|---|---|
| `dashboard.view` | View status and run history |
| `backup.run` | Run backups, dry runs, compression tests |
| `backup.schedule` | Edit the backup schedule |
| `backup.check` | Run integrity checks |
| `backup.restore` | Restore archives |
| `backup.fix_perms` | Fix file permissions |
| `remote.auth` | Authorize storage remotes (rclone) |
| `config.view` / `config.edit` | View / change configuration |
| `logs.view` | View logs |
| `daemon.control` | Start / stop / restart the daemon |
| `binary.install` | Rebuild and reinstall the `backup-mgr` binary |
| `users.manage` | Manage users: permissions, admins, blocking, provisioning |

`binary.install` and `users.manage` are the only panel-wide (privileged) permissions; the rest are
**instance**-scoped, meaning they act on the holder's own instance and cannot reach anyone else's.
Both privileged ones additionally require the holder's own sudo (see above), so a permission alone
never escalates anyone. Sessions are signed HttpOnly cookies valid for 12 hours
(`BACKUP_MGR_SESSION_SECRET`, auto-generated if unset) and the cookie is marked `Secure` when the
request arrives over HTTPS.

## 6. Deploying without root (per-user)

- **One-time sudo steps only:** install the binary, and run [`scripts/grant-access.sh`](scripts/grant-access.sh)
  to grant read+traverse access to the backup directory (it grants per-ACLs on the whole path, so
  reachability survives permission resets). Run it again if a failed backup shows
  `cannot read source ... Permission denied` — or just press **Fix permissions** in the panel.
- **First run fixes permissions for you:** if a run can't read the source, `backup-mgr` automatically
  attempts the same ACL grant (via passwordless `sudo -n`; it never blocks on a password prompt) and
  retries before failing.
- **rclone credentials are per-user:** each run writes your own fresh `~/.config/rclone/rclone.conf`
  from the `google_drive` credentials in `config.yml` (OAuth tokens auto-refresh). Don't symlink to
  another user's config.
- **pm2 runs as the user who started it:** `pm2 start ecosystem.config.cjs` uses *your* PM2. Start the
  panel from `web/` with its own `ecosystem.config.cjs` (app name `backup-mgr-web`).

## 7. Security notes

What the code does deliberately:

- **No shell interpolation.** Every external call (`rclone`, `tar`, `zip`, `gpg`, `unzip`) is
  `Command` + argv — config values can never be interpreted as shell syntax.
- **Encryption** uses `gpg -c` (AES256) and the passphrase is passed on **stdin fd**, never argv, so it
  never appears in `ps`.
- **Transport** is TLS everywhere (rustls in the Rust side; the Discord webhook and Pterodactyl panel
  calls validate certificates).
- **Integrity** is enforced on both ends: upload size verification, an MD5 manifest in SQLite, `check`
  re-hashes the remote, and `restore` verifies the *downloaded* bytes — aborting (unless `--force`) if
  they don't match the manifest.
- **Secrets on disk** are `0600` and config rewrites are atomic. The panel's own database holds
  authorization only — no password hashes at all — in a `0700` directory.
- **There is no second password store.** Sign-in verifies the Linux password against `/etc/shadow`
  with the host's `crypt(3)`, so account policy (`passwd -l`, `chage`, deletion) applies to the panel
  automatically. The hash and the password are passed on stdin, never argv, so neither appears in `ps`.
- **Privileges are the OS's, and are never handed out by the panel.** Admin is derived from sudo, and
  privileged actions run under the acting user's own sudo — so a permission flag cannot escalate
  anyone, and there is no admin flag that could drift out of sync with the server.
- **An elevated session is deliberately short-lived and in memory only.** After a sudo password is
  accepted it is kept in the panel process (scoped to one login) for `BACKUP_MGR_SUDO_TIMEOUT_MS`,
  then dropped; sign-out drops it immediately. Set the timeout to `0` if you would rather be asked
  every time. The trade-off is explicit: the panel must re-send the password to sudo, so it cannot be
  stored as a one-way hash.
- **Failed sign-ins are throttled** per account + address with an exponential lockout, and every reply
  takes at least ~350ms so timing cannot reveal whether a username exists.
- **Users are isolated by the OS, not by the panel.** Every command runs as that Linux account via
  `sudo -u`, and each instance's `config.yml` is `0600` and owned by that user — so a bug in a route
  cannot read another user's secrets, and the panel never reads an instance's files as itself.
- **Remote access is authenticated per user**, and each route checks the required permission.
- **Pterodactyl** rejects Application keys (`ptla_`) up front, and the RAII guard restarts the server on
  every exit path including panics.

Things to be aware of:

- The Prometheus metrics endpoint is unauthenticated. It's safe at the default `127.0.0.1` bind — don't
  bind it to `0.0.0.0` without a firewall.
- If you expose the panel over plain HTTP on a public IP, your password and rclone tokens travel in
  cleartext. Use nginx + certbot, or reach it through an SSH tunnel.
- The rclone browser flow listens on `127.0.0.1:53682` on the *server*. On a headless VPS the browser
  can't reach that, so use the Auth page's **paste token** method instead — or tunnel it with
  `ssh -L 53682:127.0.0.1:53682 you@vps`.
- **The token's OAuth client must match `config.yml`.** The paste flow accepts a token minted on *any*
  machine (your laptop is fine — it isn't tied to the OS user or host). But it must come from the same
  client the remote will refresh with: `drive.rs` only copies `client_id`/`client_secret` into the
  rclone config when they are **non-empty**, so a blank pair means rclone's built-in client. A token
  from the wrong client authorizes fine and then fails about an hour later, on the first refresh.
  The Auth page reads your config and prints the exact command; the two cases are:

  ```bash
  # client_id / client_secret blank in config.yml -> rclone's built-in client
  rclone authorize "drive"

  # client_id / client_secret set -> pass the SAME pair, or refreshes will fail
  rclone authorize "drive" "<client_id>" "<client_secret>"
  ```

  Paste the JSON it prints (or the whole output block) into the Auth page.
- **`binary.install` is a privileged permission.** Using it runs `cargo build --release` (which
  executes the checkout's `build.rs`) and then installs over the shared binary **under the acting
  user's own sudo** — silent on a `NOPASSWD` host, otherwise authorized by the sudo password. Grant it
  to admins/operators only; users without it just see the command to run by hand.

## 8. Tests

```bash
cargo test          # Rust: scheduler DST handling, restore integrity gate  (8 tests)
cd web && npm test  # Panel: account mirroring + reconciliation, Linux password verification
                    # (real crypt(3)), per-user instances and the run-as-user runner, permissions,
                    # sessions, rclone parsing, build-stamp + daemon-staleness logic, log
                    # sources, and API guards  (175 tests)
```

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `lock file version 4 requires ...` | Toolchain too old — update to Rust ≥ 1.78. |
| `backup path is not a directory` / `cannot read source` (non-root) | Permission on `backup.path`; re-run `sudo ./scripts/grant-access.sh $USER /path/to/your-backups-parent-directory` or press **Fix permissions**. The path must exist at run time. |
| Upload fails / auth expired | `backup-mgr remote-auth`, or confirm `rclone lsd gdrive:` works. |
| Preflight refuses | Free disk too small; raise `min_free_disk_gb` headroom or resize. |
| Hash mismatch on `check` | Remote copy differs from manifest; restore from an older intact archive. |
| Hash mismatch on `restore` | Restore is refused on purpose. Re-`check` first; only use `--force` if you accept the risk. |
| Passphrase forgotten | Irrecoverable; keep it safe (see `encrypt` notes in the example config). |
| Panel says "Cannot reach the backup-mgr binary" | Set `BACKUP_MGR_BIN` / `BACKUP_MGR_CHECKOUT` in `web/.env.local` (see [`web/.env.example`](web/.env.example)). |
| Panel rejects your password | It verifies your **Linux** password, so test it with `ssh`. If it says the hash can't be read, install `deploy/sudoers-backup-mgr` (passwordless `sudo -n getent shadow`). If it says crypt(3) is unavailable, install `perl`. |
| A privileged action says "not in sudoers" | That is the OS talking: the account has no sudo. Add it with `sudo usermod -aG sudo <user>` — admin follows sudo. |
| A privileged action asks for a sudo password | Expected when the account's rules are not `NOPASSWD`. Enter your Linux password; it is not asked again for 15 minutes (or `sudo -k`-style via **End elevation**). Set `BACKUP_MGR_SUDO_TIMEOUT_MS=0` to always ask. |
| No one can manage users | Nobody on the box has sudo, or the panel cannot query it. Grant an account sudo, or set `BACKUP_MGR_ADMIN_USER=<account>` as an escape hatch. |
| A new Linux account doesn't show in the panel | Check the Users page's sync line and the `[user-sync]` entries in **Logs → Panel (pm2)**. `BACKUP_MGR_AUTO_SYNC=0` disables automatic mirroring; `BACKUP_MGR_MIN_UID` / `BACKUP_MGR_EXCLUDE_USERS` can exclude an account deliberately. |
| A user signs in but every page says "no instance yet" | Their instance hasn't been provisioned — **Users → Provision** (or `Provision all missing`). |
| Dashboard shows a red **out of date** badge, or "could not read status from the backup-mgr binary" | The `backup-mgr` on your `PATH` was built from different code than this checkout. The Dashboard (or `GET /api/binary`) prints both versions and the exact command; fix it with `cargo build --release && sudo install -m 0755 target/release/backup-mgr /usr/local/bin/backup-mgr`, or point `BACKUP_MGR_BIN` at the freshly built binary. |
| Panel says the daemon is "still running an older backup-mgr" | A running process keeps the code it started with. Restart it (the banner has a **Restart daemon** button, or `pm2 restart backup-mgr`). |
| Live logs don't stream | Something is buffering: nginx needs `proxy_buffering off` (already set in [`deploy/nginx-backup-mgr.conf`](deploy/nginx-backup-mgr.conf)). |
| Config/schedule changes don't apply | The daemon reads `config.yml` at startup — `pm2 restart backup-mgr`. |
| Panel crash-loops (many pm2 restarts) after an update | `npm run build` replaces `.next/` while the panel is serving, so it briefly can't find a build and pm2 restarts it until the build lands. Either build **before** deploying, or stop it around the build: `pm2 stop backup-mgr-web && cd web && npm run build && cd .. && pm2 start backup-mgr-web`. Check the **Logs → Panel (pm2)** tab for the error trail. |

## Keeping your deployment out of the repo

This is a generic project: a fresh clone should never reveal *your* host, paths, domain, users or
backup payloads. Two different things can leak and they need different fixes.

**1. The working tree — `.gitignore` handles this.** The committed template is
[`config.example.yml`](config.example.yml). Your real `config.yml` (gpg passphrase, Pterodactyl key,
OAuth refresh token, Discord webhook), `history.db`, `state.json`, `logs/`, `backup/`, rclone configs,
`.env*` files, archives and the panel's `web/data/` are all ignored. Check at any time:

```bash
git status --porcelain            # what would actually be committed
git check-ignore -v config.yml    # confirm a specific file is ignored
```

**2. Git history — `.gitignore` cannot help.** Ignoring a file does **not** remove it from commits that
already contain it. Before making a repository public, check what is already in there:

```bash
# personal strings: domains, usernames, host paths you once committed
git log --all -p | grep -nE 'yourdomain|your-username|/opt/your-path|/home/you'
# every author identity — these are published permanently
git log --pretty='%an <%ae>' | sort -u
```

If history is dirty the only remedy is to rewrite it — `git filter-repo --replace-text`, or, for a
young repo, start over with a single clean commit:

```bash
git checkout --orphan clean && git add -A && git commit -m "initial commit"
git branch -D main && git branch -m main
git push --force origin main      # then ask GitHub Support to purge cached views
```

Force-pushing rewrites shared history: it does not reach clones or forks that already exist, and
GitHub may serve cached blobs for a while. **Treat anything ever pushed as public.**

**Author identity.** Every commit carries an author name and email that become public. To keep your
personal address out of it, set a noreply address *before* committing:

```bash
git config --global user.email "12345678+yourusername@users.noreply.github.com"
```

## Project layout

```
scripts/grant-access.sh       # one-time sudo ACL grant for non-root backups (also reused by `fix-perms`)
ecosystem.config.cjs          # pm2 service: the backup-mgr daemon
build.rs                      # bakes the git commit + build time into the binary (see §3)
ecosystem.frontend.cjs        # pm2 service: the web panel (the settings live here)
ecosystem.frontend.config.cjs # re-export so pm2 auto-detects it (pm2 matches filenames — see §3)
deploy/
  nginx-backup-mgr.conf       # reverse proxy + TLS notes for the panel
web/                      # Next.js control panel (dashboard, config, rclone auth, logs, users)
  data/                   # git-ignored: users.db (authorization only), session secret, instances.yml
  src/lib/userwatch.ts    # live mirror of /etc/passwd (startup + timer + file watch)
  src/lib/systemauth.ts   # Linux password verification via the host's crypt(3), throttled
build.rs                  # bakes the git commit + build time into the binary (used by the panel)
src/
  main.rs        # CLI + daemon + run/restore/check/status/version/history
  config.rs      # typed config + embedded example template
  drive.rs       # rclone remotes: config, upload, list, retention
  backup.rs      # compression, encryption, preflight
  db.rs          # SQLite history + remote-hash manifest
  notify.rs      # Discord webhook embeds
  metrics.rs     # Prometheus endpoint
  ptero.rs       # Pterodactyl CLIENT API websocket (save-all)
  scheduler.rs   # time slots / catch-up (DST-safe)
  state.rs       # JSON run-state + manual-resume flag
  perms.rs       # automatic ACL / permission setup (reuses grant-access.sh)
  logger.rs      # per-day file logging
```
