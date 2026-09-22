# backup-mgr web panel

A Next.js control panel for [`backup-mgr`](../README.md). It shells out to the `backup-mgr` binary
for actions, and drives one **instance** per Linux user: that user's `config.yml`, `history.db`, logs,
rclone config and pm2 daemon — always running commands *as that user*.

It runs on a headless VPS and is meant to be reached over the network (`http://<vps-ip>:3001`, or via
the nginx config in [`../deploy/`](../deploy/nginx-backup-mgr.conf)) — not just from localhost.

## Quick start

```bash
cd web
npm install
npm run build
npm start                                    # http://127.0.0.1:3001
```

On a fresh server, give the panel the privileges it needs once (see [Multiple users](#multiple-users)):

```bash
sudo install -m 0440 ../deploy/sudoers-backup-mgr /etc/sudoers.d/backup-mgr && sudo visudo -c
```

Or as a service, from the **repo root**:

```bash
pm2 start web/ecosystem.config.cjs && pm2 save   # app name: backup-mgr-web
```

[`web/ecosystem.config.cjs`](ecosystem.config.cjs) holds every setting the panel needs — port, host,
log paths and the `BACKUP_MGR_*` passthrough — and nothing outside `web/` is required to start it.
The daemon has its own file in the repo root ([`../ecosystem.config.cjs`](../ecosystem.config.cjs)).

> pm2 only parses a file as an ecosystem *config* when its **filename** matches
> `*.config.{js,cjs,mjs}` (or `ecosystem.{js,cjs}`) — hence `ecosystem.config.cjs` for both apps.
> Running one as a script by mistake makes it exit with an explanatory error rather than start
> nothing.

The panel binds `0.0.0.0:3001` by default; set `BACKUP_MGR_WEB_HOST=127.0.0.1` to serve it only to
nginx.

Then open the panel and sign in with your **Linux** username and password — the same credentials you
`ssh` with. There is nothing to bootstrap and no panel password to change: every human account on the
server is already a panel user, and privileges come from the OS too: any account that may run `sudo`
is an administrator, and root always is. There is no default login and no admin account to create —
`sudo usermod -aG sudo alice` is how you promote someone, and it takes effect within seconds.

## Pages (no option appears on two pages)

| Page | Purpose |
|---|---|
| **Dashboard** (`/`) | Status cards, a **countdown to the next scheduled run**, manual backup / dry run / test compression / integrity check, **fix permissions**, reset state (it stops a run in progress first), a guided **Restore dialog** (pick a backup → verify → restore, with an optional `--force`; when the instance has `encrypt.enabled` the restore asks for the encryption passphrase in a dialog first — see [Restore and the passphrase gate](#restore-and-the-passphrase-gate)), **daemon control** (start / stop / restart the pm2 service), the **schedule** (evenly spaced, or a list of exact times — see [Scheduling](#scheduling)), paged run history, a **binary build badge** with a one-click **Rebuild & reinstall** button (see [Binary version](#binary-version)), and a banner when the daemon is still running a since-replaced binary. Action output **streams live** and ends with `SUCCESSFUL` / `UNSUCCESSFUL (exit N)`. |
| **Config** (`/config`) | Every *non-schedule* `config.yml` value, grouped by section. Edits preserve comments and are written atomically with `0600` permissions. |
| **Auth** (`/auth`) | Authorize the **primary** remote or the **secondary** (redundancy) remote. Drive remotes support **both** rclone methods — plain browser auth (just your Google account) or your own client ID/secret; non-Drive remotes (e.g. **Backblaze B2**) are configured with account + key. On a headless VPS use the **paste token** method. Drive tokens are written to `google_drive` / `storage.secondary` in `config.yml`; B2 credentials are stored by rclone itself. |
| **Logs** (`/logs`) | **One tab per kind of log**, each with its own file list, **live tail** (Server-Sent Events) and download: **Backup** (per-day run logs from `logging.dir`), **Daemon (pm2)** (`logs/pm2.log`, `logs/pm2-error.log`) and **Panel (pm2)** (`web/logs/pm2-web*.log`). The newest file in a tab is selected automatically, and error logs are badged. |
| **Users** (`/users`) | Every account on the server, mirrored from Linux. Admins: role (from sudo), per-permission access, block/unblock, provision an instance, re-sync, prune records of deleted accounts, and their own elevation state with an **End elevation** button. Everyone: their own instance details, their sudo status, and a pointer to `passwd`. |

## Multiple users

Identity **is** the Linux account, so the panel stores **authorization only** — it holds no password
hashes at all (`data/users.db`, `0700` directory). Sign-in verifies your password against
`/etc/shadow` using the host's own `crypt(3)` (via `perl`, or `python3` as a fallback), so
`sudo passwd -l alice` locks the panel too, and there is no second credential to leak or forget.

**Adding a user is `sudo adduser alice`, and that is the whole procedure.** The mirror of the account
database is kept current by [`src/lib/userwatch.ts`](src/lib/userwatch.ts), started from
`src/instrumentation.ts`:

| When | What happens |
|---|---|
| At server start | One reconcile, so the panel is correct the moment it comes up |
| Every `BACKUP_MGR_AUTO_SYNC_INTERVAL_MS` (default 15s) | Poll as a backstop |
| Whenever the passwd file changes | `fs.watchFile` catches `useradd`/`userdel` within seconds |
| On first sign-in | `ensureUser()` records the account even with auto-sync off |

Nothing is ever deleted by a sync. An account that disappears is flagged **`account gone`** (and loses
access on its next request, because `currentUser()` rejects orphaned records), its permissions are
kept, and an admin prunes the record when they are sure — so re-creating an account restores access
with the same grants. Because a deleted record would be a lockout, reconciliation *refuses to act*
when the account database can't be read: an unreadable `/etc/passwd` is reported as a failure, never
as "every account was deleted".

**One instance per user.** Each user's instance defaults to `~/backup-mgr` and holds their own
`config.yml`, `logs/`, `backup/`, `history.db`, `state.json`, rclone config and pm2 daemon
(`PM2_HOME`, so their `pm2 restart` cannot touch anyone else's app). Every command runs through
`sudo -u <user> -H env …`, and `config.yml` is `0600` owned by that user — which is the isolation:
the panel never reads an instance's files as itself. `data/instances.yml` can move a user's instance
elsewhere, which is how an existing single-user deployment keeps its checkout:

```yaml
# web/data/instances.yml
alice:
  root: /opt/drive-backup      # keep using the existing checkout
  pm2_name: backup-mgr
```

**Provisioning** (directory, seeded `config.yml`, pm2 ecosystem file) is the `Provision` button, or
`Provision all missing` for several accounts at once. It never overwrites an existing `config.yml`,
which holds that user's passphrase and tokens. Set `BACKUP_MGR_AUTO_PROVISION=1` to have the watcher
do it for every new account. Until an instance exists, routes answer `409 needs_provisioning` rather
than failing obscurely.

### Who is an admin: sudo decides

The panel has no admin flag. It asks sudo itself (`sudo -l -U <user>`, so sudoers.d and per-command
rules are seen; `sudo`/`admin`/`wheel` groups are only a fallback when sudo cannot be queried), and an
account that may run sudo is an administrator holding every permission. Root always is. Promotion and
demotion therefore happen on the server — `sudo usermod -aG sudo alice` — and take effect within
seconds, with nothing to keep in sync. When sudo cannot be asked at all the panel **fails closed**
(nobody gains admin) and keeps whatever was already recorded, so a failed probe cannot lock everyone
out of user management.

### Privileged work runs under that user's own sudo

Work that changes something which is not yours is authorized by *your* sudo, not by the panel's:

| Action | Elevation |
|---|---|
| Managing users (permissions, blocking, provisioning, pruning) | required (`users.manage`) |
| Rebuild & reinstall the shared binary | required (`binary.install`) |
| Any change inside another user's instance | required (admin targeting) |
| Your own instance: config, schedule, backups, checks, restores, daemon | not required |
| Reads, including another user's instance for an admin | not required |

`authorizePrivileged()` returns `403` when the account has no sudo, and `428 { sudo_required: true,
action }` when a password is needed. The client wrapper (`src/lib/sudo-client.tsx`) catches the 428,
shows one dialog, `POST`s `/api/sudo`, and retries the request once — so a NOPASSWD host never sees the
dialog at all, because the route never answers 428 there.

| Endpoint | Purpose |
|---|---|
| `GET /api/sudo` | Your own elevation state: has sudo, is a password needed, elevated until |
| `POST /api/sudo` | Verify the sudo password once (against your real Linux hash, throttled separately from sign-in) and open a grant for this login |
| `DELETE /api/sudo` | End it now, the equivalent of `sudo -k` |

The grant lives in the process's memory keyed by a hash of the session cookie, lasts
`BACKUP_MGR_SUDO_TIMEOUT_MS` (default 15 min, sudo's default), is dropped on sign-out and after any
rejected attempt, and is never written to disk or logged. Setting the timeout to `0` disables the
cache. Admins implicitly hold every permission; other users get exactly the permissions ticked for
them, enforced **server-side on each API route**.

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

`binary.install` and `users.manage` are the only **panel-wide** (privileged) permissions, and each also
requires the holder's own sudo — grant them as you would sudo. The rest are **instance**-scoped: they act on the holder's own instance and cannot
reach anyone else's. Admins may additionally name another user on any instance route (`?user=alice`).

Sessions are signed HttpOnly cookies, valid for 12 hours, and flagged `Secure` automatically when the
request arrives over HTTPS (`X-Forwarded-Proto`). Navigation links are hidden when a user lacks the
permission, but hiding is cosmetic — the API is what enforces it.

### Sudoers rule

Because verifying a Linux password means reading `/etc/shadow`, and acting as another user means
`sudo -u`, the panel needs passwordless sudo of its own (as the service account) — note this is
separate from each user's own sudo rules, which is what authorizes privileged panel work.
[`../deploy/sudoers-backup-mgr`](../deploy/sudoers-backup-mgr) documents exactly why the rule is broad
(the execution steps are `env` and `sudo`, so a per-command allow-list would be meaningless) — read it
before installing. It needs both lines, including `ALL=(ALL) NOPASSWD: /usr/bin/sudo`, which is what
lets privileged work run under the acting user's own sudo. With the rule in place, sign-in failures
are reported precisely: "Cannot read /etc/shadow: passwordless sudo is not configured" is an
infrastructure error, not a wrong password.

Failed sign-ins are throttled per account+address with an exponential lockout (state is per process, so
it resets on restart), and every reply takes at least ~350ms so timing cannot reveal whether a username
exists. Locked (`!`) and password-less (`*`) accounts are reported distinctly to an administrator but
vaguely to the client.

## Scheduling

The Dashboard owns when backups run; the Config page owns everything else about them. Two modes,
and the file stores them in different keys:

| Mode | What you set | `config.yml` |
| --- | --- | --- |
| **Evenly spaced** | A first time and a count — `03:30`, 4 a day | `backup.time: "03:30"`, `backup.backups_per_day: 4` |
| **Specific times** | A list of exact times, with **+ Add another backup** | `backup.times: ["03:30", "09:30", "15:30", "21:30"]` |

`backup.times` wins when it is non-empty; `backup.time` + `backup.backups_per_day` remain the fallback
(and are kept in step when you save a list, so switching modes does not lose them). Both are validated
before saving — `25:00` or `half past three` is refused with a message rather than written and silently
ignored by the daemon, which is what a bad time would otherwise look like: *"the schedule saved but
nothing runs"*.

The Dashboard shows **the schedule the daemon itself reports** (`config.schedule` from
`status --json`), so a saved change that has not been applied yet is visible as a difference rather
than a surprise. It also warns when the installed binary predates per-time schedules — those were
added in the same change, so an older build ignores `backup.times` and keeps using even spacing.

**World-backup times live on the Config page**, next to the rest of the world-backup settings, because
they are a property of that feature rather than a second schedule. Nothing appears on two pages.

## Restore and the passphrase gate

The **Restore dialog** on the Dashboard lists what can be restored, verifies the archive against the
recorded hash, and then restores it: the target is **emptied first** and refilled from the archive, so
the result is exactly that backup. Run staging happens inside the target, so an interrupted or failed
restore leaves it untouched, and targets that must never be emptied (a system directory, the instance
directory, the backup directory) are refused. **Merge** writes over the target and keeps everything
else — for restoring into a live directory.

When the instance has `encrypt.enabled`, an archive is encrypted and the daemon needs the passphrase
to read it. The panel asks for it in a dialog (the same way it asks for a sudo password), checks it
against that instance's `config.yml`, and only then starts the restore:

- the passphrase is **never** stored — the panel keeps a grant in memory for that login for
  `BACKUP_MGR_RESTORE_UNLOCK_MS` (default 15 minutes), then asks again;
- until it is confirmed the restore is refused with `428 passphrase_required`, so a missing prompt
  cannot silently start an encrypted restore;
- repeated wrong entries are throttled, and every confirmation, refusal and drop is written to the
  audit log;
- signing out ends the grant, exactly like the sudo elevation does.

The CLI needs no prompt: it reads the passphrase from the config file it was told to use.

## Binary version

The panel drives whichever `backup-mgr` it finds, so it reports what it is actually talking to.
`build.rs` bakes the **git commit** (`-dirty` for a working tree) and **build timestamp** into the
binary, readable via `backup-mgr version [--json]` — which also runs *without* a `config.yml` and
never creates one.

`GET /api/binary` compares that stamp against the checkout being served and returns:

```json
{
  "binary": "backup-mgr",
  "resolved_path": "/usr/local/bin/backup-mgr",
  "file": { "size": 9942848, "mtime": "2026-09-19T10:51:11.794Z" },
  "installed": null,
  "expected": { "version": "1.0.0", "commit": "c0c0961-dirty" },
  "stale": true,
  "reasons": ["could not read a version from the installed binary — it predates the `version` command, so it is out of date."],
  "install_command": "cargo build --release && sudo install -m 0755 target/release/backup-mgr /usr/local/bin/backup-mgr"
}
```

The Dashboard renders this as a badge next to the title (red + an actionable banner when `stale`). A
field is only compared when **both** sides are known, so a binary built from a tarball (commit
`unknown`) isn't falsely reported as stale. The `-dirty` marker is also ignored: it only records
whether the tree had uncommitted edits when the binary was built, which a cached build script reports
differently from the live checkout, so `c0c0961` and `c0c0961-dirty` compare equal.

Beyond the cosmetic warning this prevents a real side effect: an old binary parses `restore --json` as
*"restore the file named `--json`"*, which logs a failed run and fires a Discord notification. Both
`/api/status` and `/api/restore` explain the out-of-date binary instead, and `/api/restore` checks the
binary speaks JSON **before** running anything.

### One-click reinstall

`POST /api/binary/install` (permission **`binary.install`**) rebuilds from the served checkout and
installs over the binary on disk. It is deliberately **not** a shell string — the two steps run via
`execFile` with an argv vector and are reported separately so a compile failure is distinguishable
from a permissions problem:

| Step | Command |
|---|---|
| 1 | `<cargo> build --release` (cargo is found via `CARGO_BIN`, then `~/.cargo/bin/cargo`, then `PATH` — a pm2/systemd process has no shell profile) |
| 2 | `sudo -n install -m 0755 target/release/backup-mgr <target>` |

`sudo -n` fails immediately rather than hanging a web request on a password prompt nobody can answer.
The install target is the resolved binary path, except when that is inside the checkout's `target/`
tree — then copying a file onto itself would be pointless, so `/usr/local/bin/backup-mgr` is used.
Concurrent requests get `409`, and `maxDuration` is raised to 20 minutes for a cold build.

On success the response notes that **the daemon keeps running the old binary until restarted**.

### Daemon running an older build

`GET /api/daemon` also reports whether the running process is behind what is on disk, via
`/proc/<pid>/exe`:

```json
"binary": {
  "restart_needed": true,
  "reason": "the file the daemon is running (/usr/local/bin/backup-mgr (deleted)) has since been replaced on disk",
  "running_exe": "/usr/local/bin/backup-mgr (deleted)",
  "disk_path": "/usr/local/bin/backup-mgr"
}
```

Replacing a binary unlinks the old inode, so the running process keeps serving the old code until it
restarts — the Dashboard shows a banner with a **Restart daemon** button. The check is deliberately
conservative: paths that merely *differ* (e.g. `BACKUP_MGR_BIN` pointing at the build tree while the
daemon runs the installed copy) are **not** flagged, so there are no false alarms.

## Environment variables (see `.env.example`)

| Variable | Meaning |
|---|---|
| `BACKUP_MGR_SUDO_TIMEOUT_MS` | How long an elevated session lasts before the sudo password is asked again (default `900000`, 15 min; `0` asks every time). |
| `BACKUP_MGR_RESTORE_UNLOCK_MS` | How long a confirmed encryption passphrase is remembered before a restore asks for it again (default `900000`, 15 min). |
| `BACKUP_MGR_SUDO_GROUPS` | Groups treated as "has sudo" when sudo itself cannot be queried (default `sudo,admin,wheel`). |
| `BACKUP_MGR_SUDO_FIXTURE` | JSON of canned capability answers instead of asking sudo, e.g. `{"alice":{"has_sudo":true,"passwordless":false}}`. Used by the tests. |
| `BACKUP_MGR_ADMIN_USER` | Escape hatch for a host where sudo cannot be queried: always treat this account as an admin (it does **not** create a sudo grant for anyone). |
| `BACKUP_MGR_SESSION_SECRET` | Secret that signs session cookies. Defaults to a random secret stored in `data/session.secret` (`0600`). |
| `BACKUP_MGR_MIN_UID` | Lowest uid treated as a human account (default `1000`). |
| `BACKUP_MGR_INCLUDE_ROOT` | Mirror root as a panel user (set `0` to exclude). |
| `BACKUP_MGR_EXCLUDE_USERS` | Comma-separated accounts never to mirror. |
| `BACKUP_MGR_AUTO_SYNC` | Keep the mirror current automatically (default on; `0` = on demand only). |
| `BACKUP_MGR_AUTO_SYNC_INTERVAL_MS` | Reconcile interval (default `15000`, minimum `2000`). |
| `BACKUP_MGR_AUTO_PROVISION` | `1` = create a new account's instance for it, instead of waiting for the Provision button. |
| `BACKUP_MGR_OSUSER_CACHE_MS` | How long a passwd read is cached (default `5000`). |
| `BACKUP_MGR_CHECKOUT` | The served checkout — `Cargo.toml`, `target/` and `config.example.yml` live here (alias: `BACKUP_MGR_ROOT`). |
| `BACKUP_MGR_INSTANCE_TEMPLATE` | Where each user's instance lives; `{home}` is their home directory (default `{home}/backup-mgr`). |
| `BACKUP_MGR_INSTANCES_FILE` | YAML file mapping a username to a non-default instance location. |
| `BACKUP_MGR_CONFIG_TEMPLATE` | Config copied into a new instance (default `<checkout>/config.example.yml`). |
| `BACKUP_MGR_BIN` | The shared `backup-mgr` binary (default: on `PATH`). |
| `BACKUP_MGR_DATA_DIR` | Where the panel's own state lives: `users.db`, `session.secret`, `instances.yml` (default `web/data`). |
| `BACKUP_MGR_USERS_DB` | Explicit path to the panel's user database. |
| `PM2_BIN` | `pm2` executable (default: on `PATH`); each instance gets its own daemon via `PM2_HOME`. |
| `CARGO_BIN` | `cargo` executable used by the one-click **Rebuild & reinstall** button (default: `~/.cargo/bin/cargo`, then `PATH`). |
| `BACKUP_MGR_WEB_PORT` | Port the panel binds (default `3001`). Read by `web/ecosystem.config.cjs`. |
| `BACKUP_MGR_WEB_HOST` | Bind address (default `0.0.0.0`). Set `127.0.0.1` to expose the panel only through nginx. |
| `BACKUP_MGR_MAX_LOGIN_FAILURES` / `BACKUP_MGR_MIN_VERIFY_MS` | Sign-in throttling: failures before a lockout (default `5`) and the reply-time floor (default `350` ms). |
| `BACKUP_MGR_PASSWD_FILE` / `BACKUP_MGR_SHADOW_FILE` | Alternate account/password database. Normally unset — the tests use them to drive the real code paths without root. |

If `pm2` isn't installed the Daemon card says so instead of failing.

## Notes

- **The panel talks to `backup-mgr` on your `PATH`** (or `BACKUP_MGR_BIN`). After updating the repo,
  rebuild and reinstall it — the Dashboard's build badge turns red and shows the exact command (and a
  one-click button) when the installed binary doesn't match the checkout; an old binary doesn't even
  know `status --json`.
- **Installing over a running binary requires a restart.** The old code stays live until the process
  restarts, which the Dashboard flags.
- The daemon reads `config.yml` at startup, so restart it (`pm2 restart backup-mgr`) after saving
  config or schedule changes. The UI reminds you.
- `rclone authorize`'s callback listens on `127.0.0.1:53682` **on the server**, which a browser on a
  different machine can't reach. Use the Auth page's **paste token** flow unless you're tunnelling
  (`ssh -L 53682:127.0.0.1:53682 you@vps`).
- **A pasted token must come from the same OAuth client as `config.yml`.** You can run
  `rclone authorize` on your laptop — the token is tied to the Google account and the OAuth client,
  not to the host or shell user. But if `google_drive.client_id`/`client_secret` (or the secondary's)
  are set, a token minted with rclone's built-in client will authorize successfully and then fail to
  refresh about an hour later. The Auth page reads your config and shows the exact command.
- **The "A previous backup did not finish cleanly" banner means the state really is stuck**, not that
  an action is running: a run lock whose holder is still alive is never reported as stale, so dry runs,
  `check` and CLI runs (which never mark the state as running) no longer trigger it. It fires for a
  lock left behind by a killed run or for `requires_manual_resume`. Its **Reset state** button stops any
  run in progress first, then runs `backup-mgr reset`; the reason is shown in the banner if it fails.
- `fix-perms` is always called with `--user <instance user>` so it never has to guess the account from
  the environment.
- For the live log stream through nginx you need `proxy_buffering off` — already set in
  [`../deploy/nginx-backup-mgr.conf`](../deploy/nginx-backup-mgr.conf).

## Serving the panel on a domain (nginx)

[`../deploy/nginx-backup-mgr.conf`](../deploy/nginx-backup-mgr.conf) is a complete site: HTTPS with
Let's Encrypt, an `http` → `https` redirect, and streaming-friendly proxy settings. Symlink it in
place — no need to copy it into `sites-available`:

```bash
sudo ln -sfn /opt/drive-backup/deploy/nginx-backup-mgr.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Set your own hostname in **both** `server_name` lines and the two `ssl_certificate` paths, then
`sudo certbot --nginx -d your.host` picks up the existing block instead of creating another one.

> **Reload, don't just create the symlink.** Until nginx reloads, HTTPS requests for your hostname
> fall to whichever server block is first in `sites-enabled` (alphabetically — often another site),
> so the domain serves the *wrong application* and the *wrong certificate*.

If the domain sits behind **Cloudflare** (proxied / orange cloud), the config already handles it:
the Cloudflare ranges are trusted for `CF-Connecting-IP`, so the audit log, sign-in throttle and sudo
throttle record the visitor rather than a Cloudflare edge IP, and a direct connection cannot forge
that header. Cloudflare does **not** buffer the panel's SSE stream — verified frame-for-frame against a
direct connection — so the Logs live tail and the streamed action output work through it.

## Log sources

The three tabs come from `logSourceDefs()` in [`src/lib/logs.ts`](src/lib/logs.ts), resolved against
the caller's own instance (or, for an admin, whichever user they target). The Backup and Daemon logs
**share a directory by default**, so each source filters by *filename* rather than by directory alone —
`pm2*.log` is routed to the Daemon tab and everything else to Backup. `<instance>` is the user's
instance root (`~/backup-mgr` by default).

| Tab | Directory | Matches |
|---|---|---|
| **Backup** | `logging.dir` from that instance's `config.yml` (default `<instance>/logs`) | `*.log` that isn't `pm2*` |
| **Daemon (pm2)** | `<instance>/logs` | `pm2.log`, `pm2-error.log` |
| **Panel (pm2)** | `web/logs` (the shared checkout) | `pm2-web.log`, `pm2-web-error.log` |

`GET /api/logs` returns every source with its files in one request; `GET /api/logs?source=<id>&file=<name>`
reads one file, and `GET /api/logs/stream?source=<id>&file=<name>` streams it. Both take the source id, so
the tab and the file are resolved independently, and filenames are reduced to their basename (no
traversal) — an unknown source is a `400`.

## Deploying an update

`next build` rewrites `.next/`, which the running server is serving from. Build **before** restarting,
and if you build while it's live expect a short restart loop until the build completes:

```bash
pm2 stop backup-mgr-web
cd web && npm run build && cd ..
pm2 start backup-mgr-web
```

Use this project's local Next binary (`node_modules/next/dist/bin/next`) — a bare `npx next` can
resolve a *different* Next version from the npx cache and refuse to start against this build.

## Tests

```bash
npm test     # vitest (175): sudo capability + elevation grants (scope, expiry,
             # sign-out, sudo -k), privileged-route gating, account mirroring +
             # reconciliation (a new Linux account appearing unaided), Linux password
             # verification against real crypt(3) hashes, per-user instance resolution
             # and the run-as-user runner, permissions, session signing, rclone
             # parsing, build-stamp comparison, install-target / cargo discovery /
             # daemon-staleness logic, log-source separation, and API guards
```
