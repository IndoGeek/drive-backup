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
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use crate::config::Config;
use crate::drive::Remote;
use crate::logger::{Level, Logger};
use crate::state::RunState;

const LOCK_NAME: &str = ".run.lock";

const RESTORE_STAGE_DIR: &str = ".backup-mgr-restore";

const BUILD_VERSION: &str = env!("CARGO_PKG_VERSION");
const BUILD_COMMIT: &str = env!("BUILD_GIT_COMMIT");
const BUILD_TIMESTAMP: &str = env!("BUILD_TIMESTAMP");

const USAGE: &str = "Usage:\n  backup-mgr [daemon]\n  backup-mgr run [--world] [--no-upload|--keep-local|--no-ptero|--dry-run|--force]\n  backup-mgr test-compress\n  backup-mgr restore [<file> [target-dir]] [--force] [--merge]\n  backup-mgr restore --json\n  backup-mgr check [file]\n  backup-mgr history [N]\n  backup-mgr remote-auth\n  backup-mgr status [--json]\n  backup-mgr fix-perms [--user <name>]\n  backup-mgr version [--json]\n  backup-mgr reset\n  [--config <path>]";

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
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

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

fn write_lock_pid(lock: &Path) -> Result<(), String> {
    std::fs::write(lock.join("pid"), std::process::id().to_string())
        .map_err(|e| format!("cannot write lock pid: {e}"))
}

fn acquire_lock(state_dir: &Path, logger: &Logger) -> Result<LockGuard, String> {
    std::fs::create_dir_all(state_dir).map_err(|e| e.to_string())?;
    let lock = state_dir.join(LOCK_NAME);
    match std::fs::create_dir(&lock) {
        Ok(_) => {
            write_lock_pid(&lock)?;
            Ok(LockGuard(lock))
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            if let Ok(meta) = std::fs::metadata(&lock) {
                if let Ok(modified) = meta.modified() {
                    if let Ok(age) = modified.elapsed() {
                        if age > Duration::from_secs(6 * 3600) {
                            let _ = std::fs::remove_dir_all(&lock);
                            std::fs::create_dir(&lock).map_err(|e| e.to_string())?;
                            write_lock_pid(&lock)?;
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
    let level: Option<u32> = b.compression_level.map(|v| v.clamp(0, 9) as u32);
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

    let est_root = match sub_dir {
        Some(s) => src.join(s),
        None => src.clone(),
    };

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

    if !opts.dry_run {
        st.stage = "compressing".into();
        st.save(state_file)?;
    }
    if let Err(e) = backup::compress_dir(&src, sub_dir, &base_dst, &compression, level, &b.exclude_patterns, logger) {
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

    if !opts.upload {
        if opts.keep_local {
            logger.info("--keep-local: skipping local prune (all archives kept on disk)");
        } else {
            backup::prune_local(&local_dir, prefix, b.max_local_backups, logger);
        }
        st.mark_ok(Utc::now().to_rfc3339());
        st.save(state_file)?;
        logger.info(if opts.keep_local {
            "RUN FINISHED (local-only mode, archive kept for inspection)"
        } else {
            "RUN FINISHED (local-only mode; upload skipped)"
        });
        return Ok(());
    }

    st.stage = "uploading".into();
    st.progress = None;
    st.save(state_file)?;

    let md5_opt = drive::local_md5(&artifact).ok();
    if md5_opt.is_none() {
        logger.warn("could not compute local MD5 for manifest; integrity check will be limited");
    }

    let remotes: Vec<Remote> = drive::active_remotes(cfg);
    let upload_to_all = cfg.inner.storage.upload_to_all;
    let mut uploaded = Vec::new();
    let mut ok_remotes: Vec<&Remote> = Vec::new();
    let mut fallback_warn: Option<String> = None;
    let mut errors: Vec<String> = Vec::new();

    let try_upload = |r: &Remote, logger: &Logger, progress: Option<&mut dyn FnMut(f64)>| -> Result<(), String> {
        drive::ensure_remote_section(r, logger)?;
        if let Err(e) = drive::check_remote(r) {
            return Err(format!(
                "Google Drive auth/access failed on {}: {e} (run `backup-mgr remote-auth` or add refresh_token)",
                r.label()
            ));
        }
        drive::upload_file(r, &artifact, logger, progress)
    };

    if upload_to_all && !remotes.is_empty() {
        for r in &remotes {
            let mut prog = |p: f64| {
                st.set_progress(p);
                let _ = st.save(state_file);
            };
            match try_upload(r, logger, Some(&mut prog)) {
                Ok(()) => {
                    uploaded.push(r.label());
                    ok_remotes.push(r);
                    if let Some(h) = &md5_opt {
                        if let Some(d) = db() {
                            let _ = d.upsert_manifest(&artifact_name, upload_size as i64, h, &r.label(), &Utc::now().to_rfc3339(), stage_label);
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
            let mut prog = |p: f64| {
                st.set_progress(p);
                let _ = st.save(state_file);
            };
            match try_upload(r, logger, Some(&mut prog)) {
                Ok(()) => {
                    uploaded.push(r.label());
                    ok_remotes.push(r);
                    if idx > 0 {
                        fallback_warn = Some(r.label());
                    }
                    if let Some(h) = &md5_opt {
                        if let Some(d) = db() {
                            let _ = d.upsert_manifest(&artifact_name, upload_size as i64, h, &r.label(), &Utc::now().to_rfc3339(), stage_label);
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

    if !ok_remotes.is_empty() {
        st.stage = "pruning".into();
        st.progress = None;
        st.save(state_file)?;
        for r in &ok_remotes {
            if let Ok(pruned) = drive::prune_remote(r, prefix, r.retention, logger) {
                if !pruned.is_empty() {
                    if let Some(d) = db() {
                        let _ = d.prune_manifest_removed(&pruned);
                    }
                }
            }
        }
    }

    st.stage = "cleanup".into();
    st.progress = None;
    st.save(state_file)?;
    if opts.keep_local {
        logger.info("--keep-local: skipping local prune (all archives kept on disk)");
    } else {
        backup::prune_local(&local_dir, prefix, b.max_local_backups, logger);
    }

    if let Some(g) = server_guard.as_mut() {
        g.restart_now();
    }

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

fn parse_minute(s: &str) -> Option<u32> {
    scheduler::parse_time(s)
}

fn full_minutes(cfg: &Config) -> Vec<u32> {
    schedule_for(
        &cfg.inner.backup.times,
        &cfg.inner.backup.time,
        cfg.inner.backup.backups_per_day,
    )
}

fn schedule_for(times: &[String], time: &str, per_day: u32) -> Vec<u32> {
    let explicit: Vec<u32> = times
        .iter()
        .filter_map(|t| scheduler::parse_time(t))
        .collect();
    if !explicit.is_empty() {
        let mut v = explicit;
        v.sort_unstable();
        v.dedup();
        return v;
    }
    scheduler::schedule_minutes(time, per_day)
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

fn run_lock_info(state_dir: &Path) -> serde_json::Value {
    let lock = state_dir.join(LOCK_NAME);
    let present = lock.is_dir();
    let age_seconds = if present {
        std::fs::metadata(&lock)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.elapsed().ok())
            .map(|d| d.as_secs() as i64)
    } else {
        None
    };
    let pid = if present {
        std::fs::read_to_string(lock.join("pid"))
            .ok()
            .and_then(|s| s.trim().parse::<i64>().ok())
    } else {
        None
    };
    let pid_alive = pid.map(|p| std::path::Path::new(&format!("/proc/{p}")).exists());
    serde_json::json!({
        "present": present,
        "age_seconds": age_seconds,
        "pid": pid,
        "pid_alive": pid_alive,
    })
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
            "progress": st.progress,
        },
        "config": {
            "backup_path": cfg.resolve(&b.path).to_string_lossy(),
            "backup_dir": cfg.resolve(&b.dir).to_string_lossy(),
            "log_dir": cfg.resolve(&cfg.inner.logging.dir).to_string_lossy(),
            "compression": b.compression,
            "compression_level": b.compression_level,
            "time": b.time,
            "backups_per_day": b.backups_per_day,

            "times": b.times,
            "schedule": full_minutes(cfg).iter().map(|&m| fmt_minute(m)).collect::<Vec<_>>(),
            "timezone": cfg.inner.timezone,
            "encrypt_enabled": cfg.inner.encrypt.enabled,
            "upload_to_all": cfg.inner.storage.upload_to_all,
            "max_local_backups": b.max_local_backups,
            "min_free_disk_gb": b.min_free_disk_gb,
        },
        "remotes": remotes,
        "run_lock": run_lock_info(&state_file.parent().map(Path::to_path_buf).unwrap_or_default()),
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
    let state_dir = state_file.parent().map(Path::to_path_buf).unwrap_or_default();
    RunState::reset(&state_file)?;
    let lock = state_dir.join(LOCK_NAME);
    if lock.is_dir() {
        match std::fs::remove_dir_all(&lock) {
            Ok(_) => println!("cleared stale run lock: {}", lock.display()),
            Err(e) => println!("could not clear run lock {}: {}", lock.display(), e),
        }
    }
    println!("state reset -> idle/ok");
    Ok(())
}

fn is_partial_archive(name: &str) -> bool {
    name.ends_with(".tmp") || name.ends_with(".part")
}

fn remote_dir_names(cfg: &Config) -> Vec<String> {
    let mut names = Vec::new();
    for r in drive::active_remotes(cfg) {
        if let Ok(files) = drive::list_backups(&r) {
            for f in files {
                if !f.IsDir && !is_partial_archive(&f.Name) {
                    names.push(format!("{}  (on {})", f.Name, r.label()));
                }
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(cfg.resolve(&cfg.inner.backup.dir)) {
        for e in entries.flatten() {
            let p = e.path();
            let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
            if p.is_file() && !is_partial_archive(&name) {
                names.push(format!("{}  (local {})", name, cfg.inner.backup.dir));
            }
        }
    }
    names.sort();
    names
}

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
            let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
            if p.is_file() && !is_partial_archive(&name) {
                items.push(serde_json::json!({
                    "name": name,
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
    let merge = args.iter().any(|a| a == "--merge");
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
        println!(
            "\nUsage: backup-mgr restore <filename> [target-dir] [--force] [--merge]\n\
             The target is emptied first so the result is exactly this backup;\n\
             --merge writes the archive over the target and keeps everything else."
        );
        return Ok(());
    }

    let file: &str = positional[0].as_str();
    let default_target = cfg.resolve(&cfg.inner.backup.dir).join("restore");
    let target_str = positional
        .get(1)
        .map(|s| s.to_string())
        .unwrap_or_else(|| default_target.to_string_lossy().to_string());
    let target = cfg.resolve(&target_str);

    if !restore_source_exists(cfg, file) {
        let reason = format!(
            "backup '{}' not found on any configured remote or in {} (run `backup-mgr restore` to list)",
            file, cfg.inner.backup.dir
        );
        return Err(reason);
    }
    if !merge {
        if let Some(reason) = restore_target_refusal(cfg, &target) {
            return Err(reason);
        }
    }

    if let Err(e) = cmd_restore_do(cfg, logger, file, &target, force, merge) {
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

fn cmd_restore_do(
    cfg: &Config,
    logger: &Logger,
    file: &str,
    target: &Path,
    force: bool,
    merge: bool,
) -> Result<(), String> {
    let mut chosen: Option<Remote> = None;
    for r in drive::active_remotes(cfg) {
        if let Ok(files) = drive::list_backups(&r) {
            if files.iter().any(|f| f.Name == file) {
                chosen = Some(r.clone());
                break;
            }
        }
    }

    let local_archive = cfg.resolve(&cfg.inner.backup.dir).join(file);
    if chosen.is_none() && !local_archive.is_file() {
        return Err(format!(
            "backup '{}' not found on any configured remote or in {} (run `backup-mgr restore` to list)",
            file, cfg.inner.backup.dir
        ));
    }

    std::fs::create_dir_all(target).map_err(|e| e.to_string())?;
    if !merge {
        if let Some(reason) = restore_target_refusal(cfg, target) {
            return Err(reason);
        }
        if normalise_path(target) == normalise_path(&cfg.resolve(&cfg.inner.backup.path)) {
            logger.warn(&format!(
                "restoring in place: {} is the directory this backup was taken from, and it is emptied before the archive is extracted",
                target.display()
            ));
        }
    }

    if let Some(r) = &chosen {
        if let Some(m) = db().and_then(|d| d.manifest(file)) {
            match drive::remote_md5(r, file) {
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
                        "could not read remote hash for {} ({e}); will verify the local copy instead",
                        file
                    ));
                }
            }
        }
    }

    let staging = cfg.resolve(&cfg.inner.backup.dir).join(".restore");

    let (raw, downloaded) = match &chosen {
        Some(r) => {
            std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
            let raw = staging.join(file);
            drive::download_file(r, file, &raw, logger)?;
            (raw, true)
        }
        None => {
            logger.info(&format!(
                "no remote copy of {} — restoring the local archive {}",
                file,
                local_archive.display()
            ));
            (local_archive.clone(), false)
        }
    };

    if let Some(m) = db().and_then(|d| d.manifest(file)) {
        match drive::local_md5(&raw) {
            Ok(local_hash) => {
                match restore_hash_gate(file, "archive file", &m.md5, &local_hash, force) {
                    Ok(true) => logger.info(&format!("integrity check passed for {} (md5 matches manifest)", file)),
                    Ok(false) => logger.warn(&format!(
                        "--force specified: extracting {} despite integrity mismatch (local md5 {} != manifest md5 {})",
                        file, local_hash, m.md5
                    )),
                    Err(e) => {
                        if downloaded {
                            let _ = std::fs::remove_file(&raw);
                        }
                        return Err(e);
                    }
                }
            }
            Err(e) => {
                logger.warn(&format!(
                    "could not verify {} ({e}); continuing without a hash confirmation",
                    file
                ));
            }
        }
    }

    let mut plain = raw.clone();
    if file.ends_with(".gpg") {
        std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        let base = file.trim_end_matches(".gpg");
        plain = staging.join(base);
        backup::decrypt_gpg(&raw, &enc_passphrase(cfg), &plain, logger)?;
    }

    let name = plain.file_name().unwrap_or_default().to_string_lossy().to_string();
    if merge {
        logger.info(&format!(
            "merging {} into {} (files that are not in this backup are kept)",
            name,
            target.display()
        ));
        extract_archive(&plain, &name, target, logger)?;
    } else {
        clean_restore_into(&plain, &name, target, logger)?;
    }

    if downloaded {
        let _ = std::fs::remove_file(&raw);
    }
    if plain != raw {
        let _ = std::fs::remove_file(&plain);
    }
    prune_restore_staging(&staging);
    logger.info(&format!("restored {} -> {}", name, target.display()));
    Ok(())
}

fn prune_restore_staging(dir: &Path) {
    let empty = std::fs::read_dir(dir).map(|mut e| e.next().is_none()).unwrap_or(false);
    if empty {
        let _ = std::fs::remove_dir(dir);
    }
}

fn restore_source_exists(cfg: &Config, file: &str) -> bool {
    for r in drive::active_remotes(cfg) {
        if let Ok(files) = drive::list_backups(&r) {
            if files.iter().any(|f| f.Name == file) {
                return true;
            }
        }
    }
    cfg.resolve(&cfg.inner.backup.dir).join(file).is_file()
}

fn normalise_path(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn restore_target_refusal(cfg: &Config, target: &Path) -> Option<String> {
    restore_target_refusal_for(
        target,
        &cfg.base_dir,
        &cfg.resolve(&cfg.inner.backup.dir),
        &cfg.resolve(&cfg.inner.backup.path),
    )
}

fn restore_target_refusal_for(
    target: &Path,
    instance_root: &Path,
    backup_dir: &Path,
    source_dir: &Path,
) -> Option<String> {
    let t = normalise_path(target);
    if !t.is_absolute() {
        return Some(format!(
            "refusing to empty {}: the target must be an absolute path",
            t.display()
        ));
    }

    const SYSTEM_DIRS: &[&str] = &[
        "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64",
        "/libx32", "/media", "/mnt", "/opt", "/proc", "/root", "/run", "/sbin", "/srv",
        "/sys", "/tmp", "/usr", "/var",
    ];
    for dir in SYSTEM_DIRS {
        if t == Path::new(dir) {
            return Some(format!(
                "refusing to empty {}: that is a system directory. Pass --merge to add this backup's files without deleting anything, or choose another target.",
                t.display()
            ));
        }
    }

    let instance_root = normalise_path(instance_root);
    let backup_dir = normalise_path(backup_dir);
    let source_dir = normalise_path(source_dir);

    for (label, p) in [
        ("the instance directory", &instance_root),
        ("the backup directory", &backup_dir),
    ] {
        if t == *p {
            return Some(format!(
                "refusing to empty {}: it is {} (config, state, history and archives live there).",
                t.display(),
                label
            ));
        }
        if p.starts_with(&t) {
            return Some(format!(
                "refusing to empty {}: {} is inside it, so its contents would go too.",
                t.display(),
                p.display()
            ));
        }
    }

    if source_dir != t && source_dir.starts_with(&t) {
        return Some(format!(
            "refusing to empty {}: the directory this backup was taken from ({}) is inside it.",
            t.display(),
            source_dir.display()
        ));
    }

    if let Ok(md) = std::fs::symlink_metadata(&t) {
        if md.file_type().is_symlink() {
            return Some(format!(
                "refusing to empty {}: it is a symlink — point the target at the real directory.",
                t.display()
            ));
        }
    }

    None
}

fn clean_restore_into(
    archive: &Path,
    name: &str,
    target: &Path,
    logger: &Logger,
) -> Result<(), String> {
    let stage = target.join(RESTORE_STAGE_DIR);
    if stage.exists() {
        std::fs::remove_dir_all(&stage)
            .map_err(|e| format!("cannot clear the leftover staging directory {}: {e}", stage.display()))?;
    }
    std::fs::create_dir_all(&stage).map_err(|e| format!("cannot create {}: {e}", stage.display()))?;

    logger.info(&format!(
        "extracting {} (staged inside {} — it is emptied only once the archive has extracted)",
        name,
        target.display()
    ));
    if let Err(e) = extract_archive(archive, name, &stage, logger) {
        let _ = std::fs::remove_dir_all(&stage);
        return Err(e);
    }

    let mut removed = 0usize;
    for entry in std::fs::read_dir(target).map_err(|e| format!("cannot list {}: {e}", target.display()))? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.file_name() == Some(OsStr::new(RESTORE_STAGE_DIR)) {
            continue;
        }
        let md = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        let res = if md.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        res.map_err(|e| format!("cannot remove {}: {e}", path.display()))?;
        removed += 1;
    }
    logger.info(&format!(
        "emptied {} first: removed {} existing entr{}",
        target.display(),
        removed,
        if removed == 1 { "y" } else { "ies" }
    ));

    let mut moved = 0usize;
    for entry in std::fs::read_dir(&stage).map_err(|e| format!("cannot list {}: {e}", stage.display()))? {
        let from = entry.map_err(|e| e.to_string())?.path();
        let to = target.join(from.file_name().unwrap_or_default());
        std::fs::rename(&from, &to).map_err(|e| format!("cannot move {} into place: {e}", to.display()))?;
        moved += 1;
    }
    std::fs::remove_dir(&stage).map_err(|e| format!("cannot remove {}: {e}", stage.display()))?;
    logger.info(&format!(
        "placed {} entr{} into {}",
        moved,
        if moved == 1 { "y" } else { "ies" },
        target.display()
    ));
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

    if cfg.inner.metrics.enabled {
        let m = METRICS.get_or_init(metrics::Metrics::new);
        m.serve(&cfg.inner.metrics.host, cfg.inner.metrics.port, &logger, cmd == "daemon");
    }

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
    use super::{
        clean_restore_into, is_partial_archive, normalise_path, restore_hash_gate,
        restore_target_refusal_for, schedule_for, RESTORE_STAGE_DIR,
    };
    use crate::logger::Logger;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bm-restore-{}-{}-{label}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_archive(src: &Path, archive: &Path) {
        let ok = Command::new("tar")
            .current_dir(src)
            .args(["-czf", archive.to_str().unwrap(), "."])
            .status()
            .expect("tar must be installed for these tests");
        assert!(ok.success());
    }


    #[test]
    fn schedule_without_times_keeps_the_even_spacing_rule() {
        assert_eq!(schedule_for(&[], "03:30", 1), vec![210]);
        assert_eq!(schedule_for(&[], "03:30", 2), vec![210, 930]);
        assert_eq!(schedule_for(&[], "03:30", 4), vec![210, 570, 930, 1290]);
    }

    #[test]
    fn explicit_times_are_the_schedule() {
        let times = vec!["15:30".to_string(), "03:30".to_string()];

        assert_eq!(schedule_for(&times, "03:30", 1), vec![210, 930]);
    }

    #[test]
    fn explicit_times_dedupe_and_ignore_unparseable_entries() {
        let times = vec![
            "06:00".to_string(),
            "06:00".to_string(),
            "6:00".to_string(),
            "25:00".to_string(),
            "not a time".to_string(),
        ];
        assert_eq!(schedule_for(&times, "03:30", 3), vec![360]);
    }

    #[test]
    fn times_that_are_all_invalid_fall_back_rather_than_run_nothing() {
        let times = vec!["nope".to_string()];
        assert_eq!(schedule_for(&times, "03:30", 2), vec![210, 930]);
    }

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
    fn clean_restore_replaces_the_target_instead_of_merging_into_it() {
        let root = scratch("clean");
        let src = root.join("src");
        let target = root.join("target");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("file.txt"), "from backup").unwrap();
        std::fs::write(src.join("sub/keep.txt"), "nested").unwrap();
        std::fs::create_dir_all(target.join("stale-dir")).unwrap();
        std::fs::write(target.join("file.txt"), "stale copy").unwrap();
        std::fs::write(target.join("leftover.txt"), "not in the backup").unwrap();
        std::fs::write(target.join("stale-dir/x.txt"), "old").unwrap();
        let archive = root.join("b.tar.gz");
        make_archive(&src, &archive);

        let logger = Logger::new(root.to_str().unwrap(), "info", 1).unwrap();
        clean_restore_into(&archive, "b.tar.gz", &target, &logger).unwrap();

        assert_eq!(std::fs::read_to_string(target.join("file.txt")).unwrap(), "from backup");
        assert_eq!(std::fs::read_to_string(target.join("sub/keep.txt")).unwrap(), "nested");
        assert!(!target.join("leftover.txt").exists(), "leftover file must be gone");
        assert!(!target.join("stale-dir").exists(), "leftover directory must be gone");
        assert!(!target.join(RESTORE_STAGE_DIR).exists(), "staging dir must be cleaned up");
        let names: Vec<String> = std::fs::read_dir(&target)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names.len(), 2, "target should hold exactly the archive's entries: {names:?}");
    }

    #[test]
    fn a_failed_extraction_leaves_the_target_untouched() {
        let root = scratch("failed");
        let target = root.join("target");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("important.txt"), "keep me").unwrap();
        let broken = root.join("broken.tar.gz");
        std::fs::write(&broken, b"this is not a tar archive").unwrap();

        let logger = Logger::new(root.to_str().unwrap(), "info", 1).unwrap();
        let err = clean_restore_into(&broken, "broken.tar.gz", &target, &logger);
        assert!(err.is_err());
        assert_eq!(std::fs::read_to_string(target.join("important.txt")).unwrap(), "keep me");
        assert!(!target.join(RESTORE_STAGE_DIR).exists());
    }

    #[test]
    fn a_clean_restore_empty_directory_is_fine() {
        let root = scratch("empty");
        let src = root.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("only.txt"), "content").unwrap();
        let archive = root.join("b.tar.gz");
        make_archive(&src, &archive);

        let logger = Logger::new(root.to_str().unwrap(), "info", 1).unwrap();
        let fresh = root.join("fresh/deeper");
        std::fs::create_dir_all(&fresh).unwrap();
        clean_restore_into(&archive, "b.tar.gz", &fresh, &logger).unwrap();
        assert_eq!(std::fs::read_to_string(fresh.join("only.txt")).unwrap(), "content");
    }

    #[test]
    fn restore_refuses_targets_that_must_never_be_emptied() {
        let root = Path::new("/opt/drive-backup");
        let backup = Path::new("/opt/drive-backup/backup");
        let source = Path::new("/var/lib/pterodactyl/volumes/abc");
        let refuse = |t: &str| restore_target_refusal_for(Path::new(t), root, backup, source);

        for bad in ["/", "/etc", "/home", "/usr", "/var", "/opt"] {
            assert!(refuse(bad).is_some(), "{bad} must be refused");
        }
        assert!(refuse("/opt/drive-backup").is_some(), "the instance root must be refused");
        assert!(refuse("/opt/drive-backup/backup").is_some(), "the backup dir must be refused");
        assert!(refuse("/opt").is_some(), "an ancestor of the instance root must be refused");
        assert!(refuse("/var/lib/pterodactyl").is_some(), "an ancestor of the source must be refused");
        assert!(refuse("/opt/drive-backup/backup/restore").is_none(), "the sandbox target is allowed");
        assert!(refuse("/srv/restore/kept").is_none(), "a normal directory is allowed");
        assert!(refuse("/var/lib/pterodactyl/volumes/abc").is_none(), "restoring in place is allowed");
        assert!(refuse("relative/dir").is_some(), "a relative path must be refused");
    }

    #[test]
    fn a_symlinked_target_is_refused() {
        let root = scratch("symlink");
        let real = root.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let refused = restore_target_refusal_for(&link, &root.join("inst"), &root.join("inst/backup"), &root.join("src"));
        assert!(refused.is_some());
    }

    #[test]
    fn half_written_archives_are_not_offered_as_restore_sources() {
        assert!(is_partial_archive("bund.tar.gz.tmp"));
        assert!(is_partial_archive("bund.tar.gz.part"));
        assert!(!is_partial_archive("bund_22-09-26_09-58.tar.gz"));
    }

    #[test]
    fn paths_are_normalised_before_comparison() {
        assert_eq!(normalise_path(Path::new("/a/b/../c/./d")), PathBuf::from("/a/c/d"));
        assert_eq!(normalise_path(Path::new("/a/../../b")), PathBuf::from("/b"));
    }

    #[test]
    fn restore_gate_force_overrides_mismatch() {
        assert_eq!(
            restore_hash_gate("b.tar.gz", "archive file", "abc", "def", true),
            Ok(false)
        );
    }
}
