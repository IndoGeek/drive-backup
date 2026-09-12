use crate::config::Config;
use crate::logger::Logger;
use serde::Deserialize;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::client::IntoClientRequest;

const STATE_OFFLINE: &str = "offline";
const STATE_RUNNING: &str = "running";

/// Pterodactyl integration error. `critical` errors MUST abort the run even
/// when `fail_on_error: false`, because they mean we lost track of the server
/// state (e.g. it never confirmed it stopped) and a backup taken now could be
/// corrupt. They are always produced together with a `PteroGuard`, so the
/// server still gets restarted before the run ends.
pub struct PteroError {
    pub message: String,
    pub critical: bool,
}

impl PteroError {
    fn soft(msg: impl Into<String>) -> Self {
        PteroError { message: msg.into(), critical: false }
    }
    fn critical(msg: impl Into<String>) -> Self {
        PteroError { message: msg.into(), critical: true }
    }
}

#[derive(Deserialize)]
struct WsResp {
    data: WsData,
}

#[derive(Deserialize)]
struct WsData {
    token: String,
    socket: String,
}

/// Ask Pterodactyl panel for websocket credentials.
fn fetch_ws_creds(cfg: &Config) -> Result<(String, String), String> {
    let base = cfg.inner.pterodactyl.panel_url.trim().trim_end_matches('/');
    let url = format!("{}/api/client/servers/{}/websocket", base, cfg.inner.pterodactyl.server_id);
    let auth = format!("Bearer {}", cfg.inner.pterodactyl.api_key.trim());
    let resp = ureq::get(&url)
        .timeout(Duration::from_secs(30))
        .set("Authorization", &auth)
        .set("Accept", "application/json")
        .call()
        .map_err(|e| api_err_msg("pterodactyl websocket endpoint request", e))?;
    let parsed: WsResp = resp
        .into_json()
        .map_err(|e| format!("cannot parse pterodactyl websocket response: {e}"))?;
    Ok((parsed.data.socket, parsed.data.token))
}

/// Run the websocket conversation in a helper thread so we can enforce a timeout.
fn run_ws_command(socket: &str, jwt: &str, origin: &str, command: &str, auth_timeout_secs: u64, console_wait_ms: u64) -> Result<bool, String> {
    let (tx, rx) = mpsc::channel();
    let socket = socket.to_string();
    let jwt = jwt.to_string();
    let origin = origin.to_string();
    let command = command.to_string();

    let handle = thread::spawn(move || {
        let result: Result<bool, String> = (|| {
            // Wings (and some forks) reject websocket upgrades unless the Origin
            // header matches the PANEL url. Build an explicit request and set
            // Origin so the panel's `socket` endpoint accepts the upgrade.
            let mut request = socket
                .into_client_request()
                .map_err(|e| format!("cannot build websocket request: {e}"))?;
            request
                .headers_mut()
                .insert("Origin", http::HeaderValue::from_str(&origin).map_err(|e| format!("bad origin header: {e}"))?);
            let (mut ws, _) = tungstenite::connect(request)
                .map_err(|e| format!("websocket connect failed: {e}"))?;

            // Pterodactyl authenticates via a JSON auth event carrying the JWT.
            let auth = serde_json::json!({"event": "auth", "args": [jwt]});
            ws.send(tungstenite::Message::Text(auth.to_string().into()))
                .map_err(|e| format!("websocket auth send failed: {e}"))?;

            // Authenticate
            let mut authed = false;
            let deadline = std::time::Instant::now() + Duration::from_secs(auth_timeout_secs);
            while !authed {
                if std::time::Instant::now() > deadline {
                    return Err("timeout waiting for pterodactyl auth".into());
                }
                match ws.read() {
                    Ok(tungstenite::Message::Text(t)) => {
                        if t.contains("auth success") {
                            authed = true;
                        } else if t.contains("auth failure") {
                            return Err(format!("pterodactyl auth rejected: {t}"));
                        }
                    }
                    Ok(_) => {}
                    Err(e) => return Err(format!("websocket read error: {e}")),
                }
            }

            // Subscribe to console so the panel forwards us the command echo
            let subscribe = serde_json::json!({"event": "console", "args": ["subscribe"]});
            ws.send(tungstenite::Message::Text(subscribe.to_string().into()))
                .map_err(|e| format!("websocket subscribe failed: {e}"))?;

            // Send the command
            if !command.trim().is_empty() {
                let payload = serde_json::json!({"event": "send command", "args": [command]});
                ws.send(tungstenite::Message::Text(payload.to_string().into()))
                    .map_err(|e| format!("websocket command send failed: {e}"))?;
            }

            // Best-effort: wait for the command to be echoed in console output
            let mut echoed = false;
            let console_deadline = std::time::Instant::now() + Duration::from_millis(console_wait_ms);
            while std::time::Instant::now() < console_deadline {
                match ws.read() {
                    Ok(tungstenite::Message::Text(t)) => {
                        if t.contains(command.trim()) {
                            echoed = true;
                        }
                        if t.contains("\"event\":\"console output\"") && echoed {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(e) => return Err(format!("websocket read error while waiting for echo: {e}")),
                }
            }
            let _ = ws.close(None);
            Ok(echoed)
        })();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(Duration::from_secs(total_timeout(auth_timeout_secs))) {
        Ok(Ok(echoed)) => {
            let _ = handle.join();
            Ok(echoed)
        }
        Ok(Err(e)) => {
            let _ = handle.join();
            Err(e)
        }
        Err(_) => {
            let _ = handle.join();
            Err("pterodactyl websocket timed out waiting for reply".into())
        }
    }
}

fn total_timeout(auth_secs: u64) -> u64 {
    auth_secs.max(15) + 5
}

/// Derive the websocket `Origin` header value from the panel URL. Wings forks
/// reject upgrades whose Origin host does not match the panel.
fn origin_from_panel(cfg: &Config) -> String {
    let base = cfg.inner.pterodactyl.panel_url.trim().trim_end_matches('/');
    if base.starts_with("https://") {
        base.to_string()
    } else {
        format!("https://{}", base)
    }
}

fn api_base(cfg: &Config) -> String {
    format!(
        "{}/api/client/servers/{}",
        cfg.inner.pterodactyl.panel_url.trim().trim_end_matches('/'),
        cfg.inner.pterodactyl.server_id
    )
}

/// Turn a ureq error into a helpful message. 403 from Pterodactyl's CLIENT API
/// almost always means the API key is an Application key (ptla_) or belongs to
/// an account without control of this server.
fn api_err_msg(op: &str, e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(403, _) => format!(
            "{op} rejected with HTTP 403 Forbidden. The Pterodactyl CLIENT API key (ptlc_...) is missing, wrong, or was created on an account that does not control this server. NOTE: Application API keys start with 'ptla_' and are NOT accepted on /api/client/* — create a Client API key (ptlc_) from your panel Account -> API Credentials."
        ),
        ureq::Error::Status(code, _) => format!("{op} failed with HTTP status {code}"),
        other => format!("{op} failed: {other}"),
    }
}

fn api_get(cfg: &Config, path: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}{}", api_base(cfg), path);
    let auth = format!("Bearer {}", cfg.inner.pterodactyl.api_key.trim());
    ureq::get(&url)
        .timeout(Duration::from_secs(30))
        .set("Authorization", &auth)
        .set("Accept", "application/json")
        .call()
        .map_err(|e| api_err_msg(&format!("pterodactyl GET {path}"), e))?
        .into_json()
        .map_err(|e| format!("cannot parse pterodactyl response for {path}: {e}"))
}

fn api_post(cfg: &Config, path: &str, body: &serde_json::Value) -> Result<(), String> {
    let url = format!("{}{}", api_base(cfg), path);
    let auth = format!("Bearer {}", cfg.inner.pterodactyl.api_key.trim());
    ureq::post(&url)
        .timeout(Duration::from_secs(30))
        .set("Authorization", &auth)
        .set("Accept", "application/json")
        .send_json(body.clone())
        .map_err(|e| api_err_msg(&format!("pterodactyl POST {path}"), e))?;
    Ok(())
}

/// Current state reported by the panel: starting | running | stopping | offline | ...
fn server_current_state(cfg: &Config) -> Result<String, String> {
    let v = api_get(cfg, "/resources")?;
    let s = v["attributes"]["current_state"].as_str().unwrap_or("").to_string();
    if s.is_empty() {
        Err(format!("cannot read current_state from pterodactyl resources endpoint: {v}"))
    } else {
        Ok(s)
    }
}

/// Send a power signal (start | stop | restart | kill) to the server.
fn power_signal(cfg: &Config, signal: &str) -> Result<(), String> {
    api_post(cfg, "/power", &serde_json::json!({"signal": signal}))
}

/// Poll the panel until the server reaches `target`, logging each transition.
fn wait_for_state(cfg: &Config, target: &str, timeout_secs: u64, logger: &Logger) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(timeout_secs.max(30));
    let mut last = String::new();
    loop {
        let state = server_current_state(cfg)?;
        if state != last {
            last = state.clone();
            logger.info(&format!("pterodactyl: server state -> {state}"));
        }
        if state == target {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("server stuck in state '{state}' and never reached '{target}' after {}s", timeout_secs.max(30)));
        }
        thread::sleep(Duration::from_secs(5));
    }
}

/// Start the server (if it is not already running) and wait for confirmation.
fn restart_server(cfg: &Config, logger: &Logger, timeout_secs: u64) -> Result<(), String> {
    let current = server_current_state(cfg).unwrap_or_default();
    if current == STATE_RUNNING {
        return Ok(());
    }
    logger.info("pterodactyl: sending power signal 'start' to restart the server...");
    power_signal(cfg, "start")?;
    wait_for_state(cfg, STATE_RUNNING, timeout_secs, logger)
}

/// RAII guard that guarantees the server is started again when it goes out of
/// scope, no matter which path `run_backup` returns through (success, failure,
/// early return, or even a panic). The only way a stopped server is left down
/// is if the whole process is killed hard (SIGKILL).
pub struct PteroGuard<'a> {
    cfg: &'a Config,
    logger: &'a Logger,
    shutdown_server: bool,
    start_server_after: bool,
    started: bool,
    start_timeout_secs: u64,
}

impl<'a> PteroGuard<'a> {
    fn new(cfg: &'a Config, logger: &'a Logger, start_server_after: bool, start_timeout_secs: u64) -> Self {
        PteroGuard {
            cfg,
            logger,
            shutdown_server: true,
            start_server_after,
            started: false,
            start_timeout_secs,
        }
    }

    /// Explicitly restart the server on the happy path so the log order reads
    /// naturally (restart before the "BACKUP RUN FINISHED OK" line).
    pub fn restart_now(&mut self) {
        if self.shutdown_server && self.start_server_after && !self.started {
            match restart_server(self.cfg, self.logger, self.start_timeout_secs) {
                Ok(()) => {
                    self.started = true;
                    self.logger.info("pterodactyl: server started again after backup");
                }
                Err(e) => {
                    // not marked started, so Drop will retry once more on return
                    self.logger.error(&format!(
                        "pterodactyl: FAILED to restart the server after backup ({e}) - retrying on exit"
                    ));
                }
            }
        }
    }
}

impl<'a> Drop for PteroGuard<'a> {
    fn drop(&mut self) {
        self.restart_now();
    }
}

/// Pre-backup Pterodactyl integration.
///
/// When the server is stopped for the backup, a `PteroGuard` is written into
/// `out_guard` that restarts the server when it is dropped (i.e. when the run
/// ends). That stays true even if this function fails afterwards: a failure
/// that happens after the stop signal was sent is returned as `critical`, and
/// the caller MUST abort the run.
pub fn pre_backup<'a>(
    cfg: &'a Config,
    logger: &'a Logger,
    out_guard: &mut Option<PteroGuard<'a>>,
) -> Result<(), PteroError> {
    let p = &cfg.inner.pterodactyl;
    if !p.enabled {
        return Ok(());
    }
    if p.panel_url.trim().is_empty() || p.api_key.trim().is_empty() || p.server_id.trim().is_empty() {
        return Err(PteroError::soft(
            "pterodactyl integration enabled but panel_url/api_key/server_id missing in config.yml".to_string(),
        ));
    }
    let key = p.api_key.trim();
    if key.starts_with("ptla_") || key.starts_with("PKLA") {
        return Err(PteroError::soft(
            "the configured Pterodactyl API key starts with 'ptla_' and is an APPLICATION key, \
             which is only accepted on /api/application/* routes. backup-mgr talks to the CLIENT \
             API (/api/client/*), which requires a CLIENT key (starts with 'ptlc_'). \
             Create a Client API key from your panel user menu (Account -> API Credentials / \
             'Create Credentials'), NOT the Admin 'Application API' page, and paste it into \
             pterodactyl.api_key in config.yml."
                .to_string(),
        ));
    }
    if !key.starts_with("ptlc_") {
        logger.warn(&format!(
            "pterodactyl: api_key does not start with the usual 'ptlc_' (Client API key) prefix — current key starts with '{}...'. If the panel rejects it, generate a Client (not Application) API key.",
            key.chars().take(5).collect::<String>()
        ));
    }

    // 1) Flush the world to disk (e.g. "save-all"). The server stays online.
    logger.info(&format!(
        "pterodactyl: sending console command '{}' to server {}",
        p.pre_backup_command, p.server_id
    ));
    let (socket, jwt) = fetch_ws_creds(cfg)
        .map_err(PteroError::soft)?;
    let origin = origin_from_panel(cfg);
    let echoed = run_ws_command(&socket, &jwt, &origin, &p.pre_backup_command, 20, 5000)
        .map_err(PteroError::soft)?;

    // 2) Wait while the flush finishes writing to disk.
    if p.pre_backup_delay_seconds > 0 {
        logger.debug(&format!(
            "pterodactyl: command accepted, waiting {}s for disk flush",
            p.pre_backup_delay_seconds
        ));
        thread::sleep(Duration::from_secs(p.pre_backup_delay_seconds));
    }
    if !echoed {
        logger.warn("pterodactyl: could not confirm the console command was run (continuing)");
    }

    // 3) Legacy mode: save-only, never stop the server.
    if !p.shutdown_server {
        return Ok(());
    }

    // 4) Stop the server completely so every file is quiescent and readable.
    let current = match server_current_state(cfg) {
        Ok(s) => s,
        Err(e) => {
            return Err(PteroError::soft(format!(
                "pterodactyl: cannot read server state, will not stop/archive blindly: {e}"
            )))
        }
    };
    if current == STATE_OFFLINE {
        logger.info("pterodactyl: server already offline");
        *out_guard = Some(PteroGuard::new(cfg, logger, p.start_server_after, p.start_timeout_seconds));
        return Ok(());
    }
    if !matches!(p.shutdown_signal.trim(), "stop" | "kill") {
        logger.warn(&format!(
            "pterodactyl: shutdown_signal '{}' is unusual; expected 'stop' (graceful) or 'kill' (immediate)",
            p.shutdown_signal
        ));
    }

    // From here on the server may end up stopped, so the guard already owns the
    // restart. Every failure past this point is critical: continuing would
    // archive a server that is mid-shutdown / in an unknown state.
    *out_guard = Some(PteroGuard::new(cfg, logger, p.start_server_after, p.start_timeout_seconds));
    logger.info(&format!(
        "pterodactyl: sending power signal '{}' and waiting (up to {}s) for the server to go fully offline",
        p.shutdown_signal, p.stop_timeout_seconds
    ));
    power_signal(cfg, p.shutdown_signal.trim()).map_err(PteroError::critical)?;
    match wait_for_state(cfg, STATE_OFFLINE, p.stop_timeout_seconds, logger) {
        Ok(()) => {
            logger.info("pterodactyl: server fully stopped - files are quiescent, starting archive");
            Ok(())
        }
        Err(e) => Err(PteroError::critical(format!(
            "cannot proceed with backup: {e} (the server will be restarted automatically when this run ends)"
        ))),
    }
}