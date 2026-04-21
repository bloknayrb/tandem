mod token_store;

#[cfg(target_os = "windows")]
mod cowork_atomic_json;

/// Process-wide mutex for tests that mutate `TANDEM_COWORK_ROOT_OVERRIDE`.
/// Shared across `cowork_installer` and `cowork_workspace_scan` test modules so
/// they serialize against each other and do not race on the env var.
#[cfg(test)]
pub(crate) static COWORK_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
#[cfg(target_os = "windows")]
mod cowork_workspace_scan;
#[cfg(target_os = "windows")]
mod cowork_installer;
#[cfg(target_os = "windows")]
mod firewall;
#[cfg(target_os = "windows")]
mod cowork_meta;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Manager;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

/// Keep in sync with DEFAULT_MCP_PORT in src/shared/constants.ts (port 3479)
const HEALTH_URL: &str = "http://localhost:3479/health";
const SETUP_URL: &str = "http://localhost:3479/api/setup";
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(200);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(15);
const HTTP_CLIENT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESTARTS: u32 = 3;
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(8 * 60 * 60);

/// Strip the Windows extended-length path prefix (`\\?\`) that Tauri's
/// `resource_dir()` / `app_data_dir()` return. Node.js can't resolve these.
fn strip_win_prefix(path: &std::path::Path) -> String {
    let s = path.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

// Tray menu item IDs — matched in on_menu_event
const MENU_OPEN: &str = "open";
const MENU_SETUP: &str = "setup";
const MENU_ABOUT: &str = "about";
const MENU_QUIT: &str = "quit";
const MENU_UPDATE: &str = "update";

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
    let tray_available = Arc::new(AtomicBool::new(false));
    let tray_flag_for_setup = tray_available.clone();
    let tray_flag_for_close = tray_available.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            log::info!("Second instance detected — args: {args:?}, cwd: {cwd}");
            show_main_window(app);
            // TODO: if args contains a file path, open it via the sidecar API
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SidecarState(Mutex::new(None)))
        .setup(move |app| {
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
                // Copy sample files BEFORE sidecar spawn so the server's
                // auto-open finds them during its startup sequence
                if let Err(e) = copy_sample_files(&handle) {
                    log::warn!("Sample file copy failed (non-fatal): {e}");
                }

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

                // Setup fires after health check passes — in BOTH paths
                // (freshly spawned sidecar OR already-running dev server)
                if let Err(e) = run_setup(&handle, &client).await {
                    log::warn!("MCP setup failed (non-fatal): {e}");
                }

                check_for_update(&handle, false).await;
            });

            // `handle` was moved into the spawn above; clone a fresh one
            let periodic_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(UPDATE_CHECK_INTERVAL);
                interval.tick().await; // Discard the first immediate tick — launch check covers it
                loop {
                    interval.tick().await;
                    check_for_update(&periodic_handle, false).await;
                }
            });

            let open_i = MenuItem::with_id(app, MENU_OPEN, "Open Editor", true, None::<&str>)?;
            let setup_i = MenuItem::with_id(app, MENU_SETUP, "Setup Claude", true, None::<&str>)?;
            let update_i = MenuItem::with_id(app, MENU_UPDATE, "Check for Updates", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let about_i = MenuItem::with_id(app, MENU_ABOUT, "About Tandem", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, MENU_QUIT, "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(app, &[&open_i, &setup_i, &update_i, &sep, &about_i, &quit_i])?;

            let icon = app
                .default_window_icon()
                .cloned()
                .expect("No window icon configured — check bundle.icon in tauri.conf.json");

            let tray_result = TrayIconBuilder::new()
                .icon(icon)
                .tooltip("Tandem")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    MENU_OPEN => show_main_window(app),
                    MENU_SETUP => {
                        let handle = app.clone();
                        let client = app.state::<reqwest::Client>().inner().clone();
                        tauri::async_runtime::spawn(async move {
                            use tauri_plugin_dialog::DialogExt;
                            match run_setup(&handle, &client).await {
                                Ok(()) => {
                                    log::info!("MCP setup re-run from tray menu");
                                    handle
                                        .dialog()
                                        .message("MCP configuration updated successfully.")
                                        .title("Setup Complete")
                                        .show(|_| {});
                                }
                                Err(e) => {
                                    log::warn!("MCP setup failed: {e}");
                                    handle
                                        .dialog()
                                        .message(format!("Setup failed: {e}"))
                                        .title("Setup Error")
                                        .show(|_| {});
                                }
                            }
                        });
                    }
                    MENU_UPDATE => {
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            check_for_update(&handle, true).await;
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
                    MENU_QUIT => {
                        log::info!("User-initiated quit from tray menu");
                        app.exit(0);
                    }
                    other => {
                        log::debug!("Unhandled tray menu event: {other}");
                    }
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
                .build(app);

            match tray_result {
                Ok(_tray) => {
                    tray_flag_for_setup.store(true, Ordering::Release);
                }
                Err(e) => {
                    if cfg!(target_os = "linux") {
                        log::error!(
                            "System tray unavailable: {e}. \
                             On Linux, install libappindicator3-dev. \
                             Tandem will continue without a tray icon."
                        );
                    } else {
                        return Err(e.into());
                    }
                }
            }

            Ok(())
        })
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if tray_flag_for_close.load(Ordering::Acquire) {
                    // Tray available: hide to tray, server keeps running
                    match window.hide() {
                        Ok(()) => api.prevent_close(),
                        Err(e) => {
                            log::error!("Failed to hide window on close: {e} — allowing native close");
                        }
                    }
                } else {
                    // No tray (Linux without libappindicator): exit cleanly so
                    // RunEvent::Exit fires and the sidecar is killed
                    log::info!("No tray icon — exiting on window close");
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            cowork_scan_workspaces,
            cowork_toggle_integration,
            cowork_rescan,
            cowork_get_status,
            cowork_get_meta,
            cowork_detect_vethernet_subnet,
            cowork_apply_token,
            cowork_install_into_workspace,
            cowork_uninstall_from_workspace,
            cowork_set_lan_ip_override,
            cowork_retry_admin_elevation,
        ])
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
    let server_js_str = strip_win_prefix(&server_js);

    let app_data_dir = handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let app_data_dir_str = strip_win_prefix(&app_data_dir);

    // Obtain or create the auth token before spawning — the Node sidecar
    // reads TANDEM_AUTH_TOKEN and skips its own generation when it's present.
    // Token-less is acceptable for now; PR b will enforce it.
    let auth_token: Option<String> = match token_store::get_or_create_token() {
        Ok(token) => Some(token),
        Err(e) => {
            log::error!("Failed to obtain auth token (sidecar will start token-less): {e}");
            None
        }
    };

    for attempt in 0..=MAX_RESTARTS {
        if attempt > 0 {
            let backoff = Duration::from_secs(2u64.pow(attempt - 1));
            log::warn!(
                "Sidecar crashed — restarting (attempt {attempt}/{MAX_RESTARTS}, backoff {backoff:?})"
            );
            tokio::time::sleep(backoff).await;
        }

        let mut cmd = handle
            .shell()
            .sidecar("node-sidecar")
            .map_err(|e| format!("Failed to create sidecar command: {e}"))?
            .args([server_js_str.as_str()])
            .env("TANDEM_OPEN_BROWSER", "0")
            .env("TANDEM_DATA_DIR", app_data_dir_str.as_str());

        if let Some(ref token) = auth_token {
            cmd = cmd.env("TANDEM_AUTH_TOKEN", token.as_str());
        }

        let (rx, child) = cmd
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
                    other => {
                        log::debug!("[sidecar] unhandled event: {other:?}");
                    }
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
                if !wait_for_port_release(client, 1).await {
                    log::warn!("Port still held 1s after kill — backoff will provide additional buffer");
                }
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
    let mut last_error: Option<String> = None;
    while start.elapsed() < HEALTH_TIMEOUT {
        if sidecar_dead.load(Ordering::Acquire) {
            return Err("Sidecar process terminated before becoming healthy".to_string());
        }
        match client.get(HEALTH_URL).send().await {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            Ok(resp) => {
                last_error = Some(format!("HTTP {}", resp.status()));
            }
            Err(e) => {
                last_error = Some(e.to_string());
            }
        }
        tokio::time::sleep(HEALTH_POLL_INTERVAL).await;
    }
    Err(format!(
        "Health endpoint not ready after {}s (last error: {})",
        HEALTH_TIMEOUT.as_secs(),
        last_error.unwrap_or_else(|| "none".to_string())
    ))
}

/// Single health check — returns true if server is already responding.
async fn check_health(client: &reqwest::Client) -> bool {
    if let Ok(resp) = client.get(HEALTH_URL).send().await {
        return resp.status().is_success();
    }
    false
}

/// Poll until the health endpoint stops responding (port released).
/// Returns true if released within the deadline, false on timeout.
async fn wait_for_port_release(client: &reqwest::Client, deadline_secs: u64) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(deadline_secs);
    while tokio::time::Instant::now() < deadline {
        if !check_health(client).await {
            return true;
        }
        tokio::time::sleep(HEALTH_POLL_INTERVAL).await;
    }
    false
}

/// Resolve the sidecar executable path (alongside the main binary).
fn sidecar_exe_path() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("current_exe failed: {e}"))?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "exe path has no parent dir".to_string())?
        .to_path_buf();
    let name = if cfg!(target_os = "windows") {
        format!("node-sidecar-{}.exe", env!("TARGET_TRIPLE"))
    } else {
        format!("node-sidecar-{}", env!("TARGET_TRIPLE"))
    };
    Ok(exe_dir.join(name))
}

/// Poll until the sidecar exe file is writable (OS released the handle).
#[cfg(target_os = "windows")]
async fn wait_for_sidecar_unlock(deadline_secs: u64) -> bool {
    let sidecar_path = match sidecar_exe_path() {
        Ok(p) if p.exists() => p,
        Ok(p) => {
            // Missing in release = packaging bug; in dev = normal (no bundled sidecar).
            if cfg!(debug_assertions) {
                log::debug!("Sidecar exe not on disk at {} — skipping unlock wait (dev mode)", p.display());
            } else {
                log::warn!("Sidecar exe not on disk at {} — skipping unlock wait (packaging bug?)", p.display());
            }
            return true;
        }
        Err(e) => {
            if cfg!(debug_assertions) {
                log::debug!("Could not resolve sidecar exe path: {e} — skipping unlock wait");
            } else {
                log::warn!("Could not resolve sidecar exe path: {e} — skipping unlock wait");
            }
            return true;
        }
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(deadline_secs);
    while tokio::time::Instant::now() < deadline {
        if std::fs::OpenOptions::new().write(true).open(&sidecar_path).is_ok() {
            log::info!("Sidecar exe file lock released");
            return true;
        }
        tokio::time::sleep(HEALTH_POLL_INTERVAL).await;
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

    // Validate response shape
    if result.get("data").is_none() {
        return Err("Setup response missing 'data' field".to_string());
    }

    // Log what was configured
    let configured_count = if let Some(configured) = result["data"]["configured"].as_array() {
        for target in configured {
            if let Some(label) = target.as_str() {
                log::info!("MCP config written for {label}");
            }
        }
        configured.len()
    } else {
        0
    };

    // Check for errors — return Err if all targets failed
    if let Some(errors) = result["data"]["errors"].as_array() {
        if !errors.is_empty() {
            let msgs: Vec<&str> = errors.iter().filter_map(|e| e.as_str()).collect();
            if configured_count == 0 {
                return Err(format!("All config writes failed: {}", msgs.join("; ")));
            }
            // Partial success: log warnings but don't fail
            for msg in &msgs {
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

        let node_binary = sidecar_exe_path()
            .map_err(|e| format!("Failed to resolve sidecar exe path: {e}"))?;

        Ok((
            strip_win_prefix(&node_binary),
            strip_win_prefix(&channel_path),
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
        if cfg!(debug_assertions) {
            log::info!("No bundled sample/ directory — skipping copy (dev mode)");
        } else {
            log::warn!("No bundled sample/ directory in release build — first-run tutorial will be missing");
        }
        return Ok(());
    }

    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("Failed to create sample dir: {e}"))?;

    let entries = std::fs::read_dir(&src_dir)
        .map_err(|e| format!("Failed to read sample dir: {e}"))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {e}"))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to get file type: {e}"))?;
        if !file_type.is_file() {
            log::debug!(
                "Skipping non-file entry: {}",
                entry.file_name().to_string_lossy()
            );
            continue;
        }
        let dest = dest_dir.join(entry.file_name());
        if !dest.exists() {
            std::fs::copy(entry.path(), &dest).map_err(|e| {
                format!(
                    "Failed to copy {}: {e}",
                    entry.file_name().to_string_lossy()
                )
            })?;
            log::info!(
                "Copied sample/{} to data dir",
                entry.file_name().to_string_lossy()
            );
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Cowork Tauri invoke commands
// ---------------------------------------------------------------------------
// All commands have Windows-native and non-Windows stub variants so that
// tauri::generate_handler![] compiles on all platforms.

/// Error string returned by every non-Windows Cowork stub.
#[cfg(not(target_os = "windows"))]
const WINDOWS_ONLY_ERR: &str = "Cowork integration is Windows-only in v0.8.0";

/// Scan for Cowork workspace directories.
#[cfg(target_os = "windows")]
#[tauri::command]
fn cowork_scan_workspaces() -> Result<Vec<String>, String> {
    let paths = cowork_workspace_scan::find_cowork_workspaces();
    Ok(paths
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect())
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cowork_scan_workspaces() -> Result<Vec<String>, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Enable or disable the Cowork integration.
///
/// On enable: fetches auth token, detects vEthernet subnet, adds allow firewall
/// rule, walks workspaces, installs plugin entries. On UAC decline: fail-closed —
/// writes a deny rule and does NOT write plugin entries (invariant §4).
/// On disable: uninstalls plugin entries, removes firewall rules.
#[cfg(target_os = "windows")]
#[tauri::command]
fn cowork_toggle_integration(enabled: bool) -> Result<String, String> {
    use cowork_installer::{install_tandem_plugin_into_workspace, uninstall_tandem_plugin_from_workspace};
    use cowork_workspace_scan::find_cowork_workspaces;

    if enabled {
        // Fetch token.
        let token = token_store::get_or_create_token()?;

        // Detect vEthernet subnet.
        let cidr = firewall::detect_vethernet_subnet().map_err(|e| e.to_string())?;

        // Add allow firewall rule.
        let firewall_result = firewall::add_cowork_allow_rule(&cidr);
        if let Err(ref e) = firewall_result {
            // Fail-closed: on UAC decline, write a deny rule and bail — do NOT
            // walk workspaces (invariant §4).
            if let firewall::FirewallError::AdminDeclined = e {
                log::warn!("[cowork] UAC declined — writing deny rule and updating meta; no plugin entries written");
                if let Err(deny_err) = firewall::add_cowork_deny_rule(&cidr) {
                    log::warn!("[cowork] failed to write deny rule: {deny_err}");
                }
                let _ = cowork_meta::update(|m| {
                    m.uac_declined_last_attempt = true;
                    m.uac_declined_at = Some(iso_now());
                    m.vethernet_cidr_detected = Some(cidr.clone());
                    m.enabled = false;
                });
                return Err(e.to_string());
            }
            return Err(e.to_string());
        }

        // Resolve TANDEM_URL (host.docker.internal by default; LAN-IP if override set).
        let tandem_url = cowork_installer::resolve_tandem_url(&cowork_meta::load().unwrap_or_default());

        // Orphan reconciliation (invariant §12).
        let workspaces = find_cowork_workspaces();
        let reconcile = cowork_installer::reconcile_orphans(&workspaces, &token);
        if !reconcile.removed_firewall_rules.is_empty() || !reconcile.rewritten_stale_entries.is_empty() {
            log::info!(
                "[cowork] orphan reconcile: removed {} rule(s), rewrote {} stale entry(s)",
                reconcile.removed_firewall_rules.len(),
                reconcile.rewritten_stale_entries.len()
            );
        }

        let workspace_count = workspaces.len();

        let reports: Vec<_> = workspaces
            .iter()
            .map(|ws| install_tandem_plugin_into_workspace(ws, &token, &tandem_url))
            .collect();

        let errors: Vec<_> = reports
            .iter()
            .filter_map(|r| r.as_ref().err())
            .collect();

        if !errors.is_empty() {
            log::warn!("[cowork] {} install error(s): {:?}", errors.len(), errors);
        }

        let _ = cowork_meta::update(|m| {
            m.enabled = true;
            m.vethernet_cidr_detected = Some(cidr.clone());
            m.workspaces_last_scanned_at = Some(iso_now());
            m.uac_declined_last_attempt = false;
            m.uac_declined_at = None;
        });

        Ok(format!("Cowork enabled: {workspace_count} workspace(s) configured"))
    } else {
        // Disable: uninstall from all workspaces and remove firewall rules.
        let workspaces = find_cowork_workspaces();
        for ws in &workspaces {
            if let Err(e) = uninstall_tandem_plugin_from_workspace(ws) {
                log::warn!("[cowork] uninstall error for {}: {e}", ws.display());
            }
        }
        if let Err(e) = firewall::remove_cowork_rules() {
            log::warn!("[cowork] remove firewall rules error: {e}");
        }
        let _ = cowork_meta::update(|m| { m.enabled = false; });
        Ok("Cowork disabled".to_string())
    }
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cowork_toggle_integration(_enabled: bool) -> Result<String, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Re-scan workspaces and install into any new ones.
#[cfg(target_os = "windows")]
#[tauri::command]
fn cowork_rescan() -> Result<String, String> {
    use cowork_installer::{install_tandem_plugin_into_workspace, resolve_tandem_url};
    use cowork_workspace_scan::find_cowork_workspaces;

    let meta = cowork_meta::load().map_err(|e| e.to_string())?;
    if !meta.enabled {
        return Ok("Cowork not enabled — rescan skipped".to_string());
    }

    let token = token_store::get_or_create_token()?;
    let tandem_url = resolve_tandem_url(&meta);

    let workspaces = find_cowork_workspaces();
    let count = workspaces.len();

    for ws in &workspaces {
        if let Err(e) = install_tandem_plugin_into_workspace(ws, &token, &tandem_url) {
            log::warn!("[cowork] rescan install error for {}: {e}", ws.display());
        }
    }

    let _ = cowork_meta::update(|m| {
        m.workspaces_last_scanned_at = Some(iso_now());
    });

    Ok(format!("Rescan complete: {count} workspace(s)"))
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cowork_rescan() -> Result<String, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Get the current Cowork integration status.
#[cfg(target_os = "windows")]
#[tauri::command]
fn cowork_get_status() -> Result<serde_json::Value, String> {
    use cowork_workspace_scan::find_cowork_workspaces;

    let meta = cowork_meta::load().map_err(|e| e.to_string())?;
    let workspaces = find_cowork_workspaces();
    let cowork_detected = !workspaces.is_empty();

    Ok(serde_json::json!({
        "enabled": meta.enabled,
        "vethernetCidr": meta.vethernet_cidr_detected,
        "lanIpFallback": meta.lan_ip_fallback,
        "useLanIpOverride": meta.use_lan_ip_override,
        "workspacesLastScannedAt": meta.workspaces_last_scanned_at,
        "uacDeclined": meta.uac_declined_last_attempt,
        "uacDeclinedAt": meta.uac_declined_at,
        "workspaceCount": workspaces.len(),
        "coworkDetected": cowork_detected,
        "osSupported": true,
    }))
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cowork_get_status() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "osSupported": false, "enabled": false, "coworkDetected": false }))
}

/// Read the Cowork metadata file.
#[cfg(target_os = "windows")]
#[tauri::command]
fn cowork_get_meta() -> Result<cowork_meta::CoworkMeta, String> {
    cowork_meta::load()
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cowork_get_meta() -> Result<serde_json::Value, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Detect the Hyper-V vEthernet subnet.
#[cfg(target_os = "windows")]
#[tauri::command]
fn cowork_detect_vethernet_subnet() -> Result<String, String> {
    firewall::detect_vethernet_subnet().map_err(|e| e.to_string())
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cowork_detect_vethernet_subnet() -> Result<String, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Re-walk all workspaces with a new auth token (called after `tandem rotate-token`).
///
/// Token is never logged — passed through to `apply_token_to_all_workspaces`
/// which also never logs it.
#[cfg(target_os = "windows")]
#[tauri::command]
fn cowork_apply_token(token: String) -> Result<String, String> {
    let reports = cowork_installer::apply_token_to_all_workspaces(&token);
    let success = reports
        .iter()
        .filter(|r| r.installed_plugins == cowork_installer::WriteStatus::Ok)
        .count();
    Ok(format!("Cowork: {success} workspace(s) re-walked with new token"))
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cowork_apply_token(_token: String) -> Result<String, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Install the Tandem plugin into a specific workspace path.
///
/// Precondition: the path must be under the canonical `local-agent-mode-sessions\`
/// root — this command re-applies invariant §3 before any file I/O (§9).
/// On mismatch: returns `Err`, does NOT trust the walker.
#[cfg(target_os = "windows")]
#[tauri::command]
fn cowork_install_into_workspace(ws_path: String) -> Result<String, String> {
    use cowork_installer::{install_tandem_plugin_into_workspace, resolve_tandem_url};
    use cowork_workspace_scan::find_cowork_workspaces;

    let path = std::path::PathBuf::from(&ws_path);

    // Re-apply invariant §9 path check: the path must match one of the
    // workspaces returned by the guarded walker. The walker is the single
    // source of safe paths; if the user-supplied path isn't in that list,
    // reject — do NOT install.
    let valid_roots = find_cowork_workspaces();
    let canonical_supplied = std::fs::canonicalize(&path)
        .map_err(|e| format!("invalid workspace path: {e}"))?;
    let path_valid = valid_roots
        .iter()
        .any(|valid| valid == &canonical_supplied);
    if !path_valid {
        log::warn!(
            "[cowork] cowork_install_into_workspace: path {} is not in the canonical workspace list — rejected",
            ws_path
        );
        return Err("Path is not within the canonical Cowork workspace root".to_string());
    }

    let token = token_store::get_or_create_token()?;
    let meta = cowork_meta::load().map_err(|e| e.to_string())?;
    let tandem_url = resolve_tandem_url(&meta);

    let report = install_tandem_plugin_into_workspace(&canonical_supplied, &token, &tandem_url)
        .map_err(|e| e.to_string())?;

    Ok(serde_json::to_string(&report).unwrap_or_default())
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cowork_install_into_workspace(_ws_path: String) -> Result<String, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Uninstall the Tandem plugin from a specific workspace path.
#[cfg(target_os = "windows")]
#[tauri::command]
fn cowork_uninstall_from_workspace(ws_path: String) -> Result<String, String> {
    use cowork_workspace_scan::find_cowork_workspaces;

    let path = std::path::PathBuf::from(&ws_path);
    let valid_roots = find_cowork_workspaces();
    let canonical_supplied = std::fs::canonicalize(&path)
        .map_err(|e| format!("invalid workspace path: {e}"))?;
    let path_valid = valid_roots
        .iter()
        .any(|valid| valid == &canonical_supplied);
    if !path_valid {
        log::warn!(
            "[cowork] cowork_uninstall_from_workspace: path {} is not in the canonical workspace list — rejected",
            ws_path
        );
        return Err("Path is not within the canonical Cowork workspace root".to_string());
    }

    let report = cowork_installer::uninstall_tandem_plugin_from_workspace(&canonical_supplied)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::to_string(&report).unwrap_or_default())
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cowork_uninstall_from_workspace(_ws_path: String) -> Result<String, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Set or unset the LAN-IP override for TANDEM_URL.
#[cfg(target_os = "windows")]
#[tauri::command]
fn cowork_set_lan_ip_override(enabled: bool) -> Result<String, String> {
    use cowork_installer::{install_tandem_plugin_into_workspace, resolve_tandem_url};
    use cowork_workspace_scan::find_cowork_workspaces;

    cowork_meta::update(|m| { m.use_lan_ip_override = enabled; })
        .map_err(|e| e.to_string())?;

    // If Cowork is enabled, re-walk to apply the new URL.
    let meta = cowork_meta::load().map_err(|e| e.to_string())?;
    if meta.enabled {
        let token = token_store::get_or_create_token()?;
        let tandem_url = resolve_tandem_url(&meta);
        for ws in find_cowork_workspaces() {
            if let Err(e) = install_tandem_plugin_into_workspace(&ws, &token, &tandem_url) {
                log::warn!("[cowork] set_lan_ip_override re-walk error: {e}");
            }
        }
    }

    Ok(format!("LAN IP override {}", if enabled { "enabled" } else { "disabled" }))
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cowork_set_lan_ip_override(_enabled: bool) -> Result<String, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Clear the UAC-declined flag and retry the enable flow.
#[cfg(target_os = "windows")]
#[tauri::command]
fn cowork_retry_admin_elevation() -> Result<String, String> {
    cowork_meta::update(|m| {
        m.uac_declined_last_attempt = false;
        m.uac_declined_at = None;
    })
    .map_err(|e| e.to_string())?;
    cowork_toggle_integration(true)
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cowork_retry_admin_elevation() -> Result<String, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Minimal ISO-8601 (UTC) timestamp without pulling in chrono.
///
/// Uses the proleptic Gregorian calendar starting from the Unix epoch
/// (1970-01-01T00:00:00Z). Handles leap years; timezone is always UTC.
#[cfg(target_os = "windows")]
fn iso_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = now.as_secs();

    // Compute time of day first.
    let secs = (total_secs % 60) as u32;
    let mins = ((total_secs / 60) % 60) as u32;
    let hours = ((total_secs / 3600) % 24) as u32;

    // Days since Unix epoch.
    let mut days = (total_secs / 86_400) as i64;

    // Walk forward from 1970 accounting for leap years.
    let mut year: i64 = 1970;
    loop {
        let days_in_year = if is_leap(year) { 366 } else { 365 };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        year += 1;
    }

    // Now walk through months of the current year.
    let months_normal = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let months_leap = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let months = if is_leap(year) { &months_leap } else { &months_normal };
    let mut month: usize = 0;
    for (i, &dim) in months.iter().enumerate() {
        if days < dim {
            month = i;
            break;
        }
        days -= dim;
    }
    let day = days + 1; // 1-indexed.

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month + 1,
        day,
        hours,
        mins,
        secs
    )
}

#[cfg(target_os = "windows")]
fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
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

/// Prompt the user to install an available update. Returns true if they accept.
/// This is intentionally a sync `fn`, NOT `async fn` — `blocking_show()` blocks
/// the calling thread waiting for the OS dialog. This is safe because:
/// 1. Tauri uses a multi-threaded Tokio runtime (default)
/// 2. This is only called from spawned async tasks, never the main thread
/// Do NOT make this async — `blocking_show()` on an async runtime thread will deadlock.
fn show_update_available_dialog(app: &tauri::AppHandle, version: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    app.dialog()
        .message(format!(
            "Tandem v{version} is available.\n\n\
             Would you like to update now? The application will restart after installing."
        ))
        .title("Update Available")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show()
}

/// Inform the user they're on the latest version (manual check feedback).
fn show_up_to_date_dialog(app: &tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

    app.dialog()
        .message(format!(
            "You're running the latest version of Tandem (v{}).",
            env!("CARGO_PKG_VERSION")
        ))
        .title("No Updates Available")
        .kind(MessageDialogKind::Info)
        .show(|_| {});
}

/// Show an error dialog for failed update checks (manual check feedback only).
fn show_update_error_dialog(app: &tauri::AppHandle, error: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

    app.dialog()
        .message(format!(
            "Could not check for updates.\n\n\
             Error: {error}\n\n\
             Please try again later or check your internet connection."
        ))
        .title("Update Error")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

/// Check for updates and optionally prompt the user.
/// `manual` controls whether the user gets feedback on "no update" / error.
async fn check_for_update(app: &tauri::AppHandle, manual: bool) {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            log::debug!("Updater unavailable: {e}");
            if manual {
                show_update_error_dialog(app, &format!("Updater not configured: {e}"));
            }
            return;
        }
    };

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            log::info!("No update available");
            if manual {
                show_up_to_date_dialog(app);
            }
            return;
        }
        Err(e) => {
            log::warn!("Update check failed: {e}");
            if manual {
                show_update_error_dialog(app, &e.to_string());
            }
            return;
        }
    };

    let version = update.version.clone();
    log::info!("Update available: v{version}");

    if !show_update_available_dialog(app, &version) {
        log::info!("User declined update to v{version}");
        return;
    }

    // Kill sidecar BEFORE install — on Windows, the NSIS installer runs during
    // download_and_install() and needs to replace node-sidecar.exe on disk.
    // If the process is still running, the file is locked and install fails.
    kill_sidecar(app);
    let client = app.state::<reqwest::Client>().inner().clone();

    // Wait for port release and (on Windows) file-lock release concurrently.
    // Port-down alone isn't sufficient on Windows: TerminateProcess returns
    // before the OS releases the exe file handle.
    //
    // Collect human-readable warnings so we can thread them into the failure
    // dialog if download_and_install later fails. Declared outside the cfg
    // block so the non-Windows branch contributes too.
    let mut pre_install_warnings: Vec<String> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let (port_ok, file_ok) = tokio::join!(
            wait_for_port_release(&client, 5),
            wait_for_sidecar_unlock(5),
        );
        if !port_ok {
            let msg = "Sidecar still responding after 5s kill deadline -- proceeding with install anyway";
            log::warn!("{msg}");
            pre_install_warnings.push(msg.to_string());
        }
        if !file_ok {
            let msg = "Sidecar exe still locked after 5s -- installer may prompt for retry";
            log::warn!("{msg}");
            pre_install_warnings.push(msg.to_string());
        }
    }
    #[cfg(not(target_os = "windows"))]
    if !wait_for_port_release(&client, 5).await {
        let msg = "Sidecar still responding after 5s kill deadline -- proceeding with install anyway";
        log::warn!("{msg}");
        pre_install_warnings.push(msg.to_string());
    }

    match update.download_and_install(
        |chunk_len, total| {
            if let Some(t) = total {
                log::debug!("Update download: {chunk_len}/{t} bytes");
            }
        },
        || { log::info!("Update downloaded -- installing"); },
    ).await {
        Ok(()) => {
            log::info!("Update to v{version} installed — restarting");
            app.restart();
        }
        Err(e) => {
            log::error!("Update install failed: {e}");
            let dialog_msg = if pre_install_warnings.is_empty() {
                e.to_string()
            } else {
                format!(
                    "{e}\n\nPre-install warnings:\n  - {}",
                    pre_install_warnings.join("\n  - ")
                )
            };
            show_update_error_dialog(app, &dialog_msg);
        }
    }
}
