use crate::config::Config;
use crate::logger::Logger;
use serde::Deserialize;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

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
        .map_err(|e| format!("pterodactyl websocket endpoint request failed: {e}"))?;
    let parsed: WsResp = resp
        .into_json()
        .map_err(|e| format!("cannot parse pterodactyl websocket response: {e}"))?;
    Ok((parsed.data.socket, parsed.data.token))
}

/// Run the websocket conversation in a helper thread so we can enforce a timeout.
fn run_ws_command(socket: &str, jwt: &str, command: &str, auth_timeout_secs: u64, console_wait_ms: u64) -> Result<bool, String> {
    let (tx, rx) = mpsc::channel();
    let socket = socket.to_string();
    let jwt = jwt.to_string();
    let command = command.to_string();

    let handle = thread::spawn(move || {
        let result: Result<bool, String> = (|| {
            let (mut ws, _) = tungstenite::connect(&socket)
                .map_err(|e| format!("websocket connect failed: {e}"))?;
            ws.send(tungstenite::Message::Text(jwt.clone().into()))
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

/// Send the pre-backup console command (e.g. "save-all") through the Pterodactyl
/// CLIENT API websocket so a live server flushes world data before archiving.
/// Returns Ok(echoed) — `echoed` tells the caller whether the panel confirmed the
/// command was accepted by the console.
pub fn pre_backup_save(cfg: &Config, logger: &Logger) -> Result<bool, String> {
    let p = &cfg.inner.pterodactyl;
    if !p.enabled {
        return Ok(true);
    }
    if p.panel_url.trim().is_empty() || p.api_key.trim().is_empty() || p.server_id.trim().is_empty() {
        return Err("pterodactyl integration enabled but panel_url/api_key/server_id missing in config.yml".into());
    }
    logger.info(&format!(
        "pterodactyl: sending console command '{}' to server {}",
        p.pre_backup_command, p.server_id
    ));
    let (socket, jwt) = fetch_ws_creds(cfg)?;
    let echoed = run_ws_command(&socket, &jwt, &p.pre_backup_command, 20, 5000)?;
    // Wait for the world to actually flush to disk.
    if cfg.inner.pterodactyl.pre_backup_delay_seconds > 0 {
        logger.debug(&format!(
            "pterodactyl: command accepted, waiting {}s for disk flush",
            p.pre_backup_delay_seconds
        ));
        thread::sleep(Duration::from_secs(p.pre_backup_delay_seconds));
    }
    if !echoed {
        logger.warn("pterodactyl: could not confirm the console command was run (continuing after flush delay)");
    }
    Ok(echoed)
}