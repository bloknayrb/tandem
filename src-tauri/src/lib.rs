use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Manager;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_shell::ShellExt;

/// Keep in sync with DEFAULT_MCP_PORT in src/shared/constants.ts (port 3479)
const HEALTH_URL: &str = "http://localhost:3479/health";
const SETUP_URL: &str = "http://localhost:3479/api/setup";
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(200);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(15);
const HTTP_CLIENT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESTARTS: u32 = 3;

// Tray menu item IDs — matched in on_menu_event
const MENU_OPEN: &str = "open";
const MENU_SETUP: &str = "setup";
const MENU_ABOUT: &str = "about";
const MENU_QUIT: &str = "quit";

/// Tracks the sidecar child process so we can kill it on shutdown.
struct SidecarState(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

/// Show, unminimize, and focus the main window.
fn show_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::error!("Main window not found — check window label matches tauri.conf.json");
        return;
    };
    if let Err(e) = window.unminimize() {
        log::warn!("unminimize failed: {e}");
    }
    if let Err(e) = window.show() {
        log::warn!("show failed: {e}");
    }
    if let Err(e) = window.set_focus() {
        log::warn!("set_focus failed: {e}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Info
            } else {
                log::LevelFilter::Warn
            };
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log_level)
                    .build(),
            )?;

            let client = build_http_client(HTTP_CLIENT_TIMEOUT)
                .expect("Failed to build HTTP client");
            app.manage(client.clone());

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = start_sidecar(&handle, &client).await {
                    log::error!("Sidecar failed: {e}");
                    use tauri_plugin_dialog::DialogExt;
                    handle
                        .dialog()
                        .message(format!(
                            "Tandem's server failed to start.\n\n\
                             Error: {e}\n\n\
                             Try restarting the application. If the problem persists, \
                             check that port 3479 is not in use by another process."
                        ))
                        .title("Server Error")
                        .show(|_| {});
                    return;
                }

                // Copy sample files to writable data dir (first-run only)
                if let Err(e) = copy_sample_files(&handle) {
                    log::warn!("Sample file copy failed (non-fatal): {e}");
                }

                // Setup fires after health check passes — in BOTH paths
                // (freshly spawned sidecar OR already-running dev server)
                if let Err(e) = run_setup(&handle, &client).await {
                    log::warn!("MCP setup failed (non-fatal): {e}");
                }
            });

            let open_i = MenuItem::with_id(app, MENU_OPEN, "Open Editor", true, None::<&str>)?;
            let setup_i = MenuItem::with_id(app, MENU_SETUP, "Setup Claude", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let about_i = MenuItem::with_id(app, MENU_ABOUT, "About Tandem", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, MENU_QUIT, "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(app, &[&open_i, &setup_i, &sep, &about_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .tooltip("Tandem")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    MENU_OPEN => show_main_window(app),
                    MENU_SETUP => {
                        let handle = app.clone();
                        let client = app.state::<reqwest::Client>().inner().clone();
                        tauri::async_runtime::spawn(async move {
                            match run_setup(&handle, &client).await {
                                Ok(()) => log::info!("MCP setup re-run from tray menu"),
                                Err(e) => log::warn!("MCP setup failed: {e}"),
                            }
                        });
                    }
                    MENU_ABOUT => {
                        use tauri_plugin_dialog::DialogExt;
                        app.dialog()
                            .message(format!(
                                "Tandem v{}\n\nCollaborative AI-human document editor",
                                env!("CARGO_PKG_VERSION")
                            ))
                            .title("About Tandem")
                            .show(|_| {});
                    }
                    MENU_QUIT => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Server keeps running in the background; tray menu provides "Quit"
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.hide() {
                    Ok(()) => api.prevent_close(),
                    Err(e) => {
                        log::error!("Failed to hide window on close: {e} — allowing native close");
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| panic!("Failed to build Tauri application: {e}"))
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
        Err(poisoned) => {
            log::error!("Sidecar state mutex poisoned — forcing access to kill child");
            poisoned.into_inner()
        }
    };
    if let Some(child) = guard.take() {
        log::info!("Killing sidecar process");
        if let Err(e) = child.kill() {
            log::error!("Failed to kill sidecar: {e}");
        }
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
async fn start_sidecar(handle: &tauri::AppHandle, client: &reqwest::Client) -> Result<(), String> {
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

        let (rx, child) = handle
            .shell()
            .sidecar("binaries/node-sidecar")
            .map_err(|e| format!("Failed to create sidecar command: {e}"))?
            .args([server_js_str.as_str()])
            .env("TANDEM_OPEN_BROWSER", "0")
            .env("TANDEM_DATA_DIR", app_data_dir_str.as_str())
            .spawn()
            .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

        // Shared flag: drain task sets true on Terminated, health poll bails early
        let sidecar_dead = Arc::new(AtomicBool::new(false));
        let dead_flag = sidecar_dead.clone();

        // Forward sidecar output to Tauri log system for diagnostics
        tauri::async_runtime::spawn(async move {
            use tauri_plugin_shell::process::CommandEvent;
            let mut rx = rx;
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line) => {
                        log::debug!("[sidecar] {}", String::from_utf8_lossy(&line));
                    }
                    CommandEvent::Stderr(line) => {
                        log::warn!("[sidecar] {}", String::from_utf8_lossy(&line));
                    }
                    CommandEvent::Error(err) => {
                        log::error!("[sidecar] error: {err}");
                    }
                    CommandEvent::Terminated(status) => {
                        log::warn!("[sidecar] terminated: {status:?}");
                        dead_flag.store(true, Ordering::Release);
                        break;
                    }
                    _ => {}
                }
            }
        });

        {
            let state = handle.state::<SidecarState>();
            let mut guard = state.0.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
            *guard = Some(child);
        }

        let started = std::time::Instant::now();
        match wait_for_health(&client, &sidecar_dead).await {
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
/// Bails early if `sidecar_dead` is set (process terminated before becoming healthy).
async fn wait_for_health(
    client: &reqwest::Client,
    sidecar_dead: &AtomicBool,
) -> Result<(), String> {
    let start = std::time::Instant::now();
    while start.elapsed() < HEALTH_TIMEOUT {
        if sidecar_dead.load(Ordering::Acquire) {
            return Err("Sidecar process terminated before becoming healthy".to_string());
        }
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

const CLAUDE_DOWNLOAD_URL: &str = "https://claude.ai/download";

/// POST to /api/setup with resolved paths. Best-effort — failures are logged, not fatal.
async fn run_setup(handle: &tauri::AppHandle, client: &reqwest::Client) -> Result<(), String> {
    let (node_binary, channel_path) = resolve_setup_paths(handle)?;

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

/// Copy sample/ files from resources to the writable data dir.
/// Copies each file only if the destination doesn't already exist (first-run).
fn copy_sample_files(handle: &tauri::AppHandle) -> Result<(), String> {
    let resource_dir = handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {e}"))?;
    let data_dir = handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

    let src_dir = resource_dir.join("sample");
    let dest_dir = data_dir.join("sample");

    // Skip if source doesn't exist (dev mode without build)
    if !src_dir.exists() {
        log::info!("No bundled sample/ directory — skipping copy");
        return Ok(());
    }

    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("Failed to create sample dir: {e}"))?;

    let entries = std::fs::read_dir(&src_dir)
        .map_err(|e| format!("Failed to read sample dir: {e}"))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {e}"))?;
        let dest = dest_dir.join(entry.file_name());
        if !dest.exists() {
            std::fs::copy(entry.path(), &dest)
                .map_err(|e| format!("Failed to copy {}: {e}", entry.file_name().to_string_lossy()))?;
            log::info!("Copied sample/{} to data dir", entry.file_name().to_string_lossy());
        }
    }

    Ok(())
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
