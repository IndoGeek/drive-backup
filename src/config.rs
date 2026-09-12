use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

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

impl Config {
    pub fn load(path: &Path) -> Result<Self, String> {
        let raw = fs::read_to_string(path)
            .map_err(|e| format!("cannot read config {}: {}", path.display(), e))?;
        let inner: ConfigStruct = serde_yaml::from_str(&raw)
            .map_err(|e| format!("cannot parse config {}: {}", path.display(), e))?;
        let mut cfg = Config {
            inner,
            base_dir: path
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| PathBuf::from(".")),
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
  backups_per_day: 1

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
  # Before compressing a live server, send a console command (e.g. "save-all")
  # through the Pterodactyl CLIENT API websocket to flush data to disk.
  enabled: false
  panel_url: "https://panel.example.com"
  api_key: ""                   # Paste a Pterodactyl CLIENT API key here.
  server_id: ""                 # Server UUID shown in the panel URL.
  pre_backup_command: "save-all"
  pre_backup_delay_seconds: 10
  fail_on_error: false          # false = log warning and still archive anyway

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
    fs::write(path, default_config_template(server_path)).map_err(|e| e.to_string())
}