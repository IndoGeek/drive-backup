//! Embeds build provenance (git commit + build time) into the binary.
//!
//! The web panel compares this stamp against the checkout it is serving, so a
//! stale `/usr/local/bin/backup-mgr` is reported instead of silently producing
//! confusing behaviour. Every step is best-effort: a source tarball with no git
//! history still builds, it just reports `unknown`.

use std::process::Command;

fn run(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    // Re-run when the checked-out commit changes so the stamp stays accurate.
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-changed=.git/refs/heads");

    let commit = match run("git", &["rev-parse", "--short", "HEAD"]) {
        // A dirty tree means the binary does not match any commit exactly.
        Some(sha) => {
            if run("git", &["status", "--porcelain"]).is_some() {
                format!("{sha}-dirty")
            } else {
                sha
            }
        }
        None => "unknown".to_string(),
    };

    let built_at = run("date", &["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=BUILD_GIT_COMMIT={commit}");
    println!("cargo:rustc-env=BUILD_TIMESTAMP={built_at}");
}
