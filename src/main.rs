mod backup;
mod config;
mod db;
mod drive;
mod logger;
mod metrics;
mod notify;
mod perms;
mod ptero;
mod scheduler;
mod state;

use chrono::{DateTime, Timelike, Utc};
use chrono_tz::Tz;
use path_guard::LockGuard;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use crate::config::Config;
use crate::drive::Remote;
use crate::logger::{Level, Logger};
use crate::state::RunState;

const LOCK_NAME: &str = ".run.lock";

/// Build provenance, baked in at compile time by build.rs. The web panel reads
/// these over `status --json` / `version --json` to spot a stale installed
/// binary (e.g. /usr/local/bin/backup-mgr predating a rebuild).
const BUILD_VERSION: &str = env!("CARGO_PKG_VERSION");
const BUILD_COMMIT: &str = env!("BUILD_GIT_COMMIT");
const BUILD_TIMESTAMP: &str = env!("BUILD_TIMESTAMP");

const USAGE: &str = "Usage:\n  backup-mgr [daemon]\n  backup-mgr run [--world] [--no-upload|--keep-local|--no-ptero|--dry-run|--force]\n  backup-mgr test-compress\n  backup-mgr restore [<file> [target-dir]] [--force]\n  backup-mgr restore --json\n  backup-mgr check [file]\n  backup-mgr history [N]\n  backup-mgr remote-auth\n  backup-mgr status [--json]\n  backup-mgr fix-perms [--user <name>]\n  backup-mgr version [--json]\n  backup-mgr reset\n  [--config <path>]";

/// The build stamp as JSON, shared by `version --json` and `status --json`.
fn build_json() -> serde_json::Value {
    serde_json::json!({
        "name": env!("CARGO_PKG_NAME"),
        "version": BUILD_VERSION,
        "commit": BUILD_COMMIT,
        "built_at": BUILD_TIMESTAMP,
    })
}

fn cmd_version(json: bool) -> Result<(), String> {
    if json {
        println!(
            "{}",
            serde_json::to_string(&build_json()).map_err(|e| e.to_string())?
        );
    } else {
        println!(
            "{} {} (commit {}, built {})",
            env!("CARGO_PKG_NAME"),
            BUILD_VERSION,
            BUILD_COMMIT,
            BUILD_TIMESTAMP
        );
    }
    Ok(())
}

static DB: OnceLock<Option<Arc<db::Db>>> = OnceLock::new();
static METRICS: OnceLock<Arc<metrics::Metrics>> = OnceLock::new();

fn db() -> Option<&'static Arc<db::Db>> {
    DB.get().and_then(|x| x.as_ref())
}
fn metrics() -> Option<&'static Arc<metrics::Metrics>> {
    METRICS.get()
}

mod path_guard {
    pub struct LockGuard(pub std::path::PathBuf);
    impl Drop for LockGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir(&self.0);
        }
    }
}

/// Default config location: `./config.yml` relative to the working directory.
///
/// Every real entry point passes `--config <path>` explicitly (the pm2 unit and
/// the web panel both do); this is only the fallback for a bare
/// `backup-mgr <command>`, so it must not hardcode any particular install path.
fn default_config_path() -> PathBuf {
    PathBuf::from("config.yml")
}

fn detect_server_volume() -> Option<String> {
    let vols = Path::new("/var/lib/pterodactyl/volumes");
    if !vols.is_dir() {
        return None;
    }
    for e in std::fs::read_dir(vols).ok()?.flatten() {
        if e.path().is_dir() {
            return Some(e.path().to_string_lossy().to_string());
        }
    }
    None
}

fn system_tz() -> Tz {
    if let Ok(name) = std::fs::read_to_string("/etc/timezone") {
        if let Ok(tz) = name.trim().parse::<Tz>() {
            return tz;
        }
    }
    if let Ok(tz) = env::var("TZ") {
        if let Ok(parsed) = tz.parse::<Tz>() {
            return parsed;
        }
    }
    Tz::UTC
}

fn resolve_tz(cfg: &Config) -> Tz {
    let name = cfg.inner.timezone.trim();
    if name.is_empty() || name.eq_ignore_ascii_case("local") || name.eq_ignore_ascii_case("system") {
        system_tz()
    } else {
        name.parse::<Tz>().unwrap_or_else(|_| {
            eprintln!("invalid timezone '{}' in config; falling back to system zone", name);
            system_tz()
        })
    }
}

fn now_in(cfg: &Config) -> chrono::DateTime<Tz> {
    chrono::Utc::now().with_timezone(&resolve_tz(cfg))
}

fn today_log_file(cfg: &Config) -> String {
    let dir = cfg.resolve(&cfg.inner.logging.dir);
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    dir.join(format!("backup_{}.log", today)).to_string_lossy().to_string()
}

fn notif_ctx(cfg: &Config) -> notify::NotifCtx {
    notify::NotifCtx {
        log_file: today_log_file(cfg),
        state_file: cfg.resolve(&cfg.inner.state.file).to_string_lossy().to_string(),
        db_file: cfg.resolve(&cfg.inner.database.file).to_string_lossy().to_string(),
        timezone: cfg.inner.timezone.clone(),
    }
}

fn log_state_line(logger: &Logger, s: &RunState) {
    logger.debug(&format!("state -> {}", s.describe()));
}

fn acquire_lock(state_dir: &Path, logger: &Logger) -> Result<LockGuard, String> {
    std::fs::create_dir_all(state_dir).map_err(|e| e.to_string())?;
    let lock = state_dir.join(LOCK_NAME);
    match std::fs::create_dir(&lock) {
        Ok(_) => Ok(LockGuard(lock)),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            if let Ok(meta) = std::fs::metadata(&lock) {
                if let Ok(modified) = meta.modified() {
                    if let Ok(age) = modified.elapsed() {
                        if age > Duration::from_secs(6 * 3600) {
                            let _ = std::fs::remove_dir(&lock);
                            std::fs::create_dir(&lock).map_err(|e| e.to_string())?;
                            logger.warn("removed stale run lock (older than 6h)");
                            return Ok(LockGuard(lock));
                        }
                    }
                }
            }
            Err("another backup run is already in progress (lock held). If that is wrong, delete the lock dir.".to_string())
        }
        Err(e) => Err(format!("cannot create run lock: {e}")),
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Full,
    World,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Kind::Full => "full",
            Kind::World => "world",
        }
    }
}

struct RunOpts {
    kind: Kind,
    upload: bool,
    keep_local: bool,
    ptero: bool,
    dry_run: bool,
}

fn db_record(
    kind: &str,
    name: &str,
    size: Option<i64>,
    dur_ms: Option<i64>,
    remote: &str,
    status: &str,
    error: &str,
) {
    if let Some(d) = db() {
        let _ = d.record_run(
            &Utc::now().to_rfc3339(),
            kind,
            name,
            size,
            dur_ms,
            remote,
            status,
            error,
        );
    }
}

fn metrics_run(ok: bool, size: u64, dur: Duration, name: &str) {
    if let Some(m) = metrics() {
        m.record_run(ok, size, dur.as_millis() as u64, name);
    }
}

fn run_backup(
    cfg: &Config,
    logger: &Logger,
    state_file: &Path,
    opts: &RunOpts,
    force: bool,
) -> Result<(), String> {
    let state_dir = state_file.parent().map(Path::to_path_buf).unwrap_or_default();
    let _lock = acquire_lock(&state_dir, logger)?;

    let now = now_in(cfg);
    let now_utc = Utc::now();
    let start_inst = Instant::now();
    let mut st = RunState::load(state_file);

    if !opts.dry_run
        && st.requires_manual_resume
        && !force
        && !cfg.inner.run.continue_after_manual_resume
    {
        let msg = format!(
            "previous run failed and requires manual resume (stage={}). Run 'backup-mgr reset' to clear, or pass --force.",
            st.stage
        );
        logger.error(&msg);
        return Err(msg);
    }

    let b = &cfg.inner.backup;
    let w = &cfg.inner.world_backup;
    let role = opts.kind;
    let is_world = role == Kind::World;
    if is_world && !w.enabled {
        return Err("world backup requested but world_backup.enabled is false in config.yml".into());
    }

    let src = cfg.resolve(&b.path);
    let local_dir = cfg.resolve(&b.dir);
    std::fs::create_dir_all(&local_dir).map_err(|e| e.to_string())?;

    let compression = backup::normalize_compression(&b.compression);
    let ext = backup::extension_for(&compression)
        .ok_or_else(|| format!("unsupported compression type in config.yml: {}", b.compression))?;
    let prefix = if is_world { &w.prefix } else { &b.prefix };
    let base_name = backup::archive_name(prefix, &b.timestamp_format, &now, ext);
    let base_dst = local_dir.join(&base_name);

    let enc_cfg = &cfg.inner.encrypt;
    if enc_cfg.enabled && enc_cfg.passphrase.trim().is_empty() {
        return Err("encrypt.enabled is true but encrypt.passphrase is empty in config.yml".into());
    }
    let encrypted = enc_cfg.enabled && !enc_cfg.passphrase.trim().is_empty();
    let artifact_name = if encrypted {
        format!("{}.gpg", base_name)
    } else {
        base_name.clone()
    };
    let prune_ext = if encrypted { ".gpg" } else { ext };
    let sub_dir = if is_world {
        Some(Path::new(&w.world_folder))
    } else {
        None
    };

    let stage_label = if is_world { "world" } else { "full" };

    if !opts.dry_run {
        st.mark_running("preflight", &base_name, now_utc.to_rfc3339());
        st.save(state_file)?;
        log_state_line(logger, &st);
    }
    logger.info(&format!(
        "========================================\nBACKUP RUN #{} STARTED ({}) at {} => {}",
        st.generation.max(1),
        stage_label,
        now.format("%Y-%m-%d %H:%M:%S %Z"),
        base_name
    ));

    // ---------- preflight: disk space ----------
    let est_root = match sub_dir {
        Some(s) => src.join(s),
        None => src.clone(),
    };
    // On the first run (or whenever the source becomes unreadable) try to fix
    // the permissions for the current user automatically before giving up.
    let mut tried_perm_fix = false;
    let estimated = loop {
        match backup::estimate_size(&est_root, &b.exclude_patterns) {
            Ok(n) => break n,
            Err(e) => {
                if !tried_perm_fix && !opts.dry_run {
                    tried_perm_fix = true;
                    if let Some(user) = perms::current_user() {
                        logger.warn(&format!(
                            "cannot read source to estimate its size ({e}); attempting to grant read access to '{user}' automatically"
                        ));
                        match perms::ensure_access(cfg, &user, logger) {
                            Ok(()) => continue,
                            Err(fix) => logger.warn(&format!("automatic permission fix failed: {fix}")),
                        }
                    }
                }
                let reason = format!(
                    "cannot read source to estimate its size: {e}. If you run the backup as a non-root user, first grant read+traverse access to the source directory: sudo ./scripts/grant-access.sh $USER <backup-dir> (see README 'Prerequisites', requires the 'acl' package)."
                );
                if opts.dry_run {
                    logger.warn(&format!("DRY RUN: {reason}"));
                    return Err(reason);
                }
                notify::send(
                    &cfg.inner.notifications.discord_webhook,
                    logger,
                    &notif_ctx(cfg),
                    &notify::Event::PreflightFail { reason: reason.clone() },
                );
                db_record(stage_label, &base_name, None, None, "-", "failed", &reason);
                metrics_run(false, 0, start_inst.elapsed(), &base_name);
                return fail(cfg, state_file, &mut st, logger, "preflight", &reason);
            }
        }
    };
    let free = backup::free_bytes_on(&local_dir).unwrap_or(u64::MAX);
    if let Some(m) = metrics() {
        m.set_sizes(free, estimated);
    }
    let min_gb = b.min_free_disk_gb;
    let slack = if b.preflight_slack_factor <= 0.0 { 1.1 } else { b.preflight_slack_factor };
    let need = estimated as f64 * slack + (min_gb as f64 * 1_073_741_824.0);
    if (free as f64) < need {
        let reason = format!(
            "disk preflight failed: source ~{} needs {} free (slack {} + min {} GB), only {} free on {}",
            backup::human_size(estimated),
            backup::human_size(need as u64),
            slack,
            min_gb,
            backup::human_size(free),
            local_dir.display()
        );
        if opts.dry_run {
            logger.warn(&format!("DRY RUN: {reason}"));
            return Err(reason);
        }
        notify::send(
            &cfg.inner.notifications.discord_webhook,
            logger,
            &notif_ctx(cfg),
            &notify::Event::PreflightFail { reason: reason.clone() },
        );
        db_record(stage_label, &base_name, None, None, "-", "failed", &reason);
        metrics_run(false, 0, start_inst.elapsed(), &base_name);
        return fail(cfg, state_file, &mut st, logger, "preflight", &reason);
    }
    logger.info(&format!(
        "preflight ok: estimated source {} , free disk {}",
        backup::human_size(estimated),
        backup::human_size(free)
    ));

    // ---------- pterodactyl pre-backup (save + optional graceful shutdown) ----------
    // `server_guard` restarts the server on Drop, so it comes back up on every
    // possible exit path (success, failure, early return) automatically.
    let mut server_guard: Option<ptero::PteroGuard<'_>> = None;
    if opts.ptero {
        if opts.dry_run {
            logger.info("dry-run: skipping pterodactyl pre-backup (server untouched)");
        } else {
            st.stage = "pterodactyl-save".into();
            st.save(state_file)?;
            match ptero::pre_backup(cfg, logger, &mut server_guard) {
                Ok(()) => {}
                Err(e) => {
                    if e.critical || cfg.inner.pterodactyl.fail_on_error {
                        db_record(stage_label, &base_name, None, None, "-", "failed", &e.message);
                        metrics_run(false, 0, start_inst.elapsed(), &base_name);
                        return fail(cfg, state_file, &mut st, logger, "pterodactyl-save", &e.message);
                    }
                    logger.warn(&format!("pterodactyl pre-backup failed (continuing): {}", e.message));
                }
            }
        }
    }

    // ---------- archive ----------
    if !opts.dry_run {
        st.stage = "compressing".into();
        st.save(state_file)?;
    }
    if let Err(e) = backup::compress_dir(&src, sub_dir, &base_dst, &compression, &b.exclude_patterns, logger) {
        db_record(stage_label, &base_name, None, None, "-", "failed", &e);
        metrics_run(false, 0, start_inst.elapsed(), &base_name);
        return fail(cfg, state_file, &mut st, logger, "compressing", &e);
    }

    if opts.dry_run {
        let plan = drive::active_remotes(cfg)
            .iter()
            .map(|r| r.label())
            .collect::<Vec<_>>()
            .join(", ");
        logger.info(&format!(
            "DRY RUN: archive {} created ({}), would upload to: {} | retention prune on file, verify after upload",
            base_name,
            backup::human_size(std::fs::metadata(&base_dst).map(|m| m.len()).unwrap_or(0)),
            if plan.is_empty() { "none (no remotes enabled)" } else { &plan }
        ));
        let _ = std::fs::remove_file(&base_dst);
        logger.info("DRY RUN complete: archive discarded, remote untouched, no state/notification written");
        return Ok(());
    }

    // ---------- encrypt ----------
    let artifact = if encrypted {
        st.stage = "encrypting".into();
        st.save(state_file)?;
        match backup::encrypt_gpg(&base_dst, &enc_cfg.passphrase, &enc_cfg.cipher, logger) {
            Ok(p) => p,
            Err(e) => {
                db_record(stage_label, &base_name, None, None, "-", "failed", &e);
                metrics_run(false, 0, start_inst.elapsed(), &base_name);
                return fail(cfg, state_file, &mut st, logger, "encrypting", &e);
            }
        }
    } else {
        base_dst.clone()
    };
    let upload_size = std::fs::metadata(&artifact).map(|m| m.len()).unwrap_or(0);

    // ---------- no-upload mode (testing) ----------
    if !opts.upload {
        if !opts.keep_local {
            let _ = std::fs::remove_file(&artifact);
        }
        backup::prune_local(&local_dir, prune_ext, b.max_local_backups, logger);
        st.mark_ok(Utc::now().to_rfc3339());
        st.save(state_file)?;
        logger.info(if opts.keep_local {
            "RUN FINISHED (local-only mode, archive kept for inspection)"
        } else {
            "RUN FINISHED (local-only mode; upload skipped)"
        });
        return Ok(());
    }

    // ---------- upload orchestration ----------
    st.stage = "uploading".into();
    st.save(state_file)?;

    let md5_opt = drive::local_md5(&artifact).ok();
    if md5_opt.is_none() {
        logger.warn("could not compute local MD5 for manifest; integrity check will be limited");
    }

    let remotes: Vec<Remote> = drive::active_remotes(cfg);
    let upload_to_all = cfg.inner.storage.upload_to_all;
    let mut uploaded = Vec::new();
    let mut fallback_warn: Option<String> = None;
    let mut errors: Vec<String> = Vec::new();

    let try_upload = |r: &Remote, logger: &Logger| -> Result<(), String> {
        drive::ensure_remote_section(r, logger)?;
        if let Err(e) = drive::check_remote(r) {
            return Err(format!(
                "Google Drive auth/access failed on {}: {e} (run `backup-mgr remote-auth` or add refresh_token)",
                r.label()
            ));
        }
        drive::upload_file(r, &artifact, logger)
    };

    if upload_to_all && !remotes.is_empty() {
        for r in &remotes {
            match try_upload(r, logger) {
                Ok(()) => {
                    uploaded.push(r.label());
                    if let Some(h) = &md5_opt {
                        if let Some(d) = db() {
                            let _ = d.upsert_manifest(&artifact_name, upload_size as i64, h, &r.label(), &Utc::now().to_rfc3339(), stage_label);
                        }
                    }
                    if let Ok(pruned) = drive::prune_remote(r, prune_ext, r.retention, logger) {
                        if !pruned.is_empty() {
                            if let Some(d) = db() {
                                let _ = d.prune_manifest_removed(&pruned);
                            }
                        }
                    }
                }
                Err(e) => {
                    logger.warn(&e);
                    errors.push(e);
                }
            }
        }
        if uploaded.is_empty() {
            let msg = errors.into_iter().last().unwrap_or_else(|| "no remotes configured".into());
            notify::send(
                &cfg.inner.notifications.discord_webhook, logger, &notif_ctx(cfg),
                &notify::Event::BackupFailure { kind: stage_label.to_string(), stage: "uploading".into(), reason: msg.clone() },
            );
            db_record(stage_label, &base_name, Some(upload_size as i64), Some(start_inst.elapsed().as_millis() as i64), "-", "failed", &msg);
            metrics_run(false, upload_size, start_inst.elapsed(), &base_name);
            return fail(cfg, state_file, &mut st, logger, "uploading", &msg);
        }
    } else if !remotes.is_empty() {
        for (idx, r) in remotes.iter().enumerate() {
            match try_upload(r, logger) {
                Ok(()) => {
                    uploaded.push(r.label());
                    if idx > 0 {
                        fallback_warn = Some(r.label());
                    }
                    if let Some(h) = &md5_opt {
                        if let Some(d) = db() {
                            let _ = d.upsert_manifest(&artifact_name, upload_size as i64, h, &r.label(), &Utc::now().to_rfc3339(), stage_label);
                        }
                    }
                    if let Ok(pruned) = drive::prune_remote(r, prune_ext, r.retention, logger) {
                        if !pruned.is_empty() {
                            if let Some(d) = db() {
                                let _ = d.prune_manifest_removed(&pruned);
                            }
                        }
                    }
                    break;
                }
                Err(e) => {
                    logger.warn(&format!("upload to {} failed: {e}", r.label()));
                    errors.push(e);
                }
            }
        }
        if uploaded.is_empty() {
            let msg = errors.into_iter().last().unwrap_or_else(|| "no remotes configured".into());
            notify::send(
                &cfg.inner.notifications.discord_webhook, logger, &notif_ctx(cfg),
                &notify::Event::BackupFailure { kind: stage_label.to_string(), stage: "uploading".into(), reason: msg.clone() },
            );
            db_record(stage_label, &base_name, Some(upload_size as i64), Some(start_inst.elapsed().as_millis() as i64), "-", "failed", &msg);
            metrics_run(false, upload_size, start_inst.elapsed(), &base_name);
            return fail(cfg, state_file, &mut st, logger, "uploading", &msg);
        }
    } else {
        let msg: String = "no storage remotes configured (google_drive or storage.secondary) — nothing to upload to".into();
        notify::send(
            &cfg.inner.notifications.discord_webhook, logger, &notif_ctx(cfg),
            &notify::Event::BackupFailure { kind: stage_label.to_string(), stage: "uploading".into(), reason: msg.clone() },
        );
        db_record(stage_label, &base_name, Some(upload_size as i64), Some(start_inst.elapsed().as_millis() as i64), "-", "failed", &msg);
        metrics_run(false, upload_size, start_inst.elapsed(), &base_name);
        return fail(cfg, state_file, &mut st, logger, "uploading", &msg);
    }
    if let Some(fw) = fallback_warn {
        logger.warn(&format!("primary remote failed; backup uploaded to fallback remote {}", fw));
    }

    // ---------- cleanup local ----------
    st.stage = "cleanup".into();
    st.save(state_file)?;
    if !opts.keep_local {
        match std::fs::remove_file(&artifact) {
            Ok(_) => logger.info(&format!("removed local archive {}", artifact.display())),
            Err(e) => logger.warn(&format!("could not remove local archive {}: {e}", artifact.display())),
        }
    }
    backup::prune_local(&local_dir, prune_ext, b.max_local_backups, logger);

    // ---------- restart server (if it was stopped for this backup) ----------
    if let Some(g) = server_guard.as_mut() {
        g.restart_now();
    }

    // ---------- finalize ----------
    let duration = start_inst.elapsed();
    let finished = Utc::now().to_rfc3339();
    st.mark_ok(finished.clone());
    st.save(state_file)?;
    log_state_line(logger, &st);

    let remotes_label = uploaded.join(", ");
    db_record(stage_label, &base_name, Some(upload_size as i64), Some(duration.as_millis() as i64), &remotes_label, "ok", "");
    metrics_run(true, upload_size, duration, &base_name);
    notify::send(
        &cfg.inner.notifications.discord_webhook,
        logger,
        &notif_ctx(cfg),
        &notify::Event::BackupSuccess {
            kind: stage_label.to_string(),
            name: base_name.clone(),
            size: upload_size,
            duration_secs: duration.as_secs() as i64,
            remote: remotes_label.clone(),
        },
    );
    logger.info(&format!(
        "BACKUP RUN FINISHED OK ({}) in {}s (backup={}, uploaded to [{}], size {})",
        stage_label,
        duration.as_secs(),
        base_name,
        remotes_label,
        backup::human_size(upload_size)
    ));
    Ok(())
}

fn fail(
    _cfg: &Config,
    state_file: &Path,
    st: &mut RunState,
    logger: &Logger,
    stage: &str,
    err: &str,
) -> Result<(), String> {
    st.mark_failed(stage, err);
    let _ = st.save(state_file);
    notify::send(
        &_cfg.inner.notifications.discord_webhook,
        logger,
        &notif_ctx(_cfg),
        &notify::Event::ManualResume {
            stage: stage.to_string(),
            reason: err.to_string(),
        },
    );
    logger.error(&format!(
        "!!!!! MANUAL RESUME NEEDED !!!!!\n  run failed at stage '{stage}': {err}\n  state saved to {} — run `backup-mgr status` to inspect.\n  Resolve the cause, then run `backup-mgr reset` to allow automatic scheduling again.",
        state_file.display()
    ));
    Err(err.to_string())
}

// ---------------------------------------------------------------------------
// scheduling
// ---------------------------------------------------------------------------

fn parse_minute(s: &str) -> Option<u32> {
    scheduler::parse_time(s)
}

fn full_minutes(cfg: &Config) -> Vec<u32> {
    scheduler::schedule_minutes(&cfg.inner.backup.time, cfg.inner.backup.backups_per_day)
}

fn world_minutes(cfg: &Config) -> Vec<u32> {
    if !cfg.inner.world_backup.enabled {
        return Vec::new();
    }
    cfg.inner
        .world_backup
        .times
        .iter()
        .filter_map(|t| parse_minute(t))
        .collect()
}

fn combined_minutes(cfg: &Config) -> Vec<u32> {
    let mut v = full_minutes(cfg);
    v.extend(world_minutes(cfg));
    v.sort_unstable();
    v.dedup();
    v
}

fn kind_for_minute(cfg: &Config, minute: u32) -> Kind {
    if world_minutes(cfg).contains(&minute) {
        Kind::World
    } else {
        Kind::Full
    }
}

fn fmt_minute(m: u32) -> String {
    format!("{:02}:{:02}", m / 60, m % 60)
}

fn daemon(cfg: &Config, logger: &Logger) -> Result<(), String> {
    let tz = resolve_tz(cfg);
    let state_file = cfg.resolve(&cfg.inner.state.file);
    let combined = combined_minutes(cfg);

    logger.info(&format!(
        "backup-mgr daemon started (timezone {}, run times: {})",
        tz,
        combined.iter().map(|&m| fmt_minute(m)).collect::<Vec<_>>().join(", ")
    ));

    let mut manual_resume_notified = false;

    loop {
        let st = RunState::load(&state_file);

        if st.requires_manual_resume && !cfg.inner.run.continue_after_manual_resume {
            if !manual_resume_notified {
                notify::send(
                    &cfg.inner.notifications.discord_webhook,
                    logger,
                    &notif_ctx(cfg),
                    &notify::Event::ManualResume {
                        stage: st.stage.clone(),
                        reason: if st.last_error.is_empty() {
                            "unknown error".into()
                        } else {
                            st.last_error.clone()
                        },
                    },
                );
                manual_resume_notified = true;
            }
            logger.error(&format!(
                "MANUAL RESUME NEEDED — previous run failed at stage '{}'. Backups are paused.\n  Inspect the logs, fix the cause, then run `backup-mgr reset` (or set run.continue_after_manual_resume: true).",
                st.stage
            ));
            thread::sleep(Duration::from_secs(cfg.inner.run.check_state_seconds.max(10)));
            continue;
        }
        manual_resume_notified = false;

        let now = Utc::now().with_timezone(&tz);
        let last_success = st
            .last_run_at
            .as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&tz));

        if cfg.inner.backup.catch_up_on_start {
            let win = cfg.inner.backup.catch_up_window_minutes;
            if scheduler::should_catch_up(now, &combined, win, last_success.as_ref()) {
                let kind = kind_for_minute(
                    cfg,
                    scheduler::last_passed(now, &combined).map(|d| d.hour() * 60 + d.minute()).unwrap_or(0),
                );
                logger.info(&format!(
                    "missed a scheduled slot recently ({}) — running catch-up backup now",
                    kind.label()
                ));
                let opts = RunOpts { kind, upload: true, keep_local: false, ptero: true, dry_run: false };
                if let Err(e) = run_backup(cfg, logger, &state_file, &opts, false) {
                    logger.error(&format!("catch-up backup failed: {e}"));
                }
                thread::sleep(Duration::from_secs(5));
                continue;
            }
        }

        let next = scheduler::next_run(now, &combined);
        let wait_ms = ((next - now).num_milliseconds().max(1000)) as u64;
        logger.info(&format!(
            "next scheduled backup ({}) at {} (in {:?})",
            kind_for_minute(cfg, next.hour() * 60 + next.minute()).label(),
            next.format("%Y-%m-%d %H:%M:%S %Z"),
            chrono::TimeDelta::milliseconds(wait_ms as i64)
        ));

        let step = (cfg.inner.run.check_state_seconds.max(5) * 1000) as u64;
        let mut slept: u64 = 0;
        while slept < wait_ms {
            thread::sleep(Duration::from_millis(step.min(wait_ms - slept)));
            slept += step.min(wait_ms - slept);
        }

        let fired = Utc::now().with_timezone(&tz);
        let fired_min = fired.hour() * 60 + fired.minute();
        let kind = kind_for_minute(cfg, fired_min);
        let opts = RunOpts { kind, upload: true, keep_local: false, ptero: true, dry_run: false };
        if let Err(e) = run_backup(cfg, logger, &state_file, &opts, false) {
            logger.error(&format!("scheduled backup failed: {e}"));
        }
    }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

fn cmd_remote_auth(cfg: &Config, cfg_path: &Path, logger: &Logger) -> Result<(), String> {
    for (idx, r) in drive::active_remotes(cfg).into_iter().enumerate() {
        drive::ensure_remote_section(&r, logger)?;
        let conf = std::env::var("RCLONE_CONFIG").unwrap_or_else(|_| {
            let home = env::var("HOME").unwrap_or_else(|_| "/root".into());
            format!("{}/.config/rclone/rclone.conf", home)
        });
        println!(
            "Running interactive rclone browser-based authentication for remote '{}:'...\nConfig file: {}\nIf this machine has no browser, open the shown URL on any device and paste the token back here.",
            r.remote, conf
        );
        let status = Command::new("rclone")
            .args(["config", "reconnect", &format!("{}:", r.remote)])
            .env("RCLONE_CONFIG", &conf)
            .status()
            .map_err(|e| format!("failed to run rclone: {e}"))?;
        if !status.success() {
            return Err(format!("rclone config reconnect exited with {:?}", status.code()));
        }
        logger.info(&format!("rclone remote '{}:' authenticated", r.remote));

        // Persist the freshly-issued token back into config.yml so the next
        // run does not clobber rclone.conf with the previous (revoked) token.
        // Only drive remotes carry the JSON token we can round-trip; others
        // (e.g. b2) have no token section, so skip them gracefully.
        match drive::read_config_token(&r) {
            Ok(creds) if !creds.refresh_token.trim().is_empty() => {
                match idx {
                    0 => config::update_remote_token_fields(cfg_path, "google_drive", 0, &creds.refresh_token, &creds.access_token, &creds.expiry)?,
                    _ => config::update_remote_token_fields(cfg_path, "secondary", 2, &creds.refresh_token, &creds.access_token, &creds.expiry)?,
                }
                logger.info("saved refreshed OAuth token back to config.yml");
            }
            Ok(_) => logger.debug(&format!("{}: no OAuth token in rclone config, nothing to save to config.yml", r.remote)),
            Err(e) => logger.warn(&format!("could not read back token for '{}': {e}", r.remote)),
        }
    }
    Ok(())
}

fn cmd_status(cfg: &Config, logger: &Logger, limit: Option<usize>) -> Result<(), String> {
    let state_file = cfg.resolve(&cfg.inner.state.file);
    let st = RunState::load(&state_file);
    println!("=== backup-mgr status ===");
    println!("{}", st.describe());
    println!("config backup path: {}", cfg.inner.backup.path);
    println!("local backup dir:  {}", cfg.resolve(&cfg.inner.backup.dir).display());
    println!("log dir:           {}", cfg.resolve(&cfg.inner.logging.dir).display());
    let remotes = drive::active_remotes(cfg);
    for r in remotes {
        println!("remote:            {} (retention {})", r.label(), r.retention);
    }
    if !st.requires_manual_resume {
        logger.info("no manual resume required");
    }
    if let Some(n) = limit {
        println!();
        print_history_rows(n)?;
    }
    Ok(())
}

/// Machine-readable status for the web panel.
fn cmd_status_json(cfg: &Config) -> Result<(), String> {
    let state_file = cfg.resolve(&cfg.inner.state.file);
    let st = RunState::load(&state_file);
    let tz = resolve_tz(cfg);
    let combined = combined_minutes(cfg);
    let now_local = Utc::now().with_timezone(&tz);
    let next = scheduler::next_run(now_local, &combined);
    let next_secs = (next - now_local).num_seconds().max(0);
    let remotes: Vec<serde_json::Value> = drive::active_remotes(cfg)
        .iter()
        .map(|r| {
            serde_json::json!({
                "label": r.label(),
                "remote": r.remote,
                "dir": r.dir,
                "retention": r.retention,
            })
        })
        .collect();
    let b = &cfg.inner.backup;
    let out = serde_json::json!({
        "build": build_json(),
        "state": {
            "stage": st.stage,
            "status": st.status,
            "current_backup": st.current_backup,
            "started_at": st.started_at,
            "finished_at": st.finished_at,
            "last_error": st.last_error,
            "requires_manual_resume": st.requires_manual_resume,
            "last_run_at": st.last_run_at,
            "generation": st.generation,
        },
        "config": {
            "backup_path": cfg.resolve(&b.path).to_string_lossy(),
            "backup_dir": cfg.resolve(&b.dir).to_string_lossy(),
            "log_dir": cfg.resolve(&cfg.inner.logging.dir).to_string_lossy(),
            "compression": b.compression,
            "time": b.time,
            "backups_per_day": b.backups_per_day,
            "timezone": cfg.inner.timezone,
            "encrypt_enabled": cfg.inner.encrypt.enabled,
            "upload_to_all": cfg.inner.storage.upload_to_all,
            "max_local_backups": b.max_local_backups,
            "min_free_disk_gb": b.min_free_disk_gb,
        },
        "remotes": remotes,
        "next_run_at": next.to_rfc3339(),
        "next_run_local": next.format("%Y-%m-%d %H:%M:%S %Z").to_string(),
        "next_run_seconds": next_secs,
    });
    println!(
        "{}",
        serde_json::to_string(&out).map_err(|e| e.to_string())?
    );
    Ok(())
}

/// Apply the ACL / permission setup for `user` so non-root backups can read the
/// source directory. Reuses scripts/grant-access.sh.
fn cmd_fix_perms(cfg: &Config, logger: &Logger, user: Option<String>) -> Result<(), String> {
    let user = user
        .or_else(perms::current_user)
        .ok_or_else(|| "cannot determine the user; pass --user <name>".to_string())?;
    perms::ensure_access(cfg, &user, logger)?;
    println!(
        "permissions verified for {} on {}",
        user,
        perms::source_dir(cfg).display()
    );
    Ok(())
}

fn cmd_reset(cfg: &Config) -> Result<(), String> {
    let state_file = cfg.resolve(&cfg.inner.state.file);
    RunState::reset(&state_file)?;
    println!("state reset -> idle/ok");
    Ok(())
}

fn remote_dir_names(cfg: &Config) -> Vec<String> {
    let mut names = Vec::new();
    for r in drive::active_remotes(cfg) {
        if let Ok(files) = drive::list_backups(&r) {
            for f in files {
                if !f.IsDir {
                    names.push(format!("{}  (on {})", f.Name, r.label()));
                }
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(cfg.resolve(&cfg.inner.backup.dir)) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_file() {
                names.push(format!("{}  (local {})", p.file_name().unwrap_or_default().to_string_lossy(), cfg.inner.backup.dir));
            }
        }
    }
    names.sort();
    names
}

/// Machine-readable list of available archives (remotes + local staging).
fn cmd_restore_list_json(cfg: &Config) -> Result<(), String> {
    let mut items: Vec<serde_json::Value> = Vec::new();
    for r in drive::active_remotes(cfg) {
        if let Ok(files) = drive::list_backups(&r) {
            for f in files {
                if !f.IsDir {
                    items.push(serde_json::json!({
                        "name": f.Name,
                        "source": r.label(),
                        "size": f.Size,
                        "modified": f.ModTime,
                    }));
                }
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(cfg.resolve(&cfg.inner.backup.dir)) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_file() {
                items.push(serde_json::json!({
                    "name": p.file_name().unwrap_or_default().to_string_lossy(),
                    "source": "local",
                    "size": std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0),
                }));
            }
        }
    }
    items.sort_by(|a, b| {
        let an = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let bn = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
        an.cmp(bn)
    });
    println!(
        "{}",
        serde_json::to_string(&items).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn cmd_restore(cfg: &Config, logger: &Logger, args: &[String]) -> Result<(), String> {
    let enc_cfg = &cfg.inner.encrypt;
    if enc_cfg.enabled && enc_cfg.passphrase.trim().is_empty() {
        return Err("this config has encrypt.enabled with an empty passphrase — restore of encrypted backups is impossible".into());
    }

    let force = args.iter().any(|a| a == "--force" || a == "--yes");
    let positional: Vec<&String> = args.iter().filter(|a| !a.starts_with('-')).collect();

    if positional.is_empty() {
        println!("=== Available backups ===");
        let names = remote_dir_names(cfg);
        if names.is_empty() {
            println!("(none found on remotes or locally)");
        }
        for n in names {
            println!("  {}", n);
        }
        println!("\nUsage: backup-mgr restore <filename> [target-dir] [--force]");
        return Ok(());
    }

    let file: &str = positional[0].as_str();
    let default_target = cfg.resolve(&cfg.inner.backup.dir).join("restore");
    let target_str = positional
        .get(1)
        .map(|s| s.to_string())
        .unwrap_or_else(|| default_target.to_string_lossy().to_string());
    let target = cfg.resolve(&target_str);

    if let Err(e) = cmd_restore_do(cfg, logger, file, &target, force) {
        // failed restore attempt
        let size = std::fs::metadata(target.join(file)).map(|m| m.len()).unwrap_or(0);
        notify::send(
            &cfg.inner.notifications.discord_webhook,
            logger,
            &notif_ctx(cfg),
            &notify::Event::RestoreFailure { name: file.to_string(), reason: e.clone() },
        );
        if let Some(d) = db() {
            let _ = d.record_run(&Utc::now().to_rfc3339(), "restore", file, Some(size as i64), None, "-", "failed", &e);
        }
        return Err(e);
    }

    let restored = target.join(file);
    let size = std::fs::metadata(&restored).map(|m| m.len()).unwrap_or(0);
    notify::send(
        &cfg.inner.notifications.discord_webhook,
        logger,
        &notif_ctx(cfg),
        &notify::Event::RestoreSuccess { name: file.to_string(), size, target: target.display().to_string() },
    );
    if let Some(d) = db() {
        let _ = d.record_run(&Utc::now().to_rfc3339(), "restore", file, Some(size as i64), None, "-", "ok", "");
    }
    logger.info(&format!("restore OK: {} -> {}", file, target.display()));
    Ok(())
}

/// Integrity gate for restore. Compares an observed MD5 against the manifest.
///
/// * `Ok(true)`  – hashes match, proceed normally.
/// * `Ok(false)` – hashes differ but `force` was given, proceed under protest.
/// * `Err(..)`   – hashes differ and no override, the restore must abort.
///
/// Kept as a pure function so the restore safety rule is unit-testable without
/// a live remote or rclone.
fn restore_hash_gate(
    file: &str,
    stage: &str,
    expected_md5: &str,
    actual_md5: &str,
    force: bool,
) -> Result<bool, String> {
    if expected_md5 == actual_md5 {
        return Ok(true);
    }
    if force {
        return Ok(false);
    }
    Err(format!(
        "refusing to restore {file}: integrity mismatch at {stage} \
         (observed md5 {actual_md5} != manifest md5 {expected_md5}). \
         Restore an older intact archive instead, or pass --force to override."
    ))
}

fn cmd_restore_do(cfg: &Config, logger: &Logger, file: &str, target: &Path, force: bool) -> Result<(), String> {
    // find the file on a remote
    let mut chosen: Option<Remote> = None;
    for r in drive::active_remotes(cfg) {
        if let Ok(files) = drive::list_backups(&r) {
            if files.iter().any(|f| f.Name == file) {
                chosen = Some(r.clone());
                break;
            }
        }
    }
    if chosen.is_none() {
        return Err(format!("backup '{}' not found on any configured remote (run `backup-mgr restore` to list)", file));
    }
    let r = chosen.unwrap();
    std::fs::create_dir_all(target).map_err(|e| e.to_string())?;

    // Verify against the manifest before downloading. A mismatch means the
    // remote copy differs from what was recorded at upload time, so abort
    // instead of restoring a possibly corrupt/tampered archive.
    if let Some(d) = db() {
        if let Some(m) = d.manifest(file) {
            match drive::remote_md5(&r, file) {
                Ok(remote_hash) => {
                    match restore_hash_gate(file, "remote pre-check", &m.md5, &remote_hash, force) {
                        Ok(true) => logger.info(&format!("integrity pre-check passed for {} (md5 matches manifest)", file)),
                        Ok(false) => logger.warn(&format!(
                            "--force specified: skipping integrity pre-check for {} (remote md5 {} != manifest md5 {})",
                            file, remote_hash, m.md5
                        )),
                        Err(e) => return Err(e),
                    }
                }
                Err(e) => {
                    logger.warn(&format!(
                        "could not read remote hash for {} ({e}); will verify the downloaded file instead",
                        file
                    ));
                }
            }
        }
    }

    let staging = cfg.resolve(&cfg.inner.backup.dir).join(".restore");
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let raw = staging.join(file);
    drive::download_file(&r, file, &raw, logger)?;

    // Verify the bytes we actually downloaded against the recorded manifest
    // hash before touching the plaintext/extraction path.
    if let Some(m) = db().and_then(|d| d.manifest(file)) {
        match drive::local_md5(&raw) {
            Ok(local_hash) => {
                match restore_hash_gate(file, "downloaded file", &m.md5, &local_hash, force) {
                    Ok(true) => logger.info(&format!("integrity check passed for downloaded {} (md5 matches manifest)", file)),
                    Ok(false) => logger.warn(&format!(
                        "--force specified: extracting {} despite integrity mismatch (local md5 {} != manifest md5 {})",
                        file, local_hash, m.md5
                    )),
                    Err(e) => {
                        let _ = std::fs::remove_file(&raw);
                        return Err(e);
                    }
                }
            }
            Err(e) => {
                logger.warn(&format!(
                    "could not verify downloaded {} ({e}); continuing without local hash confirmation",
                    file
                ));
            }
        }
    }

    let mut plain = raw.clone();
    if file.ends_with(".gpg") {
        let base = file.trim_end_matches(".gpg");
        plain = staging.join(base);
        backup::decrypt_gpg(&raw, &enc_passphrase(cfg), &plain, logger)?;
    }

    let name = plain.file_name().unwrap_or_default().to_string_lossy().to_string();
    let out = extract_archive(&plain, &name, target, logger)?;
    let _ = std::fs::remove_file(&raw);
    if plain != raw {
        let _ = std::fs::remove_file(&plain);
    }
    logger.info(&format!("extracted {} -> {}", name, target.display()));
    let _ = out;
    Ok(())
}

fn enc_passphrase(cfg: &Config) -> String {
    cfg.inner.encrypt.passphrase.trim().to_string()
}

fn extract_archive(archive: &Path, name: &str, target: &Path, logger: &Logger) -> Result<(), String> {
    logger.info(&format!("extracting {} into {}", name, target.display()));
    let mut cmd = if name.ends_with(".zip") {
        let mut c = Command::new("unzip");
        c.args(["-q", "-o"]);
        c
    } else {
        let mut c = Command::new("tar");
        if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
            c.arg("-xzf");
        } else if name.ends_with(".tar.zst") {
            c.arg("--zstd").arg("-xf");
        } else if name.ends_with(".tar.xz") {
            c.arg("-xJf");
        } else if name.ends_with(".tar.bz2") {
            c.arg("-xjf");
        } else {
            c.arg("-xf");
        }
        c
    };
    cmd.arg(archive);
    if name.ends_with(".tar") || name.ends_with(".tar.gz") || name.ends_with(".tar.zst")
        || name.ends_with(".tar.xz") || name.ends_with(".tar.bz2") {
        cmd.arg("-C").arg(target);
    } else {
        cmd.current_dir(target);
    }
    let out = cmd.output().map_err(|e| format!("cannot spawn extractor: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "extraction failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

fn cmd_check(cfg: &Config, logger: &Logger, file: Option<&str>) -> Result<(), String> {
    let mut checked = 0usize;
    let mut failed = 0usize;
    let mut failures: Vec<String> = Vec::new();

    for r in drive::active_remotes(cfg) {
        let files = match drive::list_backups(&r) {
            Ok(f) => f,
            Err(e) => {
                logger.warn(&format!("skipping {}: {}", r.label(), e));
                continue;
            }
        };
        let hashes = drive::remote_hash_map(&r)?;
        let mut candidates: Vec<String> = files.iter().filter(|f| !f.IsDir).map(|f| f.Name.clone()).collect();
        if let Some(f) = file {
            candidates.retain(|n| n == f);
        }
        for name in candidates {
            let Some(m) = db().and_then(|d| d.manifest(&name)) else {
                logger.debug(&format!("{}: no manifest record, skipping integrity check", name));
                continue;
            };
            match hashes.get(&name) {
                Some(remote_hash) => {
                    if *remote_hash == m.md5 {
                        checked += 1;
                        logger.info(&format!("OK {} ({} on {})", name, remote_hash, r.label()));
                    } else {
                        failed += 1;
                        failures.push(format!("{} on {}: remote {} != manifest {}", name, r.label(), remote_hash, m.md5));
                        logger.error(&format!("MISMATCH {}", failures.last().unwrap()));
                    }
                }
                None => {
                    logger.warn(&format!("{}: remote file not present anymore but manifest exists", name));
                    failed += 1;
                    failures.push(format!("{} on {}: missing on remote", name, r.label()));
                }
            }
        }
    }

    if failed > 0 {
        notify::send(
            &cfg.inner.notifications.discord_webhook,
            logger,
            &notif_ctx(cfg),
            &notify::Event::CheckFailure { reason: failures.join("; ") },
        );
        return Err(format!("integrity check finished with {failed} failure(s) out of {} checked + failed", checked));
    }
    if checked == 0 {
        logger.warn("integrity check found no manifest records on any remote (run a backup first, then re-run check)");
    }
    notify::send(
        &cfg.inner.notifications.discord_webhook,
        logger,
        &notif_ctx(cfg),
        &notify::Event::CheckSuccess { checked, failed },
    );
    logger.info(&format!("integrity check OK: {} backups verified", checked));
    Ok(())
}

fn cmd_history(_cfg: &Config, limit: usize) -> Result<(), String> {
    println!("=== backup-mgr history (last {}) ===", limit);
    print_history_rows(limit)
}

fn print_history_rows(limit: usize) -> Result<(), String> {
    let Some(d) = db() else {
        return Err("database unavailable".into());
    };
    let rows = d.history(limit);
    if rows.is_empty() {
        println!("(no history recorded yet)");
        return Ok(());
    }
    println!(
        "{:<4} {:<24} {:<8} {:<30} {:<10} {:<9} {:<20} {:<8} {}",
        "id", "run_at", "kind", "name", "size", "dur(ms)", "remote", "status", "error"
    );
    for r in rows {
        let sz = r.size_bytes.map(|b| crate::backup::human_size(b.max(0) as u64)).unwrap_or_else(|| "-".into());
        let dur = r.duration_ms.map(|d| d.to_string()).unwrap_or_else(|| "-".into());
        let err = if r.error.is_empty() { "-".into() } else { r.error.chars().take(40).collect::<String>() };
        println!(
            "{:<4} {:<24} {:<8} {:<30} {:<10} {:<9} {:<20} {:<8} {}",
            r.id, r.run_at, r.kind, r.name, sz, dur, r.remote, r.status, err
        );
    }
    Ok(())
}

fn ensure_config(path: &Path, logger: &Logger) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    let vol = detect_server_volume();
    config::save_default_config(path, vol.as_deref().unwrap_or("/path/to/your/data"))?;
    logger.info(&format!(
        "generated default config at {} — review it (prefix, path, compression, drive remote, timezone) and restart the process.",
        path.display()
    ));
    Ok(())
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let mut cfg_path = default_config_path();
    let mut cmd = String::new();
    let mut rest: Vec<String> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        let a = &args[i];
        match a.as_str() {
            "--config" => match args.get(i + 1) {
                Some(v) => {
                    cfg_path = PathBuf::from(v);
                    i += 1;
                }
                None => {
                    eprintln!("FATAL: --config requires a path argument");
                    std::process::exit(1);
                }
            },
            _ => {
                if cmd.is_empty() {
                    cmd = a.clone();
                } else {
                    rest.push(a.clone());
                }
            }
        }
        i += 1;
    }

    // `version` / `--help` must work before (and without) a config file: they
    // must not create config.yml as a side effect, nor fail when it is absent.
    match cmd.as_str() {
        "--version" | "-V" | "version" => {
            let json = rest.iter().any(|r| r == "--json");
            match cmd_version(json) {
                Ok(()) => std::process::exit(0),
                Err(e) => {
                    eprintln!("FATAL: {e}");
                    std::process::exit(1);
                }
            }
        }
        "--help" | "-h" | "help" => {
            println!("{USAGE}");
            std::process::exit(0);
        }
        _ => {}
    }

    let cfg = match (|| -> Result<Config, String> {
        // Per-user bootstrap log dir (e.g. /tmp/backup-mgr-alice) so the
        // pre-config phase never collides with another user's files.
        let tmp_dir = std::env::temp_dir().join(format!(
            "backup-mgr-{}",
            std::env::var("USER").unwrap_or_else(|_| "unknown".into())
        ));
        let tmp = Logger::new(&tmp_dir.to_string_lossy(), "error", 1).unwrap();
        ensure_config(&cfg_path, &tmp)?;
        Config::load(&cfg_path)
    })() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("FATAL: {e}");
            std::process::exit(1);
        }
    };

    let log_dir = cfg.resolve(&cfg.inner.logging.dir).to_string_lossy().to_string();
    let logger = match Logger::new(&log_dir, &cfg.inner.logging.level, cfg.inner.logging.keep_days) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("FATAL: cannot init logger: {e}");
            std::process::exit(1);
        }
    };
    std::fs::create_dir_all(cfg.resolve(&cfg.inner.backup.dir)).ok();
    if let Some(parent) = cfg.resolve(&cfg.inner.state.file).parent() {
        std::fs::create_dir_all(parent).ok();
    }

    // metrics endpoint
    if cfg.inner.metrics.enabled {
        let m = METRICS.get_or_init(metrics::Metrics::new);
        m.serve(&cfg.inner.metrics.host, cfg.inner.metrics.port, &logger, cmd == "daemon");
    }

    // sqlite history
    let db_path = cfg.resolve(&cfg.inner.database.file);
    match db::Db::open(&db_path) {
        Ok(d) => {
            let _ = DB.set(Some(Arc::new(d)));
            logger.debug(&format!("sqlite history: {}", db_path.display()));
        }
        Err(e) => {
            logger.error(&format!("cannot open sqlite database ({}): {e}", db_path.display()));
            logger.error("continuing WITHOUT history/integrity manifest — fix the database.file path");
            let _ = DB.set(None);
        }
    }

    let state_file = cfg.resolve(&cfg.inner.state.file);

    let result: Result<(), String> = match cmd.as_str() {
        "" | "daemon" => daemon(&cfg, &logger),
        "run" => {
            let no_upload = rest.iter().any(|r| r == "--no-upload");
            let keep_local = rest.iter().any(|r| r == "--keep-local");
            let no_ptero = rest.iter().any(|r| r == "--no-ptero");
            let force = rest.iter().any(|r| r == "--force");
            let dry_run = rest.iter().any(|r| r == "--dry-run");
            let world = rest.iter().any(|r| r == "--world");
            match run_backup(
                &cfg,
                &logger,
                &state_file,
                &RunOpts {
                    kind: if world { Kind::World } else { Kind::Full },
                    upload: !no_upload && !dry_run,
                    keep_local,
                    ptero: !no_ptero,
                    dry_run,
                },
                force,
            ) {
                Ok(()) => {
                    logger.info("one-shot run completed");
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        "test-compress" => run_backup(
            &cfg,
            &logger,
            &state_file,
            &RunOpts { kind: Kind::Full, upload: false, keep_local: true, ptero: false, dry_run: false },
            true,
        ),
        "restore" => {
            if rest.iter().any(|r| r == "--json") {
                cmd_restore_list_json(&cfg)
            } else {
                cmd_restore(&cfg, &logger, &rest)
            }
        }
        "check" => {
            let file = rest.iter().find(|a| !a.starts_with('-')).map(String::as_str);
            cmd_check(&cfg, &logger, file)
        }
        "history" => {
            let n = rest
                .iter()
                .find(|a| !a.starts_with('-'))
                .and_then(|a| a.parse::<usize>().ok())
                .unwrap_or(20);
            cmd_history(&cfg, n)
        }
        "remote-auth" => cmd_remote_auth(&cfg, &cfg_path, &logger),
        "status" => {
            if rest.iter().any(|r| r == "--json") {
                cmd_status_json(&cfg)
            } else {
                let n = rest.iter().find(|a| !a.starts_with('-')).and_then(|a| a.parse::<usize>().ok());
                cmd_status(&cfg, &logger, n)
            }
        }
        "fix-perms" => {
            let user = rest
                .iter()
                .position(|a| a == "--user")
                .and_then(|i| rest.get(i + 1))
                .cloned();
            cmd_fix_perms(&cfg, &logger, user)
        }
        "reset" => cmd_reset(&cfg),
        _ => Err(format!("unknown command '{}'.\n{USAGE}", cmd)),
    };

    match result {
        Ok(()) => {}
        Err(e) => {
            logger.log(Level::Error, &e);
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::restore_hash_gate;

    #[test]
    fn restore_gate_passes_on_matching_hash() {
        assert_eq!(
            restore_hash_gate("b.tar.gz", "remote pre-check", "abc", "abc", false),
            Ok(true)
        );
    }

    #[test]
    fn restore_gate_aborts_on_mismatch_without_force() {
        let r = restore_hash_gate("b.tar.gz", "remote pre-check", "abc", "def", false);
        assert!(r.is_err(), "mismatch without --force must abort");
        assert!(r.unwrap_err().contains("integrity mismatch"));
    }

    #[test]
    fn restore_gate_force_overrides_mismatch() {
        assert_eq!(
            restore_hash_gate("b.tar.gz", "downloaded file", "abc", "def", true),
            Ok(false)
        );
    }
}