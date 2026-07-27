//! Start-at-login commands (#1236).
//!
//! Thin wrappers over `tauri-plugin-autostart` rather than the plugin's own JS
//! API. Two reasons the indirection earns its keep:
//!
//! 1. **Readback-after-write.** The plugin's `enable()` returning `Ok` does not
//!    prove a registration exists. An MSIX/Store package cannot write HKCU Run
//!    conventionally (that needs an appxmanifest `StartupTask` extension the
//!    plugin does not emit), so the write can be virtualized away; on macOS the
//!    AppleScript path needs Automation (TCC) approval, and a denied prompt can
//!    surface as a soft failure. Re-reading `is_enabled()` after the write is
//!    the only way to tell the user the truth.
//!
//! 2. **Error redaction.** `auto_launch` errors embed the plist / `.desktop` /
//!    registry path, which contains the home directory. Those must not reach the
//!    WebView — same posture as the note in `EditorSettings.svelte` ("Tauri IPC
//!    errors can carry paths") and as `rejection_reason_code` in `lib.rs`. The
//!    full error is logged; only a fixed enum crosses the IPC boundary.
//!
//! Using app-defined commands also means no `autostart:default` capability
//! grant and no `@tauri-apps/plugin-autostart` npm dependency.

use serde::Serialize;
use tauri_plugin_autostart::ManagerExt;

/// Path-free error codes. The strings are the cross-process contract with
/// `src/client/tauri/autostart-invoke.ts` — renaming one desyncs the UI.
pub const ERR_IO: &str = "io-error";
pub const ERR_READBACK: &str = "readback-mismatch";
pub const ERR_PLUGIN: &str = "plugin-error";

/// What the Settings toggle needs to render itself: the live OS state, whether
/// hiding to a tray is even possible on this machine, and a scrubbed error.
///
/// `enabled` is deliberately read from the OS on every call rather than mirrored
/// into `tandem:settings` — the registration is mutable outside Tandem (Task
/// Manager → Startup, System Settings → Login Items, `~/.config/autostart`), so
/// a cached boolean would silently drift from reality.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    pub enabled: bool,
    pub tray_available: bool,
    /// `None` on success. One of the `ERR_*` codes otherwise.
    pub error: Option<String>,
}

/// Map an opaque plugin error to a fixed, path-free code.
///
/// `tauri_plugin_autostart::Error` is either `Io` or a stringified `Anyhow`
/// carrying whatever `auto_launch` produced — both can name the registration
/// path, so neither is ever forwarded verbatim.
pub fn autostart_error_code(err: &tauri_plugin_autostart::Error) -> &'static str {
    match err {
        tauri_plugin_autostart::Error::Io(_) => ERR_IO,
        _ => ERR_PLUGIN,
    }
}

/// Read the current registration state. Never mutates.
#[tauri::command]
pub fn autostart_get_status(
    app: tauri::AppHandle,
    tray_available: tauri::State<'_, crate::TrayAvailable>,
) -> AutostartStatus {
    let tray = tray_available.get();
    match app.autolaunch().is_enabled() {
        Ok(enabled) => AutostartStatus {
            enabled,
            tray_available: tray,
            error: None,
        },
        Err(e) => {
            log::warn!("[autostart] is_enabled failed: {e}");
            AutostartStatus {
                enabled: false,
                tray_available: tray,
                error: Some(autostart_error_code(&e).to_string()),
            }
        }
    }
}

/// Enable or disable start-at-login, then re-read to confirm it took.
///
/// The returned `enabled` is always the *read-back* value, never the requested
/// one, so a silent no-op surfaces as an unchanged toggle plus a
/// `readback-mismatch` error rather than as a lie.
#[tauri::command]
pub fn autostart_set_enabled(
    app: tauri::AppHandle,
    enabled: bool,
    tray_available: tauri::State<'_, crate::TrayAvailable>,
) -> AutostartStatus {
    let tray = tray_available.get();
    let manager = app.autolaunch();

    let write = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    if let Err(e) = write {
        log::warn!("[autostart] set_enabled({enabled}) failed: {e}");
        // Still read back — the write may have partially applied, and the
        // toggle must reflect what the OS actually holds.
        let actual = manager.is_enabled().unwrap_or(false);
        return AutostartStatus {
            enabled: actual,
            tray_available: tray,
            error: Some(autostart_error_code(&e).to_string()),
        };
    }

    match manager.is_enabled() {
        Ok(actual) if actual == enabled => AutostartStatus {
            enabled: actual,
            tray_available: tray,
            error: None,
        },
        Ok(actual) => {
            log::warn!("[autostart] readback mismatch: requested {enabled}, OS reports {actual}");
            AutostartStatus {
                enabled: actual,
                tray_available: tray,
                error: Some(ERR_READBACK.to_string()),
            }
        }
        Err(e) => {
            log::warn!("[autostart] readback failed after set_enabled({enabled}): {e}");
            AutostartStatus {
                enabled,
                tray_available: tray,
                error: Some(autostart_error_code(&e).to_string()),
            }
        }
    }
}

/// Best-effort re-write of an existing registration at launch, so the baked
/// executable path and argument list stay current.
///
/// Heals a moved AppImage, a `.app` dragged to a different folder, and a
/// registration written by an older Tandem that predates `--tandem-autostart`
/// (which would otherwise boot visible and spawn Claude — the exact behavior
/// this feature exists to avoid). Never enables autostart that wasn't already
/// on: it only refreshes when `is_enabled()` is already true.
pub fn refresh_registration(app: &tauri::AppHandle) {
    let manager = app.autolaunch();
    match manager.is_enabled() {
        Ok(true) => {
            if let Err(e) = manager.enable() {
                log::warn!("[autostart] refresh failed (registration may be stale): {e}");
            } else {
                log::info!("[autostart] refreshed registration");
            }
        }
        Ok(false) => {}
        Err(e) => log::warn!("[autostart] refresh skipped, is_enabled failed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_are_path_free() {
        // The whole point of the enum is that a home-directory path can never
        // reach the DOM. Assert on the separators rather than a sample path so
        // the test still holds if a code is renamed.
        for code in [ERR_IO, ERR_READBACK, ERR_PLUGIN] {
            assert!(!code.contains('/'), "{code} looks like a path");
            assert!(!code.contains('\\'), "{code} looks like a path");
            assert!(!code.contains(':'), "{code} could carry a drive letter");
            assert!(!code.is_empty());
        }
    }

    #[test]
    fn io_errors_map_to_the_io_code() {
        let err = tauri_plugin_autostart::Error::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "/Users/victim/Library/LaunchAgents/Tandem.plist",
        ));
        assert_eq!(autostart_error_code(&err), ERR_IO);
    }

    #[test]
    fn anyhow_errors_map_to_the_generic_code_and_drop_the_message() {
        let secret = "/Users/victim/Library/LaunchAgents/Tandem.plist";
        let err = tauri_plugin_autostart::Error::Anyhow(secret.to_string());
        let code = autostart_error_code(&err);
        assert_eq!(code, ERR_PLUGIN);
        assert!(!code.contains("victim"));
    }

    #[test]
    fn status_serializes_to_the_camel_case_client_contract() {
        let json = serde_json::to_string(&AutostartStatus {
            enabled: true,
            tray_available: false,
            error: Some(ERR_READBACK.to_string()),
        })
        .expect("serialize");
        assert_eq!(
            json,
            r#"{"enabled":true,"trayAvailable":false,"error":"readback-mismatch"}"#
        );
    }
}
