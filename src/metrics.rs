use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

pub struct Metrics {
    total_runs: AtomicU64,
    success_runs: AtomicU64,
    failed_runs: AtomicU64,
    last_size: Mutex<u64>,
    last_duration_ms: Mutex<u64>,
    last_timestamp: Mutex<Option<i64>>,
    last_status: Mutex<String>,
    last_backup_name: Mutex<String>,
    free_disk_bytes: Mutex<u64>,
    source_size_bytes: Mutex<u64>,
}

impl Metrics {
    pub fn new() -> Arc<Metrics> {
        Arc::new(Metrics {
            total_runs: AtomicU64::new(0),
            success_runs: AtomicU64::new(0),
            failed_runs: AtomicU64::new(0),
            last_size: Mutex::new(0),
            last_duration_ms: Mutex::new(0),
            last_timestamp: Mutex::new(None),
            last_status: Mutex::new("unknown".into()),
            last_backup_name: Mutex::new(String::new()),
            free_disk_bytes: Mutex::new(0),
            source_size_bytes: Mutex::new(0),
        })
    }

    pub fn record_run(&self, ok: bool, size: u64, duration_ms: u64, name: &str) {
        self.total_runs.fetch_add(1, Ordering::SeqCst);
        if ok {
            self.success_runs.fetch_add(1, Ordering::SeqCst);
        } else {
            self.failed_runs.fetch_add(1, Ordering::SeqCst);
        }
        *self.last_size.lock().unwrap() = size;
        *self.last_duration_ms.lock().unwrap() = duration_ms;
        *self.last_timestamp.lock().unwrap() = Some(chrono::Utc::now().timestamp());
        *self.last_status.lock().unwrap() = if ok { "ok" } else { "failed" }.to_string();
        *self.last_backup_name.lock().unwrap() = name.to_string();
    }

    pub fn set_sizes(&self, free: u64, estimated: u64) {
        *self.free_disk_bytes.lock().unwrap() = free;
        *self.source_size_bytes.lock().unwrap() = estimated;
    }

    pub fn serve(self: &Arc<Metrics>, host: &str, port: u16, logger: &crate::logger::Logger) {
        let addr = format!("{}:{}", host, port);
        let listener = match TcpListener::bind(&addr) {
            Ok(l) => l,
            Err(e) => {
                logger.warn(&format!("metrics: cannot bind {} ({}), skipping", addr, e));
                return;
            }
        };
        logger.info(&format!("metrics endpoint listening on http://{}/metrics", addr));
        let m = self.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                if let Ok(s) = stream {
                    let m2 = m.clone();
                    thread::spawn(move || {
                        let _ = handle(s, &m2);
                    });
                }
            }
        });
    }
}

fn handle(mut stream: TcpStream, m: &Metrics) -> std::io::Result<()> {
    let mut buf = [0u8; 1024];
    let n = stream.read(&mut buf)?;
    let req = String::from_utf8_lossy(&buf[..n]);
    if req.starts_with("GET /metrics") {
        let body = render(m);
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain; version=0.0.4\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(resp.as_bytes())?;
    } else {
        let resp = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        stream.write_all(resp.as_bytes())?;
    }
    stream.flush()?;
    Ok(())
}

fn render(m: &Metrics) -> String {
    let free = *m.free_disk_bytes.lock().unwrap();
    let est = *m.source_size_bytes.lock().unwrap();
    let last_ts = *m.last_timestamp.lock().unwrap();
    let last_size = *m.last_size.lock().unwrap();
    let last_dur = *m.last_duration_ms.lock().unwrap();
    let status = m.last_status.lock().unwrap().clone();
    let name = m.last_backup_name.lock().unwrap().clone();
    let name_label = if name.is_empty() {
        "unset=\"true\"".to_string()
    } else {
        format!("name=\"{}\"", name)
    };
    format!(
        "# HELP backup_mgr_total_runs Total number of backup attempts\n\
         # TYPE backup_mgr_total_runs counter\n\
         backup_mgr_total_runs {}\n\
         # HELP backup_mgr_success_runs Successful backup runs\n\
         # TYPE backup_mgr_success_runs counter\n\
         backup_mgr_success_runs {}\n\
         # HELP backup_mgr_failed_runs Failed backup runs\n\
         # TYPE backup_mgr_failed_runs counter\n\
         backup_mgr_failed_runs {}\n\
         # HELP backup_mgr_last_backup_size_bytes Size of the last archive\n\
         # TYPE backup_mgr_last_backup_size_bytes gauge\n\
         backup_mgr_last_backup_size_bytes {}\n\
         # HELP backup_mgr_last_backup_duration_ms Duration of last run\n\
         # TYPE backup_mgr_last_backup_duration_ms gauge\n\
         backup_mgr_last_backup_duration_ms {}\n\
         # HELP backup_mgr_last_backup_timestamp_seconds Unix time of last run\n\
         # TYPE backup_mgr_last_backup_timestamp_seconds gauge\n\
         backup_mgr_last_backup_timestamp_seconds {}\n\
         # HELP backup_mgr_last_backup_status 0=ok 1=failed\n\
         # TYPE backup_mgr_last_backup_status gauge\n\
         backup_mgr_last_backup_status {}\n\
         # HELP backup_mgr_last_backup_name The archive name of the last run\n\
         # TYPE backup_mgr_last_backup_name gauge\n\
         backup_mgr_last_backup_name {{{}}} 1\n\
         # HELP backup_mgr_free_disk_bytes Free bytes on backup target filesystem\n\
         # TYPE backup_mgr_free_disk_bytes gauge\n\
         backup_mgr_free_disk_bytes {}\n\
         # HELP backup_mgr_source_size_bytes Estimated source size\n\
         # TYPE backup_mgr_source_size_bytes gauge\n\
         backup_mgr_source_size_bytes {}\n",
        m.total_runs.load(Ordering::SeqCst),
        m.success_runs.load(Ordering::SeqCst),
        m.failed_runs.load(Ordering::SeqCst),
        last_size,
        last_dur,
        last_ts.unwrap_or(0),
        if status == "ok" { 0 } else { 1 },
        name_label,
        free,
        est,
    )
}