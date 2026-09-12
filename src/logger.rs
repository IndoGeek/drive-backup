use chrono::{Local, NaiveDate};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Clone, Copy, PartialEq, PartialOrd, Debug)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(&self) -> &'static str {
        match self {
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }
    fn from_str(s: &str) -> Level {
        match s.trim().to_lowercase().as_str() {
            "debug" => Level::Debug,
            "warn" | "warning" => Level::Warn,
            "error" => Level::Error,
            _ => Level::Info,
        }
    }
}

pub struct Logger {
    inner: Mutex<Inner>,
}

struct Inner {
    dir: PathBuf,
    prefix: String,
    min_level: Level,
    keep_days: u64,
    current_file: String,
    file: Option<fs::File>,
}

impl Logger {
    pub fn new(dir: &str, level: &str, keep_days: u64) -> Result<Self, String> {
        let dir_path = PathBuf::from(dir);
        fs::create_dir_all(&dir_path).map_err(|e| format!("cannot create log dir: {e}"))?;
        let min_level = Level::from_str(level);
        let logger = Logger {
            inner: Mutex::new(Inner {
                dir: dir_path,
                prefix: "backup".to_string(),
                min_level,
                keep_days,
                current_file: String::new(),
                file: None,
            }),
        };
        logger.rotate_if_needed()?;
        logger.prune_old()?;
        Ok(logger)
    }

    fn rotate_if_needed(&self) -> Result<(), String> {
        let mut g = self.inner.lock().unwrap();
        let today = Local::now().format("%Y-%m-%d").to_string();
        if g.current_file == today {
            return Ok(());
        }
        let path = g.dir.join(format!("{}_{}.log", g.prefix, today));
        let f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("cannot open log file {}: {e}", path.display()))?;
        g.current_file = today;
        g.file = Some(f);
        Ok(())
    }

    fn prune_old(&self) -> Result<(), String> {
        let keep = self.inner.lock().unwrap().keep_days;
        let g = self.inner.lock().unwrap();
        let cutoff = Local::now().date_naive() - chrono::Duration::days(keep as i64);
        let entries = fs::read_dir(&g.dir).map_err(|e| e.to_string())?;
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with(&g.prefix) || !name.ends_with(".log") {
                continue;
            }
            if let Some(hay) = name.strip_prefix(&format!("{}_", g.prefix)) {
                let date_str = hay.trim_end_matches(".log");
                if let Ok(d) = NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
                    if d < cutoff {
                        let _ = fs::remove_file(e.path());
                    }
                }
            }
        }
        Ok(())
    }

    pub fn log(&self, level: Level, msg: &str) {
        let mut g = self.inner.lock().unwrap();
        if level < g.min_level {
            return;
        }
        let _ = self.rotate_log_locked(&mut g);
        let ts = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let line = format!("{ts} [{}] {}", level.as_str(), msg);
        if let Some(f) = g.file.as_mut() {
            let _ = writeln!(f, "{line}");
            let _ = f.flush();
        }
        println!("{line}");
    }

    fn rotate_log_locked(&self, g: &mut Inner) -> Result<(), String> {
        let today = Local::now().format("%Y-%m-%d").to_string();
        if g.current_file == today {
            return Ok(());
        }
        let path = g.dir.join(format!("{}_{}.log", g.prefix, today));
        let f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("cannot open log file {}: {e}", path.display()))?;
        g.current_file = today;
        g.file = Some(f);
        Ok(())
    }

    pub fn debug(&self, msg: &str) {
        self.log(Level::Debug, msg);
    }
    pub fn info(&self, msg: &str) {
        self.log(Level::Info, msg);
    }
    pub fn warn(&self, msg: &str) {
        self.log(Level::Warn, msg);
    }
    pub fn error(&self, msg: &str) {
        self.log(Level::Error, msg);
    }
}