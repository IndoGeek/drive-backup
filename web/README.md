# backup-mgr web panel

A Next.js control panel for [`backup-mgr`](../README.md). It shells out to the `backup-mgr` binary
for actions, and reads/writes `config.yml`, `history.db`, the log directory, the pm2 process and its
own user database directly.

It runs on a headless VPS and is meant to be reached over the network (`http://<vps-ip>:3001`, or via
the nginx config in [`../deploy/`](../deploy/nginx-backup-mgr.conf)) — not just from localhost.

## Quick start

```bash
cd web
npm install
npm run build

# optional: initial admin password (defaults to "admin")
BACKUP_MGR_PASSWORD=change-me npm start     # http://127.0.0.1:3001
```

Or as a service — run this from the **repo root**, not `web/`:

```bash
pm2 start ecosystem.frontend.config.cjs && pm2 save   # app name: backup-mgr-web
```

> pm2 only parses a file as an ecosystem *config* when its **filename** matches
> `*.config.{js,cjs,mjs}` (or `ecosystem.{js,cjs}`). `ecosystem.frontend.config.cjs` is that file; it
> re-exports [`../ecosystem.frontend.cjs`](../ecosystem.frontend.cjs), which holds the settings.
> Running `pm2 start ecosystem.frontend.cjs` would make pm2 execute it as a *script* and start
> nothing — it now exits with an explanatory error if that happens.

The panel binds `0.0.0.0:3001` by default; set `BACKUP_MGR_WEB_HOST=127.0.0.1` to serve it only to
nginx.

Then open the panel and sign in. **First login is `admin` / `admin`** (or whatever you set as
`BACKUP_MGR_PASSWORD`). On that default the panel **forces a password change**: you are sent to
**Users → Account** and every other page and API stays refused until you set a new one. See
[Forced password change](#forced-password-change).

## Pages (no option appears on two pages)

| Page | Purpose |
|---|---|
| **Dashboard** (`/`) | Status cards, a **countdown to the next scheduled run**, manual backup / dry run / test compression / integrity check, **fix permissions**, reset state, a guided **Restore dialog** (pick a backup → verify → restore, with an optional `--force`), **daemon control** (start / stop / restart the pm2 service), the **schedule** (run time, backups per day, world times), recent run history, a **binary build badge** with a one-click **Rebuild & reinstall** button (see [Binary version](#binary-version)), and a banner when the daemon is still running a since-replaced binary. |
| **Config** (`/config`) | Every *non-schedule* `config.yml` value, grouped by section. Edits preserve comments and are written atomically with `0600` permissions. |
| **Auth** (`/auth`) | Authorize the **primary** remote or the **secondary** (redundancy) remote. Drive remotes support **both** rclone methods — plain browser auth (just your Google account) or your own client ID/secret; non-Drive remotes (e.g. **Backblaze B2**) are configured with account + key. On a headless VPS use the **paste token** method. Drive tokens are written to `google_drive` / `storage.secondary` in `config.yml`; B2 credentials are stored by rclone itself. |
| **Logs** (`/logs`) | **One tab per kind of log**, each with its own file list, **live tail** (Server-Sent Events) and download: **Backup** (per-day run logs from `logging.dir`), **Daemon (pm2)** (`logs/pm2.log`, `logs/pm2-error.log`) and **Panel (pm2)** (`web/logs/pm2-web*.log`). The newest file in a tab is selected automatically, and error logs are badged. |
| **Users** (`/users`) | Admins: create users, set roles and per-permission access, delete users. Everyone: change their **own username and password**. |

## Users and permissions

Accounts live in `data/users.db` (SQLite, scrypt-hashed passwords, `0700` directory). A default
**admin** account is bootstrapped on the first request. Admins implicitly hold every permission; other
users get exactly the permissions ticked for them, enforced **server-side on each API route**.

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
| `users.manage` | Manage users (admin only) |

Sessions are signed HttpOnly cookies, valid for 7 days, and flagged `Secure` automatically when the
request arrives over HTTPS (`X-Forwarded-Proto`). Navigation links are hidden when a user lacks the
permission, but hiding is cosmetic — the API is what enforces it.

### Forced password change

An account is **flagged** while it still holds a default or admin-assigned password. The flag is
enforced centrally, not just in the UI:

- `guard()` and `requireAdmin()` reject every guarded route with
  `403 {"error":"password change required", "must_change_password":true}` while the flag is set, so the
  prompt can't be skipped by calling the API directly. `GET /api/auth/me`, `POST /api/account` and the
  logout route intentionally stay open (they use `currentUser`, not `guard`) so the user can comply.
- The bootstrap `admin` account is flagged whenever the password is the default — including when
  `BACKUP_MGR_PASSWORD=admin` is set explicitly. Supplying any *other* `BACKUP_MGR_PASSWORD` counts as a
  deliberate choice and is not flagged.
- New users get a **"Require a password change at first sign-in"** toggle in the create/edit form
  (default **on**), and flagged accounts show a `must change password` badge in the user list. Changing
  your own password clears the flag automatically.
- The client redirect (login → `/users`) is convenience only; the API refusal is the real gate.

### Password policy

Applied everywhere a password is set (own account, admin creating/updating, first-run bootstrap):

| Rule | Detail |
|---|---|
| Minimum length | **8 characters** |
| Not the username | Rejected case-insensitively |
| Not a common word | `admin`, `password`, `changeme`, `12345678`, `backup-mgr` |

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
`unknown`) isn't falsely reported as stale.

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
| `BACKUP_MGR_PASSWORD` | Initial admin password used **only when the user DB is first created**. Defaults to `admin`. A value of `admin` still counts as the default, so the first login is forced to change it. |
| `BACKUP_MGR_SESSION_SECRET` | Secret that signs session cookies. Defaults to a random secret stored in `data/session.secret` (`0600`). |
| `BACKUP_MGR_ROOT` | Repo root (defaults to `..` from `web/`). `config.yml`, `history.db` and `logs/` are expected there. |
| `BACKUP_MGR_CONFIG` | Path to `config.yml` (defaults to `$BACKUP_MGR_ROOT/config.yml`). |
| `BACKUP_MGR_BIN` | The `backup-mgr` binary (default: on `PATH`). |
| `BACKUP_MGR_DATA_DIR` | Where `users.db` and the session secret live (default `web/data`). |
| `BACKUP_MGR_USERS_DB` | Explicit path to `users.db`. |
| `BACKUP_MGR_PM2_NAME` | pm2 app name controlled by the Dashboard (default `backup-mgr`). |
| `PM2_BIN` | `pm2` executable (default: on `PATH`). |
| `RCLONE_CONFIG` | rclone config path. Used when the panel creates remotes (e.g. B2); defaults to rclone's own per-user config. |
| `CARGO_BIN` | `cargo` executable used by the one-click **Rebuild & reinstall** button (default: `~/.cargo/bin/cargo`, then `PATH`). |
| `BACKUP_MGR_WEB_PORT` | Port the panel binds (default `3001`). Read by `ecosystem.frontend.cjs`. |
| `BACKUP_MGR_WEB_HOST` | Bind address (default `0.0.0.0`). Set `127.0.0.1` to expose the panel only through nginx. |

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
  different machine can't reach. Use the Auth page's **paste token** flow unless you're tunnelling.
- Saving an OAuth token writes it to `config.yml`; the next backup run syncs it into `rclone.conf`
  automatically.
- For the live log stream through nginx you need `proxy_buffering off` — already set in
  [`../deploy/nginx-backup-mgr.conf`](../deploy/nginx-backup-mgr.conf).

## Log sources

The three tabs come from `logSourceDefs()` in [`src/lib/logs.ts`](src/lib/logs.ts). The Backup and
Daemon logs **share a directory by default** (`<root>/logs`), so each source filters by *filename*
rather than by directory alone — `pm2*.log` is routed to the Daemon tab and everything else to Backup.

| Tab | Directory | Matches |
|---|---|---|
| **Backup** | `logging.dir` from `config.yml` (default `<root>/logs`) | `*.log` that isn't `pm2*` |
| **Daemon (pm2)** | `<root>/logs` | `pm2.log`, `pm2-error.log` |
| **Panel (pm2)** | `<root>/web/logs` | `pm2-web.log`, `pm2-web-error.log` |

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
npm test     # vitest (69): permissions, user store + password policy, session signing,
             # rclone parsing, build-stamp comparison, install-target / cargo
             # discovery / daemon-staleness logic, log-source separation, and API
             # guards (including the forced-password-change and binary-install gates)
```
