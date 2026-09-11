//! Start-at-login: the OS registration commands and the launch-mode
//! detection that reads what they wrote (#1236, ADR-046).
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
    /// `None` on success. One of the `ERR_*` codes otherwise. `&'static str`
    /// rather than `String` because every value is one of three consts — the
    /// type makes it impossible to accidentally serialize a formatted error
    /// message (and therefore a path) into this field.
    pub error: Option<&'static str>,
}

impl AutostartStatus {
    fn new(enabled: bool, tray_available: bool, error: Option<&'static str>) -> Self {
        Self {
            enabled,
            tray_available,
            error,
        }
    }
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
        Ok(enabled) => AutostartStatus::new(enabled, tray, None),
        Err(e) => {
            log::warn!("[autostart] is_enabled failed: {e}");
            AutostartStatus::new(false, tray, Some(autostart_error_code(&e)))
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
        return AutostartStatus::new(actual, tray, Some(autostart_error_code(&e)));
    }

    match manager.is_enabled() {
        Ok(actual) if actual == enabled => AutostartStatus::new(actual, tray, None),
        Ok(actual) => {
            log::warn!("[autostart] readback mismatch: requested {enabled}, OS reports {actual}");
            AutostartStatus::new(actual, tray, Some(ERR_READBACK))
        }
        Err(e) => {
            log::warn!("[autostart] readback failed after set_enabled({enabled}): {e}");
            AutostartStatus::new(enabled, tray, Some(autostart_error_code(&e)))
        }
    }
}

/// May we re-bake this launch's executable path into the OS login item?
///
/// `manager.enable()` writes whatever path the plugin resolves for this launch
/// (`$APPIMAGE` on Linux when set, else `current_exe()`); the caller resolves it
/// the same way and passes it in as `exe`, which is what keeps this pure and
/// testable by value.
///
/// An autostart launch is always eligible — that launch came *from* the
/// registration, so its path is by definition the registered one. Any other
/// launch must prove it is not an ephemeral copy first. Before #1810 the only
/// thing preventing that was the call site sitting inside `if autostart_launch`,
/// and hoisting the call removes that accidental guard:
///
/// - **Debug.** The autostart plugin is registered with no `cfg` gate, and
///   `tauri.conf.json`'s `productName` is `Tandem` for debug and release alike —
///   so a `cargo tauri dev` run reads the *installed* app's HKCU `Run\Tandem`
///   value and would overwrite it with `target/debug/tandem.exe`. The next
///   `cargo clean` would then leave a real user's login item pointing at a
///   deleted path: #1810's own failure, newly introduced on the maintainer's
///   machine.
/// - **Temp dir.** A portable copy, an extracted archive, or an
///   `--appimage-extract`ed AppImage run from a scratch dir. Note the split
///   this makes correct: a *real* AppImage launch resolves to `$APPIMAGE`, a
///   stable path on disk, and stays eligible even though its `current_exe()`
///   is under `/tmp/.mount_XXXXXX/`. That is exactly why the caller must hand
///   in the plugin's baked path rather than bare `current_exe()`.
/// - **`/Volumes/`.** A `.app` run straight off a mounted DMG, whose volume is
///   about to be ejected. Checked on every platform — a Windows path never
///   starts with `/Volumes/`, so no `cfg` is needed and the case stays testable
///   on the ubuntu leg.
pub(crate) fn autostart_refresh_allowed(
    autostart_launch: bool,
    is_debug: bool,
    exe: &std::path::Path,
    temp_dir: &std::path::Path,
) -> bool {
    if autostart_launch {
        return true;
    }
    if is_debug {
        log::info!("[autostart] refresh skipped: debug build");
        return false;
    }
    if exe.starts_with(temp_dir) {
        log::info!("[autostart] refresh skipped: executable is under the temp dir");
        return false;
    }
    if exe.starts_with("/Volumes/") {
        log::info!("[autostart] refresh skipped: executable is on a mounted volume");
        return false;
    }
    true
}

/// Best-effort re-write of an existing registration at launch, so the baked
/// executable path and argument list stay current.
///
/// Heals a moved AppImage, a `.app` dragged to a different folder, and a
/// registration written by an older Tandem that predates `--tandem-autostart`
/// (which would otherwise boot visible and spawn Claude — the exact behavior
/// this feature exists to avoid). Never enables autostart that wasn't already
/// on: it only refreshes when `is_enabled()` is already true.
///
/// Since #1810 this runs on every launch that passes
/// `autostart_refresh_allowed`, not only on autostart launches. The old scoping
/// required the thing it repairs to be working: a *moved* app never autostarts
/// at all, so the repair path was unreachable for the one case it exists for.
/// The `Ok(false)` arm below is what keeps "every launch" from ever meaning
/// "enable".
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

    /// #1810 — this is the invariant that makes "run the refresh on every
    /// launch" safe. `manager.enable()` bakes this launch's executable path, and
    /// the `if autostart_launch` the hoist removes was the only thing keeping a
    /// `cargo tauri dev` run from repointing a real user's login item at
    /// `target/debug/`.
    #[test]
    fn autostart_refresh_is_refused_for_ephemeral_binaries() {
        use std::path::Path;
        let temp = Path::new("/tmp");
        let installed = Path::new("/opt/tandem/tandem");

        assert!(
            autostart_refresh_allowed(true, true, Path::new("/tmp/x/tandem"), temp),
            "an autostart launch came FROM the registration, so its path is the registered one"
        );
        assert!(
            !autostart_refresh_allowed(false, true, installed, temp),
            "a debug build shares productName with the installed app and must never rewrite it"
        );
        assert!(
            !autostart_refresh_allowed(false, false, Path::new("/tmp/x/tandem"), temp),
            "a portable or extracted copy must not become the registered path"
        );
        assert!(
            !autostart_refresh_allowed(
                false,
                false,
                Path::new("/Volumes/Tandem/Tandem.app/Contents/MacOS/Tandem"),
                temp
            ),
            "a run-from-DMG copy points at a volume about to be ejected"
        );
        assert!(
            autostart_refresh_allowed(false, false, installed, temp),
            "an ordinary installed launch is exactly what the repair exists for"
        );
        // Deliberately next to the `/tmp/x/tandem` refusal above: an INSTALLED
        // AppImage must stay eligible even though its `current_exe()` lives
        // under `/tmp/.mount_XXXXXX/`. The plugin bakes `$APPIMAGE`, so the call
        // site must hand that in — an implementation that passes bare
        // `current_exe()` collapses this case into the refusal and makes the
        // whole fix a permanent silent no-op on the AppImage target.
        assert!(
            autostart_refresh_allowed(false, false, Path::new("/home/u/Apps/Tandem.AppImage"), temp),
            "a real AppImage's baked path is stable and must not be refused"
        );
    }

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
        let json = serde_json::to_string(&AutostartStatus::new(true, false, Some(ERR_READBACK)))
            .expect("serialize");
        assert_eq!(
            json,
            r#"{"enabled":true,"trayAvailable":false,"error":"readback-mismatch"}"#
        );
    }
}

// ---------------------------------------------------------------------------
// Launch-mode detection (#1236, ADR-046) — moved here from `lib.rs` by Unit 11f.
//
// The registration half above and the detection half below are one feature: the
// argv flag this code reads is the flag `autostart_set_enabled` writes onto the
// OS entry, and `should_start_hidden`'s `tray_available` is the same bit
// `AutostartStatus` reports. They were split across two files only because the
// commands were extracted first.
//
// `has_argv_flag` deliberately stayed at the crate root: `uninstall_scrub.rs`
// calls it for its own flag, and its doc comment is explicit that one
// definition of the skip-argv0 rule is the point. Importing it keeps
// `is_autostart_launch`'s body byte-identical to the original.
// ---------------------------------------------------------------------------

use crate::has_argv_flag;

/// argv flag the OS autostart registration carries, so a login-triggered launch
/// is distinguishable from a user-initiated one. An argv flag rather than an env
/// var because the registration itself (Run value / plist / .desktop Exec line)
/// is the only thing the OS lets us control, and it survives being inspected in
/// Task Manager → Startup where an env var would be invisible.
///
/// `extract_file_arg` already skips `-`-prefixed args, so this can never be
/// mistaken for a file-association path — `autostart_flag_is_not_a_file_arg`
/// pins that.
pub(crate) const AUTOSTART_FLAG: &str = "--tandem-autostart";

/// Debug escape hatch: forces a launch to behave as a normal one (always show
/// the window, never defer the Claude launcher) even when the OS passed
/// `--tandem-autostart`. Mirrors `TANDEM_DISABLE_LAUNCHER` in spirit — every
/// other lifecycle behavior here has an env opt-out.
pub(crate) const AUTOSTART_DISABLE_ENV: &str = "TANDEM_DISABLE_AUTOSTART";

/// True when this process was started by the OS at login.
pub(crate) fn is_autostart_launch(args: &[String]) -> bool {
    has_argv_flag(args, AUTOSTART_FLAG)
}

/// Resolve the effective autostart state for this process: the flag, minus the
/// env kill switch. Deliberately does not log — it is called before the log
/// plugin is registered (see the `setup()` ordering comment), so the one
/// interesting case (the override actually firing) is logged at the call site
/// once logging is live.
pub(crate) fn resolve_autostart_launch(args: &[String], disable_env: Option<&str>) -> bool {
    if disable_env == Some("1") {
        return false;
    }
    is_autostart_launch(args)
}

/// Whether a boot launch should stay hidden in the tray.
///
/// The tray guard is load-bearing, not cosmetic: on Linux without
/// libappindicator `TrayIconBuilder::build()` fails and `CloseRequested` exits
/// the process instead of hiding. A hidden window with no tray icon would be an
/// unreachable zombie still holding :3478/:3479 with no way to quit it short of
/// a task manager.
pub(crate) fn should_start_hidden(autostart: bool, tray_available: bool) -> bool {
    autostart && tray_available
}

/// Marker recording that at least one autostart launch has already happened.
/// Lives beside the session data in the app data dir.
#[cfg(target_os = "linux")]
const AUTOSTART_SEEN_MARKER: &str = "autostart-seen";

/// Linux-only backstop for the residual hole in `should_start_hidden`.
///
/// `TrayIconBuilder::build()` *succeeding* does not prove the icon is visible —
/// on GNOME without a status-icon extension it constructs fine and renders
/// nothing, which is exactly the unreachable-process case the tray guard exists
/// to prevent. So the first-ever autostart launch always shows the window,
/// giving the user one guaranteed chance to see Tandem running and turn the
/// setting off. Subsequent launches trust the tray.
///
/// Returns whether a prior autostart launch was recorded, and writes the marker
/// as a side effect. Any I/O failure is reported as "not seen", which fails
/// toward showing the window — always recoverable, unlike failing toward hidden.
#[cfg(target_os = "linux")]
pub(crate) fn autostart_seen_and_mark(dir: &std::path::Path) -> bool {
    let marker = dir.join(AUTOSTART_SEEN_MARKER);
    if marker.exists() {
        return true;
    }
    if let Err(e) = std::fs::create_dir_all(dir) {
        log::warn!("Could not create app data dir for autostart marker: {e}");
        return false;
    }
    if let Err(e) = std::fs::write(&marker, b"1") {
        log::warn!("Could not write autostart marker: {e}");
        return false;
    }
    false
}
#[cfg(test)]
mod autostart_tests {
    use super::*;
    use crate::{extract_file_arg, RejectionReason, LAUNCHER_DEFERRED};
    use std::sync::atomic::Ordering;

    #[test]
    fn detects_the_flag_anywhere_after_argv0() {
        assert!(is_autostart_launch(&[
            "tandem".into(),
            AUTOSTART_FLAG.into()
        ]));
        assert!(is_autostart_launch(&[
            "tandem".into(),
            "--other".into(),
            AUTOSTART_FLAG.into(),
        ]));
    }

    #[test]
    fn absent_flag_is_a_normal_launch() {
        assert!(!is_autostart_launch(&["tandem".into()]));
        assert!(!is_autostart_launch(&["tandem".into(), "doc.md".into()]));
        // Prefix/suffix collisions must not match — exact comparison only.
        assert!(!is_autostart_launch(&[
            "tandem".into(),
            "--tandem-autostart-please".into(),
        ]));
        assert!(!is_autostart_launch(&["tandem".into(), "-tandem-autostart".into()]));
    }

    #[test]
    fn argv0_is_never_read_as_the_flag() {
        // An executable renamed to the flag string must not self-trigger.
        assert!(!is_autostart_launch(&[AUTOSTART_FLAG.into()]));
    }

    #[test]
    fn env_kill_switch_downgrades_to_a_normal_launch() {
        let args = vec!["tandem".to_string(), AUTOSTART_FLAG.to_string()];
        assert!(resolve_autostart_launch(&args, None));
        assert!(resolve_autostart_launch(&args, Some("0")));
        assert!(resolve_autostart_launch(&args, Some("")));
        assert!(!resolve_autostart_launch(&args, Some("1")));
        // The kill switch can only ever downgrade — it never invents an
        // autostart launch out of a normal one.
        let plain = vec!["tandem".to_string()];
        assert!(!resolve_autostart_launch(&plain, Some("1")));
        assert!(!resolve_autostart_launch(&plain, None));
    }

    #[test]
    fn hides_only_when_autostart_and_a_tray_exists() {
        assert!(should_start_hidden(true, true));
        // The trapdoor case: hiding here would leave an unreachable process
        // holding :3478/:3479 with no tray icon and no window to close.
        assert!(!should_start_hidden(true, false));
        assert!(!should_start_hidden(false, true));
        assert!(!should_start_hidden(false, false));
    }

    #[test]
    fn autostart_flag_is_not_a_file_arg() {
        // extract_file_arg skips `-`-prefixed args, so the flag can never be
        // resolved as a path. Pin it rather than relying on it by accident.
        let cwd = std::path::Path::new("/tmp");
        let args = vec!["tandem".to_string(), AUTOSTART_FLAG.to_string()];
        assert!(matches!(extract_file_arg(&args, cwd), Ok(None)));
    }

    #[test]
    fn autostart_flag_does_not_shadow_a_real_file_arg() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("doc.md");
        std::fs::write(&file, b"# hi").expect("write");

        let args = vec![
            "tandem".to_string(),
            AUTOSTART_FLAG.to_string(),
            file.to_string_lossy().to_string(),
        ];
        let resolved = extract_file_arg(&args, dir.path()).expect("should resolve");
        assert_eq!(resolved.as_deref(), Some(file.as_path()));
    }

    #[test]
    fn autostart_flag_alongside_a_bad_extension_still_rejects() {
        // The flag must not mask the existing rejection path.
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("payload.exe");
        std::fs::write(&file, b"x").expect("write");

        let args = vec![
            "tandem".to_string(),
            AUTOSTART_FLAG.to_string(),
            file.to_string_lossy().to_string(),
        ];
        assert!(matches!(
            extract_file_arg(&args, dir.path()),
            Err(RejectionReason::UnsupportedExtension { .. })
        ));
    }

    // Serialize the tests that mutate LAUNCHER_DEFERRED (a process-wide static).
    static DEFERRAL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn deferral_latch_releases_exactly_once() {
        let _guard = DEFERRAL_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        LAUNCHER_DEFERRED.store(true, Ordering::Release);

        // `swap` is what makes concurrent shows safe: only the first caller
        // sees `true`, so the start POST can never be issued twice.
        assert!(LAUNCHER_DEFERRED.swap(false, Ordering::AcqRel));
        assert!(!LAUNCHER_DEFERRED.swap(false, Ordering::AcqRel));
        assert!(!LAUNCHER_DEFERRED.load(Ordering::Acquire));
    }

    #[test]
    fn deferral_latch_is_off_for_a_normal_launch() {
        let _guard = DEFERRAL_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        // Mirrors setup(): the latch is stored from the resolved autostart
        // state, so a normal launch never defers and never posts.
        LAUNCHER_DEFERRED.store(resolve_autostart_launch(&["tandem".into()], None), Ordering::Release);
        assert!(!LAUNCHER_DEFERRED.load(Ordering::Acquire));
        assert!(!LAUNCHER_DEFERRED.swap(false, Ordering::AcqRel));
    }

    #[test]
    fn a_failed_release_re_arms_the_latch_for_the_next_signal() {
        let _guard = DEFERRAL_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        LAUNCHER_DEFERRED.store(true, Ordering::Release);

        // `note_user_presence` claims the latch with `swap` before it knows
        // whether the POST will succeed. If the sidecar never came up, or the
        // request failed, it must put the claim back — otherwise a transient
        // failure permanently strands the launcher, which is exactly the bug
        // the health-gating was added to prevent.
        let claimed = LAUNCHER_DEFERRED.swap(false, Ordering::AcqRel);
        assert!(claimed, "the first signal claims the latch");
        assert!(!LAUNCHER_DEFERRED.load(Ordering::Acquire));

        // ...release fails...
        LAUNCHER_DEFERRED.store(true, Ordering::Release);

        // ...so a later presence signal can still claim it.
        assert!(LAUNCHER_DEFERRED.swap(false, Ordering::AcqRel));
    }

    #[test]
    fn deferral_latch_survives_a_sidecar_restart_until_released() {
        let _guard = DEFERRAL_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        LAUNCHER_DEFERRED.store(true, Ordering::Release);

        // start_sidecar re-reads the latch on every spawn attempt, so a crash
        // loop before the user opens the window keeps deferring...
        for _attempt in 0..3 {
            assert!(LAUNCHER_DEFERRED.load(Ordering::Acquire));
        }
        // ...and once released, a later restart does NOT re-defer. This is the
        // regression a statically captured env var would have shipped.
        LAUNCHER_DEFERRED.swap(false, Ordering::AcqRel);
        for _attempt in 0..3 {
            assert!(!LAUNCHER_DEFERRED.load(Ordering::Acquire));
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_marker_reports_unseen_once_then_seen() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("nested/appdata");

        // First autostart launch: no marker yet -> show the window once.
        assert!(!autostart_seen_and_mark(&root));
        assert!(root.join(AUTOSTART_SEEN_MARKER).exists());
        // Every launch after that trusts the tray.
        assert!(autostart_seen_and_mark(&root));
        assert!(autostart_seen_and_mark(&root));
    }
}
