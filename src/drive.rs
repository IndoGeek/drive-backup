use crate::config::{Config, SecondaryCfg};
use crate::logger::Logger;
use serde::Deserialize;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::process::{Command, Output};

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct Remote {
    pub remote: String,
    pub dir: String,
    pub retention: u32,
    pub client_id: String,
    pub client_secret: String,
    pub scope: String,
    pub refresh_token: String,
    pub access_token: String,
    pub expiry: String,
    pub token_uri: String,
}

impl Remote {
    pub fn label(&self) -> String {
        format!("{}:{}", self.remote, self.dir)
    }
    fn to_overrides(&self) -> Vec<(String, String)>
    where
        Self: Sized,
    {
        let mut v = Vec::new();
        v.push(("type".into(), "drive".into()));
        if !self.scope.trim().is_empty() {
            v.push(("scope".into(), self.scope.trim().to_string()));
        }
        if !self.client_id.trim().is_empty() {
            v.push(("client_id".into(), self.client_id.trim().to_string()));
        }
        if !self.client_secret.trim().is_empty() {
            v.push(("client_secret".into(), self.client_secret.trim().to_string()));
        }
        if !self.refresh_token.trim().is_empty() {
            let mut map = serde_json::Map::new();
            map.insert("refresh_token".into(), serde_json::Value::String(self.refresh_token.clone()));
            map.insert("token_type".into(), serde_json::Value::String("Bearer".into()));
            if !self.access_token.is_empty() {
                map.insert("access_token".into(), serde_json::Value::String(self.access_token.clone()));
            }
            map.insert(
                "expiry".into(),
                serde_json::Value::String(
                    if self.expiry.is_empty() {
                        "0001-01-01T00:00:00Z".to_string()
                    } else {
                        self.expiry.clone()
                    },
                ),
            );
            v.push(("token".into(), serde_json::Value::Object(map).to_string()));
        }
        v
    }
}

pub fn primary_remote(cfg: &Config) -> Remote {
    let d = &cfg.inner.google_drive;
    Remote {
        remote: d.remote.clone(),
        dir: d.dir.clone(),
        retention: d.retention,
        client_id: d.client_id.clone(),
        client_secret: d.client_secret.clone(),
        scope: d.scope.clone(),
        refresh_token: d.refresh_token.clone(),
        access_token: d.access_token.clone(),
        expiry: d.expiry.clone(),
        token_uri: d.token_uri.clone(),
    }
}

pub fn secondary_remote(cfg: &Config) -> Option<Remote> {
    let s: &SecondaryCfg = &cfg.inner.storage.secondary;
    if !s.enabled {
        return None;
    }
    Some(Remote {
        remote: s.remote.clone(),
        dir: s.dir.clone(),
        retention: s.retention,
        client_id: s.client_id.clone(),
        client_secret: s.client_secret.clone(),
        scope: s.scope.clone(),
        refresh_token: s.refresh_token.clone(),
        access_token: s.access_token.clone(),
        expiry: s.expiry.clone(),
        token_uri: s.token_uri.clone(),
    })
}

pub fn active_remotes(cfg: &Config) -> Vec<Remote> {
    let mut v = vec![primary_remote(cfg)];
    if let Some(s) = secondary_remote(cfg) {
        v.push(s);
    }
    v
}

fn rclone_conf_path() -> PathBuf {
    if let Ok(p) = std::env::var("RCLONE_CONFIG") {
        return PathBuf::from(p);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/root".into());
    PathBuf::from(home).join(".config/rclone/rclone.conf")
}

#[derive(Clone, Debug, Default)]
pub struct TokenCreds {
    pub access_token: String,
    pub refresh_token: String,
    pub expiry: String,
}

pub fn read_config_token(r: &Remote) -> Result<TokenCreds, String> {
    let path = rclone_conf_path();
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let want = format!("[{}]", r.remote);
    let mut found = false;
    let mut token_value: Option<String> = None;
    for line in raw.lines() {
        let t = line.trim();
        if !found {
            if t == want {
                found = true;
            }
            continue;
        }

        if t.starts_with('[') {
            break;
        }
        if let Some(eq) = t.find('=') {
            let key = t[..eq].trim();
            let val = t[eq + 1..].trim();
            if key == "token" {
                token_value = Some(val.to_string());
            }
        }
    }
    if !found {
        return Err(format!("no [{}] section found in {}", r.remote, path.display()));
    }
    let token_value = token_value.ok_or_else(|| {
        format!("no token stored for '{}' in {} (run `rclone config reconnect {}:` first)", r.remote, path.display(), r.remote)
    })?;
    let v: serde_json::Value = serde_json::from_str(&token_value)
        .map_err(|e| format!("cannot parse stored token for '{}': {e}", r.remote))?;
    Ok(TokenCreds {
        access_token: v.get("access_token").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
        refresh_token: v.get("refresh_token").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
        expiry: v.get("expiry").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
    })
}

fn run_rclone(args: &[&str]) -> Result<Output, String> {
    let conf = rclone_conf_path();
    Command::new("rclone")
        .args(args)
        .env("RCLONE_CONFIG", &conf)
        .output()
        .map_err(|e| format!("failed to spawn rclone: {e}"))
}

pub fn remote_arg(r: &Remote, path_suffix: &str) -> String {
    if path_suffix.is_empty() {
        format!("{}:", r.remote)
    } else {
        format!("{}:{}/{}", r.remote, r.dir, path_suffix)
    }
}

fn override_value(key: &str, overrides: &[(String, String)]) -> String {
    overrides
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v.clone())
        .unwrap_or_default()
}

fn merge_section(path: &Path, existing: &str, section: &str, overrides: &[(String, String)]) -> Result<(), String> {
    let want = format!("[{}]", section);
    let mut lines: Vec<String> = existing.lines().map(String::from).collect();
    let start = lines.iter().position(|l| l.trim() == want);

    if let Some(idx) = start {
        let mut i = idx + 1;
        while i < lines.len() && !lines[i].starts_with('[') {
            let line = lines[i].clone();
            let trimmed = line.trim();
            let key = line.split('=').next().map(|k| k.trim().to_string()).unwrap_or_default();
            if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
                i += 1;
                continue;
            }
            if overrides.iter().any(|(k, _)| *k == key) {
                lines[i] = format!("{} = {}", key, override_value(&key, overrides));
                i += 1;
                continue;
            }
            i += 1;
        }
        let present_keys: Vec<String> = lines[idx + 1..i]
            .iter()
            .filter_map(|l| l.split('=').next().map(|k| k.trim().to_string()))
            .collect();
        let mut insert_at = i;
        for (k, _) in overrides {
            if !present_keys.contains(k) {
                lines.insert(insert_at, format!("{} = {}", k, override_value(k, overrides)));
                insert_at += 1;
            }
        }
    } else {
        let mut block = vec![want];
        for (k, _) in overrides {
            block.push(format!("{} = {}", k, override_value(k, overrides)));
        }
        lines.extend(block);
    }

    let out = lines.join("\n") + "\n";
    std::fs::write(path, out).map_err(|e| format!("cannot write {}: {e}", path.display()))?;

    crate::config::restrict_file_permissions(path)
}

pub fn ensure_remote_section(r: &Remote, logger: &Logger) -> Result<(), String> {
    let path = rclone_conf_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let existing_type = section_type(&existing, &r.remote);
    let overrides = match &existing_type {
        None => r.to_overrides(),
        Some(t) if t.trim().to_lowercase() == "drive" => r.to_overrides(),
        Some(_) => {
            logger.debug(&format!(
                "{}: existing non-drive remote left untouched ({}), using rclone-managed credentials",
                r.remote,
                existing_type.unwrap_or_default()
            ));
            return Ok(());
        }
    };
    if r.refresh_token.trim().is_empty() {
        logger.debug(&format!("{}: no refresh_token in config; keeping existing rclone token (if any)", r.remote));
    } else {
        logger.info(&format!(
            "{}: writing OAuth token from config.yml into rclone config (auto-refresh on expiry)",
            r.remote
        ));
    }
    merge_section(&path, &existing, &r.remote, &overrides)?;
    Ok(())
}

fn section_type(existing: &str, section: &str) -> Option<String> {
    let want = format!("[{}]", section);
    let lines: Vec<&str> = existing.lines().collect();
    let start = lines.iter().position(|l| l.trim() == want)?;
    for l in &lines[start + 1..] {
        let t = l.trim();
        if t.starts_with('[') {
            break;
        }
        if let Some(eq) = t.find('=') {
            let (k, v) = (t[..eq].trim(), t[eq + 1..].trim());
            if k == "type" {
                return Some(v.to_string());
            }
        }
    }
    None
}

#[derive(Clone, Debug, Deserialize)]
#[allow(non_snake_case)]
pub struct RemoteFile {
    #[serde(default)]
    pub Name: String,
    #[serde(default)]
    pub Size: i64,
    #[serde(default)]
    pub IsDir: bool,
    #[serde(default)]
    pub ModTime: String,
}

pub fn list_backups(r: &Remote) -> Result<Vec<RemoteFile>, String> {
    let remote = r.label();
    let out = run_rclone(&["lsjson", "--files-only", &remote])?;
    if !out.status.success() {
        return Err(format!(
            "rclone lsjson failed for {}: {}",
            remote,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    serde_json::from_str(&String::from_utf8_lossy(&out.stdout))
        .map_err(|e| format!("cannot parse rclone lsjson output: {e}"))
}

pub fn check_remote(r: &Remote) -> Result<(), String> {
    let remote = r.label();
    let out = run_rclone(&["lsd", &remote])?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let low = err.to_lowercase();
    if low.contains("directory not found") || low.contains("didn't match directory") {
        return Ok(());
    }
    Err(format!("rclone auth/access check failed: {}", err.trim()))
}

pub fn ensure_dir(r: &Remote) -> Result<(), String> {
    let remote = r.label();
    let out = run_rclone(&["mkdir", &remote])?;
    if !out.status.success() {
        return Err(format!(
            "rclone mkdir failed for {}: {}",
            remote,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

pub fn upload_file(
    r: &Remote,
    local: &Path,
    logger: &Logger,
    mut progress: Option<&mut dyn FnMut(f64)>,
) -> Result<(), String> {
    ensure_dir(r)?;
    let remote = r.label();
    let name = local.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
    logger.info(&format!("uploading {} -> {}", name, remote));
    let conf = rclone_conf_path();
    let mut child = Command::new("rclone")
        .arg("copy")
        .arg(local.as_os_str())
        .arg(&remote)
        .arg("--no-check-dest")
        .arg("--stats")
        .arg("1s")
        .arg("--stats-one-line")
        .arg("--use-json-log")
        .arg("-v")
        .env("RCLONE_CONFIG", &conf)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn rclone: {e}"))?;
    let stderr = child.stderr.take().ok_or_else(|| "failed to capture rclone stderr".to_string())?;
    let mut err_buf = String::new();
    {
        use std::io::BufRead;
        for line in BufReader::new(stderr).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            err_buf.push_str(&line);
            err_buf.push('\n');
            if let Some(pct) = rclone_stats_percent(&line) {
                if let Some(cb) = progress.as_mut() {
                    cb(pct);
                }
            }
        }
    }
    if !child.wait().map_err(|e| format!("rclone wait failed: {e}"))?.success() {
        return Err(format!(
            "rclone copy to {} failed: {}",
            remote,
            err_buf.trim()
        ));
    }
    let local_size = std::fs::metadata(local).map(|m| m.len()).unwrap_or(0);
    let files = list_backups(r)?;
    match files.iter().find(|f| f.Name == name) {
        Some(rf) if rf.Size == local_size as i64 => {
            logger.info(&format!("verified {} on {} ({} bytes)", name, remote, rf.Size));
            Ok(())
        }
        Some(rf) => Err(format!(
            "size mismatch for {} on {}: remote {} vs local {}",
            name, remote, rf.Size, local_size
        )),
        None => Err(format!("upload verification failed: {} not found on {}", name, remote)),
    }
}

fn rclone_stats_percent(line: &str) -> Option<f64> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let stats = v.get("stats")?;
    let total = stats.get("totalBytes")?.as_i64()?;
    if total <= 0 {
        return None;
    }
    let bytes = stats.get("bytes")?.as_i64()?;
    Some((bytes.min(total) as f64 / total as f64) * 100.0)
}

pub fn delete_file(r: &Remote, name: &str) -> Result<(), String> {
    let remote = remote_arg(r, name);
    let out = run_rclone(&["deletefile", &remote])?;
    if !out.status.success() {
        return Err(format!(
            "rclone deletefile failed for {}: {}",
            remote,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

pub fn prune_remote(r: &Remote, prefix: &str, retention: u32, logger: &Logger) -> Result<Vec<String>, String> {
    let files = list_backups(r)?;
    let pfx = format!("{}_", prefix.trim().to_lowercase());
    let mut ours: Vec<RemoteFile> = files
        .into_iter()
        .filter(|f| !f.IsDir && f.Name.to_lowercase().starts_with(&pfx))
        .collect();
    ours.sort_by(|a, b| b.ModTime.cmp(&a.ModTime));
    let mut deleted = Vec::new();
    for old in ours.into_iter().skip(retention as usize) {
        logger.info(&format!("deleting old remote backup {} on {}", old.Name, r.label()));
        delete_file(r, &old.Name)?;
        deleted.push(old.Name);
    }
    Ok(deleted)
}

pub fn download_file(r: &Remote, name: &str, dest: &Path, logger: &Logger) -> Result<(), String> {
    let remote = remote_arg(r, name);
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let parent_str = parent.to_string_lossy().to_string();
    logger.info(&format!("downloading {} -> {}", remote, dest.display()));

    let out = run_rclone(&["copy", &remote, &parent_str])?;
    if !out.status.success() {
        return Err(format!(
            "rclone copy failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let landed = parent.join(name);
    if dest.is_dir() {
        if !landed.exists() {
            return Err(format!("downloaded file not found at {}", landed.display()));
        }
    } else {
        std::fs::rename(&landed, dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn remote_md5(r: &Remote, name: &str) -> Result<String, String> {
    let remote = r.label();
    let out = run_rclone(&["hashsum", "MD5", &remote])?;
    if !out.status.success() {
        return Err(format!(
            "rclone hashsum failed for {}: {}",
            remote,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut parts = line.split_whitespace();
        let hash = parts.next().unwrap_or_default();
        let fname = parts.next().unwrap_or_default();
        if fname == name {
            return Ok(hash.to_string());
        }
    }
    Err(format!("no hash found for {} on {}", name, remote))
}

pub fn local_md5(path: &Path) -> Result<String, String> {
    let s = path.to_string_lossy();
    let out = run_rclone(&["hashsum", "MD5", &s])?;
    if !out.status.success() {
        return Err(format!(
            "rclone hashsum (local) failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let first = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    first.split_whitespace().next().map(String::from).ok_or_else(|| "empty hash output".into())
}

pub fn remote_hash_map(r: &Remote) -> Result<std::collections::HashMap<String, String>, String> {
    let remote = r.label();
    let out = run_rclone(&["hashsum", "MD5", &remote])?;
    if !out.status.success() {
        return Err(format!(
            "rclone hashsum failed for {}: {}",
            remote,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let mut map = std::collections::HashMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut parts = line.split_whitespace();
        if let (Some(hash), Some(fname)) = (parts.next(), parts.next()) {
            map.insert(fname.to_string(), hash.to_string());
        }
    }
    Ok(map)
}
