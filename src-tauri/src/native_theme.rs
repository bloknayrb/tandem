//! Native theming (#992, #1363, #1368).
//!
//! **Extracted from `lib.rs` (Unit 11c).** A pure move: the decision layer, the
//! platform branches, the two cfg-gated pairs and the serde contracts are
//! reproduced verbatim, and `theme_pref_tests` moved with them as a descendant
//! module so it keeps reaching private items through `use super::*`.
//!
//! **What the move had to widen, and nothing more.** `#[tauri::command]` refuses
//! to generate a wrapper whose argument or return types are less visible than
//! the command, so the two commands plus `NativeThemeOutcome`,
//! `NativeThemeError` and their field types `AppliedNativeTheme` and
//! `NativeThemeErrorCode` are `pub(crate)`. Separately, `win_app_mode.rs`
//! reaches `AppMode`, `HighContrast` and `AppModeOutcome` by `crate::` path, so
//! those three are `pub(crate)` too and its paths now name this module. That
//! second group is the one worth watching: `win_app_mode.rs` is
//! `#![cfg(target_os = "windows")]`, and cfg-stripping runs before name
//! resolution, so getting it wrong compiles clean on macOS and Linux and fails
//! only on the Windows CI leg. Everything else here stays module-private.
//!
//! **`#[tauri::command]` names are not module-qualified**, so the wire contract
//! is untouched -- the client still invokes `"get_app_theme"` and
//! `"set_native_theme"` by bare name. The `generate_handler!` entries in
//! `lib.rs` DO become module-qualified, matching `pending_update::` and
//! `context_menu::`; that is a Rust path, not a command name.
//!
//! The cross-boundary claims this module carries -- the serde renames, the
//! cfg-pair signature match, `applied_native_theme`'s exhaustive arm shape, and
//! the Rust/TypeScript enum parity -- are pinned from outside by
//! `tests/docs/native-theme-claims.test.ts`, which reads this file as text.
//! None of them is visible to `cargo check` or `npm run typecheck`.

use crate::win_app_mode;

/// Reads the native/OS theme via `window.theme()` — not a direct registry
/// read; Tauri/tao resolve `AppsUseLightTheme` from
/// `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`
/// internally and this just surfaces the result. Fixes #535.
///
/// Two platform caveats this reading inherits from `window.theme()` itself:
/// on macOS it returns Tandem's own forced theme while `set_native_theme`
/// has an override active (#992) — it is not purely an OS read there. On
/// Linux, `window.theme()` reports Light regardless of the desktop theme
/// unless tao's `dbus` feature is enabled
/// (`tao-0.35.2/src/platform_impl/linux/window.rs:1011-1022`), which this
/// project does not turn on.
#[tauri::command]
pub(crate) fn get_app_theme(window: tauri::WebviewWindow) -> Result<String, String> {
    match window.theme() {
        Ok(tauri::Theme::Dark) => Ok("dark".to_string()),
        Ok(_) => Ok("light".to_string()),
        Err(e) => Err(format!("theme() error: {e}")),
    }
}

/// Distinguishes the three ways a theme preference resolves so the loud
/// fallback warning fires only for a genuinely unrecognized string, never
/// for `"system"` — the most common transition in the whole feature.
/// `theme_pref_to_native` collapses this to a plain `Option`; this is the
/// testable seam that keeps "system" and "unrecognized" as distinct,
/// assertable branches instead of both silently landing in one catch-all
/// (#992).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ThemePrefResolution {
    Native(tauri::Theme),
    /// Explicit "follow the OS" — clears any forced native theme.
    System,
    /// Not one of the four known `ThemePreference` values. Falls back to the
    /// same "follow the OS" behavior as `System`, but logs, because this
    /// path means the client and server enum have drifted.
    Unrecognized,
}

fn resolve_theme_pref(pref: &str) -> ThemePrefResolution {
    match pref {
        "dark" => ThemePrefResolution::Native(tauri::Theme::Dark),
        "light" | "warm" => ThemePrefResolution::Native(tauri::Theme::Light),
        "system" => ThemePrefResolution::System,
        _ => ThemePrefResolution::Unrecognized,
    }
}

/// Maps the client's theme preference to a native `tauri::Theme`. `None`
/// clears any forced window theme so it reverts to following the OS — this
/// is the branch for `"system"`, and it matters: without it, `window.theme()`
/// (which `get_app_theme` reads) would keep reporting the last forced value
/// forever, even after the user returns to "system" (#992). `"warm"` is a
/// light-family theme with no native analog and maps to `Light`. A genuinely
/// unrecognized preference string also falls back to `None` (follow the OS)
/// rather than panicking or leaving a stale forced theme in place, but logs
/// loudly — see `resolve_theme_pref` for the distinction.
fn theme_pref_to_native(pref: &str) -> Option<tauri::Theme> {
    match resolve_theme_pref(pref) {
        ThemePrefResolution::Native(theme) => Some(theme),
        ThemePrefResolution::System => None,
        ThemePrefResolution::Unrecognized => {
            log::warn!(
                "theme_pref_to_native: unrecognized theme preference {pref:?}, falling back to \"system\""
            );
            None
        }
    }
}

/// Which native host `native_theme_action` is deciding for. Threaded through
/// as a parameter — rather than branched on via `cfg!` inside the decision
/// function — so the full host × pref × high-contrast matrix is
/// unit-testable from a single CI runner regardless of which OS actually
/// runs the test (#992). `current_native_host` below is the single `cfg!`
/// call site that adapts this to the real build target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeHost {
    Windows,
    MacOs,
    Linux,
}

fn current_native_host() -> NativeHost {
    if cfg!(target_os = "windows") {
        NativeHost::Windows
    } else if cfg!(target_os = "macos") {
        NativeHost::MacOs
    } else {
        NativeHost::Linux
    }
}

/// Windows app-mode target. Deliberately a different type from
/// `win_app_mode::PreferredAppMode` (the raw FFI enum matching uxtheme.dll's
/// Win32 ABI) — this one has no platform-specific representation to keep in
/// sync, so it stays available (and testable) on every OS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AppMode {
    ForceDark,
    ForceLight,
    /// The release target — see `native_theme_action` and
    /// `win_app_mode::set_preferred_app_mode` for why this is `AllowDark`
    /// and not `Default`.
    AllowDark,
}

/// What `set_preferred_app_mode` actually managed to do. Distinguishing these
/// is the point: they are the difference between "this Windows build is too
/// old", "uxtheme is missing or patched", and "it worked" — which imply
/// completely different follow-ups in a bug report, and which the previous
/// `bool` collapsed into a single message asserting two causes at once.
///
/// Declared HERE rather than in `win_app_mode` (its only producer) for the same
/// reason `AppMode` above is: that module is `#![cfg(target_os = "windows")]`, so a
/// type declared there is invisible to the type-checker on every other host. Moving
/// it out is what lets `applied_native_theme` — the function that maps this onto the
/// IPC contract (#1368) — be an ungated, exhaustively-matched, unit-testable `match`.
/// The payoff is concrete: adding a variant here is now `error[E0004]` on Linux and
/// macOS too, not only on CI's `windows-latest` leg.
///
/// The `cfg_attr` mirrors the seven existing instances of this idiom in this file:
/// off Windows nothing constructs the failure variants outside `cfg(test)`, and the
/// `test` term keeps real dead-code checking wherever a test can actually see it.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AppModeOutcome {
    Applied,
    /// Mode set, but ordinal 136 was unresolvable, so long-lived menu objects
    /// (notably the tray menu) keep drawing from uxtheme's cached theme data.
    AppliedWithoutFlush,
    UnsupportedBuild,
    ModuleUnavailable,
    OrdinalMissing,
}

/// The decided action for a `set_native_theme` call, one per platform:
/// Linux has no reachable native surface (#1363); macOS pushes via
/// `WebviewWindow::set_theme`; Windows forces (or releases) the process-wide
/// uxtheme app mode instead of calling `set_theme`, which reaches nothing
/// visible there — see the module doc comment on `win_app_mode` for why.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeThemeAction {
    Skip,
    SetWindowTheme(Option<tauri::Theme>),
    SetAppMode(AppMode),
}

/// Whether the OS High Contrast accessibility scheme is active. `Unknown` is
/// a first-class state, not a synonym for `Off`: the Windows probe can fail,
/// and reading a failed probe as "off" would let an API failure silently
/// override an accessibility setting. Callers must treat `Unknown` like `On`
/// for the purposes of declining to force — and additionally must not report
/// the push as a success (see `set_native_theme`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HighContrast {
    On,
    Off,
    Unknown,
}

impl HighContrast {
    /// True when we must not force an app mode.
    fn declines_force(self) -> bool {
        !matches!(self, HighContrast::Off)
    }
}

/// Pure decision layer for `set_native_theme` (#992). Exhaustively
/// unit-tested across all three hosts, all four `ThemePreference` values,
/// and both High Contrast states — see `theme_pref_tests::native_theme_action_matrix`.
fn native_theme_action(pref: &str, high_contrast: bool, host: NativeHost) -> NativeThemeAction {
    match host {
        NativeHost::Linux => NativeThemeAction::Skip,
        // High Contrast has no macOS guard — the guard exists because
        // forcing a Windows app mode fights the High Contrast colour scheme
        // the OS theming layer substitutes system-wide; macOS's appearance
        // API has no equivalent conflict. (`SystemParametersInfoW` is only
        // how we *query* that state; it substitutes nothing itself.)
        NativeHost::MacOs => NativeThemeAction::SetWindowTheme(theme_pref_to_native(pref)),
        NativeHost::Windows => {
            // Do not force an app mode while High Contrast is active — that
            // would fight the accessibility setting the user turned on.
            // `high_contrast` is sampled once per call, by design; the client
            // re-pushes the unchanged preference on a `(forced-colors: active)`
            // change (#1364), which is what makes a mid-session toggle release
            // (or re-apply) the app mode without a theme change.
            if high_contrast {
                return NativeThemeAction::SetAppMode(AppMode::AllowDark);
            }
            NativeThemeAction::SetAppMode(match theme_pref_to_native(pref) {
                Some(tauri::Theme::Dark) => AppMode::ForceDark,
                Some(_) => AppMode::ForceLight,
                None => AppMode::AllowDark,
            })
        }
    }
}

/// Why a `set_native_theme` push failed, as a machine-readable discriminant (#1368).
///
/// The five failure sites in this feature used to format five distinct causes into
/// prose and hand them to one `.catch(e)` on the client, where they were also
/// indistinguishable from a client-side dynamic-import rejection. A client that wants
/// to say anything useful about a failure would have had to match on English.
///
/// `MainThreadUnavailable` deliberately covers BOTH "we could not dispatch the closure"
/// and "the sender was dropped before it ran": in both the closure provably never ran,
/// which is the distinction a caller can act on. The one that is kept separate is
/// `AppModeTimeout`, because a timeout abandons the wait WITHOUT cancelling the queued
/// closure — the mode may still apply a moment later — and that difference is the whole
/// reason the receive is bounded rather than blocking.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum NativeThemeErrorCode {
    HighContrastUnknown,
    SetThemeFailed,
    AppModeTimeout,
    MainThreadUnavailable,
}

/// `camelCase`, matching `NativeThemeOutcome` — the rename on a STRUCT governs field
/// names, and `kebab-case` here would be a no-op today (`code`, `message` are single
/// words) and actively wrong the moment anyone adds a `retryAfterMs`. The
/// `kebab-case` that matters is on the enum above, which governs the variant strings
/// the client compares against.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeThemeError {
    code: NativeThemeErrorCode,
    message: String,
}

/// Constructors, all UNGATED and unit-tested (`native_theme_error_*`), holding the
/// message strings that used to be written inline at each `Err(...)` site. Two of
/// those sites are inside `#[cfg(target_os = "windows")] fn apply_app_mode`, which is
/// cfg-stripped before name resolution on this repo's development hosts and is
/// therefore reached by no local compiler and no local test. Keeping the strings out
/// here means each gated site is a single unambiguous token, and a transposed
/// code/message pairing fails a test on Linux instead of shipping.
///
/// Every message is byte-identical to the string that shipped before #1368, so
/// `tandem.log` and the client's `console.warn` output do not change.
impl NativeThemeError {
    fn high_contrast_unknown() -> Self {
        Self {
            code: NativeThemeErrorCode::HighContrastUnknown,
            message: "could not determine the High Contrast setting; declined to force an app \
                      mode and released any prior override"
                .to_string(),
        }
    }

    fn set_theme_failed(e: impl std::fmt::Display) -> Self {
        Self {
            code: NativeThemeErrorCode::SetThemeFailed,
            message: format!("set_theme failed: {e}"),
        }
    }

    #[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
    fn app_mode_timeout() -> Self {
        Self {
            code: NativeThemeErrorCode::AppModeTimeout,
            message: "app-mode call timed out (it remains queued and may still apply)".to_string(),
        }
    }

    #[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
    fn main_thread_dropped() -> Self {
        Self {
            code: NativeThemeErrorCode::MainThreadUnavailable,
            message: "app-mode main-thread closure was dropped without running".to_string(),
        }
    }

    #[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
    fn main_thread_dispatch_failed(e: impl std::fmt::Display) -> Self {
        Self {
            code: NativeThemeErrorCode::MainThreadUnavailable,
            message: format!("run_on_main_thread failed: {e}"),
        }
    }
}

/// Applies a decided `NativeThemeAction`'s side effect. Split out from
/// `set_native_theme` so the platform-specific `apply_app_mode` halves
/// (below) stay small and symmetric; this function itself is not
/// platform-gated, so it type-checks — and its `SetAppMode` arm compiles —
/// on every OS CI builds, even though `native_theme_action` only ever
/// produces that variant when `host` is `NativeHost::Windows` (i.e. the arm
/// is compiled everywhere but taken only on Windows; see `apply_app_mode`'s
/// non-Windows stub).
///
/// Returns what the app-mode call achieved, or `None` where no app-mode call was
/// attempted at all (Linux's `Skip`, macOS's `SetWindowTheme`) — `applied_native_theme`
/// needs both halves to classify the push for the wire (#1368), and an `Option` keeps
/// that classification exhaustive over the two real enums instead of inventing a third.
fn apply_native_theme_action(
    window: &tauri::WebviewWindow,
    action: NativeThemeAction,
) -> Result<Option<AppModeOutcome>, NativeThemeError> {
    match action {
        NativeThemeAction::Skip => Ok(None),
        NativeThemeAction::SetWindowTheme(theme) => window
            .set_theme(theme)
            .map(|()| None)
            .map_err(|e| NativeThemeError::set_theme_failed(e)),
        NativeThemeAction::SetAppMode(mode) => apply_app_mode(window, mode).map(Some),
    }
}

/// Forces/releases the Windows app mode. Routed through
/// `WebviewWindow::run_on_main_thread` because `SetPreferredAppMode` and
/// `FlushMenuThemes` are UI-global uxtheme calls (#992).
///
/// The channel is a completion handshake, NOT an ordering fix: `window.theme()`
/// on Windows returns a cached field (`tao`'s `Window::theme()`) that the app
/// mode never touches, so there is nothing for the read-back in
/// `set_native_theme` to race against. It exists so this function's `Result`
/// reflects whether the closure actually ran. Today it does not even block —
/// a sync `#[tauri::command]` is dispatched inline on the main thread, and
/// `run_on_main_thread` runs the closure inline when already there, so
/// `recv_timeout` returns `Ok` synchronously and neither error arm below is
/// currently reachable. The receive is bounded anyway, because that inlining
/// is a Tauri implementation detail and one `#[tauri::command(async)]` away
/// from an unbounded wait if the event loop is ever blocked or torn down.
#[cfg(target_os = "windows")]
fn apply_app_mode(
    window: &tauri::WebviewWindow,
    mode: AppMode,
) -> Result<AppModeOutcome, NativeThemeError> {
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .run_on_main_thread(move || {
            // `warn!`, not `debug!`: the log filter is Info in debug builds
            // and Warn in release (see `run`), so a `debug!` here would print
            // in no build that exists — and `tandem.log` is the only artifact
            // a user can attach to a bug report. Each cause is named
            // separately; they imply completely different follow-ups. Bounded
            // at roughly one line per distinct theme change, since
            // `setNativeTheme` dedupes client-side.
            // Bound, then matched, then sent — rather than folding the outcome into the
            // match arms below. The arms stay BYTE-IDENTICAL to what shipped, which
            // matters more here than anywhere else in this change: this body is
            // cfg-stripped on the hosts it is developed on, so a transposition between
            // two arms would compile on Windows, pass CI and mislabel the wire forever
            // (#1368).
            let outcome = win_app_mode::set_preferred_app_mode(mode);
            match outcome {
                AppModeOutcome::Applied => {}
                AppModeOutcome::AppliedWithoutFlush => log::warn!(
                    "set_native_theme: uxtheme ordinal 136 (FlushMenuThemes) unresolved — app \
                     mode applied, but long-lived menu chrome (notably the tray menu) will keep \
                     drawing from cached theme data until it is recreated"
                ),
                AppModeOutcome::UnsupportedBuild => log::warn!(
                    "set_native_theme: Windows build is older than 1903 (18362); native menus \
                     cannot follow the app theme on this host"
                ),
                AppModeOutcome::ModuleUnavailable => log::warn!(
                    "set_native_theme: uxtheme.dll unavailable; native menus cannot follow the \
                     app theme on this host"
                ),
                AppModeOutcome::OrdinalMissing => log::warn!(
                    "set_native_theme: uxtheme ordinal 135 (SetPreferredAppMode) unresolved on a \
                     build that should export it — patched or unexpected Windows image"
                ),
            }
            let _ = tx.send(outcome);
        })
        .map_err(|e| NativeThemeError::main_thread_dispatch_failed(e))?;
    match rx.recv_timeout(std::time::Duration::from_secs(2)) {
        Ok(outcome) => Ok(outcome),
        // A timeout abandons the wait; it does NOT cancel the queued closure,
        // which may still apply the mode a moment later. Distinct from a
        // dropped sender, where the closure provably never ran.
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            Err(NativeThemeError::app_mode_timeout())
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err(NativeThemeError::main_thread_dropped())
        }
    }
}

/// Non-Windows stub so `apply_native_theme_action`'s `SetAppMode` arm
/// compiles on every OS. Unreachable in practice: `native_theme_action`
/// only produces `SetAppMode` when `host` is `NativeHost::Windows`, and
/// `current_native_host` only returns that when `cfg!(target_os = "windows")`.
/// The `Applied` is a placeholder for an unreachable path, not a claim: nothing off
/// Windows ever calls this. `tests/docs/native-theme-claims.test.ts` pins this
/// signature against the Windows one, because a mismatch between the two is the one
/// break that no compiler on this host can see.
#[cfg(not(target_os = "windows"))]
fn apply_app_mode(
    _window: &tauri::WebviewWindow,
    _mode: AppMode,
) -> Result<AppModeOutcome, NativeThemeError> {
    Ok(AppModeOutcome::Applied)
}

#[cfg(target_os = "windows")]
fn native_host_high_contrast() -> HighContrast {
    win_app_mode::probe_high_contrast()
}

/// Non-Windows hosts have no equivalent conflict — see `native_theme_action`.
#[cfg(not(target_os = "windows"))]
fn native_host_high_contrast() -> HighContrast {
    HighContrast::Off
}

/// What the user actually GOT, as distinct from what the client may TRUST
/// (`override_active`). #1368.
///
/// Before this existed, a successful force, a release, a High-Contrast decline and a
/// total no-op on a pre-1903 Windows all serialized as
/// `{ overrideActive: false, osTheme: "light" }` — `override_active` is true only on
/// macOS with an explicit theme, so on Windows it is a constant and answers a
/// different question entirely ("may the client trust `osTheme`?").
///
/// `AppliedWithoutMenuFlush` is NOT folded into `UnsupportedHost`, and the name is
/// deliberately neutral over force and release: `AppModeOutcome::AppliedWithoutFlush`
/// is returned only after ordinal 135 SUCCEEDED, so the process-wide app mode really
/// is set and menus created afterwards do follow it — only long-lived menu objects
/// (the tray menu) keep cached theme data. Calling it "unsupported" would attach a
/// false, permanent warning to a partial success; calling it "forced" would be false
/// in the other direction, since `AllowDark` reaches this on a RELEASE too.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AppliedNativeTheme {
    Forced,
    Released,
    AppliedWithoutMenuFlush,
    DeclinedHighContrast,
    UnsupportedHost,
    SkippedPlatform,
}

/// Pure classification of a completed push, for the `applied` field on the wire.
///
/// THE ARM SHAPE IS PART OF THE DESIGN, not a formatting choice. Every variant is
/// enumerated; there is no `_` arm anywhere; and there are no match guards. That is
/// what makes a new `AppModeOutcome`, `NativeThemeAction` or `AppMode` variant a
/// compile error on EVERY host — the whole reason `AppModeOutcome` was moved out of
/// the Windows-gated module. `tests/docs/native-theme-claims.test.ts` pins all three
/// properties, because both of the natural "simplifications" (a `Some(_) =>` catch-all,
/// or expressing the High-Contrast test as a guard, which stops rustc counting the arm
/// toward exhaustiveness and forces a catch-all) pass every behavioural test here while
/// silently destroying the guarantee.
///
/// `high_contrast` is deliberately NOT a parameter. Given `SetAppMode(AllowDark)`,
/// "the pref resolves to a native theme" IS "High Contrast declined a requested
/// force": that action arises only from High Contrast (any pref) or from a pref that
/// resolves to no native theme with High Contrast off. A separate flag could only ever
/// agree — or introduce a disagreement that cannot occur.
///
/// It reads `resolve_theme_pref`, NOT its wrapper `theme_pref_to_native`, and that is
/// load-bearing rather than stylistic: the wrapper LOGS on the `Unrecognized` branch,
/// so re-deriving through it would warn twice per push for an unrecognized preference
/// (once from `native_theme_action`, once from here) and would give a function
/// documented as pure a side effect. `resolve_theme_pref` is the pure inner half, and
/// `Native(_)` is by construction exactly the set the wrapper maps to `Some`.
///
/// The subtlety worth naming: `SetAppMode(AllowDark)` is emitted for BOTH "the user
/// picked system, release the force" and "High Contrast is on, decline the force".
/// Classifying off the action alone labels a plain `system` release as
/// `DeclinedHighContrast` whenever High Contrast happens to be on — a false claim
/// about a case where nothing was declined.
///
/// Precedence where several could apply: a host that cannot set the mode cannot
/// release it either, and a missing menu flush is a real visual defect even under High
/// Contrast (the tray menu keeps the PREVIOUS theme rather than picking up the
/// accessibility scheme), whereas a High-Contrast decline is the user's own
/// accessibility setting winning, which is correct behaviour.
fn applied_native_theme(
    pref: &str,
    action: NativeThemeAction,
    app_mode: Option<AppModeOutcome>,
) -> AppliedNativeTheme {
    match action {
        NativeThemeAction::Skip => AppliedNativeTheme::SkippedPlatform,
        NativeThemeAction::SetWindowTheme(Some(_)) => AppliedNativeTheme::Forced,
        NativeThemeAction::SetWindowTheme(None) => AppliedNativeTheme::Released,
        NativeThemeAction::SetAppMode(mode) => match app_mode {
            // Unreachable by construction — `apply_native_theme_action`'s `SetAppMode`
            // arm always yields `Some`. Written out, and failing CLOSED, so the pair has
            // a stated meaning instead of inviting a `_ =>` that would erase the
            // exhaustiveness this design is built on.
            None => AppliedNativeTheme::UnsupportedHost,
            Some(AppModeOutcome::UnsupportedBuild)
            | Some(AppModeOutcome::ModuleUnavailable)
            | Some(AppModeOutcome::OrdinalMissing) => AppliedNativeTheme::UnsupportedHost,
            Some(AppModeOutcome::AppliedWithoutFlush) => {
                AppliedNativeTheme::AppliedWithoutMenuFlush
            }
            Some(AppModeOutcome::Applied) => match mode {
                AppMode::ForceDark | AppMode::ForceLight => AppliedNativeTheme::Forced,
                // An arm BODY `if`, never a match guard — see the note above.
                AppMode::AllowDark => {
                    if matches!(resolve_theme_pref(pref), ThemePrefResolution::Native(_)) {
                        AppliedNativeTheme::DeclinedHighContrast
                    } else {
                        AppliedNativeTheme::Released
                    }
                }
            },
        },
    }
}

/// Pure outcome assembly for `set_native_theme`, split out from the real
/// `window.theme()` I/O so it's unit-testable (#992). `read_os_theme` is
/// invoked only when the reading could not be an echo of a theme we just
/// forced — see the IPC contract on `NativeThemeOutcome`.
///
/// Written as an exhaustive `match` on purpose. A `matches!` here would make
/// this the one place a NEW `NativeThemeAction` variant must be reconsidered
/// and the one construct guaranteeing the compiler won't ask.
///
/// On the `Skip` (Linux) arm the reading is NOT trustworthy — without tao's
/// `dbus` feature, `window.theme()` on Linux returns a hardcoded `Light`
/// regardless of the desktop. It is read anyway, deliberately: `get_app_theme`
/// (which the client's boot fetch and 3s poll both call) fabricates the exact
/// same value, so suppressing it here alone would leave two code paths giving
/// contradictory answers to the same question on the same tick, while fixing
/// nothing the user can see. All of it is tracked together in #1363.
fn native_theme_outcome(
    action: NativeThemeAction,
    applied: AppliedNativeTheme,
    read_os_theme: impl FnOnce() -> Option<String>,
) -> NativeThemeOutcome {
    let (override_active, os_theme) = match action {
        NativeThemeAction::Skip => (false, read_os_theme()),
        NativeThemeAction::SetWindowTheme(Some(_)) => (true, None),
        NativeThemeAction::SetWindowTheme(None) => (false, read_os_theme()),
        NativeThemeAction::SetAppMode(_) => (false, read_os_theme()),
    };
    NativeThemeOutcome {
        override_active,
        os_theme,
        applied,
    }
}

/// Result of a `set_native_theme` call. `override_active` is true only on
/// macOS with an explicit (non-"system") theme forced — Windows never forces
/// `window.theme()` itself (tao reads the `AppsUseLightTheme` registry value
/// before falling back to uxtheme, so our app mode cannot echo into it), so
/// it is always `false` there. `os_theme` carries the authoritative live read
/// whenever `window.theme()` succeeds, and is `None` on read failure or while
/// an override is active. The client mirrors this as a discriminated union
/// (`useTauriTheme.svelte.ts`) so `{ overrideActive: true, osTheme: <value> }`
/// cannot even be constructed there.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeThemeOutcome {
    override_active: bool,
    os_theme: Option<String>,
    /// The discriminant `override_active` never was (#1368) — see `AppliedNativeTheme`.
    applied: AppliedNativeTheme,
}

/// Pushes the app's theme preference to native OS surfaces (#992).
/// Named for "native", not "window", deliberately: the Windows mechanism is
/// process-wide (uxtheme's preferred app mode) and the macOS one is app-wide
/// (`NSApp.appearance`), so nothing about this is per-window.
///
/// Mechanism is platform-specific — see `native_theme_action`:
/// - **Windows**: forces/releases the process-wide uxtheme app mode
///   (`win_app_mode`), theming context menus and the tray menu. Never calls
///   `set_theme` — see `win_app_mode`'s module doc comment for why that
///   reaches no visible surface here, and for which surfaces this does and
///   does not reach. Declines to force while High Contrast is active.
/// - **macOS**: `WebviewWindow::set_theme(...)` → `NSApp.appearance`,
///   app-wide (menus, dialogs, panels).
///  - **Linux**: no-op (#1363).
///
/// This command intentionally stays a thin wrapper around
/// `native_theme_action` (decision) and `native_theme_outcome` (result
/// assembly) — both pure and exhaustively unit-tested — plus the real I/O
/// (`apply_native_theme_action`, `window.theme()`) that needs a live
/// `WebviewWindow`.
///
/// KNOWN COVERAGE LIMIT, stated rather than papered over: nothing tests this
/// body. Replacing the `native_theme_action(...)` call with a hardcoded
/// action passes the whole suite, because no test can reach a
/// `#[tauri::command]` without `tauri::test`'s `MockRuntime`, which this
/// codebase does not use anywhere. Extracting the composition into a pure
/// helper does NOT fix that — it was measured, and the identical defect
/// simply relocates to a wrong argument at the call site, surviving equally.
/// Adopting mock-runtime scaffolding is a repo-wide decision, not a #992 one.
#[tauri::command]
pub(crate) fn set_native_theme(
    window: tauri::WebviewWindow,
    theme: String,
) -> Result<NativeThemeOutcome, NativeThemeError> {
    let high_contrast = native_host_high_contrast();
    let action = native_theme_action(&theme, high_contrast.declines_force(), current_native_host());
    let app_mode = apply_native_theme_action(&window, action)?;
    // Fail closed AND fail loud. The action above has already released any
    // prior force, so the accessibility scheme wins — but the push did not
    // achieve the requested theme, and resolving it as success would let the
    // client latch its dedupe on a preference the OS does not have,
    // deduping every later attempt to re-apply it. That is #992 itself,
    // silently restored, so report the uncertainty instead. This stays an
    // `Err` — #1368 gives it a machine-readable `code` and changes nothing
    // else about it, because the rejection is what clears the client's latch.
    if high_contrast == HighContrast::Unknown {
        return Err(NativeThemeError::high_contrast_unknown());
    }
    let applied = applied_native_theme(&theme, action, app_mode);
    Ok(native_theme_outcome(action, applied, || {
        match window.theme() {
            Ok(tauri::Theme::Dark) => Some("dark".to_string()),
            Ok(_) => Some("light".to_string()),
            Err(e) => {
                log::warn!("set_native_theme: window.theme() read-back failed: {e}");
                None
            }
        }
    }))
}

#[cfg(test)]
mod theme_pref_tests {
    use super::*;

    // #992 — native menus/dialogs/tray/dialogs follow either window.theme()
    // (macOS/Linux) or the process-wide uxtheme app mode (Windows), both
    // pushed by set_native_theme. These test the pure mapping and decision
    // layers only; the actual set_theme()/run_on_main_thread calls need a
    // live WebviewWindow and aren't unit-testable — see set_native_theme's
    // doc comment for the restructuring that keeps everything else pure.

    #[test]
    fn theme_pref_to_native_maps_every_known_preference() {
        // "warm" is a light-family theme with no native OS equivalent (#993).
        // "system" -> None is the critical branch: without it, window.theme()
        // (read by get_app_theme) would keep reporting the last forced value
        // forever, even after the user returns to "Match system".
        for (pref, expected) in [
            ("dark", Some(tauri::Theme::Dark)),
            ("light", Some(tauri::Theme::Light)),
            ("warm", Some(tauri::Theme::Light)),
            ("system", None),
        ] {
            assert_eq!(theme_pref_to_native(pref), expected, "pref={pref}");
        }
    }

    // --- A2/A3: "system" and "unrecognized" must be distinct, assertable
    // branches, not both silently swallowed by one catch-all. ---

    #[test]
    fn resolve_theme_pref_system_is_its_own_variant() {
        assert_eq!(resolve_theme_pref("system"), ThemePrefResolution::System);
    }

    #[test]
    fn resolve_theme_pref_unrecognized_is_distinct_from_system() {
        assert_eq!(
            resolve_theme_pref("sepia"),
            ThemePrefResolution::Unrecognized
        );
        assert_ne!(
            resolve_theme_pref("sepia"),
            resolve_theme_pref("system"),
            "an unrecognized preference must not be conflated with the explicit \"system\" branch"
        );
    }

    #[test]
    fn theme_pref_to_native_treats_unrecognized_like_system() {
        // Both fall back to None (follow the OS) so a client/server enum
        // drift degrades gracefully instead of leaving a stale forced theme
        // — but only the Unrecognized branch (asserted above) logs.
        assert_eq!(theme_pref_to_native("sepia"), None);
        assert_eq!(theme_pref_to_native("system"), None);
    }

    // --- A1: the full host × pref × high-contrast decision matrix, run from
    // whichever OS actually executes `cargo test` (ubuntu-latest AND
    // windows-latest in CI) since `native_theme_action` takes the host as a
    // parameter instead of branching on `cfg!` internally. ---

    #[test]
    fn native_theme_action_matrix() {
        struct Case {
            pref: &'static str,
            mac_theme: Option<tauri::Theme>,
            windows_mode: AppMode,
        }
        let cases = [
            Case {
                pref: "dark",
                mac_theme: Some(tauri::Theme::Dark),
                windows_mode: AppMode::ForceDark,
            },
            Case {
                pref: "light",
                mac_theme: Some(tauri::Theme::Light),
                windows_mode: AppMode::ForceLight,
            },
            Case {
                pref: "warm",
                mac_theme: Some(tauri::Theme::Light),
                windows_mode: AppMode::ForceLight,
            },
            Case {
                pref: "system",
                mac_theme: None,
                windows_mode: AppMode::AllowDark,
            },
        ];

        for case in cases {
            for high_contrast in [false, true] {
                // Linux: always Skip — no reachable native surface (#1363) —
                // regardless of pref or High Contrast.
                assert_eq!(
                    native_theme_action(case.pref, high_contrast, NativeHost::Linux),
                    NativeThemeAction::Skip,
                    "linux pref={} high_contrast={high_contrast}",
                    case.pref
                );

                // macOS: mirrors theme_pref_to_native; High Contrast has no
                // macOS guard (Windows-only concern, see A5).
                assert_eq!(
                    native_theme_action(case.pref, high_contrast, NativeHost::MacOs),
                    NativeThemeAction::SetWindowTheme(case.mac_theme),
                    "macos pref={} high_contrast={high_contrast}",
                    case.pref
                );
            }

            // Windows, High Contrast off: forces the mapped app mode.
            assert_eq!(
                native_theme_action(case.pref, false, NativeHost::Windows),
                NativeThemeAction::SetAppMode(case.windows_mode),
                "windows pref={} high_contrast=false",
                case.pref
            );

            // Windows, High Contrast on: always releases regardless of pref
            // — the A5 guard, distinct from the pref-driven branch above.
            assert_eq!(
                native_theme_action(case.pref, true, NativeHost::Windows),
                NativeThemeAction::SetAppMode(AppMode::AllowDark),
                "windows pref={} high_contrast=true",
                case.pref
            );
        }
    }

    // --- A6/A8: native_theme_outcome, composed with native_theme_action AND
    // applied_native_theme exactly as set_native_theme's body does — the wiring
    // seam for the command itself, which needs a live WebviewWindow and can't be
    // unit-tested directly. The `app_mode` argument mirrors what
    // `apply_native_theme_action` returns for that action: `None` where no
    // app-mode call is attempted (Linux Skip, macOS SetWindowTheme), and
    // `Some(AppModeOutcome::Applied)` for a Windows app-mode call that worked.
    // #1368 added the third argument; the degraded-outcome cases live in
    // `applied_*` below rather than here. ---

    #[test]
    fn outcome_macos_explicit_theme_overrides_and_skips_readback() {
        let action = native_theme_action("dark", false, NativeHost::MacOs);
        let applied = applied_native_theme("dark", action, None);
        let mut read_called = false;
        let outcome = native_theme_outcome(action, applied, || {
            read_called = true;
            Some("dark".to_string())
        });
        assert!(outcome.override_active);
        assert_eq!(outcome.os_theme, None);
        assert_eq!(outcome.applied, AppliedNativeTheme::Forced);
        assert!(
            !read_called,
            "osTheme must never be sourced from a read that could echo our own forced theme"
        );
    }

    #[test]
    fn outcome_macos_system_releases_and_reads_authoritatively() {
        let action = native_theme_action("system", false, NativeHost::MacOs);
        let applied = applied_native_theme("system", action, None);
        let outcome = native_theme_outcome(action, applied, || Some("dark".to_string()));
        assert!(!outcome.override_active);
        assert_eq!(outcome.os_theme, Some("dark".to_string()));
        assert_eq!(outcome.applied, AppliedNativeTheme::Released);
    }

    #[test]
    fn outcome_windows_never_reports_override_active_for_any_pref() {
        // Windows never calls set_theme, so window.theme() stays honest
        // regardless of which AppMode was forced — overrideActive must be
        // false for every pref, matching the platform contract table.
        for (pref, expected) in [
            ("dark", AppliedNativeTheme::Forced),
            ("light", AppliedNativeTheme::Forced),
            ("warm", AppliedNativeTheme::Forced),
            ("system", AppliedNativeTheme::Released),
            // An unrecognized pref resolves to "follow the OS", so it releases
            // rather than forcing — see `theme_pref_to_native`.
            ("bogus", AppliedNativeTheme::Released),
        ] {
            let action = native_theme_action(pref, false, NativeHost::Windows);
            let applied = applied_native_theme(pref, action, Some(AppModeOutcome::Applied));
            let outcome = native_theme_outcome(action, applied, || Some("light".to_string()));
            assert!(
                !outcome.override_active,
                "windows overrideActive must be false (pref={pref})"
            );
            assert_eq!(outcome.os_theme, Some("light".to_string()));
            assert_eq!(outcome.applied, expected, "windows applied (pref={pref})");
        }
    }

    #[test]
    fn outcome_linux_reports_no_override_and_still_reads() {
        // Linux takes the `Skip` arm. It must report `override_active: false`
        // — pairing `None` with `true` (the natural-looking pairing, since
        // that is what the macOS force arm uses) would permanently disable
        // the client's 3s poll and every read-back on Linux, with nothing
        // that ever resolves an outcome to clear it again.
        let action = native_theme_action("dark", false, NativeHost::Linux);
        let applied = applied_native_theme("dark", action, None);
        let mut read_called = false;
        let outcome = native_theme_outcome(action, applied, || {
            read_called = true;
            Some("light".to_string())
        });
        assert!(!outcome.override_active);
        assert_eq!(outcome.os_theme, Some("light".to_string()));
        assert_eq!(outcome.applied, AppliedNativeTheme::SkippedPlatform);
        // The reading is untrustworthy on Linux but is still taken, to stay
        // consistent with `get_app_theme` — see `native_theme_outcome`, #1363.
        assert!(read_called);
    }

    // --- #1368: applied_native_theme, the pure classifier behind the wire's
    // `applied` discriminant. Every case here is reachable on a real Windows
    // host and unreachable from `cargo test` on any host without this split —
    // the whole reason `AppModeOutcome` was moved out of the Windows-gated
    // module. The `app_mode` argument is what `apply_native_theme_action`
    // returns: `None` when no app-mode call was attempted at all. ---

    #[test]
    fn applied_linux_skip_is_skipped_platform() {
        // A Linux user must never be told anything about Windows menus, and
        // this variant is what the client keys that silence on.
        let action = native_theme_action("dark", false, NativeHost::Linux);
        assert_eq!(
            applied_native_theme("dark", action, None),
            AppliedNativeTheme::SkippedPlatform
        );
    }

    #[test]
    fn applied_macos_forces_on_explicit_and_releases_on_system() {
        for pref in ["dark", "light", "warm"] {
            let action = native_theme_action(pref, false, NativeHost::MacOs);
            assert_eq!(
                applied_native_theme(pref, action, None),
                AppliedNativeTheme::Forced,
                "macos pref={pref}"
            );
        }
        for pref in ["system", "bogus"] {
            let action = native_theme_action(pref, false, NativeHost::MacOs);
            assert_eq!(
                applied_native_theme(pref, action, None),
                AppliedNativeTheme::Released,
                "macos pref={pref}"
            );
        }
    }

    #[test]
    fn applied_macos_ignores_high_contrast_entirely() {
        // macOS has NO High Contrast guard (see native_theme_action): the guard
        // exists because a Windows app mode fights the colour scheme the OS
        // substitutes system-wide, and macOS's appearance API has no equivalent
        // conflict. Letting High Contrast reach this arm would report a decline
        // that never happened.
        let action = native_theme_action("dark", true, NativeHost::MacOs);
        assert_eq!(
            applied_native_theme("dark", action, None),
            AppliedNativeTheme::Forced
        );
    }

    #[test]
    fn applied_windows_explicit_pref_under_high_contrast_is_declined() {
        for pref in ["dark", "light", "warm"] {
            let action = native_theme_action(pref, true, NativeHost::Windows);
            assert_eq!(action, NativeThemeAction::SetAppMode(AppMode::AllowDark));
            assert_eq!(
                applied_native_theme(pref, action, Some(AppModeOutcome::Applied)),
                AppliedNativeTheme::DeclinedHighContrast,
                "windows pref={pref} high_contrast=true"
            );
        }
    }

    #[test]
    fn applied_windows_system_under_high_contrast_is_released_not_declined() {
        // THE trap in this classifier. `SetAppMode(AllowDark)` is emitted for
        // BOTH "the user picked system, release the force" and "High Contrast is
        // on, decline the force" — so classifying off the action alone reports
        // `declined-high-contrast` for a plain release whenever High Contrast
        // happens to be on. Nothing was declined there: the user asked for the
        // force to be released and it was.
        for pref in ["system", "bogus"] {
            let action = native_theme_action(pref, true, NativeHost::Windows);
            assert_eq!(action, NativeThemeAction::SetAppMode(AppMode::AllowDark));
            assert_eq!(
                applied_native_theme(pref, action, Some(AppModeOutcome::Applied)),
                AppliedNativeTheme::Released,
                "windows pref={pref} high_contrast=true"
            );
        }
    }

    #[test]
    fn applied_windows_without_high_contrast_forces_or_releases() {
        for (pref, expected) in [
            ("dark", AppliedNativeTheme::Forced),
            ("light", AppliedNativeTheme::Forced),
            ("warm", AppliedNativeTheme::Forced),
            ("system", AppliedNativeTheme::Released),
            ("bogus", AppliedNativeTheme::Released),
        ] {
            let action = native_theme_action(pref, false, NativeHost::Windows);
            assert_eq!(
                applied_native_theme(pref, action, Some(AppModeOutcome::Applied)),
                expected,
                "windows pref={pref} high_contrast=false"
            );
        }
    }

    #[test]
    fn applied_without_flush_is_its_own_variant_not_unsupported() {
        // `AppliedWithoutFlush` is returned only after ordinal 135 SUCCEEDED, so
        // the process-wide app mode really is set — only long-lived menu objects
        // (the tray menu) keep cached theme data. Folding it into
        // `UnsupportedHost` would attach the user-facing "native menus can't
        // follow the app theme on this Windows build" copy to a partial SUCCESS,
        // permanently, in an activity tray that is a log. Folding it into
        // `Forced` would be false on the release path below.
        for pref in ["dark", "system"] {
            let action = native_theme_action(pref, false, NativeHost::Windows);
            assert_eq!(
                applied_native_theme(pref, action, Some(AppModeOutcome::AppliedWithoutFlush)),
                AppliedNativeTheme::AppliedWithoutMenuFlush,
                "windows pref={pref} outcome=AppliedWithoutFlush"
            );
        }
    }

    #[test]
    fn applied_reports_unsupported_host_for_every_failed_app_mode_call() {
        for outcome in [
            AppModeOutcome::UnsupportedBuild,
            AppModeOutcome::ModuleUnavailable,
            AppModeOutcome::OrdinalMissing,
        ] {
            for pref in ["dark", "system"] {
                let action = native_theme_action(pref, false, NativeHost::Windows);
                assert_eq!(
                    applied_native_theme(pref, action, Some(outcome)),
                    AppliedNativeTheme::UnsupportedHost,
                    "windows pref={pref} outcome={outcome:?}"
                );
            }
        }
        // ...and it outranks the High Contrast decline: a host that cannot set
        // the mode cannot release it either, so "this host can't do it" is both
        // the true cause and the actionable one.
        let action = native_theme_action("dark", true, NativeHost::Windows);
        assert_eq!(
            applied_native_theme("dark", action, Some(AppModeOutcome::UnsupportedBuild)),
            AppliedNativeTheme::UnsupportedHost
        );
    }

    #[test]
    fn applied_set_app_mode_without_an_outcome_fails_closed() {
        // Unreachable by construction — `apply_native_theme_action`'s SetAppMode
        // arm always yields `Some`. Asserted anyway so the pair has a stated
        // meaning: the alternative to writing it out is a `_ =>` catch-all, which
        // would silently swallow a future `AppModeOutcome` variant and erase the
        // exhaustiveness this whole design is built on.
        assert_eq!(
            applied_native_theme(
                "dark",
                NativeThemeAction::SetAppMode(AppMode::ForceDark),
                None
            ),
            AppliedNativeTheme::UnsupportedHost
        );
    }

    // --- #1368: the serialized wire shape. serde renames are invisible to every
    // compiler on both sides of the IPC, and the client compares string literals. ---

    #[test]
    fn native_theme_outcome_serializes_applied_as_kebab_case() {
        let value = serde_json::to_value(NativeThemeOutcome {
            override_active: false,
            os_theme: Some("light".to_string()),
            applied: AppliedNativeTheme::DeclinedHighContrast,
        })
        .expect("NativeThemeOutcome must serialize");
        assert_eq!(value["overrideActive"], serde_json::json!(false));
        assert_eq!(value["osTheme"], serde_json::json!("light"));
        // Drop `rename_all = "kebab-case"` from AppliedNativeTheme and this is
        // "DeclinedHighContrast" — which no client comparison ever matches, so the
        // feature silently does nothing and nothing fails.
        assert_eq!(
            value["applied"],
            serde_json::json!("declined-high-contrast")
        );
    }

    #[test]
    fn every_applied_native_theme_variant_serializes_kebab_case() {
        for (variant, expected) in [
            (AppliedNativeTheme::Forced, "forced"),
            (AppliedNativeTheme::Released, "released"),
            (
                AppliedNativeTheme::AppliedWithoutMenuFlush,
                "applied-without-menu-flush",
            ),
            (
                AppliedNativeTheme::DeclinedHighContrast,
                "declined-high-contrast",
            ),
            (AppliedNativeTheme::UnsupportedHost, "unsupported-host"),
            (AppliedNativeTheme::SkippedPlatform, "skipped-platform"),
        ] {
            assert_eq!(
                serde_json::to_value(variant).expect("variant must serialize"),
                serde_json::json!(expected)
            );
        }
    }

    #[test]
    fn native_theme_error_serializes_camel_case_struct_and_kebab_case_code() {
        let value = serde_json::to_value(NativeThemeError::high_contrast_unknown())
            .expect("NativeThemeError must serialize");
        // The struct's fields are single words today, so `camelCase` here is a
        // no-op — but `kebab-case` on the STRUCT would be actively wrong for any
        // future multi-word field, and the rename that IS load-bearing is the one
        // on the enum, asserted next.
        assert!(value.get("code").is_some(), "error must carry a code");
        assert!(value.get("message").is_some(), "error must carry a message");
        assert_eq!(value["code"], serde_json::json!("high-contrast-unknown"));
    }

    #[test]
    fn every_native_theme_error_constructor_pairs_its_code_with_its_message() {
        // The two `main_thread_*` constructors and `app_mode_timeout` are called
        // ONLY from `#[cfg(target_os = "windows")] fn apply_app_mode`, which is
        // cfg-stripped before name resolution on every host this repo is developed
        // on — no local compiler and no local test reaches those call sites. Keeping
        // the strings out here is what makes a transposed pairing fail on Linux
        // instead of shipping. Every message is byte-identical to what shipped
        // before #1368, so `tandem.log` and the client's console output do not move.
        let cases: [(NativeThemeError, NativeThemeErrorCode, &str); 5] = [
            (
                NativeThemeError::high_contrast_unknown(),
                NativeThemeErrorCode::HighContrastUnknown,
                "could not determine the High Contrast setting; declined to force an app mode \
                 and released any prior override",
            ),
            (
                NativeThemeError::set_theme_failed("boom"),
                NativeThemeErrorCode::SetThemeFailed,
                "set_theme failed: boom",
            ),
            (
                NativeThemeError::app_mode_timeout(),
                NativeThemeErrorCode::AppModeTimeout,
                "app-mode call timed out (it remains queued and may still apply)",
            ),
            (
                NativeThemeError::main_thread_dropped(),
                NativeThemeErrorCode::MainThreadUnavailable,
                "app-mode main-thread closure was dropped without running",
            ),
            (
                NativeThemeError::main_thread_dispatch_failed("boom"),
                NativeThemeErrorCode::MainThreadUnavailable,
                "run_on_main_thread failed: boom",
            ),
        ];
        for (error, code, message) in cases {
            assert_eq!(error.code, code, "code for {message:?}");
            assert_eq!(error.message, message);
        }
    }

    #[test]
    fn current_native_host_matches_the_build_target() {
        // Oracle comes from `std::env::consts::OS`, a separately-compiled
        // crate, rather than from `cfg!` — restating this crate's own `cfg!`
        // in the assertion would make the test a pure change-detector that
        // any mutation of `current_native_host` satisfies by construction.
        //
        // Coverage note: `rust-test` runs on ubuntu, windows and macos, so
        // all three arms are asserted, each on the leg that can reach it.
        let expected = match std::env::consts::OS {
            "windows" => NativeHost::Windows,
            "macos" => NativeHost::MacOs,
            _ => NativeHost::Linux,
        };
        assert_eq!(current_native_host(), expected);
    }

    #[test]
    fn high_contrast_declines_force_unless_definitely_off() {
        // `Unknown` must behave like `On` here: a failed probe is not
        // permission to override an accessibility setting.
        assert!(!HighContrast::Off.declines_force());
        assert!(HighContrast::On.declines_force());
        assert!(HighContrast::Unknown.declines_force());
    }
}
