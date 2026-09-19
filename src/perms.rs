use crate::config::Config;
use crate::logger::Logger;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The user that owns this deployment (the one the daemon/panel runs as).
/// Defaults to `$USER`; the panel can override it with `--user`.
pub fn current_user() -> Option<String> {
    std::env::var("USER")
        .ok()
        .filter(|u| !u.trim().is_empty())
}

/// Absolute path of the directory that is actually archived.
pub fn source_dir(cfg: &Config) -> PathBuf {
    cfg.resolve(&cfg.inner.backup.path)
}

/// Locate the bundled ACL helper next to the config file (config.yml lives in
/// the project root, the helper in `scripts/`).
fn script_path(cfg: &Config) -> Option<PathBuf> {
    [
        cfg.base_dir.join("scripts/grant-access.sh"),
        cfg.base_dir.join("../scripts/grant-access.sh"),
        PathBuf::from("scripts/grant-access.sh"),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

fn is_root() -> bool {
    unsafe { libc::geteuid() == 0 }
}

fn readable(p: &Path) -> bool {
    std::fs::read_dir(p).is_ok()
}

/// Ensure `user` can read + traverse the configured backup source directory.
///
/// This is the "first run / panel button" permission setup: if the directory is
/// already readable nothing happens, otherwise the bundled
/// `scripts/grant-access.sh` is invoked (directly when root, through
/// passwordless `sudo -n` otherwise) and access is re-checked afterwards. All
/// ACL logic therefore stays in one place.
pub fn ensure_access(cfg: &Config, user: &str, logger: &Logger) -> Result<(), String> {
    let dest = source_dir(cfg);
    if readable(&dest) {
        logger.info(&format!(
            "{} is already readable by {}",
            dest.display(),
            user
        ));
        return Ok(());
    }

    let script = script_path(cfg).ok_or_else(|| {
        format!(
            "cannot read {} and scripts/grant-access.sh was not found. \
             Run it manually: sudo ./scripts/grant-access.sh {} <backup-dir>",
            dest.display(),
            user
        )
    })?;

    let dest_s = dest.to_string_lossy().to_string();
    let script_s = script.to_string_lossy().to_string();

    logger.info(&format!(
        "granting read access on {} to user '{}' via {}",
        dest_s, user, script_s
    ));

    let status = if is_root() {
        Command::new("bash")
            .arg(&script_s)
            .arg(user)
            .arg(&dest_s)
            .status()
    } else {
        // Never block waiting for a password: require a non-interactive sudo.
        let sudo_ok = Command::new("sudo")
            .args(["-n", "true"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !sudo_ok {
            return Err(format!(
                "cannot read {} and passwordless sudo is unavailable. \
                 Run: sudo {} {} {}",
                dest.display(),
                script_s,
                user,
                dest_s
            ));
        }
        Command::new("sudo")
            .arg("-n")
            .arg("bash")
            .arg(&script_s)
            .arg(user)
            .arg(&dest_s)
            .status()
    }
    .map_err(|e| format!("failed to run grant-access.sh: {e}"))?;

    if !status.success() {
        return Err(format!(
            "grant-access.sh exited with {:?}",
            status.code()
        ));
    }

    if readable(&dest) {
        logger.info(&format!(
            "permission fix verified: {} is now readable by {}",
            dest.display(),
            user
        ));
        Ok(())
    } else {
        Err(format!(
            "ran grant-access.sh but {} is still not readable by {}",
            dest.display(),
            user
        ))
    }
}
