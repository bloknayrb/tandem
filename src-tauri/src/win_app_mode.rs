//! Windows "preferred app mode" bindings for native theming (#992).
//!
//! ## Why not `WebviewWindow::set_theme`
//!
//! On Windows, `set_theme` reaches no visible surface: `tauri.conf.json` sets
//! `"decorations": false` and `tauri-plugin-decorum` calls `set_decorations(false)`
//! again, so there is no native title bar for `DWMWA_USE_IMMERSIVE_DARK_MODE`
//! to paint (`apply_window_chrome` in `lib.rs` already owns the border/corner
//! styling). Tauri re-themes menus through `self.menu()` — a window MENU BAR,
//! which this app does not have; its menus are a tray menu and `popup_menu`
//! calls, and `muda`'s popup path is a bare `TrackPopupMenu`. The mechanism
//! that does reach those is uxtheme.dll's process-wide "preferred app mode",
//! the same call `tao` already makes once at event-loop init
//! (`allow_dark_mode_for_app`, also ordinal 135 — likewise PROCESS-wide;
//! tao's window-scoped dark mode is a separate export at ordinal 133).
//!
//! ### Surfaces this reaches, and one it probably does not
//!
//! Reaches: context menus and the tray menu (`muda`). NOT scrollbars — every
//! scrollbar a Tandem user sees is WebView2/Blink-rendered and driven by CSS
//! (`::-webkit-scrollbar` + the `--tandem-scrollbar-*` tokens in `index.html`,
//! shipped in #369); uxtheme has no say. File dialogs are UNVERIFIED and the
//! evidence points against: `rfd`'s Windows backend is `win_cid`, the
//! shell-hosted Common Item Dialog (`IFileOpenDialog`), which follows the
//! system `AppsUseLightTheme` value rather than a caller's process app mode —
//! the usual illustration being that Windows Terminal and VS Code force a dark
//! app mode and still get a light file picker on a light Windows. Nobody has
//! measured it here. Do not claim it in user-facing copy without measuring.
//!
//! ## The ordinal-only export
//!
//! Microsoft has never published headers or a name for these uxtheme.dll
//! exports — every consumer resolves them by numeric ordinal via
//! `GetProcAddress`, guarded by OS build number because the ordinal→function
//! mapping changed between Windows releases (the pre-1903 `AllowDarkModeForApp`
//! and the 1903+ `SetPreferredAppMode` occupy the SAME ordinal, 135, in their
//! respective uxtheme.dll builds — they are not the same function). This
//! module targets build >= 18362 (`MIN_BUILD_FOR_APP_MODE`, Windows 10 1903)
//! only — the same 1903 threshold `tao` branches on in
//! `dark_mode.rs::allow_dark_mode_for_app` — so there is no older-build branch
//! here to resolve ordinal 135 against.
//!
//! **Two deliberate divergences from that tao precedent**, neither of which
//! "matches exactly":
//!
//! 1. tao follows its mode change with `RefreshImmersiveColorPolicyState`
//!    (ordinal 104), which refreshes the immersive colour cache that
//!    `ShouldAppsUseDarkMode` reads. We never read that, so we skip 104 and
//!    call `FlushMenuThemes` (136) instead.
//! 2. tao's own local `PreferredAppMode` declares only `Default`/`AllowDark`
//!    and types ordinal 135 as returning that two-variant enum. Since the
//!    export returns the PREVIOUS mode, tao would materialize an out-of-range
//!    discriminant if it ran after we set `ForceDark`/`ForceLight`. It is
//!    unreachable today (tao's single call site is at event-loop init, before
//!    any of ours), but it is an ordering accident we do not own — which is
//!    part of why our own binding returns a plain `i32` (see below).
//!
//! `FlushMenuThemes` (ordinal 136) invalidates uxtheme's CACHED menu theme
//! data. It does not repaint a popup that is already on screen; it makes the
//! NEXT `TrackPopupMenu` draw with the new mode. That matters for long-lived
//! menu objects — the tray menu in particular, built once in `setup()` and
//! kept for the process lifetime, which would otherwise keep drawing from
//! stale cached theme data.

#![cfg(target_os = "windows")]

use std::sync::OnceLock;

// `AppModeOutcome` is declared in `lib.rs`, NOT here, even though this module is its
// only producer. This module is `#![cfg(target_os = "windows")]`, so a type declared
// here is invisible to the type-checker on every other host — and the classification
// that maps this outcome onto the IPC contract (`applied_native_theme`, #1368) has to
// be ungated and unit-testable on the machines this is developed on. Same reasoning,
// and the same shape, as `crate::native_theme::AppMode` and `crate::native_theme::HighContrast` above/below.
use crate::native_theme::AppModeOutcome;

use windows_sys::Win32::Foundation::{FARPROC, HMODULE};
use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryA};
use windows_sys::Win32::UI::Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW};
use windows_sys::Win32::UI::WindowsAndMessaging::{SPI_GETHIGHCONTRAST, SystemParametersInfoW};

/// Mirrors uxtheme.dll's `PreferredAppMode` enum exactly — this is the raw
/// Win32 ABI type passed by value across the ordinal-135 FFI boundary, and
/// its variant order is load-bearing. It is intentionally a different type
/// from `crate::native_theme::AppMode`, which is the platform-agnostic decision
/// `native_theme_action` (in `lib.rs`) produces and is unit-tested on every
/// host; keeping them separate means the FFI shape can never leak into the
/// pure decision layer.
///
/// `#[repr(i32)]`, not `#[repr(C)]`: on a fieldless enum `repr(C)` means
/// "whatever this target's C ABI says an enum is", which is target-spec
/// defined. This type exists solely to pin a Win32 `int`, so it says `i32`.
/// That also makes the `as i32` discriminant assertions in `tests` exact
/// rather than incidentally true.
#[repr(i32)]
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

impl From<crate::native_theme::AppMode> for PreferredAppMode {
    fn from(mode: crate::native_theme::AppMode) -> Self {
        match mode {
            crate::native_theme::AppMode::ForceDark => PreferredAppMode::ForceDark,
            crate::native_theme::AppMode::ForceLight => PreferredAppMode::ForceLight,
            // Release maps to AllowDark, not Default — AllowDark is what tao
            // itself installs at event-loop init
            // (`windows/event_loop.rs:195`), so releasing restores the status
            // quo ante rather than switching to a third, different mode.
            crate::native_theme::AppMode::AllowDark => PreferredAppMode::AllowDark,
        }
    }
}

/// Returns `i32`, NOT `PreferredAppMode`, even though the export really does
/// return the previous mode. Materializing a value outside 0..=3 into a
/// fieldless enum violates its validity invariant, and the source here is an
/// undocumented ordinal-resolved export from a DLL with no published header.
/// rustc emits no range metadata for this call today, so it is a latent hole
/// rather than a live miscompilation — but the value is discarded anyway, so
/// there is nothing to trade for the risk. The ABI is unchanged: both forms
/// lower to the same single-register `i32` return.
type SetPreferredAppModeFn = unsafe extern "system" fn(PreferredAppMode) -> i32;
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
        let h = unsafe { LoadLibraryA(b"uxtheme.dll\0".as_ptr()) as isize };
        if h == 0 {
            // Genuinely abnormal (Server Core, a hardened image, DLL
            // redirection) and quite different from "this build predates the
            // export" — logged separately so a bug report can tell them apart.
            log::warn!("uxtheme.dll failed to load; native app-mode theming is unavailable");
        }
        h
    });
    if handle == 0 {
        None
    } else {
        Some(handle as HMODULE)
    }
}

/// Resolves a uxtheme.dll export by ordinal. `ordinal as usize as *const u8`
/// is the `MAKEINTRESOURCEA` encoding: `GetProcAddress` treats `lpProcName`
/// as an ordinal when its high-order word is zero, which is safe because the
/// low 64 KB of address space is never mapped. (Identical to `tao`'s own
/// `PCSTR::from_raw(ordinal as usize as *mut _)`.)
///
/// Memoized per ordinal by `cached_ordinal` below, matching `tao`, which
/// caches the resolved proc addresses and not merely the module handle.
fn resolve_ordinal(ordinal: u16) -> FARPROC {
    let module = uxtheme_module()?;
    // SAFETY: `module` is a handle returned by a successful `LoadLibraryA`
    // above, kept alive for the process lifetime. `ordinal` is a compile-time
    // constant, not attacker- or user-controlled input.
    unsafe { GetProcAddress(module, ordinal as usize as *const u8) }
}

/// `FARPROC` is a raw pointer and therefore not `Sync`, so the resolved
/// address is cached as a `usize` and cast back. `0` doubles as "unresolved"
/// — a real export address is never null.
fn cached_ordinal(slot: &'static OnceLock<usize>, ordinal: u16) -> FARPROC {
    let addr = *slot.get_or_init(|| resolve_ordinal(ordinal).map_or(0, |p| p as usize));
    if addr == 0 {
        None
    } else {
        // SAFETY: `addr` is a non-null address returned by `GetProcAddress`
        // for a module that is never freed, so casting it back to the same
        // opaque function pointer it came from is valid. Callers transmute it
        // to the real signature at the call site, as before.
        Some(unsafe { std::mem::transmute::<usize, unsafe extern "system" fn() -> isize>(addr) })
    }
}

/// Cached in a `OnceLock`: the OS build cannot change under a running
/// process, and `windows-version` 0.1.7's `OsVersion::current()` re-reads it
/// (via `RtlGetVersion`, a PEB read) on every call. `tao` caches the
/// equivalent gate in a `Lazy<bool>` (`windows/dark_mode.rs`).
fn build_supports_app_mode() -> bool {
    static SUPPORTED: OnceLock<bool> = OnceLock::new();
    *SUPPORTED.get_or_init(|| windows_version::OsVersion::current().build >= MIN_BUILD_FOR_APP_MODE)
}

/// Forces (or releases, via `AppMode::AllowDark`) the process-wide Windows
/// "preferred app mode" — the mechanism that themes native context menus and
/// the tray menu (#992). See the module doc for what this does NOT reach.
/// A non-`Applied` outcome is an unsupported-host no-op, not an error, but
/// the caller is expected to log which one — see `apply_app_mode` in `lib.rs`.
pub fn set_preferred_app_mode(mode: crate::native_theme::AppMode) -> AppModeOutcome {
    if !build_supports_app_mode() {
        return AppModeOutcome::UnsupportedBuild;
    }
    static SET_MODE: OnceLock<usize> = OnceLock::new();
    static FLUSH: OnceLock<usize> = OnceLock::new();
    let Some(set_mode) = cached_ordinal(&SET_MODE, UXTHEME_SET_PREFERRED_APP_MODE_ORDINAL) else {
        return if uxtheme_module().is_none() {
            AppModeOutcome::ModuleUnavailable
        } else {
            AppModeOutcome::OrdinalMissing
        };
    };
    // SAFETY: `set_mode` was resolved via `GetProcAddress` against a live
    // module handle and is transmuted to the calling convention and by-value
    // `#[repr(i32)]` signature uxtheme.dll implements for ordinal 135 on
    // build >= 18362. Basis: `tao` resolves and calls this same ordinal the
    // same way (`dark_mode.rs::allow_dark_mode_for_app`), and the return is
    // taken as a plain `i32` so an out-of-range previous mode cannot violate
    // an enum's validity invariant.
    unsafe {
        let set_mode: SetPreferredAppModeFn = std::mem::transmute(set_mode);
        set_mode(mode.into());
    }
    if let Some(flush) = cached_ordinal(&FLUSH, UXTHEME_FLUSH_MENU_THEMES_ORDINAL) {
        // SAFETY: `flush` was resolved the same way as `set_mode` above and is
        // transmuted to a nullary `extern "system"` signature. Note this one
        // is NOT corroborated by tao — tao resolves ordinals 135, 133, 132 and
        // 104, never 136; the nullary shape comes from the ysc3839
        // win32-darkmode reference implementation that consumers of these
        // exports derive from. A nullary stdcall call cannot corrupt the
        // caller's stack (the callee pops nothing), so a wrong arity here
        // degrades to a no-op rather than to memory unsafety.
        unsafe {
            let flush: FlushMenuThemesFn = std::mem::transmute(flush);
            flush();
        }
        AppModeOutcome::Applied
    } else {
        AppModeOutcome::AppliedWithoutFlush
    }
}

/// True when Windows' High Contrast accessibility mode is currently active.
/// `native_theme_action` (`lib.rs`) uses this to refuse forcing an app mode
/// while it's on, so an explicit theme choice never fights the user's
/// accessibility setting. This remains a PER-CALL sample by design — nothing
/// here subscribes to `WM_SETTINGCHANGE`. Mid-session toggling is handled on
/// the client instead (#1364): `useTauriTheme.svelte.ts` watches
/// `(forced-colors: active)` and re-pushes the unchanged preference, which
/// re-enters this probe and releases (or re-applies) the app mode.
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
pub fn probe_high_contrast() -> crate::native_theme::HighContrast {
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
    high_contrast_from(ok, hc.dwFlags)
}

/// The decision half of `probe_high_contrast`, split out because neither
/// branch of the real syscall is reachable from a test: in an interactive GUI
/// process `SPI_GETHIGHCONTRAST` essentially cannot fail, so the failure path
/// would otherwise ship with zero coverage.
///
/// A failed query yields `Unknown`, NOT `Off`. Treating "I could not tell" as
/// "High Contrast is off" would let an API failure silently override an
/// accessibility setting the user chose at the OS level — the exact outcome
/// this guard exists to prevent, reached by the guard failing rather than by
/// its absence. `Unknown` is kept distinct from `On` because the caller must
/// additionally decline to report the push as a success (see
/// `set_native_theme`); folding the two together would let the client latch a
/// preference the OS does not have.
///
/// Related, and worth knowing: `tao`'s own `is_high_contrast` passes
/// `cbSize: 0`, which is exactly the mismatched-size case that makes
/// `SystemParametersInfoW` silently return FALSE — so tao's High Contrast
/// neutralization never fires, and the two readings in this process disagree.
/// Tracked in #1367.
fn high_contrast_from(ok: i32, flags: u32) -> crate::native_theme::HighContrast {
    if ok == 0 {
        return crate::native_theme::HighContrast::Unknown;
    }
    if (flags & HCF_HIGHCONTRASTON) != 0 {
        crate::native_theme::HighContrast::On
    } else {
        crate::native_theme::HighContrast::Off
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // These run on the `windows-latest` CI leg only — the whole module is
    // `#![cfg(target_os = "windows")]`, so on other hosts it compiles to
    // nothing. That is the right and only home for them: everything pinned
    // here is Windows-only code.

    #[test]
    fn app_mode_maps_to_the_uxtheme_abi() {
        // The single point where dark and light could be transposed. The
        // symptom of getting it wrong is "user picks dark, gets a light
        // context menu" — i.e. exactly the bug #992 exists to fix — and it is
        // invisible to every other test, which all stop at `crate::native_theme::AppMode`.
        assert_eq!(
            PreferredAppMode::from(crate::native_theme::AppMode::ForceDark),
            PreferredAppMode::ForceDark
        );
        assert_eq!(
            PreferredAppMode::from(crate::native_theme::AppMode::ForceLight),
            PreferredAppMode::ForceLight
        );
        // Release maps to AllowDark, not Default — see the `From` impl.
        assert_eq!(
            PreferredAppMode::from(crate::native_theme::AppMode::AllowDark),
            PreferredAppMode::AllowDark
        );
    }

    #[test]
    fn discriminants_match_the_uxtheme_abi() {
        // These values are a contract with uxtheme.dll, not an implementation
        // detail. rustc rejects a duplicate discriminant but not a wrong one.
        assert_eq!(PreferredAppMode::Default as i32, 0);
        assert_eq!(PreferredAppMode::AllowDark as i32, 1);
        assert_eq!(PreferredAppMode::ForceDark as i32, 2);
        assert_eq!(PreferredAppMode::ForceLight as i32, 3);
        // Pins the `#[repr(i32)]` the FFI signature's ABI argument rests on.
        assert_eq!(std::mem::size_of::<PreferredAppMode>(), 4);
    }

    #[test]
    fn a_failed_high_contrast_query_is_unknown_not_off() {
        // Fails CLOSED: the flags are all-clear (i.e. "off"), but a zero
        // return means we could not tell, and the guard must not read that as
        // permission to override an accessibility setting.
        assert_eq!(high_contrast_from(0, 0), crate::native_theme::HighContrast::Unknown);
        assert_eq!(
            high_contrast_from(0, HCF_HIGHCONTRASTON),
            crate::native_theme::HighContrast::Unknown
        );
    }

    #[test]
    fn a_successful_high_contrast_query_reads_the_flag() {
        assert_eq!(
            high_contrast_from(1, HCF_HIGHCONTRASTON),
            crate::native_theme::HighContrast::On
        );
        assert_eq!(high_contrast_from(1, 0), crate::native_theme::HighContrast::Off);
    }
}
