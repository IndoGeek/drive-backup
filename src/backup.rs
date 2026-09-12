use crate::logger::Logger;
use chrono::DateTime;
use chrono_tz::Tz;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Extension (including leading dot) for a compression type.
pub fn extension_for(compression: &str) -> Option<&'static str> {
    match compression {
        "tar" => Some(".tar"),
        "tar.gz" => Some(".tar.gz"),
        "tar.zst" | "zst" => Some(".tar.zst"),
        "tar.xz" | "xz" => Some(".tar.xz"),
        "tar.bz2" | "bz2" => Some(".tar.bz2"),
        "zip" => Some(".zip"),
        _ => None,
    }
}

pub fn normalize_compression(compression: &str) -> String {
    match compression.trim().to_lowercase().as_str() {
        "tar" => "tar".to_string(),
        "tar.gz" | "gz" | "gzip" | "" => "tar.gz".to_string(),
        "tar.zst" | "zst" => "tar.zst".to_string(),
        "tar.xz" | "xz" => "tar.xz".to_string(),
        "tar.bz2" | "bz2" => "tar.bz2".to_string(),
        "zip" => "zip".to_string(),
        other => other.to_string(),
    }
}

pub fn format_timestamp(fmt: &str, dt: &DateTime<Tz>) -> String {
    let mut s = fmt.to_string();
    let pairs = [
        ("%Y", &dt.format("%Y").to_string()),
        ("%y", &dt.format("%y").to_string()),
        ("%m", &dt.format("%m").to_string()),
        ("%d", &dt.format("%d").to_string()),
        ("%H", &dt.format("%H").to_string()),
        ("%M", &dt.format("%M").to_string()),
        ("%S", &dt.format("%S").to_string()),
    ];
    for (tok, val) in pairs {
        s = s.replace(tok, val);
    }
    s
}

pub fn archive_name(prefix: &str, fmt: &str, dt: &DateTime<Tz>, ext: &str) -> String {
    format!("{}_{}{}", prefix, format_timestamp(fmt, dt), ext)
}

pub fn validate_compression(compression: &str) -> Result<(), String> {
    match compression {
        "tar" | "tar.gz" | "tar.zst" | "tar.xz" | "tar.bz2" => {
            if Command::new("tar").arg("--version").output().is_err() {
                return Err("'tar' binary not found in PATH".into());
            }
        }
        "zip" => {
            if Command::new("zip").arg("-v").output().is_err() {
                return Err("'zip' binary not found in PATH".into());
            }
        }
        other => return Err(format!("unsupported compression type: {other}")),
    }
    Ok(())
}

fn require_binary(bin: &str, must: bool) -> Result<(), String> {
    if Command::new(bin).arg("--version").output().is_err() && must {
        return Err(format!("'{bin}' binary not found in PATH"));
    }
    Ok(())
}

/// Compress the *contents* of src_dir (or just sub_dir inside it) into dst_file.
pub fn compress_dir(
    src_dir: &Path,
    sub_dir: Option<&Path>,
    dst_file: &Path,
    compression: &str,
    excludes: &[String],
    logger: &Logger,
) -> Result<u64, String> {
    let root = match sub_dir {
        Some(s) => src_dir.join(s),
        None => src_dir.to_path_buf(),
    };
    if !root.is_dir() {
        let reason = match std::fs::metadata(&root) {
            Ok(m) if m.is_dir() => {
                "the directory exists but cannot be traversed (missing read/traverse permission)".to_string()
            }
            Ok(_) => "path exists but is not a directory".to_string(),
            Err(e) => format!("cannot access path: {e}"),
        };
        return Err(format!(
            "backup path is not a directory: {} ({reason}). If you run the backup as a non-root user, first grant read+traverse access to it: sudo ./scripts/grant-access.sh $USER <backup-dir> (see README 'Prerequisites', requires the 'acl' package).",
            root.display()
        ));
    }
    if let Some(parent) = dst_file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    validate_compression(compression)?;

    let partial = dst_file.with_file_name(format!(
        "{}.tmp",
        dst_file.file_name().unwrap_or_default().to_string_lossy()
    ));

    let mut cmd = Command::new(if compression == "zip" { "zip" } else { "tar" });
    if compression == "zip" {
        let args: Vec<String> = {
            let mut a = vec![
                "-r".to_string(),
                partial.to_string_lossy().to_string(),
                ".".to_string(),
            ];
            a.extend(excludes.iter().map(|p| format!("-x {}", p)));
            a
        };
        cmd.current_dir(&root).args(&args);
    } else {
        let flag = match compression {
            "tar" => "-cf",
            "tar.gz" => "-czf",
            "tar.zst" => "--zstd -cf",
            "tar.bz2" => "-cjf",
            "tar.xz" => "-cJf",
            _ => "-czf",
        };
        let mut args: Vec<String> = flag.split_whitespace().map(String::from).collect();
        args.push(partial.to_string_lossy().to_string());
        // Skip unreadable files (e.g. transient process-private files) instead of
        // failing the whole backup. Any skipped files are reported as warnings
        // below. This is what lets the tool run as a non-root user.
        args.push("--ignore-failed-read".to_string());
        for p in excludes {
            args.push(format!("--exclude={}", p));
        }
        args.push(".".to_string());
        cmd.current_dir(&root).args(&args);
    }

    logger.info(&format!(
        "compressing {} ({} -> {})",
        root.display(),
        compression,
        dst_file.file_name().unwrap_or_default().to_string_lossy()
    ));
    let out = cmd
        .output()
        .map_err(|e| format!("failed to spawn {}: {e}", if compression == "zip" { "zip" } else { "tar" }))?;
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        let _ = std::fs::remove_file(&partial);
        return Err(format!(
            "compression failed (exit {:?}): {}",
            out.status.code(),
            stderr
        ));
    }
    if !stderr.is_empty() {
        logger.warn(&format!("compression finished with warnings (unreadable/transient files were skipped):\n{}", stderr));
    }
    std::fs::rename(&partial, dst_file).map_err(|e| e.to_string())?;
    let size = std::fs::metadata(dst_file).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        return Err(format!("compression produced an empty archive: {}", dst_file.display()));
    }
    logger.info(&format!(
        "archive created: {} ({})",
        dst_file.display(),
        human_size(size)
    ));
    Ok(size)
}

/// Symmetric gpg encryption: <in> -> <in>.gpg, removing the plaintext afterwards.
pub fn encrypt_gpg(input: &Path, passphrase: &str, cipher: &str, logger: &Logger) -> Result<PathBuf, String> {
    let out = input.with_extension(format!(
        "{}.gpg",
        input.extension().unwrap_or_default().to_string_lossy()
    ));
    require_binary("gpg", true)?;
    logger.info(&format!("encrypting {} -> {} (gpg -c {})", input.display(), out.display(), cipher));
    let mut child = Command::new("gpg")
        .args([
            "--batch",
            "--yes",
            "--pinentry-mode",
            "loopback",
            "--passphrase-fd",
            "0",
            "-c",
            "--cipher-algo",
            cipher,
            "-o",
        ])
        .arg(&out)
        .arg(input)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn gpg: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{}\n", passphrase).as_bytes());
    }
    let res = child.wait_with_output().map_err(|e| format!("gpg failed: {e}"))?;
    if !res.status.success() {
        let _ = std::fs::remove_file(&out);
        return Err(format!(
            "gpg encryption failed (exit {:?}): {}",
            res.status.code(),
            String::from_utf8_lossy(&res.stderr).trim()
        ));
    }
    std::fs::remove_file(input).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Decrypt a .gpg file back to plaintext <in without .gpg>.
pub fn decrypt_gpg(input: &Path, passphrase: &str, out: &Path, logger: &Logger) -> Result<(), String> {
    require_binary("gpg", true)?;
    logger.info(&format!("decrypting {} -> {}", input.display(), out.display()));
    let mut child = Command::new("gpg")
        .args([
            "--batch",
            "--yes",
            "--pinentry-mode",
            "loopback",
            "--passphrase-fd",
            "0",
            "--decrypt",
            "-o",
        ])
        .arg(out)
        .arg(input)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn gpg: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{}\n", passphrase).as_bytes());
    }
    let res = child.wait_with_output().map_err(|e| format!("gpg failed: {e}"))?;
    if !res.status.success() {
        let _ = std::fs::remove_file(out);
        return Err(format!(
            "gpg decryption failed (exit {:?}): {}",
            res.status.code(),
            String::from_utf8_lossy(&res.stderr).trim()
        ));
    }
    Ok(())
}

/// Simple glob matcher supporting `*` and `?`.
fn glob_match(s: &[char], p: &[char]) -> bool {
    match (s.first(), p.first()) {
        (None, None) => true,
        (Some(_), Some('*')) => glob_match(s, &p[1..]) || glob_match(&s[1..], p),
        (_, Some('?')) => !s.is_empty() && glob_match(&s[1..], &p[1..]),
        (Some(a), Some(b)) => a == b && glob_match(&s[1..], &p[1..]),
        _ => false,
    }
}

pub fn matches_pattern(name: &str, pattern: &str) -> bool {
    let s: Vec<char> = name.chars().collect();
    let p: Vec<char> = pattern.chars().collect();
    glob_match(&s, &p)
}

fn excluded(path: &Path, root: &Path, excludes: &[String]) -> bool {
    let rel = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();
    let base = path.file_name().unwrap_or_default().to_string_lossy().to_string();
    excludes.iter().any(|pat| {
        matches_pattern(&rel, pat) || matches_pattern(&base, pat) || rel.split('/').any(|c| matches_pattern(c, pat))
    })
}

/// Recursively estimate total size of a directory, skipping excluded entries.
pub fn estimate_size(dir: &Path, excludes: &[String]) -> Result<u64, String> {
    fn walk(p: &Path, root: &Path, ex: &[String], out: &mut u64) -> Result<(), String> {
        for entry in std::fs::read_dir(p).map_err(|e| format!("cannot read {}: {e}", p.display()))? {
            let e = entry.map_err(|e| e.to_string())?;
            let path = e.path();
            if excluded(&path, root, ex) {
                continue;
            }
            let md = e.metadata().map_err(|e| e.to_string())?;
            if md.is_dir() {
                walk(&path, root, ex, out)?;
            } else if md.is_file() {
                *out = out.saturating_add(md.len());
            }
        }
        Ok(())
    }
    let mut total = 0u64;
    walk(dir, dir, excludes, &mut total)?;
    Ok(total)
}

pub fn free_bytes_on(dir: &Path) -> Result<u64, String> {
    use std::ffi::CString;
    let dir_c = CString::new(dir.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statvfs(dir_c.as_ptr(), &mut stat) };
    if rc != 0 {
        return Err(format!("statvfs failed for {}: errno {}", dir.display(), std::io::Error::last_os_error()));
    }
    Ok(stat.f_bavail as u64 * stat.f_frsize as u64)
}

pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = bytes as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{} {}", bytes, UNITS[u])
    } else {
        format!("{:.2} {}", v, UNITS[u])
    }
}

/// Prune the local staging dir, keeping only the `keep` newest archives matching
/// the given extension. Returns removed file paths.
pub fn prune_local(dir: &Path, ext: &str, keep: usize, logger: &Logger) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut archives: Vec<(std::fs::Metadata, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if !p.is_file() || !p.to_string_lossy().ends_with(ext) {
                return None;
            }
            Some((std::fs::metadata(&p).ok()?, p))
        })
        .collect();
    archives.sort_by_key(|(m, _)| {
        std::cmp::Reverse(m.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH))
    });
    let mut removed = Vec::new();
    for (_, p) in archives.into_iter().skip(keep) {
        match std::fs::remove_file(&p) {
            Ok(_) => {
                logger.info(&format!("pruned local archive {}", p.display()));
                removed.push(p);
            }
            Err(e) => logger.warn(&format!("failed to prune {}: {e}", p.display())),
        }
    }
    removed
}