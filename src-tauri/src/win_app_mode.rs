//! Windows "preferred app mode" bindings for native theming (#992, rev2).
//!
//! ## Why not `WebviewWindow::set_theme`
//!
//! On Windows, `set_theme` reaches no visible surface: `tauri.conf.json` sets
//! `"decorations": false` and `tauri-plugin-decorum` calls `set_decorations(false)`
//! again, so there is no native title bar for `DWMWA_USE_IMMERSIVE_DARK_MODE`
//! to paint (`apply_window_chrome` in `lib.rs` already owns the border/corner
//! styling). Context menus (`muda`), file dialogs (`rfd`), and scrollbars are
//! untouched by `set_theme` too. The mechanism that actually reaches those
//! surfaces is uxtheme.dll's process-wide "preferred app mode" — the same one
//! Windows Terminal, VS Code, and every other themed-native-menu Windows app
//! uses, and the same one `tao` itself calls for its own (window-scoped)
//! dark-mode support.
//!
//! ## The ordinal-only export
//!
//! Microsoft has never published headers or a name for these uxtheme.dll
//! exports — every consumer resolves them by numeric ordinal via
//! `GetProcAddress`, guarded by OS build number because the ordinal→function
//! mapping changed between Windows releases (the pre-1903 `AllowDarkModeForApp`
//! and the 1903+ `SetPreferredAppMode` occupy the SAME ordinal, 135, in their
//! respective uxtheme.dll builds — they are not the same function). This
//! module only targets build >= 18362 (`MIN_BUILD_FOR_APP_MODE`, Windows 10
//! 1903), matching `tao-0.35.2/src/platform_impl/windows/dark_mode.rs:38-90`
//! exactly, so there is no older-build branch to resolve ordinal 135 against.
//!
//! `FlushMenuThemes` (ordinal 136) is called immediately after
//! `SetPreferredAppMode` so already-open menu chrome (the tray menu, in
//! particular, which can live for the whole process lifetime) re-themes
//! without waiting for a fresh `TrackPopupMenu`.

#![cfg(target_os = "windows")]

use std::sync::OnceLock;

use windows_sys::Win32::Foundation::{FARPROC, HMODULE};
use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryA};
use windows_sys::Win32::UI::Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW};
use windows_sys::Win32::UI::WindowsAndMessaging::{SPI_GETHIGHCONTRAST, SystemParametersInfoW};

/// Mirrors uxtheme.dll's `PreferredAppMode` enum exactly — this is the raw
/// Win32 ABI type passed by value across the ordinal-135 FFI boundary, and
/// its variant order is load-bearing. It is intentionally a different type
/// from `crate::AppMode`, which is the platform-agnostic decision
/// `native_theme_action` (in `lib.rs`) produces and is unit-tested on every
/// host; keeping them separate means the FFI shape can never leak into the
/// pure decision layer.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreferredAppMode {
    // Never constructed: releasing maps to `AllowDark` (see the `From` impl
    // below), not `Default`. Every discriminant here is written explicitly,
    // so this variant is NOT padding — deleting it would shift nothing. It
    // is kept purely as documentation of the real uxtheme.dll enum, so a
    // future reader comparing this against Microsoft's (unpublished) header
    // sees the same four values.
    #[allow(dead_code)]
    Default = 0,
    AllowDark = 1,
    ForceDark = 2,
    ForceLight = 3,
}

impl From<crate::AppMode> for PreferredAppMode {
    fn from(mode: crate::AppMode) -> Self {
        match mode {
            crate::AppMode::ForceDark => PreferredAppMode::ForceDark,
            crate::AppMode::ForceLight => PreferredAppMode::ForceLight,
            // Release maps to AllowDark, not Default — AllowDark is what tao
            // itself installs at event-loop init
            // (`windows/event_loop.rs:195`), so releasing restores the status
            // quo ante rather than switching to a third, different mode.
            crate::AppMode::AllowDark => PreferredAppMode::AllowDark,
        }
    }
}

type SetPreferredAppModeFn = unsafe extern "system" fn(PreferredAppMode) -> PreferredAppMode;
type FlushMenuThemesFn = unsafe extern "system" fn();

const UXTHEME_SET_PREFERRED_APP_MODE_ORDINAL: u16 = 135;
const UXTHEME_FLUSH_MENU_THEMES_ORDINAL: u16 = 136;

/// Windows 10 1903 ("May 2019 Update"). Below this build, uxtheme ordinal 135
/// is the older `AllowDarkModeForApp`, which this module does not call — see
/// the module doc comment.
const MIN_BUILD_FOR_APP_MODE: u32 = 18362;

/// `uxtheme.dll`, loaded once and kept for the process lifetime (never
/// freed — matching `tao`'s own `Lazy<isize>` pattern). Stored as `isize`
/// rather than the raw `HMODULE` pointer so the `OnceLock` is `Send + Sync`
/// without an `unsafe impl`.
fn uxtheme_module() -> Option<HMODULE> {
    static MODULE: OnceLock<isize> = OnceLock::new();
    let handle = *MODULE.get_or_init(|| {
        // SAFETY: "uxtheme.dll\0" is a valid, static, NUL-terminated ANSI
        // string. The returned handle is checked for null before use and is
        // never passed to FreeLibrary, so it stays valid for every later call.
        unsafe { LoadLibraryA(b"uxtheme.dll\0".as_ptr()) as isize }
    });
    if handle == 0 { None } else { Some(handle as HMODULE) }
}

/// Resolves a uxtheme.dll export by ordinal. `ordinal as usize as *const u8`
/// is the documented `MAKEINTRESOURCEA` encoding — `GetProcAddress`
/// distinguishes an ordinal from a real name pointer because the value never
/// falls in a mapped address range (identical to how `tao`'s own
/// `PCSTR::from_raw(ordinal as usize as *mut _)` resolves the same exports).
fn resolve_ordinal(ordinal: u16) -> FARPROC {
    let module = uxtheme_module()?;
    // SAFETY: `module` is a handle returned by a successful `LoadLibraryA`
    // above, kept alive for the process lifetime. `ordinal` is a compile-time
    // constant, not attacker- or user-controlled input.
    unsafe { GetProcAddress(module, ordinal as usize as *const u8) }
}

/// Cached: `OsVersion::current()` is an uncached `RtlGetVersion` syscall in
/// `windows-version` 0.1.7, and the OS build cannot change under a running
/// process. `tao` caches the equivalent check in a `Lazy<bool>`
/// (`windows/dark_mode.rs:31-36`); this module's doc claims to match tao's
/// pattern, so it caches too.
fn build_supports_app_mode() -> bool {
    static SUPPORTED: OnceLock<bool> = OnceLock::new();
    *SUPPORTED
        .get_or_init(|| windows_version::OsVersion::current().build >= MIN_BUILD_FOR_APP_MODE)
}

/// Forces (or releases, via `AppMode::AllowDark`) the process-wide Windows
/// "preferred app mode" — the mechanism that themes native context menus,
/// the tray menu, and common (`rfd`) dialogs (#992). Returns `false` and
/// does nothing below `MIN_BUILD_FOR_APP_MODE`, or if uxtheme.dll doesn't
/// export the ordinal (an unexpected/patched Windows build); callers must
/// treat that as an unsupported-host no-op, not an error — mirroring how
/// `apply_window_chrome`'s pre-Win11 DWM failures are handled elsewhere in
/// this codebase.
pub fn set_preferred_app_mode(mode: crate::AppMode) -> bool {
    if !build_supports_app_mode() {
        return false;
    }
    let Some(set_mode) = resolve_ordinal(UXTHEME_SET_PREFERRED_APP_MODE_ORDINAL) else {
        return false;
    };
    // SAFETY: `set_mode` was resolved via `GetProcAddress` against a live
    // module handle and is transmuted to the exact calling convention and
    // by-value `#[repr(C)]` signature uxtheme.dll implements for ordinal 135
    // on build >= 18362 (verified against `tao`'s own resolution of the same
    // ordinal the same way — see module doc comment).
    unsafe {
        let set_mode: SetPreferredAppModeFn = std::mem::transmute(set_mode);
        set_mode(mode.into());
    }
    if let Some(flush) = resolve_ordinal(UXTHEME_FLUSH_MENU_THEMES_ORDINAL) {
        // SAFETY: same reasoning as above; ordinal 136 takes no arguments.
        unsafe {
            let flush: FlushMenuThemesFn = std::mem::transmute(flush);
            flush();
        }
    }
    true
}

/// True when Windows' High Contrast accessibility mode is currently active.
/// `native_theme_action` (`lib.rs`) uses this to refuse forcing an app mode
/// while it's on, so an explicit theme choice never fights the user's
/// accessibility setting. Mid-session High Contrast toggling does not
/// re-release an already-forced app mode — that is #1364, not this guard.
///
/// `uiParam` MUST be `size_of::<HIGHCONTRASTW>()` — `SystemParametersInfoW`
/// returns FALSE (not an error, just silently declines) for a mismatched
/// size, which would make this guard never fire. Verified against
/// windows-sys 0.59: `SPI_GETHIGHCONTRAST` and `SystemParametersInfoW` live
/// in `Win32::UI::WindowsAndMessaging`; `HIGHCONTRASTW` and
/// `HCF_HIGHCONTRASTON` live in `Win32::UI::Accessibility`. This is a
/// different shape from the `windows`-crate API `tao` uses elsewhere in this
/// dependency tree (`HIGHCONTRASTA`, `.ok()`, a `dwFlags.0` tuple field) —
/// copying that shape here will not compile against windows-sys 0.59.
/// NOTE: this is the OS accessibility state, NOT Tandem's own
/// `settings.highContrast` app toggle (`useTandemSettings.ts`, applied by
/// `useHighContrast.ts`). The two are unrelated despite the shared name —
/// this one gates whether we may override the OS appearance at all, and a
/// future reader should not wire them together.
pub fn is_high_contrast_active() -> bool {
    let mut hc = HIGHCONTRASTW {
        cbSize: std::mem::size_of::<HIGHCONTRASTW>() as u32,
        dwFlags: 0,
        lpszDefaultScheme: std::ptr::null_mut(),
    };
    // SAFETY: `hc` is a stack-local, sized exactly per `SPI_GETHIGHCONTRAST`'s
    // contract (`cbSize` set, `uiParam` matching), and initialized before the
    // call. `SystemParametersInfoW` only writes within that declared size.
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETHIGHCONTRAST,
            std::mem::size_of::<HIGHCONTRASTW>() as u32,
            (&mut hc as *mut HIGHCONTRASTW).cast(),
            0,
        )
    };
    ok != 0 && (hc.dwFlags & HCF_HIGHCONTRASTON) != 0
}
