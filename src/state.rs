use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunState {
    pub stage: String,
    pub status: String,
    pub current_backup: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub last_error: String,
    pub requires_manual_resume: bool,
    pub last_run_at: Option<String>,
    pub generation: u64,
}

impl Default for RunState {
    fn default() -> Self {
        RunState {
            stage: "idle".into(),
            status: "ok".into(),
            current_backup: String::new(),
            started_at: None,
            finished_at: None,
            last_error: String::new(),
            requires_manual_resume: false,
            last_run_at: None,
            generation: 0,
        }
    }
}

impl RunState {
    pub fn load(path: &Path) -> RunState {
        match fs::read_to_string(path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(_) => RunState::default(),
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
        }
        let data = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, data).map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn reset(path: &Path) -> Result<(), String> {
        let s = RunState::default();
        s.save(path)
    }

    pub fn mark_running(&mut self, stage: &str, backup: &str, started: String) {
        self.stage = stage.into();
        self.status = "running".into();
        self.current_backup = backup.into();
        self.started_at = Some(started);
        self.requires_manual_resume = false;
        self.last_error = String::new();
        self.generation += 1;
    }

    pub fn mark_ok(&mut self, finished: String) {
        self.stage = "idle".into();
        self.status = "ok".into();
        self.finished_at = Some(finished.clone());
        self.last_run_at = Some(finished);
        self.requires_manual_resume = false;
    }

    pub fn mark_failed(&mut self, stage: &str, err: &str) {
        self.stage = stage.into();
        self.status = "failed".into();
        self.last_error = err.into();
        self.requires_manual_resume = true;
    }

    #[allow(dead_code)]
    pub fn is_mid_flight(&self) -> bool {
        !matches!(self.stage.as_str(), "idle")
    }

    pub fn describe(&self) -> String {
        format!(
            "stage={} status={} backup={} started_at={:?} finished_at={:?} error={} manual_resume={} last_run={:?} gen={}",
            self.stage,
            self.status,
            self.current_backup,
            self.started_at,
            self.finished_at,
            if self.last_error.is_empty() {
                "-"
            } else {
                &self.last_error
            },
            self.requires_manual_resume,
            self.last_run_at,
            self.generation
        )
    }
}
