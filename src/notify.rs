use crate::backup::human_size;
use crate::logger::Logger;
use serde_json::json;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct NotifCtx {
    pub log_file: String,
    pub state_file: String,
    pub db_file: String,
    pub timezone: String,
}

#[derive(Clone, Debug)]
pub enum Event {
    BackupSuccess {
        kind: String,
        name: String,
        size: u64,
        duration_secs: i64,
        remote: String,
    },
    BackupFailure {
        kind: String,
        stage: String,
        reason: String,
    },
    RestoreSuccess {
        name: String,
        size: u64,
        target: String,
    },
    RestoreFailure {
        name: String,
        reason: String,
    },
    PreflightFail {
        reason: String,
    },
    ManualResume {
        stage: String,
        reason: String,
    },
    CheckSuccess {
        checked: usize,
        failed: usize,
    },
    CheckFailure {
        reason: String,
    },
}

const GREEN: i32 = 0x2ECC71;
const RED: i32 = 0xE74C3C;
const YELLOW: i32 = 0xF1C40F;
const AQUA: i32 = 0x1ABC9C;

struct Embed {
    title: String,
    description: String,
    color: i32,
    fields: Vec<(String, String, bool)>,
}

fn build_embed(ev: &Event, ctx: &NotifCtx) -> Embed {
    let logs_val = format!(
        "`{}`\n`{}`\n`{}`",
        ctx.log_file, ctx.state_file, ctx.db_file
    );
    match ev {
        Event::BackupSuccess { kind, name, size, duration_secs, remote } => Embed {
            title: format!("✅ Backup Successful — {}", kind),
            description: "The backup was created, verified and uploaded.".into(),
            color: GREEN,
            fields: vec![
                ("📦 **Name**".into(), name.clone(), true),
                ("💾 **Size**".into(), human_size(*size), true),
                ("⏱ **Duration**".into(), format!("{}s", duration_secs), true),
                ("☁ **Remote**".into(), remote.clone(), true),
                ("🗄 **Logs & State**".into(), logs_val, false),
            ],
        },
        Event::BackupFailure { kind, stage, reason } => Embed {
            title: format!("❌ Backup Failed — {}", kind),
            description: format!("**Stage:** `{}`\n```{}```", stage, reason),
            color: RED,
            fields: vec![
                ("🚨 **Action Required**".into(), "Run `backup-mgr status`, then `backup-mgr reset` after fixing.".into(), true),
                ("🗄 **Logs & State**".into(), logs_val, false),
            ],
        },
        Event::RestoreSuccess { name, size, target } => Embed {
            title: "♻️ Restore Completed".into(),
            description: format!("Backup restored successfully to `{}`.", target),
            color: AQUA,
            fields: vec![
                ("📦 **Name**".into(), name.clone(), true),
                ("💾 **Size**".into(), human_size(*size), true),
                ("🗄 **Logs & State**".into(), logs_val, false),
            ],
        },
        Event::RestoreFailure { name, reason } => Embed {
            title: "❌ Restore Failed".into(),
            description: format!("**Source:** `{}`\n```{}```", name, reason),
            color: RED,
            fields: vec![("🗄 **Logs & State**".into(), logs_val, false)],
        },
        Event::PreflightFail { reason } => Embed {
            title: "⚠️ Backup Blocked — Disk Preflight".into(),
            description: format!("```{}```", reason),
            color: YELLOW,
            fields: vec![
                ("🧹 **Suggestion**".into(), "Free up disk space or raise `backup.min_free_disk_gb`.".into(), true),
                ("🗄 **Logs & State**".into(), logs_val, false),
            ],
        },
        Event::ManualResume { stage, reason } => Embed {
            title: "⏸ Manual Resume Required".into(),
            description: format!("**Stage:** `{}`\n```{}```", stage, reason),
            color: YELLOW,
            fields: vec![
                ("🔄 **Next step**".into(), "Fix the cause, then run `backup-mgr reset`.".into(), true),
                ("🗄 **Logs & State**".into(), logs_val, false),
            ],
        },
        Event::CheckSuccess { checked, failed } => Embed {
            title: "🛡 Integrity Check Passed".into(),
            description: format!("All {} remote backups verified against the recorded MD5 hashes.", checked),
            color: GREEN,
            fields: vec![
                ("✅ **Verified**".into(), checked.to_string(), true),
                ("❌ **Failed**".into(), failed.to_string(), true),
                ("🗄 **Logs & State**".into(), logs_val, false),
            ],
        },
        Event::CheckFailure { reason } => Embed {
            title: "🛡 Integrity Check Failed".into(),
            description: format!("```{}```", reason),
            color: RED,
            fields: vec![
                ("🚨 **Warning**".into(), "A backup hash does not match. Do not trust this backup; consider restoring an older one.".into(), true),
                ("🗄 **Logs & State**".into(), logs_val, false),
            ],
        },
    }
}

pub fn send(cfg_webhook: &str, logger: &Logger, ctx: &NotifCtx, ev: &Event) {
    let webhook = cfg_webhook.trim();
    if webhook.is_empty() {
        return;
    }
    let embed = build_embed(ev, ctx);
    let payload = json!({
        "username": "backup-mgr",
        "embeds": [{
            "title": embed.title,
            "description": embed.description,
            "color": embed.color,
            "fields": embed.fields.iter().map(|(n, v, inline)| json!({
                "name": n,
                "value": v,
                "inline": inline
            })).collect::<Vec<_>>(),
            "footer": {"text": format!("backup-mgr · timezone {}", ctx.timezone)},
            "timestamp": chrono::Utc::now().to_rfc3339()
        }]
    });

    let url = webhook.to_string();
    let log_line = format!("discord notification: {}", embed.title);
    let _ = ureq::post(&url)
        .timeout(Duration::from_secs(15))
        .send_json(payload);
    logger.info(&log_line);
}
