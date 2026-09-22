use crate::config::Config;
use crate::logger::Logger;
use std::path::{Path, PathBuf};
use std::process::Command;

fn clean(value: String) -> Option<String> {
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn username_from_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

fn username_for_uid(uid: libc::uid_t) -> Option<String> {
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = vec![0 as libc::c_char; 4096];
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    let rc = unsafe {
        libc::getpwuid_r(
            uid,
            &mut pwd,
            buf.as_mut_ptr(),
            buf.len(),
            &mut result,
        )
    };
    if rc != 0 || result.is_null() || pwd.pw_name.is_null() {
        return None;
    }
    let name = unsafe { std::ffi::CStr::from_ptr(pwd.pw_name) }
        .to_string_lossy()
        .trim()
        .to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

fn username_from_id_command() -> Option<String> {
    let out = Command::new("id").arg("-un").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

fn resolve_user(env: &dyn Fn(&str) -> Option<String>, uid: libc::uid_t) -> Option<String> {
    env("USER")
        .and_then(clean)
        .or_else(|| env("LOGNAME").and_then(clean))
        .or_else(|| env("SUDO_USER").and_then(clean))
        .or_else(|| username_for_uid(uid))
        .or_else(username_from_id_command)
}

pub fn current_user() -> Option<String> {
    resolve_user(&username_from_env, unsafe { libc::geteuid() })
}

pub fn source_dir(cfg: &Config) -> PathBuf {
    cfg.resolve(&cfg.inner.backup.path)
}

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

#[cfg(test)]
mod tests {
    use super::{current_user, resolve_user, username_for_uid};

    fn env_from<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name: &str| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| (*v).to_string())
        }
    }

    #[test]
    fn uid_lookup_names_real_accounts() {
        let root = username_for_uid(0).expect("uid 0 must resolve to a name");
        assert_eq!(root, "root");
    }

    #[test]
    fn a_scrubbed_environment_still_resolves_a_user() {
        let resolved = resolve_user(&env_from(&[]), 0);
        assert_eq!(resolved.as_deref(), Some("root"));
    }

    #[test]
    fn blank_environment_values_fall_through_to_the_uid() {
        let resolved = resolve_user(&env_from(&[("USER", "   "), ("LOGNAME", "")]), 0);
        assert_eq!(resolved.as_deref(), Some("root"));
    }

    #[test]
    fn the_environment_wins_when_it_is_set() {
        let resolved = resolve_user(&env_from(&[("USER", "alice")]), 0);
        assert_eq!(resolved.as_deref(), Some("alice"));
    }

    #[test]
    fn logname_is_used_when_user_is_missing() {
        let resolved = resolve_user(&env_from(&[("LOGNAME", "bob")]), 0);
        assert_eq!(resolved.as_deref(), Some("bob"));
    }

    #[test]
    fn current_user_never_returns_a_blank_name() {
        let user = current_user().expect("the running account must be identifiable");
        assert!(!user.trim().is_empty());
        assert_eq!(user, user.trim());
    }
}
