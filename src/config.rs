use crate::scheduler;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub fn restrict_file_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("cannot restrict permissions on {}: {e}", path.display()))
}

#[derive(Clone, Debug)]
pub struct Config {
    pub inner: ConfigStruct,
    pub base_dir: PathBuf,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConfigStruct {
    pub backup: BackupCfg,
    #[serde(default = "default_world_backup")]
    pub world_backup: WorldBackupCfg,
    #[serde(default)]
    pub encrypt: EncryptCfg,
    pub logging: LoggingCfg,
    pub state: StateCfg,
    pub google_drive: DriveCfg,
    #[serde(default = "default_storage")]
    pub storage: StorageCfg,
    #[serde(default)]
    pub notifications: NotificationCfg,
    #[serde(default = "default_metrics")]
    pub metrics: MetricsCfg,
    #[serde(default = "default_database")]
    pub database: DatabaseCfg,
    pub pterodactyl: PteroCfg,
    pub run: RunCfg,
    #[serde(default = "default_tz")]
    pub timezone: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BackupCfg {
    pub prefix: String,
    pub path: String,
    pub dir: String,
    #[serde(default = "default_compression")]
    pub compression: String,
    #[serde(default = "default_time")]
    pub time: String,
    #[serde(default = "default_bpd")]
    pub backups_per_day: u32,

    #[serde(default)]
    pub times: Vec<String>,
    #[serde(default = "default_timestamp_fmt")]
    pub timestamp_format: String,
    #[serde(default)]
    pub max_local_backups: usize,
    #[serde(default)]
    pub exclude_patterns: Vec<String>,
    #[serde(default = "default_true")]
    pub catch_up_on_start: bool,
    #[serde(default = "default_catchup_win")]
    pub catch_up_window_minutes: i64,
    #[serde(default)]
    pub min_free_disk_gb: u64,
    #[serde(default = "default_slack")]
    pub preflight_slack_factor: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorldBackupCfg {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub minecraft_only: bool,
    #[serde(default = "default_world_folder")]
    pub world_folder: String,
    #[serde(default = "default_world_prefix")]
    pub prefix: String,
    #[serde(default)]
    pub times: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct EncryptCfg {
    pub enabled: bool,
    pub passphrase: String,
    #[serde(default = "default_cipher")]
    pub cipher: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LoggingCfg {
    pub dir: String,
    pub level: String,
    #[serde(default = "default_log_keep_days")]
    pub keep_days: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StateCfg {
    pub file: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DriveCfg {
    pub remote: String,
    pub dir: String,
    pub retention: u32,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    #[serde(default = "default_scope")]
    pub scope: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub expiry: String,
    #[serde(default = "default_token_uri")]
    pub token_uri: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StorageCfg {
    #[serde(default)]
    pub upload_to_all: bool,
    #[serde(default = "default_secondary")]
    pub secondary: SecondaryCfg,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SecondaryCfg {
    pub enabled: bool,
    pub remote: String,
    pub dir: String,
    pub retention: u32,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    #[serde(default = "default_scope")]
    pub scope: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub expiry: String,
    #[serde(default = "default_token_uri")]
    pub token_uri: String,
}

impl Default for SecondaryCfg {
    fn default() -> Self {
        SecondaryCfg {
            enabled: false,
            remote: "b2".into(),
            dir: "mc-backup".into(),
            retention: 3,
            client_id: String::new(),
            client_secret: String::new(),
            scope: default_scope(),
            refresh_token: String::new(),
            access_token: String::new(),
            expiry: String::new(),
            token_uri: default_token_uri(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct NotificationCfg {
    pub discord_webhook: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MetricsCfg {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_metrics_host")]
    pub host: String,
    #[serde(default = "default_metrics_port")]
    pub port: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DatabaseCfg {
    #[serde(default = "default_db_file")]
    pub file: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PteroCfg {
    pub enabled: bool,
    pub panel_url: String,
    pub api_key: String,
    pub server_id: String,
    pub pre_backup_command: String,
    pub pre_backup_delay_seconds: u64,
    pub fail_on_error: bool,
    #[serde(default)]
    pub shutdown_server: bool,
    #[serde(default = "default_shutdown_signal")]
    pub shutdown_signal: String,
    #[serde(default = "default_stop_timeout_secs")]
    pub stop_timeout_seconds: u64,
    #[serde(default = "default_true")]
    pub start_server_after: bool,
    #[serde(default = "default_start_timeout_secs")]
    pub start_timeout_seconds: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunCfg {
    #[serde(default)]
    pub continue_after_manual_resume: bool,
    #[serde(default = "default_check_secs")]
    pub check_state_seconds: u64,
}

fn default_tz() -> String {
    "UTC".to_string()
}
fn default_compression() -> String {
    "tar.gz".to_string()
}
fn default_time() -> String {
    "03:30".to_string()
}
fn default_bpd() -> u32 {
    1
}
fn default_timestamp_fmt() -> String {
    "%d-%m-%y_%H-%M".to_string()
}
fn default_true() -> bool {
    true
}
fn default_catchup_win() -> i64 {
    120
}
fn default_log_keep_days() -> u64 {
    30
}
fn default_scope() -> String {
    "https://www.googleapis.com/auth/drive".to_string()
}
fn default_token_uri() -> String {
    "https://oauth2.googleapis.com/token".to_string()
}
fn default_check_secs() -> u64 {
    30
}
fn default_slack() -> f64 {
    1.1
}
fn default_world_folder() -> String {
    "world".to_string()
}
fn default_world_prefix() -> String {
    "mcworld".to_string()
}
fn default_cipher() -> String {
    "AES256".to_string()
}
fn default_shutdown_signal() -> String {
    "stop".to_string()
}
fn default_stop_timeout_secs() -> u64 {
    180
}
fn default_start_timeout_secs() -> u64 {
    90
}
fn default_metrics_host() -> String {
    "127.0.0.1".to_string()
}
fn default_metrics_port() -> u16 {
    9101
}
fn default_db_file() -> String {
    "./history.db".to_string()
}
fn default_secondary() -> SecondaryCfg {
    SecondaryCfg::default()
}

fn default_world_backup() -> WorldBackupCfg {
    WorldBackupCfg {
        enabled: false,
        minecraft_only: true,
        world_folder: default_world_folder(),
        prefix: default_world_prefix(),
        times: Vec::new(),
    }
}

fn default_storage() -> StorageCfg {
    StorageCfg {
        upload_to_all: false,
        secondary: SecondaryCfg::default(),
    }
}

fn default_metrics() -> MetricsCfg {
    MetricsCfg {
        enabled: false,
        host: default_metrics_host(),
        port: default_metrics_port(),
    }
}

fn default_database() -> DatabaseCfg {
    DatabaseCfg {
        file: default_db_file(),
    }
}

fn yaml_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn update_remote_token_fields(path: &Path, section: &str, section_indent: usize, refresh: &str, access: &str, expiry: &str) -> Result<(), String> {
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut lines: Vec<String> = raw.lines().map(String::from).collect();
    let target = format!("{}:", section);
    let val_indent = section_indent + 2;
    let keys = ["refresh_token", "access_token", "expiry"];
    let vals = [refresh, access, expiry];

    for l in lines.iter_mut() {
        let trimmed = l.trim_end().to_string();
        *l = trimmed;
    }

    let header_idx = lines.iter().position(|l| {
        let t = l.trim();
        (l.len() - t.len()) == section_indent && t.starts_with(&target)
    }).ok_or_else(|| format!("section '{}' not found in {}", target, path.display()))?;

    let mut end = lines.len();
    for i in (header_idx + 1)..lines.len() {
        let t = lines[i].trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if (lines[i].len() - t.len()) <= section_indent {
            end = i;
            break;
        }
    }

    let mut replaced = [false; 3];
    for i in (header_idx + 1)..end {
        let t = lines[i].trim();
        if t.is_empty() || t.starts_with('#') || (lines[i].len() - t.len()) != val_indent {
            continue;
        }
        for (ki, k) in keys.iter().enumerate() {
            if t.starts_with(&format!("{}:", k)) && !t.starts_with(&format!("{} :", k)) {
                let comment = t
                    .split_once('#')
                    .map(|(_, c)| format!("  #{}", c))
                    .unwrap_or_default();
                lines[i] = format!("{}{}: {}{}", " ".repeat(val_indent), k, yaml_quote(vals[ki]), comment);
                replaced[ki] = true;
                break;
            }
        }
    }

    let mut insert_at = header_idx + 1;
    for (ki, k) in keys.iter().enumerate() {
        if !replaced[ki] {
            lines.insert(insert_at, format!("{}{}: {}", " ".repeat(val_indent), k, yaml_quote(vals[ki])));
            insert_at += 1;
        }
    }

    let data = lines.join("\n") + "\n";
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!(
        ".{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    fs::write(&tmp, data).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("cannot replace {}: {e}", path.display())
    })?;
    restrict_file_permissions(path)
}

impl Config {
    pub fn load(path: &Path) -> Result<Self, String> {
        let raw = fs::read_to_string(path)
            .map_err(|e| format!("cannot read config {}: {}", path.display(), e))?;

        let _ = restrict_file_permissions(path);
        let inner: ConfigStruct = serde_yaml::from_str(&raw)
            .map_err(|e| format!("cannot parse config {}: {}", path.display(), e))?;
        let mut cfg = Config {
            inner,
            base_dir: path
                .canonicalize()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))),
        };
        cfg.normalize();
        Ok(cfg)
    }

    fn normalize(&mut self) {
        if self.inner.backup.compression.trim().is_empty() {
            self.inner.backup.compression = "tar.gz".into();
        }
        if self.inner.backup.compression == "gz" || self.inner.backup.compression == "gzip" {
            self.inner.backup.compression = "tar.gz".into();
        }
        let c = self.inner.backup.compression.trim().to_lowercase();
        self.inner.backup.compression = c;
        if self.inner.backup.backups_per_day == 0 {
            self.inner.backup.backups_per_day = 1;
        }

        let mut times: Vec<u32> = self
            .inner
            .backup
            .times
            .iter()
            .filter_map(|t| scheduler::parse_time(t))
            .collect();
        times.sort_unstable();
        times.dedup();
        self.inner.backup.times = times.iter().map(|m| format!("{:02}:{:02}", m / 60, m % 60)).collect();
        if self.inner.backup.max_local_backups == 0 {
            self.inner.backup.max_local_backups = 1;
        }
        if self.inner.google_drive.retention == 0 {
            self.inner.google_drive.retention = 1;
        }
        if self.inner.storage.secondary.retention == 0 {
            self.inner.storage.secondary.retention = 1;
        }
    }

    pub fn resolve(&self, p: &str) -> PathBuf {
        let path = Path::new(p);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.base_dir.join(path)
        }
    }
}

pub fn default_config_template(server_path: &str) -> String {
    format!(
        r#"# =============================================================================
# backup-mgr configuration
# Generated on first run. Edit values below and restart the process when done.
# Relative paths are resolved against this file's directory.
# =============================================================================

backup:
  # First part of every full-archive name, e.g. "mc" -> mc_12-09-26_03-30.tar.gz
  prefix: "mc"

  # Directory to back up. EVERYTHING inside it is archived (unless excluded).
  path: "{server_path}"

  # Local staging directory where archives are created before upload.
  dir: "./backup"

  # Compression. Empty defaults to "tar.gz".
  # Supported: tar | tar.gz | tar.zst | tar.xz | tar.bz2 | zip
  compression: "tar.gz"

  # Time of the first daily backup (24h, HH:MM) in the configured timezone.
  time: "03:30"

  # How many backups to run per day. 1 = once/day. N = N evenly spaced runs/day.
  # Ignored when "times" below is set.
  backups_per_day: 1

  # Exact daily run times (24h, HH:MM). Empty = use time + backups_per_day.
  # Set these to run at specific times instead of at even intervals, e.g.:
  #   times:
  #     - "03:30"
  #     - "15:30"
  times: []

  # Archive timestamp format (%Y %y %m %d %H %M %S tokens supported).
  timestamp_format: "%d-%m-%y_%H-%M"

  # Keep at most this many archives in the local staging dir before upload/prune.
  max_local_backups: 1

  # Glob patterns excluded from the archive (tar --exclude semantics).
  exclude_patterns:
    - "*.zip"

  # Catch-up: run on startup if a scheduled slot was missed within the window.
  catch_up_on_start: true
  catch_up_window_minutes: 120

  # ---- Disk-space preflight ----
  # Before compressing we estimate the source size (excluding excluded files)
  # and require free disk >= estimated_size * preflight_slack_factor + min_free_disk_gb.
  # min_free_disk_gb: 0 disables the extra buffer (estimation always applies).
  min_free_disk_gb: 5
  preflight_slack_factor: 1.1

# ---- World-only backups (MINECRAFT SERVER ONLY) ----
# Backs up just the world folder for fast, frequent snapshots.
world_backup:
  enabled: false                # disable by default; enable for minecraft servers
  minecraft_only: true          # this feature is intended for minecraft servers only
  world_folder: "world"         # sub-folder inside backup.path that holds the world
  prefix: "mcworld"             # archive prefix, e.g. mcworld_12-09-26_06-00.tar.gz
  times:                        # empty list = disabled; list of HH:MM run times
    - "06:00"
    - "12:00"
    - "18:00"

# ---- Encrypted archives (gpg -c, symmetric AES256) ----
encrypt:
  enabled: false
  passphrase: ""                # if enabled this MUST be set (kept in this file!)
  cipher: "AES256"

logging:
  dir: "./logs"
  level: "info"                 # debug | info | warn | error
  keep_days: 30

state:
  file: "./state.json"

google_drive:
  # PRIMARY storage remote (rclone remote name; created by "backup-mgr remote-auth").
  remote: "gdrive"
  dir: "mc-backup"
  retention: 3                  # keep this many backups on the primary remote

  # Optional OAuth client id/secret (Google Cloud OAuth client). When set they are
  # written into the rclone config. Leave blank to use browser-based authentication.
  client_id: ""
  client_secret: ""
  scope: "https://www.googleapis.com/auth/drive"
  token_uri: "https://oauth2.googleapis.com/token"

  # Optional pre-issued tokens. On expiry rclone silently uses refresh_token here.
  refresh_token: ""
  access_token: ""
  expiry: ""                    # RFC3339

storage:
  # upload_to_all: false -> try only the primary; if it fails, fall back to the
  #                        secondary remote (e.g. Backblaze B2). "or vice versa"
  #                        = just swap primary/secondary sections.
  # upload_to_all: true  -> upload to EVERY enabled remote; any failure aborts.
  upload_to_all: false
  secondary:
    enabled: false
    remote: "b2"
    dir: "mc-backup"
    retention: 3
    client_id: ""
    client_secret: ""
    refresh_token: ""
    access_token: ""
    expiry: ""

notifications:
  # Discord webhook URL. Empty = disabled. When set, embedded messages are sent
  # for: backup success/failure, restore done, preflight fail, manual-resume and
  # integrity checks. Every message includes the log/state/db file paths.
  discord_webhook: ""

metrics:
  # Prometheus-style metrics on a localhost HTTP endpoint for monitoring/scraping.
  # Try: curl http://127.0.0.1:9101/metrics
  enabled: true
  host: "127.0.0.1"
  port: 9101

database:
  # SQLite history of every run + remote hash manifest used by "backup-mgr check".
  file: "./history.db"

pterodactyl:
  # ------------------------------------------------------------------
  # Pterodactyl server control during backups. Requires a CLIENT API key
  # (Account -> API Credentials on the panel) pasted into api_key below.
  #
  # WHAT 'save-all' DOES (Minecraft):
  #   The game keeps chunks in RAM and writes them to disk lazily.
  #   'save-all' forces it to flush every chunk to disk immediately, so an
  #   archive taken right after contains the exact current world. It does
  #   NOT stop the server.
  #
  # ORDER OF STAGES when enabled:
  #   1. send pre_backup_command (e.g. "save-all") via the console websocket
  #   2. wait pre_backup_delay_seconds while the flush finishes writing
  #   3. if shutdown_server: true -> send the power signal shutdown_signal
  #      and wait until the panel reports the server fully OFFLINE
  #   4. THEN archiving starts, with the server completely stopped, so every
  #      file is readable and nothing is mid-write (no corruption/skips)
  #   5. when the backup is done (success OR failure), the server is started
  #      again automatically if start_server_after: true
  #
  # pre_backup_delay_seconds is the pause AFTER the save command is sent and
  # BEFORE stop/archive — NOT "time after compression starts".
  enabled: false
  panel_url: "https://panel.example.com"
  api_key: ""                   # CRITICAL - paste a Pterodactyl CLIENT API key here
  server_id: ""                 # server UUID shown in the panel URL
  pre_backup_command: "save-all"
  pre_backup_delay_seconds: 10

  # Stop the server completely before archiving (recommended for a fully
  # consistent backup). shutdown_signal: "stop" = graceful shutdown (server
  # saves and exits cleanly, safest) | "kill" = force-kill (data-loss risk).
  shutdown_server: false
  shutdown_signal: "stop"
  stop_timeout_seconds: 180     # max wait for the server to go offline

  # Start the server again once the backup finishes. start_timeout_seconds
  # is the max time we wait for it to report "running".
  start_server_after: true
  start_timeout_seconds: 90

  # false = problems log a warning and the archive still happens;
  # true  = abort the run (server is restarted before aborting if it was stopped).
  fail_on_error: false

run:
  # true  -> log warning and keep taking scheduled backups after a failure
  # false -> pause backups until "backup-mgr reset" is run
  continue_after_manual_resume: false
  check_state_seconds: 30

timezone: "UTC"
"#
    )
}

pub fn save_default_config(path: &Path, server_path: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, default_config_template(server_path)).map_err(|e| e.to_string())?;
    restrict_file_permissions(path)
}
