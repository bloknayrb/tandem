use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;
use tauri_plugin_shell::ShellExt;

/// Keep in sync with DEFAULT_MCP_PORT in src/shared/constants.ts
const HEALTH_URL: &str = "http://localhost:3479/health";
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(200);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESTARTS: u32 = 3;

/// Tracks the sidecar child process so we can kill it on shutdown.
struct SidecarState(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = start_sidecar(&handle).await {
                    log::error!("Sidecar failed: {e}");
                    // TODO: show user-visible error dialog
                    return;
                }

                // Setup fires after health check passes — in BOTH paths
                // (freshly spawned sidecar OR already-running dev server)
                if let Err(e) = run_setup(&handle).await {
                    log::warn!("MCP setup failed (non-fatal): {e}");
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Server keeps running in the background; tray menu provides "Quit"
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                kill_sidecar(app);
            }
        });
}

/// Kill the sidecar process if one is running.
fn kill_sidecar(handle: &tauri::AppHandle) {
    let state: tauri::State<'_, SidecarState> = handle.state();
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(child) = guard.take() {
        log::info!("Killing sidecar process");
        let _ = child.kill();
    }
}

fn build_http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

/// Spawn the Node.js sidecar and wait for the health endpoint.
/// Retries up to MAX_RESTARTS times with exponential backoff on crash.
async fn start_sidecar(handle: &tauri::AppHandle) -> Result<(), String> {
    let client = build_http_client(Duration::from_secs(2))?;

    // Dev mode: skip spawn if server is already running (e.g. npm run dev:standalone)
    if check_health(&client).await {
        log::info!("Server already healthy — skipping sidecar spawn");
        return Ok(());
    }

    let resource_dir = handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {e}"))?;
    let server_js = resource_dir.join("dist/server/index.js");
    let server_js_str = server_js.to_string_lossy().into_owned();

    let app_data_dir = handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let app_data_dir_str = app_data_dir.to_string_lossy().into_owned();

    for attempt in 0..=MAX_RESTARTS {
        if attempt > 0 {
            let backoff = Duration::from_secs(2u64.pow(attempt - 1));
            log::warn!(
                "Sidecar crashed — restarting (attempt {attempt}/{MAX_RESTARTS}, backoff {backoff:?})"
            );
            tokio::time::sleep(backoff).await;
        }

        let (_rx, child) = handle
            .shell()
            .sidecar("binaries/node-sidecar")
            .map_err(|e| format!("Failed to create sidecar command: {e}"))?
            .args([server_js_str.as_str()])
            .env("TANDEM_OPEN_BROWSER", "0")
            .env("TANDEM_DATA_DIR", app_data_dir_str.as_str())
            .spawn()
            .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

        {
            let state = handle.state::<SidecarState>();
            let mut guard = state.0.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
            *guard = Some(child);
        }

        let started = std::time::Instant::now();
        match wait_for_health(&client).await {
            Ok(()) => {
                log::info!("Sidecar healthy after {:.1}s", started.elapsed().as_secs_f64());
                return Ok(());
            }
            Err(e) => {
                log::error!("Health check failed: {e}");
                kill_sidecar(handle);
            }
        }
    }

    Err(format!(
        "Server failed to start after {MAX_RESTARTS} restart attempts"
    ))
}

/// Poll the health endpoint until it responds 200.
async fn wait_for_health(client: &reqwest::Client) -> Result<(), String> {
    let start = std::time::Instant::now();
    while start.elapsed() < HEALTH_TIMEOUT {
        if let Ok(resp) = client.get(HEALTH_URL).send().await {
            if resp.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(HEALTH_POLL_INTERVAL).await;
    }

    Err(format!(
        "Health endpoint not ready after {:.0}s",
        HEALTH_TIMEOUT.as_secs()
    ))
}

/// Single health check — returns true if server is already responding.
async fn check_health(client: &reqwest::Client) -> bool {
    if let Ok(resp) = client.get(HEALTH_URL).send().await {
        return resp.status().is_success();
    }
    false
}

const SETUP_URL: &str = "http://localhost:3479/api/setup";
const CLAUDE_DOWNLOAD_URL: &str = "https://claude.ai/download";

/// POST to /api/setup with resolved paths. Best-effort — failures are logged, not fatal.
async fn run_setup(handle: &tauri::AppHandle) -> Result<(), String> {
    let (node_binary, channel_path) = resolve_setup_paths(handle)?;

    let client = build_http_client(Duration::from_secs(5))?;
    let body = serde_json::json!({
        "nodeBinary": node_binary,
        "channelPath": channel_path,
    });

    let resp = client
        .post(SETUP_URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Setup request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Setup returned {status}: {text}"));
    }

    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Setup response parse error: {e}"))?;

    // Log what was configured
    if let Some(configured) = result["data"]["configured"].as_array() {
        for target in configured {
            if let Some(label) = target.as_str() {
                log::info!("MCP config written for {label}");
            }
        }
    }

    if let Some(errors) = result["data"]["errors"].as_array() {
        for err in errors {
            if let Some(msg) = err.as_str() {
                log::warn!("Setup error: {msg}");
            }
        }
    }

    // Show dialog if no Claude installations found
    let targets = result["data"]["targets"]
        .as_array()
        .map(|a| a.len())
        .unwrap_or(0);

    if targets == 0 {
        show_no_claude_dialog(handle);
    }

    Ok(())
}

/// Resolve nodeBinary and channelPath based on build mode.
///
/// Sidecar binaries live alongside the main executable (not in resource_dir)
/// and use the naming convention `node-sidecar-{target-triple}[.exe]`.
/// Channel JS and other resources live in resource_dir.
fn resolve_setup_paths(handle: &tauri::AppHandle) -> Result<(String, String), String> {
    if cfg!(debug_assertions) {
        // Dev mode: use bare "node" (PATH-dependent) and repo-relative channel path
        let channel_path = std::env::current_dir()
            .map_err(|e| format!("Failed to get cwd: {e}"))?
            .join("dist/channel/index.js");
        Ok(("node".to_string(), channel_path.to_string_lossy().into_owned()))
    } else {
        // Release mode: channel JS is a resource
        let resource_dir = handle
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to resolve resource dir: {e}"))?;
        let channel_path = resource_dir.join("dist/channel/index.js");

        // Sidecar binary lives alongside the main executable with target triple suffix
        let exe_dir = std::env::current_exe()
            .map_err(|e| format!("Failed to get current exe: {e}"))?
            .parent()
            .ok_or("Failed to get exe parent dir")?
            .to_path_buf();

        let sidecar_name = if cfg!(target_os = "windows") {
            format!("node-sidecar-{}.exe", env!("TARGET_TRIPLE"))
        } else {
            format!("node-sidecar-{}", env!("TARGET_TRIPLE"))
        };
        let node_binary = exe_dir.join(sidecar_name);

        Ok((
            node_binary.to_string_lossy().into_owned(),
            channel_path.to_string_lossy().into_owned(),
        ))
    }
}

/// Show a non-blocking dialog informing the user that Claude is not installed.
fn show_no_claude_dialog(handle: &tauri::AppHandle) {
    use tauri_plugin_dialog::DialogExt;

    handle
        .dialog()
        .message(format!(
            "No Claude installation found.\n\n\
             Tandem works as a standalone editor, but AI collaboration \
             features require Claude Desktop or Claude Code.\n\n\
             Download Claude at: {CLAUDE_DOWNLOAD_URL}"
        ))
        .title("Claude Not Found")
        .show(|_| {});
}
