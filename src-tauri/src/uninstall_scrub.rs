//! `--uninstall-scrub` — the desktop shell's uninstall cleanup (#1236).
//!
//! ## Why this exists
//!
//! `src-tauri/windows/installer-hook.nsi` has invoked
//! `"$INSTDIR\tandem.exe" --uninstall-scrub` since it was written, but nothing
//! ever handled it: `main.rs` is just `app_lib::run()`, and the only
//! `std::env::args()` read was the file-association one. Worse, the binary is
//! not named `tandem.exe` — with no `mainBinaryName` in `tauri.conf.json` and
//! no `[[bin]]` section, Tauri names it after the Cargo package
//! (`tandem-desktop`), so `ExecWait` never found a file to run. Cowork plugin
//! entries and firewall rules have never actually been scrubbed on uninstall.
//!
//! ## Scope
//!
//! Exactly what the `.nsi` hook's own comment promises, plus the new autostart
//! registration:
//!   - Cowork plugin entries in every detected workspace (Windows)
//!   - The Tandem Cowork firewall rules (Windows)
//!   - The start-at-login registration (all platforms)
//!
//! MCP config entries in `~/.claude.json` and the bundled skill directory stay
//! with the npm CLI's `tandem --uninstall-scrub` (`src/cli/uninstall-scrub.ts`),
//! whose bundle is not among the Tauri `resources`.
//!
//! ## Security
//!
//! Runs inside the already-signed application binary rather than a separate
//! `uninstall_scrub.exe`, so an attacker cannot plant a same-named executable on
//! a PATH search path and have the uninstaller run it.
//!
//! Registration removal names the exact registry value / file path and deletes
//! it — never enumerate-and-log, matching the token-safety invariant in
//! `src/cli/uninstall-scrub.ts`.

/// Exit code contract with the NSIS hook: 0 means "clean, or nothing was
/// installed". The hook logs a non-zero code but never aborts the uninstall —
/// removing Tandem must always succeed even when a workspace scrub fails.
pub const SCRUB_OK: i32 = 0;

/// The argv flag. Recognized before the Tauri app is built so the scrub never
/// spawns a window, a sidecar, or a tray icon.
pub const UNINSTALL_SCRUB_FLAG: &str = "--uninstall-scrub";

/// True when this process was invoked purely to scrub.
///
/// `argv[0]` is skipped for the same reason `is_autostart_launch` skips it.
pub fn is_uninstall_scrub(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == UNINSTALL_SCRUB_FLAG)
}

/// Name the autostart registration is filed under.
///
/// `tauri-plugin-autostart` defaults `app_name` to `app.package_info().name`,
/// which Tauri populates from `productName` in `tauri.conf.json`. Keep the two
/// in sync — a mismatch here silently leaves the user auto-starting a deleted
/// executable after uninstall.
pub const AUTOSTART_APP_NAME: &str = "Tandem";

/// Registry paths `auto-launch` 0.5 writes on Windows. `disable()` only removes
/// the first; the StartupApproved value is left behind, so the scrub takes both.
#[cfg(target_os = "windows")]
const RUN_KEY: &str = r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run";
#[cfg(target_os = "windows")]
const STARTUP_APPROVED_KEY: &str =
    r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

/// Remove the OS start-at-login registration, if any.
///
/// Best-effort and idempotent: "not present" is success, since the overwhelmingly
/// common case is a user who never enabled autostart at all.
#[cfg(target_os = "windows")]
fn remove_autostart_registration() {
    use std::process::Command;

    for key in [RUN_KEY, STARTUP_APPROVED_KEY] {
        // Array args, never a composed shell string — the value name is an
        // exact literal, so there is nothing to quote-escape and nothing to
        // enumerate. `/f` suppresses the confirmation prompt.
        let output = Command::new("reg")
            .args(["delete", key, "/v", AUTOSTART_APP_NAME, "/f"])
            .output();
        match output {
            // A missing value is the normal case, not a failure. NB: `reg
            // delete` writes "unable to find" to STDERR, not stdout — the
            // firewall helper's stdout-matching idiom would log a spurious
            // warning on every clean uninstall.
            Ok(o) if o.status.success() => {
                log::info!("[scrub] removed autostart registration from {key}");
            }
            Ok(_) => {}
            Err(e) => log::warn!("[scrub] could not run reg delete for {key}: {e}"),
        }
    }
}

/// macOS/Linux have no uninstaller that could call this, so in practice it runs
/// only when a user invokes the flag by hand. Implemented anyway so the
/// registration is removable without hand-editing, and so the path is covered by
/// a test.
#[cfg(not(target_os = "windows"))]
fn remove_autostart_registration() {
    if let Some(path) = autostart_entry_path(dirs::home_dir()) {
        match std::fs::remove_file(&path) {
            Ok(()) => log::info!("[scrub] removed autostart registration"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!("[scrub] could not remove autostart registration: {e}"),
        }
    }
}

/// Resolve the file `tauri-plugin-autostart` writes, given a home directory.
///
/// Split out and `home`-parameterized so it is testable without touching the
/// real home directory — the same seam `removeSkillDir(logger, homeOverride)`
/// uses on the TypeScript side.
///
/// macOS: `~/Library/LaunchAgents/{app_name}.plist` (the LaunchAgent variant —
/// see the plugin registration in `lib.rs` for why that variant was chosen).
/// Linux: `$XDG_CONFIG_HOME/autostart/{app_name}.desktop`, defaulting to
/// `~/.config`.
#[cfg(not(target_os = "windows"))]
pub fn autostart_entry_path(home: Option<std::path::PathBuf>) -> Option<std::path::PathBuf> {
    let home = home?;
    #[cfg(target_os = "macos")]
    {
        Some(
            home.join("Library")
                .join("LaunchAgents")
                .join(format!("{AUTOSTART_APP_NAME}.plist")),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(std::path::PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".config"));
        Some(
            base.join("autostart")
                .join(format!("{AUTOSTART_APP_NAME}.desktop")),
        )
    }
}

/// Run the scrub. Always returns `SCRUB_OK` — every step is independently
/// best-effort, and a partial failure must not block uninstalling Tandem.
pub fn run_uninstall_scrub() -> i32 {
    log::info!("[scrub] starting uninstall scrub");

    remove_autostart_registration();

    #[cfg(target_os = "windows")]
    {
        let workspaces = crate::cowork_workspace_scan::find_cowork_workspaces();
        let mut removed = 0usize;
        for ws in &workspaces {
            match crate::cowork_installer::uninstall_tandem_plugin_from_workspace(ws) {
                Ok(()) => removed += 1,
                Err(e) => log::warn!("[scrub] workspace uninstall failed: {e}"),
            }
        }
        log::info!(
            "[scrub] cleared Tandem plugin entries from {removed}/{} workspace(s)",
            workspaces.len()
        );

        if let Err(e) = crate::firewall::remove_cowork_rules() {
            log::warn!("[scrub] firewall rule removal failed: {e}");
        }
    }

    log::info!("[scrub] uninstall scrub complete");
    SCRUB_OK
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_the_flag_after_argv0() {
        assert!(is_uninstall_scrub(&[
            "tandem-desktop".into(),
            UNINSTALL_SCRUB_FLAG.into()
        ]));
        assert!(!is_uninstall_scrub(&["tandem-desktop".into()]));
        assert!(!is_uninstall_scrub(&[
            "tandem-desktop".into(),
            "--uninstall".into()
        ]));
    }

    #[test]
    fn argv0_is_never_read_as_the_flag() {
        assert!(!is_uninstall_scrub(&[UNINSTALL_SCRUB_FLAG.into()]));
    }

    #[test]
    fn scrub_flag_is_not_a_file_arg() {
        // The flag must not be mistaken for a document path — otherwise an
        // uninstall would boot the editor instead of scrubbing.
        let cwd = std::path::Path::new("/tmp");
        let args = vec![
            "tandem-desktop".to_string(),
            UNINSTALL_SCRUB_FLAG.to_string(),
        ];
        assert!(matches!(crate::extract_file_arg(&args, cwd), Ok(None)));
    }

    #[test]
    fn autostart_app_name_matches_the_product_name() {
        // `tauri-plugin-autostart` files the registration under
        // `package_info().name`, i.e. tauri.conf.json's productName. If these
        // drift, uninstall silently leaves the user auto-starting a binary that
        // no longer exists.
        let conf = include_str!("../tauri.conf.json");
        let parsed: serde_json::Value = serde_json::from_str(conf).expect("tauri.conf.json parses");
        assert_eq!(
            parsed.get("productName").and_then(|v| v.as_str()),
            Some(AUTOSTART_APP_NAME)
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn autostart_entry_path_is_home_relative_and_named_for_the_app() {
        let home = std::path::PathBuf::from("/home/testuser");
        let path = autostart_entry_path(Some(home.clone())).expect("path");
        assert!(path.starts_with(&home) || path.starts_with("/home/testuser"));
        assert!(
            path.to_string_lossy().contains(AUTOSTART_APP_NAME),
            "got {}",
            path.display()
        );
        assert_eq!(autostart_entry_path(None), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_autostart_entry_is_an_xdg_desktop_file() {
        let path =
            autostart_entry_path(Some(std::path::PathBuf::from("/home/testuser"))).expect("path");
        assert!(path.ends_with("Tandem.desktop"), "got {}", path.display());
        assert!(
            path.to_string_lossy().contains("autostart"),
            "got {}",
            path.display()
        );
    }
}
