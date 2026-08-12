mod autostart;
pub mod keychain;
mod sentry_reporting;
mod token_store;
mod uninstall_scrub;

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
// Native theming (#992): resolves the undocumented uxtheme.dll "preferred
// app mode" exports that theme context menus, the tray menu, and common
// dialogs on Windows. See the module doc comment for why this replaces
// `WebviewWindow::set_theme` there.
#[cfg(target_os = "windows")]
mod win_app_mode;

// Windows-only: kill-on-job-close ownership so the sidecar dies with the shell
// even on ungraceful exit (taskkill / crash / dev-runner restart). See #987.
#[cfg(target_os = "windows")]
mod sidecar_job;

// Spike #477 PR 4: sidecar launcher validation. Test-only; not shipped.
#[cfg(test)]
mod integrations_probe;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Url;
use tauri::{Emitter, Manager};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_prevent_default::Flags;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_window_state::StateFlags;

/// Keep in sync with DEFAULT_MCP_PORT in src/shared/constants.ts (port 3479).
/// Must use 127.0.0.1, not `localhost` — `isHostAllowed` (api-routes.ts) narrowed
/// out the bare `localhost` hostname in #477 PR 2, so a `Host: localhost:3479`
/// request returns 403 Forbidden and the supervisor's health-poll times out.
const HEALTH_URL: &str = "http://127.0.0.1:3479/health";
const OPEN_URL: &str = "http://127.0.0.1:3479/api/open";
/// Graceful-shutdown endpoint on the sidecar (#1088). POSTing here triggers
/// the Node shutdown sequence (dirty-doc flush + session save) before exit.
/// Keep in sync with API_SHUTDOWN in src/shared/api-paths.ts.
const SHUTDOWN_URL: &str = "http://127.0.0.1:3479/api/shutdown";
/// Launcher nonce + deferred-start endpoints (#1236). A boot launch tells the
/// sidecar to hold the Claude Code launcher; these promote it once a human
/// actually shows up. Keep in sync with API_LAUNCHER_NONCE / API_LAUNCHER_START
/// in src/shared/api-paths.ts.
const LAUNCHER_NONCE_URL: &str = "http://127.0.0.1:3479/api/launcher/nonce";
const LAUNCHER_START_URL: &str = "http://127.0.0.1:3479/api/launcher/start";
/// How long a presence signal waits for the sidecar before giving up and
/// re-arming the latch. Generous: the user has already shown up, so a slow boot
/// should still get Claude launched rather than silently skipping it.
const PRESENCE_HEALTH_DEADLINE: Duration = Duration::from_secs(90);
/// License status endpoint (loopback). The updater reads `licenseId` +
/// `updateWindowCurrent` to decide whether to route update checks through the
/// license-gated Worker (#1116, ADR-040 §7). Keep in sync with
/// API_LICENSE_STATUS in src/shared/api-paths.ts.
const LICENSE_STATUS_URL: &str = "http://127.0.0.1:3479/api/license/status";
/// Deployed license-update Worker endpoint (owner-configured; see
/// docs/licensing-operations.md §3). EMPTY until the Worker is deployed for
/// v1.0 — while empty, update checks always use the default public endpoint
/// from tauri.conf.json, so updater behavior is byte-identical to today. The
/// `{{target}}`, `{{arch}}`, and `{{current_version}}` template vars are
/// expanded by tauri-plugin-updater at check time.
const LICENSE_UPDATE_ENDPOINT: &str = "";
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(200);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(15);
const HTTP_CLIENT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long to wait for the sidecar to exit after POST /api/shutdown before
/// hard-killing it. The Node shutdown's disk flush is 5s-bounded
/// (src/server/index.ts), so 6s covers the flush plus the session save in the
/// common case while keeping the restart button responsive (#1088).
const GRACEFUL_SHUTDOWN_DEADLINE_SECS: u64 = 6;
const MAX_RESTARTS: u32 = 3;
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(8 * 60 * 60);

/// Cadence of the Cowork self-heal pass (see `cowork_heal_pass`): installs
/// plugin entries into workspaces that appear after the integration was
/// enabled (e.g. the user's first Cowork run) without requiring a settings
/// visit. The first tick fires immediately at launch.
#[cfg(target_os = "windows")]
const COWORK_HEAL_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// File extensions Tandem can open via OS file association. Keep aligned with
/// `SUPPORTED_EXTENSIONS` in `src/shared/constants.ts` (re-exported through
/// `src/server/mcp/file-opener.ts`) — server-side is the authority; this list is
/// defense-in-depth, rejecting an obviously-wrong open candidate before an HTTP
/// request is issued. Since #1344 that means BOTH surfaces: argv on
/// Windows/Linux, and macOS `RunEvent::Opened` URLs.
///
/// "Keep aligned" was the whole instruction and it still drifted (#1306):
/// `markdown` sat in this list and in `tauri.conf.json` while the server
/// rejected it, and the failure is silent — `maybeOpenStartupFile` swallows the
/// open error and falls through to `welcome.md`. The alignment is now pinned by
/// `tests/build/file-association-alignment.test.ts`, which parses this literal
/// out of the source, so renaming or reshaping the constant fails that test
/// rather than silently stopping the check.
///
/// It must EQUAL the server's list, not merely be a subset of it. `htm` used to
/// be omitted, on the reasoning that `.htm` is not OS-registered (`.html` alone
/// is the association) so a double-click could never put one on argv. That was
/// true of argv and false everywhere else: #1344 routed the macOS Apple Event
/// through this same filter, and "Open With" and a Dock-icon drop deliver ANY
/// file regardless of registration. Omitting `htm` therefore stopped being a
/// no-op the moment the filter was shared, and refused a file the server
/// accepts — while the same file dropped on the window still opened, because
/// `useTauriFileDrop.svelte.ts` checks the server's list. Equality costs no
/// defense (the server rejects everything else regardless) and deletes the
/// drift axis instead of testing it.
///
/// `pub` rather than `pub(crate)` so `tests/file_association.rs` can iterate it
/// instead of keeping a hand-copied duplicate.
pub const SUPPORTED_FILE_ASSOC_EXTS: &[&str] =
    &["md", "markdown", "txt", "html", "htm", "docx"];

/// Set to `true` once the sidecar's /health endpoint has responded 200 AND the
/// pending-opens queue has been drained. Read by the `RunEvent::Opened` handler
/// to decide between posting immediately vs queueing. Static (process-wide):
/// there is exactly one sidecar per process.
static SIDECAR_HEALTHY: AtomicBool = AtomicBool::new(false);

/// One-shot latch: true from an autostart launch until the first human-presence
/// signal, and read on EVERY sidecar spawn.
///
/// It has to be a latch rather than a value captured once at spawn time. The
/// `.env(...)` chain lives inside `for attempt in 0..=MAX_RESTARTS`, and
/// `restart_sidecar` re-enters `start_sidecar` from scratch — the existing code
/// guards `TANDEM_OPEN_FILE` with `if attempt == 0` for exactly this reason. A
/// statically captured flag would mean: boot hidden → user opens the window →
/// launcher starts → sidecar crashes and restarts → the fresh sidecar defers
/// again, no second presence signal ever fires, and Claude never comes back for
/// the rest of the session.
static LAUNCHER_DEFERRED: AtomicBool = AtomicBool::new(false);

/// Buffered file-open rejection reason CODE (stable, path-free) — the single
/// delivery surface for EVERY entry point, cold start and warm start alike.
/// See issues #630 and #1344.
///
/// ## Why buffer instead of just emitting an event
///
/// A cold-start "Open With" rejection (`extract_file_arg` returns `Err`) is
/// classified in `setup()` — which runs before `App.svelte` exists at all, let
/// alone its listener. Emitting a Tauri event there drops silently on the exact
/// failure mode it is meant to surface. So the reason is buffered here and
/// drained via `get_startup_rejection()` when the client comes up.
///
/// ## Why the buffer is unconditional, and not gated on WebView readiness
///
/// `startup-file-rejected` is a payload-free NUDGE, answered by calling
/// `get_startup_rejection()` — the same take-once accessor the init-time drain
/// uses. So Rust never has to know whether the listener is wired, which it
/// cannot know.
///
/// An earlier revision of this work (see PR #1414's history; the design does not
/// appear in issue #1344 itself) inferred readiness from a `REJECTION_POLLED`
/// latch — "the WebView has polled, so its listener must be wired" — and skipped
/// the buffer once set. The inference does not hold, for a reason that needs no
/// race to demonstrate: the latch is process-global and the listener is not. **A
/// WebView reload leaves the latch set and the listener gone**, so every
/// rejection after the first reload took the emit-only path and was dropped
/// permanently. (`App.svelte` also wires the listener and drains in two
/// independent promise chains whose completion order is not guaranteed, so a
/// completed drain never proved a wired listener either — but that one is a
/// sub-millisecond window and is not the argument this rests on.)
///
/// Unconditional buffering also means a nudge with no listener costs one dropped
/// event rather than the toast. Same queue-then-drain shape as `PendingOpens`,
/// the other place in this file where a producer must not care whether the
/// consumer is ready.
///
/// ## Why a `Mutex<Option<_>>` and not a `OnceLock`
///
/// `OnceLock` cannot be cleared, but the buffer MUST be cleared on
/// `restart_sidecar` so a stale rejection from a previous launch isn't replayed
/// against the new sidecar. A `Mutex<Option<String>>` gives set / take / clear.
///
/// ## No path leakage
///
/// The buffer holds a stable reason CODE only (e.g. `"unsupported-extension"`),
/// never the rejected path — the resolved path is already logged at `warn` for
/// diagnostics, and the human-readable toast message is composed client-side
/// (mirrors the path-free `sidecar-restart-failed` toast contract). The writers
/// take `&'static str` precisely so this cannot be relaxed by accident; see
/// [`buffer_startup_rejection_code`].
static STARTUP_REJECTION: Mutex<Option<String>> = Mutex::new(None);

/// Run `f` against the rejection buffer, recovering from (and reporting) a
/// poisoned mutex. One helper rather than three hand-rolled `match` arms: the
/// take path used to be the only one that recovered *silently*, and it is the
/// one whose recovery destroys state, so the divergence was exactly backwards.
fn with_rejection<R>(what: &str, f: impl FnOnce(&mut Option<String>) -> R) -> R {
    match STARTUP_REJECTION.lock() {
        Ok(mut guard) => f(&mut guard),
        Err(poisoned) => {
            log::error!("STARTUP_REJECTION mutex poisoned during {what} — recovering");
            f(&mut poisoned.into_inner())
        }
    }
}

/// Tauri event name for a startup-file rejection surfaced to the WebView.
/// Deliberately payload-FREE: it is a nudge to call `get_startup_rejection`,
/// not the delivery itself (see [`STARTUP_REJECTION`]). Keeping the code out of
/// the payload is what makes the buffer the single source of truth, so a nudge
/// with no listener costs nothing.
const EVENT_STARTUP_FILE_REJECTED: &str = "startup-file-rejected";

/// Map a typed [`RejectionReason`] to a stable, path-free reason code for the
/// WebView toast bus. The code travels to the client through
/// `get_startup_rejection`, never through the event payload; `App.svelte`'s
/// reason-code→message map turns it into user-facing text.
fn rejection_reason_code(reason: &RejectionReason) -> &'static str {
    match reason {
        RejectionReason::SuspiciousColon { .. } => "suspicious-path",
        RejectionReason::UnsupportedExtension { .. } => "unsupported-extension",
        RejectionReason::NotAFile { .. } => "not-a-file",
    }
}

/// Record an already-mapped, path-free reason CODE in the buffer. The single
/// writer — every entry point funnels through [`surface_startup_rejection`],
/// which funnels through here.
///
/// `&'static str`, not `&str`, and that is a safety property rather than a
/// style choice. `Display for OpenedUrlRejection` deliberately EMBEDS the
/// resolved path (it is the log format), so a sink taking `&str` would accept
/// `&format!("{reason}")` and put a filesystem path on the wire to the DOM.
/// A formatted string is not `'static`, so that mistake is now a compile error
/// rather than a thing tests have to notice. Both producers
/// ([`rejection_reason_code`], [`opened_url_reason_code`]) already return
/// `&'static str` from a closed set of literals.
///
/// Last-write-wins. A multi-file Opened batch rejects at most once through
/// [`surface_startup_rejection`] — the batch collapses to a single code before
/// it reaches here — so the surviving value is one deliberate summary, not an
/// arbitrary survivor of N racing writes.
fn buffer_startup_rejection_code(code: &'static str) {
    with_rejection("buffer", |slot| *slot = Some(code.to_string()));
}

/// Deliver a startup-file rejection to the WebView. THE delivery path — every
/// OS entry point that rejects a candidate calls this and nothing else: argv
/// cold start, second-instance warm start, and the macOS Apple Event, which
/// alone serves cold and warm start through one arm.
///
/// Buffer first, then nudge, unconditionally. Do not re-add a "has the WebView
/// polled yet" discriminator to skip the buffer on warm start — [`STARTUP_REJECTION`]
/// records why the readiness inference is false (it also raced, being read
/// outside the buffer's mutex).
fn surface_startup_rejection(app: &tauri::AppHandle, code: &'static str) {
    surface_startup_rejection_with(code, || {
        if let Err(e) = app.emit(EVENT_STARTUP_FILE_REJECTED, ()) {
            // Non-fatal by construction: the code is already buffered, so the
            // worst case is that the toast waits for the next client init.
            log::warn!("Failed to emit {EVENT_STARTUP_FILE_REJECTED}: {e}");
        }
    });
}

/// The testable half of [`surface_startup_rejection`], split out because
/// `tauri::AppHandle` cannot be constructed in a unit test (no `tauri` `test`
/// feature is in dev-dependencies) — and without this seam the ordering below
/// was pinned by nothing at all: deleting the buffer call reverted the whole
/// fix, and swapping the two lines re-opened the drop, both with a green suite.
///
/// The order is the contract. Buffer BEFORE nudging, or a live listener drains
/// an empty slot and the toast is lost — the nudge is deliberately payload-free,
/// so it carries nothing the client could fall back on.
fn surface_startup_rejection_with(code: &'static str, nudge: impl FnOnce()) {
    buffer_startup_rejection_code(code);
    nudge();
}

/// Wire code for "more than one file in this batch was refused". Distinct from
/// the per-reason codes because a mixed batch has no single true reason, and
/// picking one of them would state something false rather than something vague.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
const CODE_MULTIPLE_REJECTED: &str = "multiple-rejected";

/// Collapses one OS batch — a Finder multi-select "Open With", a multi-file Dock
/// drop — into the single code the user should see.
///
/// This exists because the buffer is one slot and the batch is N rejections. The
/// obvious shape (call [`surface_startup_rejection`] per rejected URL) is what
/// the first version did, and it is nondeterministic in a way that shows: the
/// loop is synchronous while the client's drain is an async IPC round-trip, so
/// whether the user got one toast or two-with-a-count-badge, and which reason it
/// named, depended on where the drain happened to land. Same user action, two
/// different outcomes.
///
/// Accumulating first and surfacing once removes the race rather than narrowing
/// it. Deliberately ungated and free of Tauri types so it is unit-testable on
/// every platform — its only caller, `handle_opened_urls`, is macOS-only and
/// cannot be tested from Windows or Linux CI, which is precisely why the logic
/// must not live inside it.
#[derive(Default)]
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
struct RejectionBatch {
    first: Option<&'static str>,
    count: usize,
}

#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
impl RejectionBatch {
    fn record(&mut self, code: &'static str) {
        self.count += 1;
        if self.first.is_none() {
            self.first = Some(code);
        }
    }

    /// The one code to surface, or `None` when nothing was rejected. A single
    /// rejection keeps its specific reason; two or more report multiplicity,
    /// because "that file type can't be opened" is actively misleading when the
    /// user just dropped five files and four of them opened.
    fn resolve(&self) -> Option<&'static str> {
        match self.count {
            0 => None,
            1 => self.first,
            _ => Some(CODE_MULTIPLE_REJECTED),
        }
    }
}

/// Clear any buffered rejection. Called from `restart_sidecar` so a stale
/// rejection from the previous launch can't be replayed against the new sidecar.
///
/// Note the scope is wider than that rationale: since every entry point buffers,
/// this also discards a LIVE rejection caught in the window between
/// [`surface_startup_rejection`] and the client's drain. That needs the user to
/// hit Relaunch in the same breath as a rejected open, and the alternative
/// (replaying it against the new sidecar) is worse.
fn clear_startup_rejection() {
    with_rejection("clear", |slot| *slot = None);
}

/// Client-drained accessor for the buffered rejection code. Returns `Some(code)`
/// exactly once per buffered rejection: the value is TAKEN, so a re-init (e.g.
/// an in-WebView reload) doesn't replay a toast the user already saw. Called
/// from BOTH `App.svelte` sites — the init-time drain and the
/// `startup-file-rejected` listener — because the event is a payload-free nudge
/// and this is the only way to read what it is about. Take-once is what makes
/// that safe: whichever arrives first wins, the other gets `None`.
#[tauri::command]
fn get_startup_rejection() -> Option<String> {
    with_rejection("take", |slot| slot.take())
}

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

const MAIN_WINDOW_LABEL: &str = "main";

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
const AUTOSTART_DISABLE_ENV: &str = "TANDEM_DISABLE_AUTOSTART";

/// Exact-match argv flag predicate, skipping `argv[0]`.
///
/// The skip is a security invariant, not a nicety: an executable literally
/// *named* `--tandem-autostart` (or `--uninstall-scrub`) must not be able to
/// self-trigger the behavior by being renamed. One definition so a third flag
/// can't copy the invariant a third time and get it subtly wrong.
pub(crate) fn has_argv_flag(args: &[String], flag: &str) -> bool {
    args.iter().skip(1).any(|a| a == flag)
}

/// True when this process was started by the OS at login.
pub(crate) fn is_autostart_launch(args: &[String]) -> bool {
    has_argv_flag(args, AUTOSTART_FLAG)
}

/// Resolve the effective autostart state for this process: the flag, minus the
/// env kill switch. Deliberately does not log — it is called before the log
/// plugin is registered (see the `setup()` ordering comment), so the one
/// interesting case (the override actually firing) is logged at the call site
/// once logging is live.
fn resolve_autostart_launch(args: &[String], disable_env: Option<&str>) -> bool {
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
fn should_start_hidden(autostart: bool, tray_available: bool) -> bool {
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
fn autostart_seen_and_mark(dir: &std::path::Path) -> bool {
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

/// Managed handle to the "tray icon was constructed" flag, so commands can read
/// it. Autostart's Settings toggle needs it: with no tray, a hidden boot launch
/// would be unreachable, so the control is disabled rather than lying.
pub(crate) struct TrayAvailable(Arc<AtomicBool>);

impl TrayAvailable {
    pub(crate) fn get(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// Tracks the sidecar child process so we can kill it on shutdown.
struct SidecarState(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

/// Queue of file paths that arrived (via macOS `RunEvent::Opened` Apple Events,
/// or in principle any pre-health second-instance launch) BEFORE the sidecar's
/// HTTP server was ready to accept `POST /api/open`. Drained once
/// `wait_for_health()` returns Ok, then `SIDECAR_HEALTHY` is flipped so future
/// events post directly.
struct PendingOpens(Mutex<Vec<std::path::PathBuf>>);

/// Why `extract_file_arg` rejected a candidate path. Carried in the `Err`
/// variant of its return so callers can log a typed reason (and, in the
/// future, surface a typed event to the WebView). See issue #630 — this is
/// sub-task #1 of the broader rejection-surfacing work; downstream sub-tasks
/// (Tauri event emission, buffered drain summaries, etc.) are tracked in a
/// follow-up issue.
///
/// `Ok(None)` is used for the "no candidate arg" case (the user did not pass
/// a file at all — e.g. cold-start with only flags). Only paths that were
/// supplied but failed validation produce an `Err`.
#[derive(Debug, Clone, PartialEq)]
pub enum RejectionReason {
    /// On Windows, the resolved absolute path contains a `:` outside the
    /// drive-letter slot (index 1). Catches NTFS Alternate Data Stream
    /// syntax like `file.md:Zone.Identifier`. Carries the resolved absolute
    /// `path` and the byte `index` of the offending colon — both are
    /// security-relevant (ADS detection) and were logged inline before the
    /// typed-reason refactor.
    SuspiciousColon { path: std::path::PathBuf, index: usize },
    /// The candidate's extension (lowercased) is not in
    /// `SUPPORTED_FILE_ASSOC_EXTS`. `ext` is the offending extension (empty
    /// when the path had no extension at all); `path` is the resolved
    /// absolute path.
    UnsupportedExtension { ext: String, path: std::path::PathBuf },
    /// The resolved `path` does not exist as a regular file (missing, a
    /// directory, or some other non-file inode).
    NotAFile { path: std::path::PathBuf },
}

impl std::fmt::Display for RejectionReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RejectionReason::SuspiciousColon { path, index } => write!(
                f,
                "suspicious colon at byte index {index} in resolved path {}",
                path.display()
            ),
            RejectionReason::UnsupportedExtension { ext, path } => {
                if ext.is_empty() {
                    write!(f, "missing/empty extension on path {}", path.display())
                } else {
                    write!(
                        f,
                        "unsupported extension '.{ext}' on path {}",
                        path.display()
                    )
                }
            }
            RejectionReason::NotAFile { path } => {
                write!(f, "not a regular file: {}", path.display())
            }
        }
    }
}

/// Why `classify_opened_url` rejected a `file://`-style URL delivered via the
/// macOS `RunEvent::Opened` Apple Event (`kAEOpenDocuments`). Distinct from
/// `RejectionReason` (which classifies argv candidates): this enum classifies
/// already-parsed `tauri::Url` values from the Opened-event surface. See issue
/// #630, sub-task #3 (`classify_opened_url` extraction).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum OpenedUrlRejection {
    /// The URL's scheme is not `file` (e.g. `https://…`). Tandem only opens
    /// local files from Opened events.
    NonFileScheme,
    /// The URL carries a non-empty host (e.g. `file://localhost/x` or the
    /// SMB-style `file://smb-host/share`). RFC-8089 permits `localhost`, but
    /// Tandem flags any host conservatively — an SMB host is a real security
    /// concern and a `localhost` host is surprising for a desktop open.
    NonEmptyHost,
    /// `url.to_file_path()` failed to produce a filesystem path (e.g. a
    /// `cannot-be-a-base` `file:` URL with no path component).
    ConversionFailed,
    /// The URL converted to a filesystem path, but that path failed the shared
    /// [`validate_open_candidate`] checks (extension / regular-file). Wraps the
    /// argv path's [`RejectionReason`] rather than mirroring its variants so the
    /// reason-code strings have exactly one definition —
    /// `opened_url_reason_code` delegates to `rejection_reason_code`, and a
    /// third copy of `"unsupported-extension"` / `"not-a-file"` is precisely the
    /// drift #1344 was.
    ///
    /// Every `RejectionReason` variant is reachable through here on the platform
    /// that produces it — `SuspiciousColon` only where the ADS scan compiles
    /// (Windows), which is why the wrapping is exact rather than aspirational.
    /// Its production caller is macOS-only today, so that arm is currently
    /// unreached; it is deliberately not *unreachable*, because a future
    /// Windows Opened / deep-link handler must inherit the scan rather than
    /// silently skip it. See [`validate_open_candidate`].
    PathRejected(RejectionReason),
}

impl std::fmt::Display for OpenedUrlRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenedUrlRejection::NonFileScheme => {
                write!(f, "non-file URL from Opened event")
            }
            OpenedUrlRejection::NonEmptyHost => {
                write!(f, "file URL with host from Opened event")
            }
            OpenedUrlRejection::ConversionFailed => {
                write!(f, "failed to convert URL to file path")
            }
            // Delegate so the log line keeps the resolved path + detail the
            // inner reason carries. Wire payloads stay path-free because they go
            // through `opened_url_reason_code`, never through `Display`.
            OpenedUrlRejection::PathRejected(reason) => {
                write!(f, "rejected path from Opened event: {reason}")
            }
        }
    }
}

/// Map an [`OpenedUrlRejection`] to a stable, path-free reason code for the
/// WebView toast bus. Mirrors `rejection_reason_code` for the argv path; both
/// codes are handled by the `startup-file-rejected` listener in `App.svelte`.
///
/// The `dead_code` allowance is because its only production caller is the
/// macOS-gated `handle_opened_urls`; it stays compiled everywhere so the
/// code-stability test runs on every CI leg.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn opened_url_reason_code(reason: &OpenedUrlRejection) -> &'static str {
    match reason {
        OpenedUrlRejection::NonFileScheme => "non-file-url",
        OpenedUrlRejection::NonEmptyHost => "suspicious-path",
        OpenedUrlRejection::ConversionFailed => "not-a-file",
        // Pure delegation — no new code strings on this surface.
        OpenedUrlRejection::PathRejected(reason) => rejection_reason_code(reason),
    }
}

/// Classify a `file://`-style URL from the macOS Opened event into either an
/// openable filesystem path or a typed rejection.
///
/// Rules (in order):
/// - Reject any non-`file` scheme (`NonFileScheme`).
/// - Reject any non-empty host (`NonEmptyHost`). `file://host/share/...`
///   SMB-style URLs would surprise the user; require an empty/missing host.
/// - Convert via `Url::to_file_path()`; a failure is `ConversionFailed`.
/// - Validate the resulting path with the shared [`validate_open_candidate`]
///   (extension + regular file); a failure is `PathRejected(..)`. This step was
///   APPENDED, not interleaved — the first three gates are unchanged.
///
/// Unconditionally compiled and free of Tauri / Apple-Event plumbing (it reads
/// only the filesystem), so it can be unit-tested cross-platform with tempfiles
/// (the macOS Apple-Event delivery plumbing in `handle_opened_urls` is not
/// unit-testable from Windows). Its only production caller is the macOS-gated
/// `handle_opened_urls`. See issues #630 (sub-task #3) and #1344.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) fn classify_opened_url(url: &Url) -> Result<PathBuf, OpenedUrlRejection> {
    if url.scheme() != "file" {
        return Err(OpenedUrlRejection::NonFileScheme);
    }
    if url.host_str().map(|h| !h.is_empty()).unwrap_or(false) {
        return Err(OpenedUrlRejection::NonEmptyHost);
    }
    let path =
        url.to_file_path().map_err(|_| OpenedUrlRejection::ConversionFailed)?;
    validate_open_candidate(path).map_err(OpenedUrlRejection::PathRejected)
}

/// ALL of the path-shaped open-candidate validation the desktop shell performs,
/// in one place: the NTFS alternate-data-stream scan (Windows), UNC rejection,
/// the extension allowlist, and the regular-file check. Shared by the argv path
/// (`extract_file_arg`, used by Windows / Linux cold start and the
/// `single-instance` warm-start callback) and the macOS `RunEvent::Opened` path
/// (`classify_opened_url`).
///
/// One definition so the OS entry points cannot drift again: before #1344 these
/// checks existed only inline inside `extract_file_arg`, so a macOS Finder
/// double-click of a `.pdf` or a deleted path sailed through to `/api/open` and
/// was refused server-side with nothing but a `log::warn!`.
///
/// The ADS scan lives HERE rather than in `extract_file_arg`, and that placement
/// is the point. Guarding it with a `#[cfg]` on the *caller* was the same shape
/// of bug as #1344 itself: this function is unconditionally compiled and
/// `classify_opened_url` is too, so a future Windows or Linux Opened / deep-link
/// handler would have inherited the extension and `is_file()` checks with no ADS
/// scan — and `C:\x\notes:stream.md` has `extension() == "md"` and reports
/// `is_file() == true` (Windows returns the base file's attributes for a stream
/// path). A check whose safety depends on who happens to call it is not a check.
///
/// ORDER IS LOAD-BEARING. The ADS and UNC scans run before `is_file()`, because
/// `is_file()` on a UNC path performs the SMB handshake — leaking an NTLM hash
/// from the shell process on a path Tandem was never going to open (the server's
/// `resolveAndValidatePath` refuses `\\` and `//` prefixes). A gate that runs
/// after the syscall it is protecting against is decoration.
///
/// Takes and returns the `PathBuf` by value so neither caller has to clone it.
///
/// `SUPPORTED_FILE_ASSOC_EXTS` must MATCH the server's `SUPPORTED_EXTENSIONS`
/// exactly — asserted as set equality by
/// `tests/build/file-association-alignment.test.ts`. Making this the shared
/// validator is what turned that list into a contract: an extension the server
/// opens but this list omits becomes unopenable via "Open With" or a Dock drop
/// while still opening when dropped on the *window* (`useTauriFileDrop.svelte.ts`
/// validates against the server list). `.htm` was exactly that, briefly, and a
/// per-surface difference in what counts as an openable file is not a policy
/// anyone chose.
fn validate_open_candidate(
    absolute: std::path::PathBuf,
) -> Result<std::path::PathBuf, RejectionReason> {
    #[cfg(target_os = "windows")]
    {
        // Reject any colon outside the drive-letter position (index 1) on the
        // resolved absolute path. Catches NTFS Alternate Data Stream syntax
        // (`file.md:Zone.Identifier`) both when the colon lands at an absolute
        // index >1 (e.g. `C:\tmp\file.md:ADS`) and when a relative candidate
        // joined against `cwd` produces an absolute path with the suspicious
        // colon. An earlier version scanned the un-joined candidate string,
        // which let a relative `f:ADS.md` through (colon at index 1 of the
        // *candidate*). Scanning the resolved absolute closes that gap, which
        // is also why this must run on the already-joined path.
        let absolute_str = absolute.to_string_lossy();
        for (i, b) in absolute_str.as_bytes().iter().enumerate() {
            if *b == b':' && i != 1 {
                let index = i;
                return Err(RejectionReason::SuspiciousColon { path: absolute, index });
            }
        }
    }

    // UNC / network paths, refused before any filesystem call touches them.
    // Matches the server's `resolveAndValidatePath`, which rejects both
    // prefixes — but the server refusing it is one HTTP hop too late to stop
    // `is_file()` from having already performed the SMB handshake here.
    let as_str = absolute.to_string_lossy();
    if as_str.starts_with(r"\\") || as_str.starts_with("//") {
        return Err(RejectionReason::NotAFile { path: absolute });
    }

    let ext = absolute
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !SUPPORTED_FILE_ASSOC_EXTS.contains(&ext.as_str()) {
        return Err(RejectionReason::UnsupportedExtension { ext, path: absolute });
    }

    // is_file() follows symlinks intentionally — the final read goes through
    // server-side openFileByPath which is the authority for path validation
    // (extension, size, UNC rejection, etc.). Resolving symlinks here would
    // duplicate that check without adding defense in depth, since a symlink
    // pointing at a disallowed target would be rejected on the server hop.
    if !absolute.is_file() {
        return Err(RejectionReason::NotAFile { path: absolute });
    }

    Ok(absolute)
}

/// Extract a file path to open from a process's command-line args.
///
/// Rules:
/// - Skip the executable (args\[0\]).
/// - Skip any arg whose first byte is `-` (covers both `-x` and `--long`).
///   We do **not** parse `--key=value` style flags — the value is treated as
///   part of the flag.
/// - Skip a literal `--` separator.
/// - Take the FIRST remaining arg.
/// - Resolve relative to `cwd`.
/// - Hand the resolved absolute path to the shared [`validate_open_candidate`],
///   which owns EVERY path-shaped check: the Windows NTFS alternate-data-stream
///   colon scan, UNC rejection, the `SUPPORTED_FILE_ASSOC_EXTS` allowlist
///   (case-insensitive), and the regular-file check. The macOS
///   `RunEvent::Opened` path runs the same helper (#1344). This function's own
///   job is argv shape only — it deliberately performs no path validation of
///   its own, because a check that lives at one entry point is a check the
///   other entry point does not have.
///
/// Returns:
/// - `Ok(Some(path))` — a validated, openable file path.
/// - `Ok(None)` — no candidate file arg was supplied (cold-start without a
///   file, all args were flags, etc.). Not a rejection.
/// - `Err(RejectionReason::...)` — a candidate was supplied but failed
///   validation. Each variant carries the resolved absolute path (and, for
///   `SuspiciousColon`, the offending byte index) so callers can log a
///   human-readable, diagnostic reason via the `Display` impl (`{reason}`,
///   not `{reason:?}`) — matching the path + index detail logged inline
///   before the typed-reason refactor.
///
/// This is `pub` so the integration test in `tests/file_association.rs` can
/// exercise it.
pub fn extract_file_arg(
    args: &[String],
    cwd: &std::path::Path,
) -> Result<Option<std::path::PathBuf>, RejectionReason> {
    let Some(candidate) =
        args.iter().skip(1).find(|a| !a.starts_with('-') && a.as_str() != "--")
    else {
        return Ok(None);
    };

    let p = std::path::Path::new(candidate);
    let absolute: std::path::PathBuf =
        if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };

    validate_open_candidate(absolute).map(Some)
}

/// POST `{ filePath }` to the sidecar's `/api/open` endpoint with the auth
/// token as a Bearer header. Loopback currently bypasses Bearer enforcement
/// (`src/server/auth/middleware.ts:156-185`) but we include the header anyway
/// for defense-in-depth.
async fn request_open_file(
    client: &reqwest::Client,
    auth_token: Option<&str>,
    path: &std::path::Path,
) -> Result<(), String> {
    let body = serde_json::json!({ "filePath": path.to_string_lossy() });
    let mut req = client.post(OPEN_URL).json(&body);
    if let Some(token) = auth_token {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("POST {OPEN_URL} failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!("POST {OPEN_URL} returned {status}: {body_text}"));
    }
    log::info!("Opened file via OS association: {}", path.display());
    Ok(())
}

/// Consumer-side critical section: flip `SIDECAR_HEALTHY` to true AND drain
/// the pending queue while holding the `PendingOpens` mutex. Returns the
/// drained paths so the async caller can POST them outside the lock (we can't
/// hold a `std::sync::Mutex` across `.await`).
///
/// Pairs with `try_queue_or_post` on the producer side: producers also read
/// `SIDECAR_HEALTHY` only while holding the same mutex, which serializes all
/// flag access through it and closes every TOCTOU window where a producer's
/// load-before-push could orphan a path. See the doc comment on
/// `try_queue_or_post` for the full ordering argument.
pub(crate) fn promote_healthy_and_drain(state: &PendingOpens) -> Vec<std::path::PathBuf> {
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(poisoned) => {
            log::error!("PendingOpens mutex poisoned — recovering");
            poisoned.into_inner()
        }
    };
    SIDECAR_HEALTHY.store(true, Ordering::Release);
    std::mem::take(&mut *guard)
}

/// Inverse of `promote_healthy_and_drain`: clear `SIDECAR_HEALTHY` while
/// holding the `PendingOpens` mutex so any concurrent producer either pushes
/// (and the next promote_and_drain captures the path) or observes flag=false
/// (and queues). Bare `SIDECAR_HEALTHY.store(false)` outside the lock would
/// re-open the same TOCTOU window the lock was introduced to close: a
/// producer could read flag=true between `kill_sidecar` and the clear, then
/// POST to a sidecar that no longer exists. Used by `restart_sidecar`.
#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
pub(crate) fn clear_healthy_under_lock(state: &PendingOpens) {
    let _guard = match state.0.lock() {
        Ok(g) => g,
        Err(poisoned) => {
            log::error!("PendingOpens mutex poisoned during clear — recovering");
            poisoned.into_inner()
        }
    };
    SIDECAR_HEALTHY.store(false, Ordering::Release);
}

/// Producer-side critical section: under the `PendingOpens` mutex, decide
/// whether to queue the path (sidecar not yet healthy) or hand it back to the
/// caller to POST directly (sidecar healthy). Returns `Ok(())` on queue,
/// `Err(path)` when the caller should POST.
///
/// Ordering proof (paired with `promote_healthy_and_drain`):
/// - Consumer's flag-flip and drain are atomic under the mutex.
/// - Producer's flag-load and push are atomic under the same mutex.
/// - Any producer that acquires the lock BEFORE the consumer pushes, then
///   the consumer's drain captures it.
/// - Any producer that acquires the lock AFTER the consumer reads
///   `SIDECAR_HEALTHY=true` (set by the consumer while holding the lock) and
///   either POSTs directly. No orphan window remains.
// Used by `handle_opened_urls` (macOS only) and by unit tests; the
// non-macOS, non-test build sees no call sites.
#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
pub(crate) fn try_queue_or_post(
    state: &PendingOpens,
    path: std::path::PathBuf,
) -> Result<(), std::path::PathBuf> {
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(poisoned) => {
            log::error!("PendingOpens mutex poisoned — recovering and queueing");
            poisoned.into_inner()
        }
    };
    if SIDECAR_HEALTHY.load(Ordering::Acquire) {
        Err(path)
    } else {
        log::info!("Queueing file (sidecar not yet healthy): {}", path.display());
        guard.push(path);
        Ok(())
    }
}

/// POST every queued path to `/api/open`. The flag flip + drain has already
/// happened atomically in `promote_healthy_and_drain`; this just runs the I/O.
async fn post_drained_paths(
    paths: Vec<std::path::PathBuf>,
    client: &reqwest::Client,
) {
    if paths.is_empty() {
        return;
    }
    let token = best_effort_token("drained-path POSTs");
    for path in paths {
        if let Err(e) = request_open_file(client, token.as_deref(), &path).await {
            log::warn!(
                "request_open_file (drain) failed for {}: {e}",
                path.display()
            );
        }
    }
}

/// Handle a batch of file URLs delivered via macOS `RunEvent::Opened` (Apple
/// Event `kAEOpenDocuments`). Posts directly when the sidecar is healthy,
/// queues when it is not.
#[cfg(target_os = "macos")]
fn handle_opened_urls(app: &tauri::AppHandle, urls: Vec<tauri::Url>) {
    // Deliberately BEFORE validation: a fully-rejected batch still needs a
    // visible window, because the thing it produces is a toast.
    show_main_window_for_user(app);
    // Fetched at most once per batch, and LAZILY — a keyring read is an XPC
    // round-trip to `securityd` (and can *write* on first run), on the main
    // event-loop thread. Hoisting it out of the loop stops an N-file "Open
    // With" paying it N times; deferring it to the first URL that actually
    // needs a direct POST (accepted, and the sidecar already healthy) stops a
    // fully-rejected — or fully-queued — batch paying it at all. Since #1344 a
    // fully-rejected batch is the shape of the realistic user error (a
    // double-clicked .pdf, a stale alias), so it is the common case, not a
    // corner. Falls back to anonymous on retrieval failure; loopback bypasses
    // Bearer enforcement so this is non-fatal, and the failure is memoized so a
    // locked keychain is not re-hit per URL.
    let mut batch_token: Option<Option<String>> = None;
    // Accumulate, then surface once after the loop. See `RejectionBatch` — one
    // arm here serves BOTH cold and warm start and cannot tell them apart, so
    // per-URL surfacing raced the client's drain nondeterministically.
    let mut rejected = RejectionBatch::default();
    for url in urls {
        let path = match classify_opened_url(&url) {
            Ok(path) => path,
            Err(reason) => {
                log::warn!("Ignoring URL from Opened event ({reason}): {url}");
                rejected.record(opened_url_reason_code(&reason));
                continue;
            }
        };
        // try_queue_or_post serializes the SIDECAR_HEALTHY check + the push
        // through the same mutex used by promote_healthy_and_drain. This is
        // the load-bearing piece of the drain-race fix: any producer that
        // acquires the lock either pushes (and gets drained) or sees
        // flag=true (and is handed back the path to POST directly). No
        // load-before-push window remains.
        let pending = app.state::<PendingOpens>();
        if let Err(path) = try_queue_or_post(pending.inner(), path) {
            let app = app.clone();
            let token = batch_token
                .get_or_insert_with(|| best_effort_token("Opened-event batch"))
                .clone();
            tauri::async_runtime::spawn(async move {
                let client = app.state::<reqwest::Client>().inner().clone();
                if let Err(e) = request_open_file(&client, token.as_deref(), &path).await {
                    log::warn!(
                        "request_open_file (Opened) failed for {}: {e}",
                        path.display()
                    );
                }
            });
        }
    }
    if let Some(code) = rejected.resolve() {
        surface_startup_rejection(app, code);
    }
}

/// POST `/api/launcher/start` to promote a deferred Claude Code launcher.
///
/// Two hops because the route is nonce-gated like every other mutating launcher
/// route: fetch a single-use nonce, then spend it. Best-effort — a failure means
/// the user simply doesn't get Claude auto-launched this session, which is the
/// same outcome as before this feature existed, so it logs and moves on.
async fn request_launcher_start(
    client: &reqwest::Client,
    auth_token: Option<&str>,
) -> Result<(), String> {
    let with_auth = |req: reqwest::RequestBuilder| match auth_token {
        Some(token) => req.header("Authorization", format!("Bearer {token}")),
        None => req,
    };

    let nonce_resp = with_auth(client.get(LAUNCHER_NONCE_URL))
        .send()
        .await
        .map_err(|e| format!("GET {LAUNCHER_NONCE_URL} failed: {e}"))?;
    if !nonce_resp.status().is_success() {
        return Err(format!(
            "GET {LAUNCHER_NONCE_URL} returned {}",
            nonce_resp.status()
        ));
    }
    let nonce: serde_json::Value = nonce_resp
        .json()
        .await
        .map_err(|e| format!("nonce body was not JSON: {e}"))?;
    let nonce = nonce
        .get("nonce")
        .and_then(|n| n.as_str())
        .ok_or_else(|| "nonce body missing `nonce`".to_string())?;

    let body = serde_json::json!({ "nonce": nonce });
    let resp = with_auth(client.post(LAUNCHER_START_URL).json(&body))
        .send()
        .await
        .map_err(|e| format!("POST {LAUNCHER_START_URL} failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("POST {LAUNCHER_START_URL} returned {status}: {text}"));
    }
    Ok(())
}

/// Record that a human is present, and release the deferred Claude launcher.
///
/// Called from `show_main_window`, which is the single choke point for every
/// path that surfaces the window: tray click, tray "Open Editor", the setup menu
/// item, a second instance, and macOS Dock reopen. Cheap no-op after the first
/// call — the latch is swapped atomically, so concurrent shows can't double-post.
///
/// The trigger lives in Rust rather than the WebView deliberately. The client
/// alternative would key off `document.visibilityState`, whose behavior for a
/// natively-hidden Tauri window is unverified, and it would silently do nothing
/// if the WebView failed to mount. Rust knows exactly when the window is shown.
/// A Tauri *event* would not work — events aren't buffered, and the listener may
/// not exist yet (see [`STARTUP_REJECTION`]) — but a direct loopback POST
/// has no such constraint.
///
/// Known, accepted consequence: the tray's "Setup AI Assistant" item also
/// signals presence, so it releases the launcher too. The supervisor's own gate
/// (a `claude-code` integration with `apply !== "skip"`) is the backstop. See
/// ADR-046.
fn note_user_presence(app: &tauri::AppHandle) {
    if !LAUNCHER_DEFERRED.swap(false, Ordering::AcqRel) {
        return;
    }
    log::info!("User presence detected after an autostart launch — releasing the Claude Code launcher");
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // The presence signal can beat the sidecar's HTTP server to the punch:
        // `setup()` shows the window at boot on the trayless-Linux path, ~200
        // lines before `start_sidecar`'s health poll returns. POSTing blind
        // there hits a connection-refused, and since the latch was already
        // consumed by the `swap` above, Claude would never launch for the rest
        // of the session. Wait for the flag the spawn path sets instead.
        if !await_sidecar_healthy(PRESENCE_HEALTH_DEADLINE).await {
            log::warn!(
                "Sidecar never became healthy — deferring the launcher release to the next presence signal"
            );
            LAUNCHER_DEFERRED.store(true, Ordering::Release);
            return;
        }
        let client = app.state::<reqwest::Client>().inner().clone();
        let token = best_effort_token("deferred launcher start");
        if let Err(e) = request_launcher_start(&client, token.as_deref()).await {
            // Restore the latch so a later presence signal retries. The `swap`
            // above is a claim, not a commitment — without this a transient
            // failure would permanently strand the launcher.
            log::warn!("Deferred launcher start failed, will retry on the next presence signal: {e}");
            LAUNCHER_DEFERRED.store(true, Ordering::Release);
        }
    });
}

/// Bounded wait for the sidecar's HTTP server to accept requests.
///
/// Polls the existing `SIDECAR_HEALTHY` flag rather than re-probing `/health` —
/// the spawn path already flips it once `wait_for_health` succeeds and the
/// pending-opens queue has drained, so this observes the same readiness the
/// file-open path does instead of racing it with a second probe.
async fn await_sidecar_healthy(deadline: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < deadline {
        if SIDECAR_HEALTHY.load(Ordering::Acquire) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    SIDECAR_HEALTHY.load(Ordering::Acquire)
}

/// Fetch the auth token for a loopback POST, falling back to anonymous.
///
/// Loopback callers are exempt from bearer enforcement (`createAuthMiddleware`),
/// so a missing token is not fatal — but the header is still sent when
/// available so the same call works if the server is ever bound non-loopback.
/// One definition so the fallback posture can't drift between the four callers
/// that need it.
fn best_effort_token(context: &str) -> Option<String> {
    match token_store::get_or_create_token() {
        Ok(t) => Some(t),
        Err(e) => {
            log::warn!("Token retrieval failed for {context}: {e}");
            None
        }
    }
}

/// Show, unminimize, and focus the main window.
///
/// Mechanical only — this is also the startup path's show, so it must NOT imply
/// a human is present. User-initiated entry points call
/// `show_main_window_for_user` instead.
fn show_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
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

/// Show the window *because a human asked for it*.
///
/// The split from `show_main_window` is load-bearing, not stylistic: `setup()`
/// shows the window at boot on paths where nobody is necessarily watching (a
/// trayless Linux autostart launch, and the Linux first-launch backstop).
/// Treating "the window became visible" as "a human is here" would fire the
/// launcher release at login — the exact scenario the deferral exists to
/// prevent — and would do it before the sidecar is listening.
fn show_main_window_for_user(app: &tauri::AppHandle) {
    show_main_window(app);
    note_user_presence(app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Uninstall scrub (#1236) — handled BEFORE anything else: before Sentry
    // init, before the Tauri builder, before any window, sidecar, or tray
    // exists. The NSIS uninstaller runs this synchronously via `ExecWait` and
    // waits for it, so booting the full app here would hang the uninstall on a
    // visible editor window (which is what the previous, unhandled flag would
    // have done had the binary name in the .nsi been correct).
    {
        let args: Vec<String> = std::env::args().collect();
        if uninstall_scrub::is_uninstall_scrub(&args) {
            std::process::exit(uninstall_scrub::run_uninstall_scrub());
        }
    }

    // Crash reporting (#921) — OPT-IN, off by default. Returns `Some(guard)`
    // only when `TANDEM_SENTRY_DSN` is set; with no DSN this is `None`, so the
    // plugin is never registered below (no WebView IPC wiring, no minidump
    // handler). The guard MUST outlive the Tauri event loop — it flushes pending
    // events on drop — so it is bound here and held until `run()` returns, after
    // `.run(...)` blocks. Initialised BEFORE the builder per the plugin contract
    // ("everything before here runs in both the app and the crash-reporter
    // process").
    let _sentry_guard = sentry_reporting::init();

    let tray_available = Arc::new(AtomicBool::new(false));
    let tray_flag_for_setup = tray_available.clone();
    let tray_flag_for_close = tray_available.clone();

    #[allow(unused_mut)] // `mut` is only exercised when the `devtools` feature is on
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            log::info!("Second instance detected — args: {args:?}, cwd: {cwd}");
            let cwd_path = std::path::PathBuf::from(&cwd);
            // On macOS, "Open With" actions reactivate the existing app via
            // Apple Events (RunEvent::Opened) — args won't contain the file
            // path. This call is a no-op there, intentionally defensive for
            // shell-invoke edge cases.
            let parsed = extract_file_arg(&args, &cwd_path);

            // A second instance carrying `--tandem-autostart` is the OS racing
            // us at login (or a stale registration firing against an already-
            // running Tandem) — that is not a human asking for the window, so
            // don't pop it. But only suppress when nothing else was requested:
            // `Tandem.exe --tandem-autostart doc.md` must still surface, or the
            // document would open into an invisible editor with no feedback.
            let suppress_show =
                is_autostart_launch(&args) && !matches!(parsed, Ok(Some(_)));
            if suppress_show {
                log::info!("Second instance is an autostart launch — not showing the window");
            } else {
                show_main_window_for_user(app);
            }

            match parsed {
                Ok(Some(path)) => {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let client = app_handle.state::<reqwest::Client>().inner().clone();
                        let token = best_effort_token("second-instance POST");
                        if let Err(e) =
                            request_open_file(&client, token.as_deref(), &path).await
                        {
                            log::warn!("request_open_file (second-instance) failed: {e}");
                        }
                    });
                }
                Ok(None) => {}
                Err(reason) => {
                    log::warn!(
                        "extract_file_arg (second-instance) rejected candidate: {reason}"
                    );
                    // Warm start, so the nudge normally lands on a live
                    // listener — but this still buffers, because "already
                    // running" does not prove the listener survived a WebView
                    // reload. See `surface_startup_rejection`. #630, #1344.
                    surface_startup_rejection(app, rejection_reason_code(&reason));
                }
            }
        }));

    // CrabNebula DevTools — opt-in `devtools` feature, development only.
    // Registered immediately after single-instance (which MUST stay the
    // FIRST plugin) so it still captures the other plugins' events.
    // Mutually exclusive with tauri-plugin-log (see the setup() gate): both
    // install a global `tracing` subscriber and panic if both are active.
    #[cfg(feature = "devtools")]
    {
        builder = builder.plugin(tauri_plugin_devtools::init());
    }

    // Windows-only kill-on-job-close ownership of the sidecar (#987). Managed
    // here (not in the fluent chain below) so the `#[cfg]` is a clean statement.
    // Held for the parent process's lifetime; the OS closes the job handle on
    // parent exit — graceful OR crash/taskkill — reaping the sidecar. macOS and
    // Linux rely on the existing RunEvent::Exit + kill_sidecar path.
    #[cfg(target_os = "windows")]
    {
        builder = builder.manage(sidecar_job::SidecarJob::new());
    }

    // Crash-reporting plugin (#921). Registered immediately after
    // single-instance (which MUST stay the FIRST plugin) so it bridges the
    // WebView's `@sentry/browser` events to the Rust client over IPC and
    // attaches OS/device context. Only registered when a DSN was configured
    // (opt-in) — `sentry_reporting::init` returns `None` otherwise, so the
    // WebView IPC command is never wired for a default (telemetry-off) launch.
    //
    // `init_with_no_injection` is used instead of `init` so the WebView is NOT
    // auto-injected with a bundled `@sentry/browser`: Tandem's own client-side
    // `src/client/sentry.ts` owns `Sentry.init` (with our `beforeSend`
    // scrubbing) and routes events through the plugin's IPC transport. Two
    // initializers would double-count events and bypass our scrubbing hook.
    //
    // `ClientInitGuard` derefs to `sentry::Client`, satisfying the plugin's
    // `&Client` signature.
    if let Some(ref guard) = _sentry_guard {
        builder = builder.plugin(tauri_plugin_sentry::init_with_no_injection(guard.client()));
    }

    builder
        // Blocks reload shortcuts (F5, Ctrl+F5, Shift+F5, Ctrl+R, Ctrl+Shift+R) only.
        // DevTools, Find, Print, and right-click are preserved. Fixes #541.
        .plugin(tauri_plugin_prevent_default::Builder::new()
            .with_flags(prevent_default_flags())
            .build())
        // Custom window chrome — preserves Aero Snap, Snap Layouts, traffic lights.
        // decorations:false is set in tauri.conf.json; decorum restores resize handles
        // and shadow.
        .plugin(tauri_plugin_decorum::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        // VISIBLE is masked out of the default `StateFlags::all()` so `setup()`
        // is the sole authority on whether the window appears. The plugin's
        // `restore_state` does `self.show()?.set_focus()?` when the flag is on
        // and the cached state says visible — with `visible: false` in
        // tauri.conf.json that would override `should_start_hidden` entirely
        // AND steal focus during login, since the common case is a user who
        // quit with the window open. Size/position/maximized restore are
        // unaffected; `skip_initial_state` would have dropped those too.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        // Start-at-login (#1236). Default OFF — registering the plugin only
        // makes the capability available; it never writes a registration on its
        // own. The flag is what makes a login launch distinguishable from a
        // user-initiated one downstream.
        //
        // macOS launcher variant — LaunchAgent, and the deciding factor is the
        // READ path, not the write path.
        //
        // In `auto-launch` 0.5 (what the plugin pins), AppleScript mode's
        // `is_enabled()` shells out to `osascript` ("get the name of every login
        // item"), which needs Automation (TCC) approval. `autostart_get_status`
        // runs on every Settings open, so choosing AppleScript would pop a
        // scary "Tandem wants to control System Events" prompt at users who
        // never asked for autostart at all. LaunchAgent's `is_enabled()` is a
        // plain `plist.exists()` — free, silent, no permissions. Enabling costs
        // two pop-ups under AppleScript versus none here.
        //
        // The known trade-off: a LaunchAgent plist points at the Mach-O inside
        // the bundle and launches it outside LaunchServices, which may weaken
        // the Apple Events (`RunEvent::Opened`) that file associations rely on.
        // That risk is narrower than prompting every macOS user, it only
        // affects login-launched instances, and `RunEvent::Reopen` plus
        // single-instance still work. If real hardware shows Apple Events
        // break (S4), this is a one-constant change. See ADR-046.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_FLAG]),
        ))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SidecarState(Mutex::new(None)))
        .manage(PendingOpens(Mutex::new(Vec::new())))
        .manage(TrayAvailable(tray_available.clone()))
        // App-level menu-event handler — registered exactly once here (NOT per
        // show_context_menu call, which would stack handlers). Forwards
        // `ctx:`-prefixed popup ids to the webview; the tray's own scoped
        // handler owns MENU_* ids. See forward_context_menu_event (#923).
        .on_menu_event(forward_context_menu_event)
        .setup(move |app| {
            // --- Window visibility (#1236) ------------------------------------
            //
            // `tauri.conf.json` sets `visible: false`, so *something* in here
            // must show the window or the app is unreachable. For a normal
            // launch that show happens HERE — the very first statement, ahead of
            // the log plugin (which can `?`-return), `build_http_client()
            // .expect(...)` (which panics), sidecar spawn, and tray
            // construction. None of that fallible work can strand a
            // user-initiated launch behind an invisible window.
            //
            // An autostart launch defers the decision to after the tray build,
            // where `tray_available` is known — see `should_start_hidden`.
            //
            // Cost of being first: `log::` macros are no-ops until the log
            // plugin registers a few lines down, so `show_main_window`'s
            // warnings are lost on this path. Worth it — a lost warning beats a
            // window that never appears.
            // Both facts are kept from ONE read of argv and the environment:
            // the deferred log block below needs to distinguish "not an
            // autostart launch" from "autostart launch, overridden", and
            // re-deriving that would re-implement `resolve_autostart_launch`'s
            // override rule inline — free to drift the moment the rule changes.
            let (autostart_flag, autostart_launch) = {
                let args: Vec<String> = std::env::args().collect();
                let disable = std::env::var(AUTOSTART_DISABLE_ENV).ok();
                (
                    is_autostart_launch(&args),
                    resolve_autostart_launch(&args, disable.as_deref()),
                )
            };
            // Arm the deferral BEFORE anything can show the window, so the
            // latch is never observed half-initialized. Set for every autostart
            // launch — not only the ones that stay hidden. If we end up showing
            // the window anyway (no tray, or the Linux first-launch exception),
            // that path releases the latch explicitly; see the comment there.
            LAUNCHER_DEFERRED.store(autostart_launch, Ordering::Release);

            // Mechanical show, not a presence signal: the latch is false on
            // this path anyway, and routing it through the user-intent helper
            // would blur the distinction the split exists to keep.
            if !autostart_launch {
                show_main_window(app.handle());
            }

            // tauri-plugin-log installs a global `tracing` subscriber. The
            // optional `devtools` feature installs its own, and two global
            // subscribers in one process panic — so the log plugin is gated off
            // when `devtools` is enabled (DevTools then owns logging). In every
            // normal build the log plugin runs with size-capped rotation so a
            // long-running install can't grow the log file unbounded (#922).
            #[cfg(not(feature = "devtools"))]
            {
                use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
                let log_level = if cfg!(debug_assertions) {
                    log::LevelFilter::Info
                } else {
                    log::LevelFilter::Warn
                };
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log_level)
                        // NB: this Stdout target is the Tauri shell's stdout
                        // (HTTP mode) — NOT the MCP stdio wire, which lives in
                        // the sidecar. The "stdout is reserved" rule is unaffected.
                        .targets([
                            Target::new(TargetKind::Stdout),
                            Target::new(TargetKind::LogDir {
                                file_name: Some("tandem".into()),
                            }),
                            Target::new(TargetKind::Webview),
                        ])
                        .max_file_size(25 * 1024 * 1024) // 25 MB per file
                        .rotation_strategy(RotationStrategy::KeepOne)
                        .build(),
                )?;
            }

            // Deferred from the visibility block above — logging wasn't live yet.
            if autostart_launch {
                log::info!("Autostart launch detected ({AUTOSTART_FLAG})");
            } else if autostart_flag {
                log::info!(
                    "{AUTOSTART_DISABLE_ENV}=1 — treating this autostart launch as a normal launch"
                );
            }

            let client = build_http_client(HTTP_CLIENT_TIMEOUT)
                .expect("Failed to build HTTP client");
            app.manage(client.clone());

            // Cold-start file path: if the OS launched us via file association
            // (Windows / Linux pass it on argv; macOS uses Apple Events handled by
            // RunEvent::Opened instead). Resolved here ONCE at process start and
            // threaded explicitly into the first `start_sidecar` invocation, so
            // any later `restart_sidecar` (which passes `None`) never re-opens
            // the file. This is the only argv read for file-association — no
            // global statics, no env-var side effects.
            let cold_start_file: Option<std::path::PathBuf> = {
                let args: Vec<String> = std::env::args().collect();
                let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
                match extract_file_arg(&args, &cwd) {
                    Ok(opt) => opt,
                    Err(reason) => {
                        log::warn!(
                            "extract_file_arg (cold-start) rejected candidate: {reason}"
                        );
                        // The user double-clicked a file and silently landed on
                        // welcome.md; this is the feedback. The nudge drops
                        // here (no listener yet, this is `setup()`), which is
                        // exactly the case the buffer covers. See #630.
                        surface_startup_rejection(app.handle(), rejection_reason_code(&reason));
                        None
                    }
                }
            };
            if let Some(ref p) = cold_start_file {
                log::info!(
                    "Tauri cold-start: passing TANDEM_OPEN_FILE={} to sidecar",
                    p.display()
                );
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Copy sample files BEFORE sidecar spawn so the server's
                // auto-open finds them during its startup sequence
                if let Err(e) = copy_sample_files(&handle) {
                    log::warn!("Sample file copy failed (non-fatal): {e}");
                }

                if let Err(e) = start_sidecar(&handle, &client, cold_start_file.as_deref()).await {
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

                // Auto-configuration of Claude on startup was removed in #477 PR
                // 3c-ii-c — first-run setup is wizard-driven (the client opens the
                // wizard when integrations.json is empty). The channel-shim path is
                // now injected into the sidecar via TANDEM_CHANNEL_DIST on spawn.

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

            // Cowork self-heal: when the integration is enabled, periodically
            // install plugin entries into workspaces that appeared after
            // enable (e.g. the user's first Cowork session) — headless, no
            // settings visit required. The first tick fires immediately so a
            // workspace created while Tandem was closed heals at launch.
            // No firewall work, no UAC; see `cowork_heal_pass` guards.
            #[cfg(target_os = "windows")]
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(COWORK_HEAL_INTERVAL);
                loop {
                    interval.tick().await;
                    match tauri::async_runtime::spawn_blocking(cowork_heal_pass).await {
                        Ok(Ok(0)) => {}
                        Ok(Ok(n)) => {
                            log::info!("[cowork] heal pass installed into {n} workspace(s)");
                        }
                        Ok(Err(e)) => log::warn!("[cowork] heal pass failed: {e}"),
                        Err(e) => log::warn!("[cowork] heal task join error: {e}"),
                    }
                }
            });

            let open_i = MenuItem::with_id(app, MENU_OPEN, "Open Editor", true, None::<&str>)?;
            let setup_i = MenuItem::with_id(app, MENU_SETUP, "Setup AI Assistant", true, None::<&str>)?;
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
                    MENU_OPEN => show_main_window_for_user(app),
                    MENU_SETUP => {
                        // Auto-config was removed in #477 PR 3c-ii-c — setup is
                        // wizard-driven now. Focus the window and ask the client
                        // to open the integration wizard (App.svelte listens for
                        // "open-integration-wizard").
                        show_main_window_for_user(app);
                        if let Err(e) = app.emit("open-integration-wizard", ()) {
                            log::warn!("Failed to emit open-integration-wizard: {e}");
                        }
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
                        show_main_window_for_user(tray.app_handle());
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

            // --- Autostart visibility decision (#1236) ------------------------
            //
            // Deferred to here because it needs `tray_available`, which only
            // exists after the build above. A normal launch already showed the
            // window as setup()'s first statement and never reaches this.
            if autostart_launch {
                let tray_available = tray_flag_for_setup.load(Ordering::Acquire);
                // `mut` only on Linux — the backstop below is the sole writer,
                // and it compiles out everywhere else (an unconditional `mut`
                // warns on Windows/macOS).
                #[cfg_attr(not(target_os = "linux"), allow(unused_mut))]
                let mut hide = should_start_hidden(autostart_launch, tray_available);

                // Linux backstop: a *constructed* tray icon is not a *visible*
                // one (GNOME without a status-icon extension). Always show on
                // the first autostart launch so the user gets one guaranteed
                // chance to find the setting and turn it off.
                #[cfg(target_os = "linux")]
                if hide {
                    match app.path().app_data_dir() {
                        Ok(dir) => {
                            if !autostart_seen_and_mark(&dir) {
                                log::info!(
                                    "First autostart launch on Linux — showing the window once \
                                     so the tray icon can be verified"
                                );
                                hide = false;
                            }
                        }
                        Err(e) => {
                            log::warn!("app_data_dir unavailable for autostart marker: {e}");
                            hide = false;
                        }
                    }
                }

                // Rewrite the registration so its baked exe path and args stay
                // current. Spawned off the setup thread — on Windows this is a
                // registry write and on Linux a file write, both fast, but
                // neither belongs on the startup critical path. Only ever
                // refreshes an *existing* registration; it can't turn autostart
                // on. Scoped to autostart launches: a normal launch has no
                // reason to touch it, and a user who moved the app will
                // autostart at least once before the path matters.
                {
                    let refresh_handle = app.handle().clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        autostart::refresh_registration(&refresh_handle);
                    });
                }

                if hide {
                    log::info!("Autostart launch — staying hidden in the tray");
                } else {
                    if !tray_available {
                        log::warn!(
                            "Autostart launch with no tray icon — showing the window instead \
                             (a hidden, trayless process would be unreachable)"
                        );
                    }
                    // Presence, deliberately, even though nobody has necessarily
                    // arrived yet. Reaching here means we have abandoned the
                    // hidden-tray model for this launch: there is no tray to
                    // click and no Dock icon on Linux, so NO later signal can
                    // ever release the latch and Claude would be stranded for
                    // the whole session. Releasing at boot on an already-visible
                    // window is the lesser evil, and it is confined to two
                    // degraded Linux configurations we warn about. The release
                    // is health-gated inside `note_user_presence`, so it lands
                    // once the sidecar is actually listening. See ADR-046.
                    show_main_window_for_user(app.handle());
                }
            }

            // Pre-seed the initial theme before Svelte mounts so the correct
            // app-mode preference (AppsUseLightTheme, not taskbar mode) is
            // available synchronously for the first paint. Value is always a
            // trusted literal ("light" or "dark") from the OS API — not user
            // input. Falls back gracefully if window isn't ready; the
            // useTauriTheme bridge will invoke get_app_theme on first init.
            // Fixes #535.
            if let Some(main_window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let theme_str = match main_window.theme() {
                    Ok(tauri::Theme::Dark) => "dark",
                    Ok(_) => "light",
                    Err(e) => {
                        log::warn!("[theme] WebviewWindow::theme() failed, defaulting to light: {e}");
                        "light"
                    }
                };
                // SAFETY: theme_str is always "dark" or "light" — a trusted
                // compile-time-controlled literal from a Rust match arm, not
                // any external input. Injection is not possible.
                let script = format!("window.__TANDEM_INITIAL_THEME__={:?};", theme_str);
                if let Err(e) = main_window.eval(&script) {
                    log::warn!("Failed to seed initial theme: {e}");
                }

                // Force rounded corners + suppress the borderless outline (#984).
                // No-op on non-Windows. Re-asserted on `Resized` in the
                // window-event handler since snap/maximize resets the corner
                // preference.
                #[cfg(target_os = "windows")]
                apply_window_chrome(&main_window);
            } else {
                log::warn!("main window not found at theme-seed time — useTauriTheme bridge will handle initial theme");
            }

            Ok(())
        })
        .on_window_event(move |window, event| {
            // Re-assert rounded corners + the no-outline border after snap or
            // maximize, which reset the DWM corner preference (#984). Snap-layout
            // changes (and maximize/restore) always change window size, so they
            // deliver `Resized` — we key on that alone. `Moved` fires per
            // mouse-move sample during a drag and never changes corner state, so
            // including it would issue two DWM syscalls per drag tick for nothing.
            // No-op on non-Windows; `apply_window_chrome` is Windows-only.
            #[cfg(target_os = "windows")]
            if matches!(event, tauri::WindowEvent::Resized(_)) {
                apply_window_chrome(window);
            }
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
            setup_overlay_titlebar,
            get_app_theme,
            set_native_theme,
            sentry_enabled,
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
            restart_sidecar,
            get_startup_rejection,
            show_in_file_manager,
            show_context_menu,
            show_tab_context_menu,
            show_annotation_context_menu,
            install_update,
            keychain::keychain_get,
            keychain::keychain_set,
            keychain::keychain_delete,
            autostart::autostart_get_status,
            autostart::autostart_set_enabled,
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| panic!("Failed to build Tauri application: {e}"))
        .run(|_app, _event| {
            match _event {
                tauri::RunEvent::Exit => kill_sidecar(_app),
                // macOS: file paths from "Open With" arrive here, not on argv.
                // The single-instance callback's args are empty for these events.
                // RunEvent::Opened does not exist on Windows/Linux — gate with
                // cfg to keep the match exhaustive there. Tandem targets desktop
                // only; iOS is not a build target.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => handle_opened_urls(_app, urls),
                // macOS: clicking the Dock icon fires applicationShouldHandleReopen.
                // Without this, an autostart launch that started hidden leaves a
                // Dock icon that does nothing when clicked — the window is real
                // but hidden, so AppKit has nothing to un-minimize on its own.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } => {
                    if !has_visible_windows {
                        show_main_window_for_user(_app);
                    }
                }
                _ => {}
            }
        });
}

/// Guards against concurrent `restart_sidecar` invocations. The command
/// returns immediately (stop + respawn run on the async runtime), so the
/// WebView's restart button re-enables while a restart is still in flight; a
/// second click used to race two stop/start tasks (two spawned children, one
/// orphaned out of `SidecarState`). The graceful-stop wait (#1088) widens
/// that window to ~6s, so gate it explicitly: while a restart is in flight,
/// further requests are logged no-ops.
static RESTART_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Gracefully stop the sidecar (flush dirty docs + save session, #1088),
/// hard-kill as fallback, then spawn it again.
#[tauri::command]
fn restart_sidecar(app: tauri::AppHandle) {
    if RESTART_IN_PROGRESS
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        log::warn!("restart_sidecar ignored — a restart is already in flight");
        return;
    }
    // Reset healthy flag FIRST so any RunEvent::Opened arriving mid-restart
    // queues instead of POSTing to a dying server. Must clear under the
    // PendingOpens mutex (see clear_healthy_under_lock) — a bare atomic store
    // here would race a concurrent producer that read flag=true a moment ago.
    // `start_sidecar` will set it back to true after the next successful
    // `wait_for_health`.
    let pending: tauri::State<'_, PendingOpens> = app.state();
    clear_healthy_under_lock(&pending);
    // Drop any buffered cold-start rejection so a stale reason from the previous
    // launch can't be replayed against the freshly restarted sidecar on the next
    // init-time drain. See the STARTUP_REJECTION doc comment (#630 risk note).
    clear_startup_rejection();
    let client = app.state::<reqwest::Client>().inner().clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // Graceful stop before the hard kill (#1088): POST /api/shutdown so
        // the Node shutdown sequence flushes up to ~60s of unsaved edits and
        // persists the session, then wait up to 6s for exit. A bare kill()
        // here discarded those edits and made server/WebView histories
        // diverge on every restart.
        stop_sidecar_gracefully(&handle, &client, GRACEFUL_SHUTDOWN_DEADLINE_SECS).await;
        // Restart never re-injects the cold-start file: the original `setup()`
        // invocation already opened it and registered it in `openDocuments`.
        if let Err(e) = start_sidecar(&handle, &client, None).await {
            // Detailed error stays in the log sink only — never user-visible.
            // The emitted event carries a stable code, no error detail, so the
            // WebView can surface a generic toast without leaking paths, env
            // vars, errno text, or the auth token.
            log::error!("[restart_sidecar] failed to restart sidecar: {e}");
            eprintln!("[restart_sidecar] failed to restart sidecar: {e}");
            if let Err(emit_err) =
                handle.emit("sidecar-restart-failed", "SIDECAR_RESTART_FAILED")
            {
                log::error!("[restart_sidecar] failed to emit failure event: {emit_err}");
            }
        }
        // Release the gate on success AND failure — a failed restart must
        // leave the button usable for another attempt.
        RESTART_IN_PROGRESS.store(false, Ordering::Release);
    });
}

/// Build the `(program, args)` tuple that reveals `path` in the host OS file
/// manager, parameterized by target OS string so the construction can be unit
/// tested for every platform without spawning a process.
///
/// Platform contracts:
/// - **Windows** (`explorer`): the documented form is `/select,<path>` as a
///   *single* argv element — Explorer parses the comma-prefixed switch and the
///   path as one token. Passing `/select,` and the path as two separate args
///   makes Explorer open the parent folder without selecting the file. The path
///   is the *file* itself.
/// - **macOS** (`open -R <path>`): `-R` reveals (selects) the file in Finder.
///   The path is the *file* itself.
/// - **Linux** (`xdg-open <dir>`): no portable "reveal/select" verb exists, so
///   we open the *containing directory*. Callers pass the dirname for Linux.
///
/// In every case the path is appended as opaque argv data to a fixed literal —
/// never interpolated into a shell line, and no shell is ever invoked.
fn reveal_command_args(path: &str, target_os: &str) -> (&'static str, Vec<String>) {
    match target_os {
        "windows" => ("explorer", vec![format!("/select,{path}")]),
        "macos" => ("open", vec!["-R".to_string(), path.to_string()]),
        // Linux and any other Unix-like target: open the containing directory.
        _ => {
            // `Path::parent()` returns `Some("")` (not `None`) for a bare
            // filename with no directory component — treat that empty parent
            // the same as "no parent" and fall back to the path itself, so we
            // never hand `xdg-open` an empty argument.
            let dir = std::path::Path::new(path)
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .filter(|p| !p.is_empty())
                .unwrap_or_else(|| path.to_string());
            ("xdg-open", vec![dir])
        }
    }
}

/// Reveal `path` in the OS file manager (Explorer / Finder / file manager).
///
/// Implemented as a native `std::process::Command` — this needs NO capability
/// entry. Capabilities gate Tauri *plugin* APIs (e.g. `shell:allow-execute`),
/// not native Rust process spawns. The per-OS argument vector is built by the
/// pure `reveal_command_args` helper (unit-tested); the path is always passed
/// as a separate argv element, so there is no shell-injection surface.
#[tauri::command]
fn show_in_file_manager(path: String) -> Result<(), String> {
    let (program, args) = reveal_command_args(&path, std::env::consts::OS);
    match std::process::Command::new(program).args(&args).spawn() {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("Failed to reveal {path} in file manager: {e}")),
    }
}

// ---- Native editor context menu (issue #923) ------------------------------
//
// Security contract (enum-in / id-out): the request from JS carries only a kind
// enum + booleans — never an href or path. We build the menu from a FIXED id
// set and emit one of those ids back; the sensitive link href stays in the
// webview's module-local state and is re-validated there. The app-level
// `on_menu_event` (registered once in the builder) forwards `ctx:`-prefixed ids
// to the webview — see `EVENT_CONTEXT_MENU_ACTION`.

const EVENT_CONTEXT_MENU_ACTION: &str = "context-menu-action";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum ContextMenuKind {
    EditorText,
    TableCell,
    Link,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextMenuRequest {
    kind: ContextMenuKind,
    #[allow(dead_code)] // reserved: native Cut/Copy self-disable on macOS
    has_selection: bool,
    is_editable: bool,
    #[allow(dead_code)] // overLink is implied by kind == Link
    over_link: bool,
    can_merge_cells: bool,
    can_split_cell: bool,
}

#[derive(serde::Serialize, Clone)]
struct ContextMenuActionPayload {
    id: String,
}

/// One item in a context menu. Predefined variants map to OS-native
/// `PredefinedMenuItem`s (Cut/Copy/Paste/Select All operate on the focused
/// webview); `Custom` items carry a `ctx:` id routed back to the editor.
#[derive(Debug, PartialEq, Eq)]
enum CtxItem {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Separator,
    /// (id, label, enabled)
    Custom(&'static str, &'static str, bool),
    /// (id, label, enabled, native accelerator)
    Accelerated(&'static str, &'static str, bool, &'static str),
    /// Recursive group. Submenu ids are deliberately not routed leaves.
    Submenu(&'static str, Vec<CtxItem>),
}

fn selection_intents(req: &ContextMenuRequest) -> Vec<CtxItem> {
    let enabled = req.is_editable && req.has_selection;
    vec![
        CtxItem::Custom("ctx:selection:askAi", "Ask AI about selection…", enabled),
        CtxItem::Custom("ctx:selection:comment", "Comment to AI…", enabled),
        CtxItem::Custom("ctx:selection:privateNote", "Private Note…", enabled),
    ]
}

/// Pure builder — returns the item spec for a request. Unit-tested like
/// `reveal_command_args`; building the real `Menu` (which needs a manager) is a
/// thin mapping over this in `build_context_menu`.
fn build_context_menu_spec(req: &ContextMenuRequest) -> Vec<CtxItem> {
    let ed = req.is_editable;
    match req.kind {
        ContextMenuKind::Link => {
            let mut spec = vec![
                CtxItem::Custom("ctx:link:open", "Open Link", true),
                CtxItem::Custom("ctx:link:copy", "Copy Link", true),
                CtxItem::Custom("ctx:link:edit", "Edit Link…", ed),
                CtxItem::Custom("ctx:link:remove", "Remove Link", ed),
                CtxItem::Separator,
                CtxItem::Cut,
                CtxItem::Copy,
                CtxItem::Paste,
            ];
            if req.has_selection {
                spec.push(CtxItem::Separator);
                spec.extend(selection_intents(req));
            }
            spec
        }
        ContextMenuKind::TableCell => {
            let mut spec = vec![
                CtxItem::Cut,
                CtxItem::Copy,
                CtxItem::Paste,
                CtxItem::Separator,
                CtxItem::Submenu(
                    "Rows",
                    vec![
                        CtxItem::Custom("ctx:table:insertRowAbove", "Insert Above", ed),
                        CtxItem::Custom("ctx:table:insertRowBelow", "Insert Below", ed),
                        CtxItem::Separator,
                        CtxItem::Custom("ctx:table:deleteRow", "Delete Row", ed),
                    ],
                ),
                CtxItem::Submenu(
                    "Columns",
                    vec![
                        CtxItem::Custom("ctx:table:insertColLeft", "Insert Left", ed),
                        CtxItem::Custom("ctx:table:insertColRight", "Insert Right", ed),
                        CtxItem::Separator,
                        CtxItem::Custom("ctx:table:deleteCol", "Delete Column", ed),
                    ],
                ),
                CtxItem::Custom(
                    "ctx:table:mergeCells",
                    "Merge Cells",
                    ed && req.can_merge_cells,
                ),
                CtxItem::Custom(
                    "ctx:table:splitCell",
                    "Split Cell",
                    ed && req.can_split_cell,
                ),
                CtxItem::Separator,
                CtxItem::Custom("ctx:table:deleteTable", "Delete Table", ed),
            ];
            if req.has_selection {
                spec.push(CtxItem::Separator);
                spec.extend(selection_intents(req));
            }
            spec
        }
        ContextMenuKind::EditorText => {
            let mut spec = vec![
                CtxItem::Undo,
                CtxItem::Redo,
                CtxItem::Separator,
                CtxItem::Cut,
                CtxItem::Copy,
                CtxItem::Paste,
                CtxItem::Accelerated(
                    "ctx:pastePlain",
                    "Paste as Raw Text",
                    ed,
                    "CmdOrCtrl+Shift+V",
                ),
                CtxItem::Separator,
                CtxItem::SelectAll,
            ];
            if req.has_selection {
                spec.push(CtxItem::Separator);
                spec.extend(selection_intents(req));
            }
            spec
        }
    }
}

fn build_menu_items_from_spec(
    window: &tauri::WebviewWindow,
    spec: &[CtxItem],
) -> tauri::Result<Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>>> {
    use tauri::menu::IsMenuItem;
    let mut items: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = Vec::with_capacity(spec.len());
    for item in spec {
        let boxed: Box<dyn IsMenuItem<tauri::Wry>> =
            match item {
                CtxItem::Undo => Box::new(PredefinedMenuItem::undo(window, None)?),
                CtxItem::Redo => Box::new(PredefinedMenuItem::redo(window, None)?),
                CtxItem::Cut => Box::new(PredefinedMenuItem::cut(window, None)?),
                CtxItem::Copy => Box::new(PredefinedMenuItem::copy(window, None)?),
                CtxItem::Paste => Box::new(PredefinedMenuItem::paste(window, None)?),
                CtxItem::SelectAll => Box::new(PredefinedMenuItem::select_all(window, None)?),
                CtxItem::Separator => Box::new(PredefinedMenuItem::separator(window)?),
                CtxItem::Custom(id, label, enabled) => Box::new(MenuItem::with_id(
                    window,
                    *id,
                    *label,
                    *enabled,
                    None::<&str>,
                )?),
                CtxItem::Accelerated(id, label, enabled, accelerator) => Box::new(
                    MenuItem::with_id(window, *id, *label, *enabled, Some(*accelerator))?,
                ),
                CtxItem::Submenu(label, children) => {
                    let child_items = build_menu_items_from_spec(window, children)?;
                    let child_refs: Vec<&dyn IsMenuItem<tauri::Wry>> =
                        child_items.iter().map(|item| item.as_ref()).collect();
                    Box::new(Submenu::with_items(window, *label, true, &child_refs)?)
                }
            };
        items.push(boxed);
    }
    Ok(items)
}

fn build_menu_from_spec(
    window: &tauri::WebviewWindow,
    spec: &[CtxItem],
) -> tauri::Result<Menu<tauri::Wry>> {
    use tauri::menu::IsMenuItem;
    let items = build_menu_items_from_spec(window, spec)?;
    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(window, &refs)
}

fn build_context_menu(
    window: &tauri::WebviewWindow,
    req: &ContextMenuRequest,
) -> tauri::Result<Menu<tauri::Wry>> {
    build_menu_from_spec(window, &build_context_menu_spec(req))
}

#[tauri::command]
fn show_context_menu(window: tauri::WebviewWindow, req: ContextMenuRequest) -> Result<(), String> {
    let menu = build_context_menu(&window, &req).map_err(|e| e.to_string())?;
    // Cursor-position overload; popup is modal so the local `menu` outlives the
    // user's click and can drop afterwards (no retention needed).
    window.popup_menu(&menu).map_err(|e| e.to_string())?;
    Ok(())
}

// ---- Tab-strip context menu (issue #923, Phase 2) -------------------------
//
// Reuses the Phase 1 plumbing: the same fixed-id / boolean-only request shape,
// the same `build_menu_from_spec` mapping, and the same app-level
// `forward_context_menu_event` (any `ctx:`-prefixed id is emitted back). Tab
// actions are all app-level (close tabs, copy path, reveal), so every item is a
// custom `ctx:tab:*` id routed to the webview — no PredefinedMenuItems.

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TabContextMenuRequest {
    /// At least one tab sits to the left of the clicked tab.
    can_close_left: bool,
    /// More than one tab is open → "Close Others" is meaningful.
    can_close_others: bool,
    /// At least one tab sits to the right of the clicked tab.
    can_close_right: bool,
    can_rename: bool,
    can_save: bool,
    /// Selects the fixed Save As label; no filename/path crosses IPC.
    save_as: bool,
    can_copy_file_name: bool,
    /// The tab maps to a real on-disk file (not a scratchpad / upload) →
    /// Copy Path + Reveal are meaningful.
    has_path: bool,
    can_toggle_source_view: bool,
    /// Selects the fixed return-to-editor label.
    source_view_active: bool,
}

/// OS-appropriate label for the reveal-in-file-manager item. Mirrors the
/// per-OS verb users expect (Finder / Explorer / generic).
fn reveal_in_file_manager_label(target_os: &str) -> &'static str {
    match target_os {
        "macos" => "Reveal in Finder",
        "windows" => "Show in File Explorer",
        _ => "Show in File Manager",
    }
}

fn build_tab_context_menu_spec(req: &TabContextMenuRequest, target_os: &str) -> Vec<CtxItem> {
    vec![
        CtxItem::Custom("ctx:tab:close", "Close", true),
        CtxItem::Custom(
            "ctx:tab:closeLeft",
            "Close Tabs to the Left",
            req.can_close_left,
        ),
        CtxItem::Custom("ctx:tab:closeOthers", "Close Others", req.can_close_others),
        CtxItem::Custom(
            "ctx:tab:closeRight",
            "Close to the Right",
            req.can_close_right,
        ),
        CtxItem::Separator,
        CtxItem::Custom("ctx:tab:rename", "Rename", req.can_rename),
        CtxItem::Custom(
            "ctx:tab:save",
            if req.save_as { "Save As…" } else { "Save" },
            req.can_save,
        ),
        CtxItem::Custom(
            "ctx:tab:toggleSourceView",
            if req.source_view_active {
                "Return to Formatted Editor"
            } else {
                "View Markdown Source"
            },
            req.can_toggle_source_view,
        ),
        CtxItem::Separator,
        CtxItem::Custom(
            "ctx:tab:copyFileName",
            "Copy File Name",
            req.can_copy_file_name,
        ),
        CtxItem::Custom("ctx:tab:copyPath", "Copy Path", req.has_path),
        CtxItem::Custom(
            "ctx:tab:reveal",
            reveal_in_file_manager_label(target_os),
            req.has_path,
        ),
    ]
}

#[tauri::command]
fn show_tab_context_menu(
    window: tauri::WebviewWindow,
    req: TabContextMenuRequest,
) -> Result<(), String> {
    let spec = build_tab_context_menu_spec(&req, std::env::consts::OS);
    let menu = build_menu_from_spec(&window, &spec).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())?;
    Ok(())
}

// ---- Annotation-card context menu (issue #999, #923 Phase 3) ----------------
//
// Same plumbing as Phase 1/2: booleans-only request, fixed `ctx:annotation:*` ids routed
// back through the shared `forward_context_menu_event`, all custom items (no
// PredefinedMenuItems — "Copy text" is a custom webview clipboard write of the annotation
// body, not the native Copy of a selection). The sensitive annotation id never crosses
// IPC; only these booleans go in. Items are grouped and EMPTY GROUPS COLLAPSE their
// separators, so the menu never shows a leading/trailing/doubled divider.

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnnotationContextMenuRequest {
    can_accept: bool,
    can_dismiss: bool,
    can_reply: bool,
    can_edit: bool,
    can_send_to_claude: bool,
    can_copy: bool,
    can_remove: bool,
    /// Remove item label: note → "Archive", else → "Remove".
    is_note: bool,
}

fn build_annotation_context_menu_spec(req: &AnnotationContextMenuRequest) -> Vec<CtxItem> {
    // Four logical groups; an item is present only when its gate is true. Empty groups
    // are dropped and the surviving groups are joined with a single separator each.
    let review: Vec<CtxItem> = [
        (req.can_accept, "ctx:annotation:accept", "Accept"),
        (req.can_dismiss, "ctx:annotation:dismiss", "Dismiss"),
    ]
    .into_iter()
    .filter_map(|(on, id, label)| on.then_some(CtxItem::Custom(id, label, true)))
    .collect();

    let compose: Vec<CtxItem> = [
        (req.can_reply, "ctx:annotation:reply", "Reply…"),
        (req.can_edit, "ctx:annotation:edit", "Edit…"),
        (
            req.can_send_to_claude,
            "ctx:annotation:sendToClaude",
            "Send to Claude",
        ),
    ]
    .into_iter()
    .filter_map(|(on, id, label)| on.then_some(CtxItem::Custom(id, label, true)))
    .collect();

    let clipboard: Vec<CtxItem> = if req.can_copy {
        vec![CtxItem::Custom("ctx:annotation:copy", "Copy text", true)]
    } else {
        vec![]
    };

    let destructive: Vec<CtxItem> = if req.can_remove {
        let label = if req.is_note { "Archive" } else { "Remove" };
        vec![CtxItem::Custom("ctx:annotation:remove", label, true)]
    } else {
        vec![]
    };

    let mut out: Vec<CtxItem> = Vec::new();
    for group in [review, compose, clipboard, destructive] {
        if group.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(CtxItem::Separator);
        }
        out.extend(group);
    }
    out
}

#[tauri::command]
fn show_annotation_context_menu(
    window: tauri::WebviewWindow,
    req: AnnotationContextMenuRequest,
) -> Result<(), String> {
    let spec = build_annotation_context_menu_spec(&req);
    let menu = build_menu_from_spec(&window, &spec).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())?;
    Ok(())
}

/// App-level menu-event handler (registered ONCE in the builder). Forwards
/// `ctx:`-prefixed ids to the main webview; tray ids (`MENU_*`) are handled by
/// the tray's own scoped handler and ignored here. Window-scoped emit so a
/// future second window can't receive another window's action.
fn forward_context_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    if !id.starts_with("ctx:") {
        return;
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Err(e) = window.emit(
            EVENT_CONTEXT_MENU_ACTION,
            ContextMenuActionPayload { id: id.to_string() },
        ) {
            log::warn!("Failed to emit context-menu action {id}: {e}");
        }
    }
}

/// Graceful-then-hard sidecar stop (#1088).
///
/// When we own a sidecar child, POST `/api/shutdown` so the Node shutdown
/// sequence runs (unwatchAll → stopAutoSave → autoSaveAllToDisk (5s-bounded)
/// → saveCurrentSession) and wait up to `deadline_secs` for the port to
/// release. Always finishes with `kill_sidecar`: on a graceful exit that just
/// clears the stored child handle (killing an already-exited child is a
/// logged no-op); on POST failure or timeout it is the hard-kill fallback —
/// the old behavior.
///
/// When no child is owned (debug builds running against an external
/// `dev:standalone` server) this never POSTs — we must not shut down a server
/// we did not spawn.
async fn stop_sidecar_gracefully(
    handle: &tauri::AppHandle,
    client: &reqwest::Client,
    deadline_secs: u64,
) {
    let state: tauri::State<'_, SidecarState> = handle.state();
    let owns_child = match state.0.lock() {
        Ok(guard) => guard.is_some(),
        Err(poisoned) => poisoned.into_inner().is_some(),
    };
    if owns_child {
        let posted = match client.post(SHUTDOWN_URL).send().await {
            Ok(resp) if resp.status().is_success() => true,
            Ok(resp) => {
                log::warn!(
                    "Graceful shutdown POST returned HTTP {} — falling back to hard kill",
                    resp.status()
                );
                false
            }
            Err(e) => {
                log::warn!("Graceful shutdown POST failed ({e}) — falling back to hard kill");
                false
            }
        };
        if posted {
            if wait_for_port_release(client, deadline_secs).await {
                log::info!("Sidecar exited gracefully after /api/shutdown");
            } else {
                log::warn!(
                    "Sidecar still up {deadline_secs}s after /api/shutdown — falling back to hard kill"
                );
            }
        }
    }
    kill_sidecar(handle);
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
async fn start_sidecar(
    handle: &tauri::AppHandle,
    client: &reqwest::Client,
    cold_start_file: Option<&std::path::Path>,
) -> Result<(), String> {
    // Debug-only: skip spawn if a server is already running (e.g. `npm run dev:standalone`
    // alongside `cargo tauri dev`). In release builds the installed app must own its
    // sidecar exclusively — a stale `tsx watch` dev session, an older release process,
    // or any other listener on the MCP/WS ports can answer /health but be incompatible
    // with this app's auth token / session state, leaving the UI stuck on "Disconnected".
    // The sidecar's own `freePort()` step on start handles port conflicts cleanly.
    if cfg!(debug_assertions) && check_health(&client).await {
        log::info!("Server already healthy — skipping sidecar spawn (debug build)");
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

    // Resolve the bundled channel-shim path and inject it as TANDEM_CHANNEL_DIST
    // so the Node server can register Claude Code's push transport from the
    // correct resource-dir path. On a desktop bundle the server's own
    // package-root derivation resolves OUTSIDE the resource dir, so without this
    // the channel shim silently fails to register (real-time push degrades to
    // polling). Replaces the /api/setup startup round-trip removed in #477 PR
    // 3c-ii-c. None = no built channel artifact (source dev) → server falls back
    // to its package-root derivation.
    let channel_dist: Option<String> = resolve_channel_dist(handle);
    // Warn once before the restart loop begins — not repeated on each restart attempt.
    if channel_dist.is_none() {
        log::warn!("Channel shim path unresolved — Claude Code push may fall back to polling");
    }

    // Same problem, different artifact: the `tandem` stdio entry Tandem writes
    // for Claude Desktop needs an absolute script path, or it falls back to a
    // bare `npx` the client cannot resolve on a GUI-launched PATH. Deliberately
    // a SEPARATE Option from `channel_dist` — a partial `dist/` can carry one
    // and not the other, and folding them together would let a missing channel
    // bundle silently disable the stdio fix.
    let stdio_bridge_dist: Option<String> = resolve_stdio_bridge_dist(handle);
    if stdio_bridge_dist.is_none() {
        log::warn!(
            "stdio-bridge path unresolved — the Claude Desktop MCP entry will fall back to npx"
        );
    }

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
            .env("TANDEM_TAURI_SIDECAR", "1")
            .env("TANDEM_DATA_DIR", app_data_dir_str.as_str());

        if let Some(ref token) = auth_token {
            cmd = cmd.env("TANDEM_AUTH_TOKEN", token.as_str());
        }

        if let Some(ref cd) = channel_dist {
            cmd = cmd.env("TANDEM_CHANNEL_DIST", cd.as_str());
        }

        if let Some(ref sb) = stdio_bridge_dist {
            cmd = cmd.env("TANDEM_STDIO_BRIDGE_DIST", sb.as_str());
        }

        // Crash reporting (#921): forward the opt-in DSN so the sidecar reports
        // to the SAME Sentry/GlitchTip project as the shell (separate event
        // source). `tauri-plugin-shell` does NOT inherit the parent env, so we
        // must pass it explicitly. Unset → not forwarded → sidecar reporting
        // stays off (default posture).
        if let Ok(dsn) = std::env::var(sentry_reporting::SENTRY_DSN_ENV) {
            if !dsn.trim().is_empty() {
                cmd = cmd.env(sentry_reporting::SENTRY_DSN_ENV, dsn);
            }
        }

        // Autostart deferral (#1236). Read fresh on EVERY attempt — unlike
        // TANDEM_OPEN_FILE below, this must NOT be pinned to `attempt == 0`.
        // If the user has already opened the window, the latch is clear and a
        // restarted sidecar starts the launcher normally; if they haven't, the
        // restarted sidecar keeps holding it. Either way the restart inherits
        // current reality rather than a snapshot from boot.
        if LAUNCHER_DEFERRED.load(Ordering::Acquire) {
            cmd = cmd.env("TANDEM_DEFER_LAUNCHER", "1");
        }

        // Cold-start file open from OS file association (Windows/Linux argv).
        // Only set on the first spawn — sidecar restarts must not re-trigger
        // an open (the file has already been registered in openDocuments).
        if attempt == 0 {
            if let Some(p) = cold_start_file {
                cmd = cmd.env("TANDEM_OPEN_FILE", p.to_string_lossy().as_ref());
            }
        }

        let (rx, child) = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

        // Windows-only (#987): bind this sidecar to the kill-on-job-close job
        // object so it dies with the shell even on an ungraceful parent exit
        // (taskkill / crash / dev-runner rebuild) where RunEvent::Exit never
        // fires. Best-effort: a failure here only logs and falls back to the
        // graceful kill path — it never blocks startup. Done before `child` is
        // moved into SidecarState; the job holds its own reference to the
        // process. A restarted sidecar (new PID) re-assigns to the same job.
        #[cfg(target_os = "windows")]
        {
            let job = handle.state::<sidecar_job::SidecarJob>();
            job.assign(child.pid());
        }

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

                // Promote SIDECAR_HEALTHY=true AND drain the pending queue in
                // a single critical section over `PendingOpens` mutex. Then
                // POST the drained paths outside the lock (we can't hold a
                // std::sync::Mutex across .await). See docs on
                // `promote_healthy_and_drain` and `try_queue_or_post` for the
                // ordering argument that proves no path is orphaned.
                let drained = promote_healthy_and_drain(handle.state::<PendingOpens>().inner());
                post_drained_paths(drained, client).await;

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

    // The queue is never going to drain, so say so at a level that survives
    // release builds. `LevelFilter::Warn` is the release floor, and the queue
    // push logs at `info` — so without this line a file the user double-clicked
    // is dropped leaving no evidence anywhere: no tab, no toast, and nothing in
    // `tandem.log`, the one artifact a bug report can attach.
    let abandoned = {
        let pending = handle.state::<PendingOpens>();
        let mut guard = match pending.0.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        std::mem::take(&mut *guard)
    };
    if !abandoned.is_empty() {
        log::warn!(
            "Abandoning {} queued file open(s) — sidecar never became healthy",
            abandoned.len()
        );
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
///
/// Windows-only since #477 PR 3c-ii-c removed `resolve_setup_paths` (the
/// cross-platform caller) — the sole remaining consumer is the Windows-gated
/// `wait_for_sidecar_unlock`. Gated to avoid a dead-code warning elsewhere.
#[cfg(target_os = "windows")]
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

/// Resolve the bundled channel-shim JS path, injected into the sidecar as
/// `TANDEM_CHANNEL_DIST` so the Node server registers Claude Code's push
/// transport from the correct resource-dir path. Replaces `resolve_setup_paths`
/// + the `/api/setup` round-trip removed in #477 PR 3c-ii-c.
///
/// Prefers `resource_dir/dist/channel/index.js` (always present in a release
/// bundle; `cargo tauri dev` materializes it under target/<profile>/). Falls
/// back to a cwd-relative path for non-Tauri dev layouts (cwd = repo root, e.g.
/// `dev:standalone`). `strip_win_prefix` drops the `\\?\` prefix resource_dir
/// can carry on Windows (Node can't resolve it). `None` when no built artifact
/// exists (running from source without a build) → the server falls back to its
/// own package-root derivation.
fn resolve_channel_dist(handle: &tauri::AppHandle) -> Option<String> {
    let resource_channel = handle
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join("dist/channel/index.js"));
    if let Some(p) = resource_channel {
        if p.exists() {
            return Some(strip_win_prefix(&p));
        }
    }
    let cwd_channel = std::env::current_dir().ok()?.join("dist/channel/index.js");
    if cwd_channel.exists() {
        Some(strip_win_prefix(&cwd_channel))
    } else {
        None
    }
}

/// Resolve the bundled stdio-bridge JS path, injected into the sidecar as
/// `TANDEM_STDIO_BRIDGE_DIST` so the generated `mcpServers.tandem` entry for
/// Claude Desktop can name an absolute script instead of a bare `npx` the
/// client may not be able to resolve. Exact sibling of `resolve_channel_dist`
/// — same precedence, same `strip_win_prefix` (Node cannot resolve `\\?\`),
/// same `None`-means-fall-back-to-the-server's-own-derivation contract.
///
/// Deliberately not folded into `resolve_channel_dist` with a parameter: the
/// two are injected independently and their absence has different
/// consequences (degraded push vs an unspawnable tool surface), so they warn
/// separately at the call site.
fn resolve_stdio_bridge_dist(handle: &tauri::AppHandle) -> Option<String> {
    let resource_bridge = handle
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join("dist/stdio-bridge/index.js"));
    if let Some(p) = resource_bridge {
        if p.exists() {
            return Some(strip_win_prefix(&p));
        }
    }
    let cwd_bridge = std::env::current_dir().ok()?.join("dist/stdio-bridge/index.js");
    if cwd_bridge.exists() {
        Some(strip_win_prefix(&cwd_bridge))
    } else {
        None
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

/// Abstracts over the Tauri window types that expose a native `hwnd()` on
/// Windows. `setup()` hands us a `WebviewWindow`; the `on_window_event` handler
/// hands us a `Window`. Both expose `hwnd()` returning a `windows`-crate `HWND`
/// (`pub struct HWND(pub *mut core::ffi::c_void)`); `.0` extracts the raw pointer,
/// which is the same underlying type as `windows-sys`'s `type HWND = *mut c_void`,
/// so no cast is needed at either end.
#[cfg(target_os = "windows")]
trait RawHwnd {
    fn raw_hwnd(&self) -> Result<*mut core::ffi::c_void, String>;
}

#[cfg(target_os = "windows")]
impl RawHwnd for tauri::WebviewWindow {
    fn raw_hwnd(&self) -> Result<*mut core::ffi::c_void, String> {
        self.hwnd().map(|h| h.0).map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "windows")]
impl RawHwnd for tauri::Window {
    fn raw_hwnd(&self) -> Result<*mut core::ffi::c_void, String> {
        self.hwnd().map(|h| h.0).map_err(|e| e.to_string())
    }
}

/// Force rounded window corners and suppress the borderless-window outline via
/// the Desktop Window Manager. Windows-only; a no-op stub on every other OS so
/// call sites stay platform-agnostic. See issue #984.
///
/// Windows 11 rounds normal windows by default but **squares the corners when
/// the window is snapped or maximized**, and the `decorations: false`
/// borderless window can draw a thin 1px outline. We explicitly opt in to
/// `DWMWCP_ROUND` (so snapped/maximized windows stay rounded) and set the
/// border color to `DWMWA_COLOR_NONE` (so no outline is drawn). Both attributes
/// reset on some window-state transitions, so this is invoked at setup AND
/// re-asserted from the window-event handler on `Resized`.
///
/// All DWM calls are best-effort: a failing `DwmSetWindowAttribute` (e.g. an
/// older Windows 10 build that predates these attributes — they require Win11
/// build 22000+) is silently ignored so startup is never aborted. A `debug`-level
/// log is emitted, but the shipping log filter is Info/Warn (and the log plugin is
/// absent under the `devtools` feature), so in practice the failure leaves no trace
/// — that is intentional: a pre-Win11 fallback is expected, not actionable.
///
/// Generic over the window type so it accepts both the `WebviewWindow` from
/// `setup()` and the `Window` delivered to the `on_window_event` handler — both
/// expose `hwnd()` on Windows.
#[cfg(target_os = "windows")]
fn apply_window_chrome<W: RawHwnd>(window: &W) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };

    let hwnd: HWND = match window.raw_hwnd() {
        Ok(v) => v,
        Err(e) => {
            log::warn!("apply_window_chrome: hwnd() unavailable: {e}");
            return;
        }
    };

    // SAFETY: `hwnd` is a live top-level window handle owned by this process for
    // the lifetime of the call. Each attribute value is a stack local whose size
    // we pass exactly; DwmSetWindowAttribute only reads `cbAttribute` bytes.
    unsafe {
        let corner_pref: i32 = DWMWCP_ROUND;
        let hr = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            std::ptr::addr_of!(corner_pref).cast(),
            std::mem::size_of::<i32>() as u32,
        );
        if hr != 0 {
            log::debug!("DwmSetWindowAttribute(CORNER_PREFERENCE) failed: hr=0x{hr:08x}");
        }

        let border_color: u32 = DWMWA_COLOR_NONE;
        let hr = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR as u32,
            std::ptr::addr_of!(border_color).cast(),
            std::mem::size_of::<u32>() as u32,
        );
        if hr != 0 {
            log::debug!("DwmSetWindowAttribute(BORDER_COLOR) failed: hr=0x{hr:08x}");
        }
    }
}

/// Invoked from `TitleBar.svelte` after the WebView page has loaded.
/// `create_overlay_titlebar()` injects JS hit-test logic that is cleared on
/// page navigation; calling post-load keeps it alive so button clicks reach the
/// WebView. Windows-only; no-op on other platforms.
#[tauri::command]
#[cfg_attr(not(target_os = "windows"), allow(unused_variables))]
fn setup_overlay_titlebar(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_decorum::WebviewWindowExt;
        window
            .create_overlay_titlebar()
            .map_err(|e| format!("create_overlay_titlebar failed: {e}"))?;
    }
    Ok(())
}

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
fn get_app_theme(window: tauri::WebviewWindow) -> Result<String, String> {
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
enum AppMode {
    ForceDark,
    ForceLight,
    /// The release target — see `native_theme_action` and
    /// `win_app_mode::set_preferred_app_mode` for why this is `AllowDark`
    /// and not `Default`.
    AllowDark,
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
enum HighContrast {
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
            // Mid-session toggling is not re-released by this guard; that is
            // #1364, a separate, narrower gap.
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

/// Applies a decided `NativeThemeAction`'s side effect. Split out from
/// `set_native_theme` so the platform-specific `apply_app_mode` halves
/// (below) stay small and symmetric; this function itself is not
/// platform-gated, so it type-checks — and its `SetAppMode` arm compiles —
/// on every OS CI builds, even though `native_theme_action` only ever
/// produces that variant when `host` is `NativeHost::Windows` (i.e. the arm
/// is compiled everywhere but taken only on Windows; see `apply_app_mode`'s
/// non-Windows stub).
fn apply_native_theme_action(
    window: &tauri::WebviewWindow,
    action: NativeThemeAction,
) -> Result<(), String> {
    match action {
        NativeThemeAction::Skip => Ok(()),
        NativeThemeAction::SetWindowTheme(theme) => window
            .set_theme(theme)
            .map_err(|e| format!("set_theme failed: {e}")),
        NativeThemeAction::SetAppMode(mode) => apply_app_mode(window, mode),
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
fn apply_app_mode(window: &tauri::WebviewWindow, mode: AppMode) -> Result<(), String> {
    use win_app_mode::AppModeOutcome;
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
            match win_app_mode::set_preferred_app_mode(mode) {
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
            let _ = tx.send(());
        })
        .map_err(|e| format!("run_on_main_thread failed: {e}"))?;
    match rx.recv_timeout(std::time::Duration::from_secs(2)) {
        Ok(()) => Ok(()),
        // A timeout abandons the wait; it does NOT cancel the queued closure,
        // which may still apply the mode a moment later. Distinct from a
        // dropped sender, where the closure provably never ran.
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            Err("app-mode call timed out (it remains queued and may still apply)".to_string())
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err("app-mode main-thread closure was dropped without running".to_string())
        }
    }
}

/// Non-Windows stub so `apply_native_theme_action`'s `SetAppMode` arm
/// compiles on every OS. Unreachable in practice: `native_theme_action`
/// only produces `SetAppMode` when `host` is `NativeHost::Windows`, and
/// `current_native_host` only returns that when `cfg!(target_os = "windows")`.
#[cfg(not(target_os = "windows"))]
fn apply_app_mode(_window: &tauri::WebviewWindow, _mode: AppMode) -> Result<(), String> {
    Ok(())
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
struct NativeThemeOutcome {
    override_active: bool,
    os_theme: Option<String>,
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
fn set_native_theme(
    window: tauri::WebviewWindow,
    theme: String,
) -> Result<NativeThemeOutcome, String> {
    let high_contrast = native_host_high_contrast();
    let action = native_theme_action(&theme, high_contrast.declines_force(), current_native_host());
    apply_native_theme_action(&window, action)?;
    // Fail closed AND fail loud. The action above has already released any
    // prior force, so the accessibility scheme wins — but the push did not
    // achieve the requested theme, and resolving it as success would let the
    // client latch `lastPush.pref` on a preference the OS does not have,
    // deduping every later attempt to re-apply it. That is #992 itself,
    // silently restored, so report the uncertainty instead.
    if high_contrast == HighContrast::Unknown {
        return Err(
            "could not determine the High Contrast setting; declined to force an app mode and \
             released any prior override"
                .to_string(),
        );
    }
    Ok(native_theme_outcome(action, || match window.theme() {
        Ok(tauri::Theme::Dark) => Some("dark".to_string()),
        Ok(_) => Some("light".to_string()),
        Err(e) => {
            log::warn!("set_native_theme: window.theme() read-back failed: {e}");
            None
        }
    }))
}

/// Whether opt-in crash reporting (#921) is active. The WebView calls this to
/// decide whether to initialise `@sentry/browser`; it can't read the
/// `TANDEM_SENTRY_DSN` env var itself. Returns `false` (default posture) unless
/// the operator configured a DSN at launch.
#[tauri::command]
fn sentry_enabled() -> bool {
    sentry_reporting::is_enabled()
}

/// Returns the set of keyboard shortcuts that should be blocked in the Tauri
/// webview. All shortcuts except DevTools (F12, Ctrl+Shift+I) are blocked.
/// Exported so the regression test in tests/prevent_default.rs can assert
/// against the same value that with_flags() receives. Fixes #541.
pub fn prevent_default_flags() -> tauri_plugin_prevent_default::Flags {
    Flags::RELOAD
}

// ---------------------------------------------------------------------------
// Cowork Tauri invoke commands
// ---------------------------------------------------------------------------
// All commands have Windows-native and non-Windows stub variants so that
// tauri::generate_handler![] compiles on all platforms.

/// Error string returned by every non-Windows Cowork stub.
#[cfg(not(target_os = "windows"))]
const WINDOWS_ONLY_ERR: &str = "Cowork integration is Windows-only";

/// Scan for Cowork workspace directories.
///
/// Returns an opaque, validated [`cowork_workspace_scan::WorkspaceHandle`] per
/// workspace rather than a bare path. The handle's `token` must be round-tripped
/// to `cowork_install_into_workspace` / `cowork_uninstall_from_workspace`, which
/// resolve it back to the exact canonical path validated here — closing the
/// TOCTOU window between this scan and the install IPC call (issue #433). The
/// `path` field is for display only and is never trusted on the return trip.
#[cfg(target_os = "windows")]
#[tauri::command]
fn cowork_scan_workspaces() -> Result<Vec<cowork_workspace_scan::WorkspaceHandle>, String> {
    Ok(cowork_workspace_scan::scan_workspaces_with_handles())
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cowork_scan_workspaces() -> Result<Vec<String>, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Enable or disable the Cowork integration.
///
/// On enable: fetches auth token, detects vEthernet subnet, adds allow firewall
/// rule, walks workspaces, installs plugin entries. When the firewall rule needs
/// elevation Tandem doesn't have: fail-closed — does NOT write plugin entries
/// (invariant §4). On disable: uninstalls plugin entries, removes firewall rules.
#[cfg(target_os = "windows")]
#[tauri::command]
fn cowork_toggle_integration(enabled: bool) -> Result<String, String> {
    use cowork_installer::{install_tandem_plugin_into_workspace, uninstall_tandem_plugin_from_workspace};
    use cowork_workspace_scan::find_cowork_workspaces;

    if enabled {
        // Fetch token.
        let token = token_store::get_or_create_token()?;

        // Detect vEthernet subnet.
        let cidr = firewall::detect_vethernet_subnet()
            .map_err(|e| serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()))?;

        // Scan workspaces up-front (read-only) — reused for both reconcile and install.
        let workspaces = find_cowork_workspaces();

        // Orphan firewall reconciliation BEFORE the add (issue #1163): remove stale
        // "Tandem Cowork*" rules from a previous failed uninstall first. The orphan
        // scan matches by name prefix (identical to the allow rule's own name), so
        // reconciling AFTER the add would scan the just-added rule as an orphan and
        // delete it — leaving every enable with no allow rule. Trade-off: on an
        // elevated run where cleanup succeeds but the add then errors, a leftover
        // rule is dropped without replacement; for the VM-scoped allow rule that's
        // strictly more restrictive, and a retired deny rule is inert under the
        // 127.0.0.1 loopback bind (same rationale as the disable path below).
        let removed_firewall_rules = cowork_installer::reconcile_orphan_firewall_rules();
        // Log removals here, before the add — a fail-closed add bails below, so
        // folding this into the post-add log would silently drop the audit trail
        // for "removed an allow rule but then failed to replace it".
        if !removed_firewall_rules.is_empty() {
            log::info!(
                "[cowork] orphan reconcile: removed {} firewall rule(s)",
                removed_firewall_rules.len()
            );
        }

        // Add allow firewall rule.
        let firewall_result = firewall::add_cowork_allow_rule(&cidr);
        if let Err(ref e) = firewall_result {
            // Fail-closed: if the firewall rule can't be written, bail — do NOT
            // walk workspaces (invariant §4).
            if let firewall::FirewallError::AdminDeclined = e {
                // The firewall rule needs elevation Tandem does not have (it never
                // runs elevated, so no UAC prompt ever appears). Do NOT attempt a
                // deny rule — it needs the same elevation and always fails, and the
                // server binds 127.0.0.1 so port 3479 was never network-exposed.
                // Record the outcome and surface the structured error for the UI's
                // honest copy. No plugin entries are written (invariant §4).
                log::warn!("[cowork] firewall rule needs elevation (none available); no plugin entries written");
                if let Err(meta_err) = cowork_meta::update(|m| {
                    m.uac_declined_last_attempt = true;
                    m.uac_declined_at = Some(iso_now());
                    m.vethernet_cidr_detected = Some(cidr.clone());
                    m.enabled = false;
                }) {
                    log::warn!("[cowork] failed to persist firewall-declined meta: {meta_err}");
                }
                return Err(serde_json::to_string(e).unwrap_or_else(|_| e.to_string()));
            }
            return Err(serde_json::to_string(e).unwrap_or_else(|_| e.to_string()));
        }

        // Resolve TANDEM_URL (host.docker.internal by default; LAN-IP if override set).
        let tandem_url = cowork_installer::resolve_tandem_url(&cowork_meta::load().map_err(|e| e.to_string())?);

        // Stale-token reconciliation (invariant §12) — AFTER the successful add, so a
        // fail-closed firewall add never reaches a workspace write (invariant §4).
        let rewritten_stale_entries =
            cowork_installer::reconcile_stale_workspace_tokens(&workspaces, &token);
        if !rewritten_stale_entries.is_empty() {
            log::info!(
                "[cowork] reconcile: rewrote {} stale token entry(s)",
                rewritten_stale_entries.len()
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

        // Count workspaces where installed_plugins was written successfully.
        // A workspace is "successful" if its installed_plugins status is Ok or
        // AlreadyPresent — anything else (Locked, SchemaDrift, InsecureAcl, Failed)
        // counts as a failure.
        if !workspaces.is_empty() {
            let success_count = reports.iter().filter(|r| {
                match r {
                    Ok(report) => matches!(
                        report.installed_plugins,
                        cowork_installer::WriteStatus::Ok | cowork_installer::WriteStatus::AlreadyPresent
                    ),
                    Err(_) => false,
                }
            }).count();

            if success_count == 0 {
                let failure_summary: Vec<String> = reports.iter().map(|r| match r {
                    Ok(report) => format!("{}/{}: {:?}", report.workspace_id, report.vm_id, report.installed_plugins),
                    Err(e) => e.to_string(),
                }).collect();
                return Err(format!(
                    "Cowork enable failed: all {} workspace(s) failed to install. Failures: {}",
                    workspaces.len(),
                    failure_summary.join("; ")
                ));
            }

            if success_count < workspaces.len() {
                log::warn!(
                    "[cowork] partial install: {}/{} workspace(s) succeeded",
                    success_count,
                    workspaces.len()
                );
            }
        }

        if let Err(e) = cowork_meta::update(|m| {
            m.enabled = true;
            m.vethernet_cidr_detected = Some(cidr.clone());
            m.workspaces_last_scanned_at = Some(iso_now());
            m.uac_declined_last_attempt = false;
            m.uac_declined_at = None;
        }) {
            log::warn!("[cowork] failed to persist meta after enable: {e}");
        }

        Ok(format!("Cowork enabled: {workspace_count} workspace(s) configured"))
    } else {
        // Disable: uninstall from all workspaces and remove firewall rules.
        let workspaces = find_cowork_workspaces();

        let reports: Vec<_> = workspaces
            .iter()
            .map(|ws| uninstall_tandem_plugin_from_workspace(ws))
            .collect();

        let errors: Vec<_> = reports.iter().filter_map(|r| r.as_ref().err()).collect();
        if !errors.is_empty() {
            log::warn!("[cowork] disable: {} uninstall error(s): {:?}", errors.len(), errors);
        }

        let workspace_all_failed = if !workspaces.is_empty() {
            let success_count = reports.iter().filter(|r| {
                match r {
                    Ok(report) => matches!(
                        report.installed_plugins,
                        cowork_installer::WriteStatus::Ok | cowork_installer::WriteStatus::AlreadyPresent
                    ),
                    Err(_) => false,
                }
            }).count();

            if success_count > 0 && success_count < workspaces.len() {
                log::warn!(
                    "[cowork] disable partial: {}/{} workspace(s) uninstalled cleanly",
                    success_count, workspaces.len()
                );
            }
            success_count == 0
        } else {
            false // No workspaces = nothing to uninstall = success (firewall still needs removing).
        };

        // Firewall removal is ADVISORY, not fatal. Tandem never runs elevated, so a
        // `netsh delete` on a rule a past elevated run wrote fails with "requires
        // elevation" — surfacing as NetshFailure (run_netsh only classifies AdminDeclined
        // for `add`), indistinguishable from other delete failures. Failing disable here
        // traps exactly the non-admin user who needs the escape hatch. Leaving a rule is
        // safe: the deny rule is retired, the allow rule is scoped to the VM subnet, and
        // the server binds 127.0.0.1 only, so a leftover rule is inert. This aligns with
        // reconcile_orphan_firewall_rules (cowork_installer.rs), which already treats remove
        // failures as non-fatal (§12). (Caveat: leaving the rule is inert only under the default
        // loopback bind; a future TANDEM_BIND_HOST=routable + stale VM-CIDR rule is an
        // untested composition. A later enable *may* clear it via reconcile_orphan_firewall_rules, but
        // that's best-effort — reconcile returns early if its scan fails — and the leftover
        // is an inert allow rule, not a missing protection.)
        let firewall_failed = match firewall::remove_cowork_rules() {
            Ok(()) => false,
            Err(fe) => {
                log::warn!("[cowork] disable: firewall rule removal failed (non-fatal): {fe}");
                true
            }
        };

        // Persist meta regardless of workspace/firewall outcome. Clearing the UAC-declined
        // flag is what makes the "Admin permission required" modal disappear: the user has
        // resolved the blocked state by turning the feature off. Unlike the advisory
        // firewall removal above, this write is the disable's CORE contract — if it fails,
        // the on-disk state stays `enabled = true` with the UAC flag set, so the modal
        // never goes away and the integration still reads as on. We therefore fail loud
        // (Err in the success-path tail below) instead of returning a green toast over a
        // stale state. Borrow in the warn so the Result survives for the later check.
        let meta_persist = cowork_meta::update(|m| {
            m.enabled = false;
            m.uac_declined_last_attempt = false;
            m.uac_declined_at = None;
        });
        if let Err(e) = &meta_persist {
            log::warn!("[cowork] failed to persist meta after disable: {e}");
        }

        if workspace_all_failed {
            let failure_summary: Vec<String> = reports.iter().map(|r| match r {
                Ok(report) => format!("{}/{}: {:?}", report.workspace_id, report.vm_id, report.installed_plugins),
                Err(e) => e.to_string(),
            }).collect();
            return Err(format!(
                "Cowork disable failed: all {} workspace(s) failed to uninstall. Failures: {}",
                workspaces.len(),
                failure_summary.join("; ")
            ));
        }

        // Workspace uninstall + firewall removal already ran (idempotent / inert), and the
        // disable branch re-drives this whole path on a repeat call, so failing here strands
        // nothing — a retry safely re-attempts the persist. Surface it so the user knows the
        // disable didn't stick rather than discovering the modal is still up.
        if let Err(e) = meta_persist {
            return Err(format!(
                "Cowork was turned off, but saving that state failed ({e}). Cowork is still \
                 marked enabled and the admin-permission notice stays open. Try disabling \
                 again; if it persists, restart Tandem."
            ));
        }

        if firewall_failed {
            Ok("Cowork disabled (a leftover firewall rule may remain — harmless; \
                Tandem's server only listens on this computer)"
                .to_string())
        } else {
            Ok("Cowork disabled".to_string())
        }
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

    let reports: Vec<_> = workspaces
        .iter()
        .map(|ws| install_tandem_plugin_into_workspace(ws, &token, &tandem_url))
        .collect();

    let errors: Vec<_> = reports.iter().filter_map(|r| r.as_ref().err()).collect();
    if !errors.is_empty() {
        log::warn!("[cowork] rescan: {} install error(s): {:?}", errors.len(), errors);
    }

    if !workspaces.is_empty() {
        let success_count = reports.iter().filter(|r| {
            match r {
                Ok(report) => matches!(
                    report.installed_plugins,
                    cowork_installer::WriteStatus::Ok | cowork_installer::WriteStatus::AlreadyPresent
                ),
                Err(_) => false,
            }
        }).count();

        if success_count == 0 {
            let failure_summary: Vec<String> = reports.iter().map(|r| match r {
                Ok(report) => format!("{}/{}: {:?}", report.workspace_id, report.vm_id, report.installed_plugins),
                Err(e) => e.to_string(),
            }).collect();
            return Err(format!(
                "Cowork rescan failed: all {} workspace(s) failed. Failures: {}",
                workspaces.len(),
                failure_summary.join("; ")
            ));
        }

        if success_count < workspaces.len() {
            log::warn!("[cowork] rescan partial: {}/{} workspace(s) succeeded", success_count, workspaces.len());
        }
    }

    if let Err(e) = cowork_meta::update(|m| {
        m.workspaces_last_scanned_at = Some(iso_now());
    }) {
        log::warn!("[cowork] rescan: failed to persist meta: {e}");
    }

    Ok(format!("Rescan complete: {} workspace(s)", workspaces.len()))
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cowork_rescan() -> Result<String, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// One self-heal pass: when the Cowork integration is enabled, install the
/// plugin entry into any workspace that lacks one. Runs from a background
/// interval task (see `setup`) so a workspace created AFTER enable — e.g. the
/// user's first Cowork session — gets configured headlessly, without the user
/// reopening settings or clicking Re-scan.
///
/// Guards:
/// - No-op unless `cowork_meta.enabled` (never arms anything by itself; no
///   firewall work, no UAC, ever).
/// - Read-only precheck first — zero writes and zero keychain access when every
///   workspace already has its entry (the steady state). The credential fetch is
///   forced lazily, from inside the injected installer, so a pass with nothing
///   to install stays side-effect-free and infallible.
/// - Attempt set keyed on *terminal* outcomes only: a workspace is recorded
///   (and not retried this run) once its install succeeds OR fails terminally
///   (`InsecureAcl` — a redirected/synced path that will never become safe).
///   A *transient* failure (`Locked` / `SchemaDrift` / `Failed` / error) is left
///   OUT of the set so the next tick self-heals a momentary glitch. New paths
///   are attempted as they appear. The manual "Re-scan workspaces" button
///   deliberately bypasses this guard (it force-reinstalls everything).
///
/// Returns the number of workspaces successfully installed this pass.
///
/// The loop itself lives in `heal_pass_inner` — this is the shell that loads
/// meta, scans, delegates (handing the loop a closure that lazily resolves the
/// credential and writes), and persists meta. Everything below the shell's disk
/// and keychain dependencies is unit-tested there (#1112).
#[cfg(target_os = "windows")]
fn cowork_heal_pass() -> Result<usize, String> {
    use std::cell::OnceCell;
    use std::collections::BTreeSet;
    use std::path::Path;

    use cowork_installer::{install_tandem_plugin_into_workspace, resolve_tandem_url, WriteStatus};
    use cowork_workspace_scan::find_cowork_workspaces;

    static HEAL_ATTEMPTED: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());

    let meta = cowork_meta::load().map_err(|e| e.to_string())?;
    if !meta.enabled {
        return Ok(0);
    }

    // Read-only snapshot of the attempt set; the heal pass is a single serialized
    // interval task, so no concurrent pass races this — and manual rescan never
    // touches HEAL_ATTEMPTED.
    let attempted: BTreeSet<PathBuf> = {
        let guard = HEAL_ATTEMPTED.lock().unwrap_or_else(|p| p.into_inner());
        guard.clone()
    };

    // Credentials are resolved LAZILY, inside the installer closure, and only
    // once per pass. This PRESERVES a property the pre-refactor shell already
    // had for free — there, the token fetch sat physically below both early
    // returns, so an enabled-but-idle tick never reached it. Moving the
    // precheck into `heal_pass_inner` removes that positional guarantee, and
    // the `OnceCell` is what puts it back; this is not repairing a live bug.
    //
    // It matters because `get_or_create_token` is NOT a pure keychain read:
    // with no token stored it mints one and persists it (keyring
    // `set_password`, or the env-paths file), and it can fail outright on a
    // broken keyring. Forcing it up here would make the idle steady state both
    // a potential write and a fallible operation, turning a silent `Ok(0)`
    // into a "[cowork] heal pass failed" log on every 5-minute tick.
    // A failure is therefore scoped to the workspace that needed it, as a
    // transient `Failed` (left out of the attempt set, retried next tick).
    let credentials: OnceCell<Result<(String, String), String>> = OnceCell::new();

    let (installed, terminal) =
        heal_pass_inner(find_cowork_workspaces(), &attempted, |ws: &Path| {
            let creds = match credentials.get_or_init(|| {
                token_store::get_or_create_token().map(|t| (t, resolve_tandem_url(&meta)))
            }) {
                Ok(creds) => creds,
                Err(e) => {
                    log::warn!(
                        "[cowork] heal: no token available, skipping {}: {e}",
                        ws.display()
                    );
                    return WriteStatus::Failed(e.clone());
                }
            };
            match install_tandem_plugin_into_workspace(ws, &creds.0, &creds.1) {
                Ok(report) => report.installed_plugins,
                Err(e) => {
                    log::warn!("[cowork] heal: install into {} errored: {e}", ws.display());
                    // Treat an error as a transient Failed so it retries next tick.
                    WriteStatus::Failed(e.to_string())
                }
            }
        });

    // Record only terminal outcomes — transient failures stay retryable.
    if !terminal.is_empty() {
        let mut attempted = HEAL_ATTEMPTED.lock().unwrap_or_else(|p| p.into_inner());
        attempted.extend(terminal);
    }

    if installed > 0 {
        if let Err(e) = cowork_meta::update(|m| {
            m.workspaces_last_scanned_at = Some(iso_now());
        }) {
            log::warn!("[cowork] heal: failed to persist meta: {e}");
        }
    }

    Ok(installed)
}

/// The heal pass's find -> filter -> classify -> terminal-mark loop, with the
/// keychain and the registry write injected as `install`.
///
/// Split out of `cowork_heal_pass` so the orchestration is unit-testable (#1112):
/// the shell's `cowork_meta::load()` reads env-paths disk and its `install`
/// closure resolves `token_store::get_or_create_token()` against the OS keychain,
/// neither of which is overridable. Because the credential lives behind `install`
/// (lazily, via a `OnceCell` the shell only forces from inside it), a pass that
/// installs nothing never reaches the keychain: the two early returns below are
/// what keep the steady state a pure read. `attempted` is taken as a borrowed set
/// rather than read from the caller's process-wide static, so tests need no
/// ordering lock.
///
/// Returns `(installed_count, newly_terminal_workspaces)`. The caller — and only
/// the caller — folds the returned paths into its attempt set: marking inside
/// the loop is what poisoned transient failures in #1110 (see lessons-learned
/// lesson 81), so a `Locked` / `SchemaDrift` / `Failed` workspace must come back
/// out of here unmarked and be retried on the next tick.
#[cfg(target_os = "windows")]
fn heal_pass_inner(
    workspaces: Vec<PathBuf>,
    attempted: &std::collections::BTreeSet<PathBuf>,
    install: impl Fn(&std::path::Path) -> cowork_installer::WriteStatus,
) -> (usize, Vec<PathBuf>) {
    use cowork_installer::{heal_outcome_is_terminal, workspace_has_tandem_entry, WriteStatus};

    // Read-only precheck: which workspaces lack a tandem entry?
    let missing: Vec<PathBuf> = workspaces
        .into_iter()
        .filter(|ws| !workspace_has_tandem_entry(ws))
        .collect();
    if missing.is_empty() {
        return (0, Vec::new());
    }

    // Skip workspaces already terminally attempted this run.
    let to_attempt: Vec<PathBuf> = missing
        .into_iter()
        .filter(|ws| !attempted.contains(ws))
        .collect();
    if to_attempt.is_empty() {
        return (0, Vec::new());
    }

    let mut installed = 0usize;
    let mut terminal: Vec<PathBuf> = Vec::new();
    for ws in &to_attempt {
        let status = install(ws.as_path());
        match &status {
            WriteStatus::Ok | WriteStatus::AlreadyPresent => installed += 1,
            other => log::warn!(
                "[cowork] heal: install into {} not successful: {other:?}",
                ws.display()
            ),
        }
        if heal_outcome_is_terminal(&status) {
            terminal.push(ws.clone());
        }
    }

    (installed, terminal)
}

/// Tests for the Cowork heal-pass loop orchestration (#1112): no-op when there
/// is nothing to scan, no-op when every workspace is already configured (or was
/// already attempted), install-on-missing, and terminal-only attempt marking.
///
/// Windows-gated, like everything they exercise (`cowork_installer` is
/// `#![cfg(target_os = "windows")]`), so they compile — and run — only on the
/// windows-latest leg of ci.yml's `rust-test` matrix. A green `cargo test` on
/// Linux does not mean these ran; it means they did not exist.
///
/// No env lock is needed: `heal_pass_inner` reads only the paths it is handed
/// and the borrowed attempt set, never `HEAL_ATTEMPTED` or the scan roots.
#[cfg(all(test, target_os = "windows"))]
mod cowork_heal_pass_tests {
    use super::*;
    use crate::cowork_installer::WriteStatus;
    use std::cell::RefCell;
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::{Path, PathBuf};
    use tempfile::TempDir;

    /// Create a workspace dir under `root`; when `configured`, give it the
    /// `installed_plugins.json` entry `workspace_has_tandem_entry` looks for.
    fn make_ws(root: &Path, name: &str, configured: bool) -> PathBuf {
        let ws = root.join(name);
        let plugins = ws.join("cowork_plugins");
        fs::create_dir_all(&plugins).unwrap();
        if configured {
            fs::write(
                plugins.join("installed_plugins.json"),
                r#"{"mcpServers":{"tandem":{"type":"stdio"}}}"#,
            )
            .unwrap();
        }
        ws
    }

    #[test]
    fn inner_no_ops_when_there_is_nothing_to_scan() {
        // The `!meta.enabled` guard itself lives in the shell (it needs
        // `cowork_meta::load`), and a disabled pass never reaches a scan — so the
        // delegated shape is an empty workspace list. Nothing installed, nothing
        // marked, and the injected install is never called: no keychain, no writes.
        let calls = RefCell::new(Vec::new());
        let attempted = BTreeSet::new();
        let (installed, terminal) = heal_pass_inner(Vec::new(), &attempted, |ws: &Path| {
            calls.borrow_mut().push(ws.to_path_buf());
            WriteStatus::Ok
        });

        assert_eq!(installed, 0);
        assert!(terminal.is_empty());
        assert!(
            calls.borrow().is_empty(),
            "install must not run with no workspaces"
        );
    }

    #[test]
    fn inner_no_ops_when_every_workspace_is_already_configured() {
        // The steady state: the read-only precheck finds nothing missing, so the
        // pass stays a pure read. `install` never being called is the whole
        // invariant — the shell resolves the token lazily from inside it, so an
        // uncalled `install` means no keychain access and no token minted either.
        let dir = TempDir::new().unwrap();
        let a = make_ws(dir.path(), "a", true);
        let b = make_ws(dir.path(), "b", true);

        let calls = RefCell::new(Vec::new());
        let attempted = BTreeSet::new();
        let (installed, terminal) = heal_pass_inner(vec![a, b], &attempted, |ws: &Path| {
            calls.borrow_mut().push(ws.to_path_buf());
            WriteStatus::Ok
        });

        assert_eq!(installed, 0);
        assert!(terminal.is_empty());
        assert!(
            calls.borrow().is_empty(),
            "steady state must not write anything"
        );
    }

    #[test]
    fn inner_no_ops_when_every_missing_workspace_was_already_attempted() {
        // Second early return: the workspace lacks its entry but was terminally
        // attempted this run, so it is not retried.
        let dir = TempDir::new().unwrap();
        let missing = make_ws(dir.path(), "attempted", false);

        let mut attempted = BTreeSet::new();
        attempted.insert(missing.clone());

        let calls = RefCell::new(Vec::new());
        let (installed, terminal) = heal_pass_inner(vec![missing], &attempted, |ws: &Path| {
            calls.borrow_mut().push(ws.to_path_buf());
            WriteStatus::Ok
        });

        assert_eq!(installed, 0);
        assert!(terminal.is_empty());
        assert!(
            calls.borrow().is_empty(),
            "a terminally attempted workspace must not be reinstalled"
        );
    }

    #[test]
    fn inner_installs_only_into_unconfigured_unattempted_workspaces() {
        let dir = TempDir::new().unwrap();
        let configured = make_ws(dir.path(), "configured", true);
        let already_tried = make_ws(dir.path(), "already-tried", false);
        let fresh = make_ws(dir.path(), "fresh", false);

        let mut attempted = BTreeSet::new();
        attempted.insert(already_tried.clone());

        let calls = RefCell::new(Vec::new());
        let (installed, terminal) = heal_pass_inner(
            vec![configured, already_tried, fresh.clone()],
            &attempted,
            |ws: &Path| {
                calls.borrow_mut().push(ws.to_path_buf());
                WriteStatus::Ok
            },
        );

        assert_eq!(installed, 1);
        assert_eq!(terminal, vec![fresh.clone()]);
        assert_eq!(*calls.borrow(), vec![fresh]);
    }

    #[test]
    fn inner_marks_only_terminal_outcomes_so_transient_failures_retry() {
        // The #1110 regression (lessons-learned lesson 81): marking every touched
        // workspace instead of gating on `heal_outcome_is_terminal` poisons a
        // momentary Locked/SchemaDrift/Failed, so the next tick never retries it.
        // Terminal = Ok | AlreadyPresent | InsecureAcl, and nothing else.
        fn outcome(ws: &Path) -> WriteStatus {
            match ws.file_name().unwrap().to_str().unwrap() {
                "ok" => WriteStatus::Ok,
                "present" => WriteStatus::AlreadyPresent,
                "acl" => WriteStatus::InsecureAcl,
                "locked" => WriteStatus::Locked,
                "drift" => WriteStatus::SchemaDrift,
                _ => WriteStatus::Failed("io".into()),
            }
        }

        let dir = TempDir::new().unwrap();
        let ok = make_ws(dir.path(), "ok", false);
        let present = make_ws(dir.path(), "present", false);
        let acl = make_ws(dir.path(), "acl", false);
        let locked = make_ws(dir.path(), "locked", false);
        let drift = make_ws(dir.path(), "drift", false);
        let failed = make_ws(dir.path(), "failed", false);
        let all = vec![
            ok.clone(),
            present.clone(),
            acl.clone(),
            locked.clone(),
            drift.clone(),
            failed.clone(),
        ];

        let attempted = BTreeSet::new();
        let (installed, terminal) = heal_pass_inner(all.clone(), &attempted, outcome);

        // Only the two successes count as installed — InsecureAcl is terminal but
        // is not an install.
        assert_eq!(installed, 2);
        assert_eq!(terminal, vec![ok, present, acl]);
        for retryable in [&locked, &drift, &failed] {
            assert!(
                !terminal.contains(retryable),
                "{} is a transient failure and must stay retryable",
                retryable.display()
            );
        }

        // Next tick: fold the returned terminal set in (what the shell does) and
        // re-run. Exactly the three transient workspaces are attempted again.
        let attempted: BTreeSet<PathBuf> = terminal.into_iter().collect();
        let calls = RefCell::new(Vec::new());
        let (installed, terminal) = heal_pass_inner(all, &attempted, |ws: &Path| {
            calls.borrow_mut().push(ws.to_path_buf());
            outcome(ws)
        });

        assert_eq!(installed, 0);
        assert!(terminal.is_empty());
        assert_eq!(*calls.borrow(), vec![locked, drift, failed]);
    }
}

/// Get the current Cowork integration status.
#[cfg(target_os = "windows")]
#[tauri::command]
fn cowork_get_status() -> Result<serde_json::Value, String> {
    use cowork_workspace_scan::{claude_desktop_detected, find_cowork_workspaces_with_stats};

    let meta = cowork_meta::load().map_err(|e| e.to_string())?;
    let (workspace_paths, scan_stats) = find_cowork_workspaces_with_stats();
    let cowork_detected = !workspace_paths.is_empty();
    // Claude Desktop install signal, independent of workspace existence —
    // lets the UI distinguish "no Claude at all" from "Claude present, Cowork
    // never run yet" and from "sessions found but blocked by the path guard"
    // (redirected/synced AppData). Existence checks only; read-only.
    let claude_detected = claude_desktop_detected();

    // Build a workspace status array compatible with the TypeScript WorkspaceStatus[]
    // type declared in PR f.  This is a read-only status check — no writes, no ACL
    // checks, no firewall operations.
    // When the integration is not enabled, an absent entry is the expected
    // "not yet set up" state — not a failure. Reporting "failed" for writes that
    // were never attempted is misleading (the enable flow aborts before any
    // plugin write when the firewall step can't run). Only call a missing entry
    // "failed" once the user has actually enabled the integration.
    let absent_status = if meta.enabled { "failed" } else { "notConfigured" };

    let workspaces: Vec<serde_json::Value> = workspace_paths
        .iter()
        .map(|ws_path| {
            // Extract workspace_id (grandparent leaf) and vm_id (leaf).
            let vm_id = ws_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let workspace_id = ws_path
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();

            // Read-only check: does installed_plugins.json contain a tandem entry?
            let installed_status = if cowork_installer::workspace_has_tandem_entry(ws_path) {
                "ok"
            } else {
                absent_status
            };

            // Read-only check: does known_marketplaces.json exist?
            let marketplaces_file = ws_path.join("cowork_plugins").join("known_marketplaces.json");
            let marketplaces_status = if marketplaces_file.exists() {
                match std::fs::read_to_string(&marketplaces_file)
                    .ok()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                {
                    Some(_) => "ok",
                    _ => "failed",
                }
            } else {
                absent_status
            };

            // Read-only check: does cowork_settings.json exist?
            let settings_file = ws_path.join("cowork_plugins").join("cowork_settings.json");
            let cowork_settings_status = if settings_file.exists() {
                match std::fs::read_to_string(&settings_file)
                    .ok()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                {
                    Some(_) => "ok",
                    _ => "failed",
                }
            } else {
                absent_status
            };

            serde_json::json!({
                "workspaceId": workspace_id,
                "vmId": vm_id,
                "path": ws_path.to_string_lossy(),
                "installedPlugins": installed_status,
                "knownMarketplaces": marketplaces_status,
                "coworkSettings": cowork_settings_status,
            })
        })
        .collect();

    Ok(serde_json::json!({
        "enabled": meta.enabled,
        "vethernetCidr": meta.vethernet_cidr_detected,
        "lanIpFallback": meta.lan_ip_fallback,
        "useLanIpOverride": meta.use_lan_ip_override,
        "workspacesLastScannedAt": meta.workspaces_last_scanned_at,
        "uacDeclined": meta.uac_declined_last_attempt,
        "uacDeclinedAt": meta.uac_declined_at,
        "workspaces": workspaces,
        "coworkDetected": cowork_detected,
        "claudeDesktopDetected": claude_detected,
        "workspacesBlocked": scan_stats.rejected_by_guard,
        "osSupported": true,
    }))
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cowork_get_status() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "osSupported": false,
        "enabled": false,
        "coworkDetected": false,
        "claudeDesktopDetected": false,
        "workspacesBlocked": 0,
        "workspaces": [],
        "vethernetCidr": null,
        "lanIpFallback": null,
        "useLanIpOverride": false,
        "uacDeclined": false,
        "uacDeclinedAt": null,
    }))
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
    firewall::detect_vethernet_subnet()
        .map_err(|e| serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()))
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
    let total = reports.len();
    let success = reports.iter().filter(|r| matches!(
        r.installed_plugins,
        cowork_installer::WriteStatus::Ok | cowork_installer::WriteStatus::AlreadyPresent
    )).count();

    if total > 0 && success == 0 {
        let failure_summary: Vec<String> = reports.iter().map(|r| {
            format!("{}/{}: {:?}", r.workspace_id, r.vm_id, r.installed_plugins)
        }).collect();
        return Err(format!(
            "Cowork apply-token failed: all {total} workspace(s) failed. Failures: {}",
            failure_summary.join("; ")
        ));
    }
    if success < total {
        log::warn!("[cowork] apply-token partial: {success}/{total} workspace(s) succeeded");
    }
    Ok(format!("Cowork: {success} workspace(s) re-walked with new token"))
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cowork_apply_token(_token: String) -> Result<String, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Resolve a snapshot handle token to its validated canonical workspace path.
///
/// Closes the TOCTOU window (issue #433): instead of re-scanning the filesystem
/// and trusting a caller-supplied string, the token can only name a path that
/// `cowork_scan_workspaces` already validated this session. The resolved path is
/// then re-run through the four-layer guard (`revalidate_resolved_path`) to
/// catch a directory swapped *after* the scan. An unknown token — forged, or
/// from a superseded scan — is rejected with no file I/O. The re-validation's
/// specific rejection reason is preserved (single informative message, not
/// re-flattened) for incident triage.
#[cfg(target_os = "windows")]
fn cowork_resolve_validated_handle(handle: &str, op: &str) -> Result<std::path::PathBuf, String> {
    let Some(resolved) = cowork_workspace_scan::resolve_handle(handle) else {
        log::warn!(
            "[cowork] {op}: unknown workspace handle — rejected (no current scan token matches)"
        );
        return Err("Unknown or expired workspace handle — re-scan and try again".to_string());
    };

    // Defense-in-depth: re-run the four-layer guard against the stored path to
    // catch a post-scan swap (directory replaced with a junction, moved, etc.).
    cowork_workspace_scan::revalidate_resolved_path(&resolved).map_err(|reason| {
        log::warn!("[cowork] {op}: resolved handle failed re-validation — rejected: {reason}");
        reason
    })
}

/// Install the Tandem plugin into a specific workspace, named by an opaque
/// snapshot handle from `cowork_scan_workspaces`.
///
/// The handle resolves — in-process — to the exact canonical path validated at
/// scan time, which is re-checked against invariant §3 before any file I/O (§9).
/// A caller-supplied path string is never trusted; an unknown handle is rejected.
#[cfg(target_os = "windows")]
#[tauri::command]
fn cowork_install_into_workspace(handle: String) -> Result<String, String> {
    use cowork_installer::{install_tandem_plugin_into_workspace, resolve_tandem_url};

    let validated_path = cowork_resolve_validated_handle(&handle, "cowork_install_into_workspace")?;

    let token = token_store::get_or_create_token()?;
    let meta = cowork_meta::load().map_err(|e| e.to_string())?;
    let tandem_url = resolve_tandem_url(&meta);

    let report = install_tandem_plugin_into_workspace(&validated_path, &token, &tandem_url)
        .map_err(|e| e.to_string())?;

    Ok(serde_json::to_string(&report).map_err(|e| e.to_string())?)
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cowork_install_into_workspace(_handle: String) -> Result<String, String> {
    Err(WINDOWS_ONLY_ERR.into())
}

/// Uninstall the Tandem plugin from a specific workspace, named by an opaque
/// snapshot handle from `cowork_scan_workspaces`. See
/// [`cowork_install_into_workspace`] for the handle contract.
#[cfg(target_os = "windows")]
#[tauri::command]
fn cowork_uninstall_from_workspace(handle: String) -> Result<String, String> {
    let validated_path =
        cowork_resolve_validated_handle(&handle, "cowork_uninstall_from_workspace")?;

    let report = cowork_installer::uninstall_tandem_plugin_from_workspace(&validated_path)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::to_string(&report).map_err(|e| e.to_string())?)
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cowork_uninstall_from_workspace(_handle: String) -> Result<String, String> {
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
        let workspaces = find_cowork_workspaces();

        let reports: Vec<_> = workspaces
            .iter()
            .map(|ws| install_tandem_plugin_into_workspace(ws, &token, &tandem_url))
            .collect();

        let errors: Vec<_> = reports.iter().filter_map(|r| r.as_ref().err()).collect();
        if !errors.is_empty() {
            log::warn!("[cowork] set_lan_ip_override: {} re-walk error(s): {:?}", errors.len(), errors);
        }

        if !workspaces.is_empty() {
            let success_count = reports.iter().filter(|r| {
                match r {
                    Ok(report) => matches!(
                        report.installed_plugins,
                        cowork_installer::WriteStatus::Ok | cowork_installer::WriteStatus::AlreadyPresent
                    ),
                    Err(_) => false,
                }
            }).count();

            if success_count == 0 {
                let failure_summary: Vec<String> = reports.iter().map(|r| match r {
                    Ok(report) => format!("{}/{}: {:?}", report.workspace_id, report.vm_id, report.installed_plugins),
                    Err(e) => e.to_string(),
                }).collect();
                return Err(format!(
                    "LAN IP override applied to meta but re-walk failed: all {} workspace(s) failed. Failures: {}",
                    workspaces.len(),
                    failure_summary.join("; ")
                ));
            }

            if success_count < workspaces.len() {
                log::warn!("[cowork] set_lan_ip_override partial: {}/{} workspace(s) succeeded", success_count, workspaces.len());
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

// The "no AI client detected" nudge (formerly show_no_claude_dialog) moved into
// the integration wizard's connect step in #477 PR 3c-ii-c — transport-agnostic
// (covers npm-browser too) and no longer gated on the deleted /api/setup
// round-trip. (The wizard's "Install Claude Code" empty state, added by #1084,
// now owns that surface; its testid retains the legacy `-step-detect` name.)
// See src/client/components/IntegrationWizardModal.svelte.

/// Prompt the user to install an available update. Returns true if they accept.
/// This is intentionally a sync `fn`, NOT `async fn` — `blocking_show()` blocks
/// the calling thread waiting for the OS dialog. This is safe because:
/// 1. Tauri uses a multi-threaded Tokio runtime (default)
/// 2. This is only called from spawned async tasks, never the main thread
/// Do NOT make this async — `blocking_show()` on an async runtime thread will deadlock.
fn show_update_available_dialog(app: &tauri::AppHandle, version: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let mut builder = app
        .dialog()
        .message(format!(
            "Tandem v{version} is available.\n\n\
             Would you like to update now? The application will restart after installing."
        ))
        .title("Update Available")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancel);
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        builder = builder.parent(&window);
    } else {
        log::warn!("show_update_available_dialog: main window not found — dialog will appear parentless");
    }
    builder.blocking_show()
}

/// Inform the user they're on the latest version (manual check feedback).
fn show_up_to_date_dialog(app: &tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

    let mut builder = app
        .dialog()
        .message(format!(
            "You're running the latest version of Tandem (v{}).",
            env!("CARGO_PKG_VERSION")
        ))
        .title("No Updates Available")
        .kind(MessageDialogKind::Info);
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        builder = builder.parent(&window);
    } else {
        log::warn!("show_up_to_date_dialog: main window not found — dialog will appear parentless");
    }
    builder.show(|_| {});
}

/// Show an error dialog for failed update checks (manual check feedback only).
fn show_update_error_dialog(app: &tauri::AppHandle, error: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

    let mut builder = app
        .dialog()
        .message(format!(
            "Could not check for updates.\n\n\
             Error: {error}\n\n\
             Please try again later or check your internet connection."
        ))
        .title("Update Error")
        .kind(MessageDialogKind::Error);
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        builder = builder.parent(&window);
    } else {
        log::warn!("show_update_error_dialog: main window not found — dialog will appear parentless");
    }
    builder.show(|_| {});
}

/// Check for updates and optionally prompt the user.
/// `manual` controls whether the user gets feedback on "no update" / error.
/// Subset of `GET /api/license/status` the updater needs. Keys are camelCase on
/// the wire (see src/server/mcp/routes/license.ts); `#[serde(default)]` keeps a
/// scrubbed/partial body from failing deserialization.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LicenseStatusResponse {
    #[serde(default)]
    gate_active: bool,
    #[serde(default)]
    license_id: Option<String>,
    #[serde(default)]
    update_window_current: bool,
}

/// Ask the sidecar (loopback) whether update checks should route through the
/// license-gated Worker. Returns `Some(license_id)` ONLY when a Worker endpoint
/// is configured AND the gate is active AND the license's update window is
/// current. Every other case (no endpoint, gate dark, trial, restricted,
/// expired window, sidecar unreachable, scrubbed body) falls back to `None` ⇒
/// the default public endpoint. Never errors — update checks must not depend on
/// the license probe succeeding.
async fn entitled_license_id(app: &tauri::AppHandle) -> Option<String> {
    if LICENSE_UPDATE_ENDPOINT.is_empty() {
        return None;
    }
    let client = app.try_state::<reqwest::Client>()?.inner().clone();
    let resp = client.get(LICENSE_STATUS_URL).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let status: LicenseStatusResponse = resp.json().await.ok()?;
    if status.gate_active && status.update_window_current {
        status.license_id
    } else {
        None
    }
}

/// Build the updater, routing through the license-gated Worker (with the opaque
/// license-id header) when the device is entitled, else the default public
/// endpoint from `tauri.conf.json`. Both `check_for_update` and `install_update`
/// go through this so check + install agree on the source (#1116, ADR-040 §7).
async fn build_updater(app: &tauri::AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    match entitled_license_id(app).await {
        Some(lid) => {
            let endpoint = Url::parse(LICENSE_UPDATE_ENDPOINT)
                .map_err(|e| format!("Invalid license update endpoint: {e}"))?;
            app.updater_builder()
                .endpoints(vec![endpoint])
                .map_err(|e| e.to_string())?
                .header("X-Tandem-License-Id", lid)
                .map_err(|e| e.to_string())?
                .build()
                .map_err(|e| e.to_string())
        }
        None => app.updater().map_err(|e| e.to_string()),
    }
}

async fn check_for_update(app: &tauri::AppHandle, manual: bool) {
    let updater = match build_updater(app).await {
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

    // Auto-check path (D6 locked decision): surface as an in-app banner via the
    // updater event channel rather than blocking the user with a native dialog.
    // The "Restart to install" CTA invokes `install_update` to kick off the
    // download+install flow below. Manual checks (tray menu) keep the dialog so
    // the user gets immediate feedback on their explicit action.
    if !manual {
        match app.emit(
            "tandem://update-available",
            serde_json::json!({ "version": version }),
        ) {
            Ok(()) => return,
            Err(e) => {
                // Emit failure leaves the banner with no signal to render
                // against, so the user would see nothing for a known-available
                // update. Fall through to the native dialog as a visible
                // fallback — the same one the manual-check path uses below.
                // Security note: `update.version` is signature-verified by
                // tauri-plugin-updater before reaching this point, so it's
                // safe to display.
                log::warn!(
                    "Failed to emit update-available event: {e}; falling back to dialog",
                );
            }
        }
    }

    if !show_update_available_dialog(app, &version) {
        log::info!("User declined update to v{version}");
        return;
    }

    perform_install(app, update, &version).await;
}

/// Tauri command — invoked by the in-app updater banner's "Restart to install"
/// CTA. Re-runs `updater.check()` (so we always operate on the most recent
/// release the server advertises) and dispatches the install flow.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = build_updater(&app)
        .await
        .map_err(|e| format!("Updater not configured: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Update check failed: {e}"))?
        .ok_or_else(|| "No update available".to_string())?;
    let version = update.version.clone();
    perform_install(&app, update, &version).await;
    Ok(())
}

/// Shared install flow: kill sidecar, await port + file-lock release, then
/// download+install via the Tauri updater plugin. On success the application
/// is restarted; on failure a native dialog surfaces the error.
async fn perform_install(
    app: &tauri::AppHandle,
    update: tauri_plugin_updater::Update,
    version: &str,
) {
    // Stop sidecar BEFORE install — on Windows, the NSIS installer runs during
    // download_and_install() and needs to replace node-sidecar.exe on disk.
    // If the process is still running, the file is locked and install fails.
    // Graceful first (#1088): POST /api/shutdown flushes dirty docs + saves
    // the session before the app restarts into the new version; hard kill is
    // the fallback on POST failure or timeout.
    let client = app.state::<reqwest::Client>().inner().clone();
    stop_sidecar_gracefully(app, &client, GRACEFUL_SHUTDOWN_DEADLINE_SECS).await;

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

#[cfg(test)]
mod pending_opens_tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Mutex;

    // Serialize tests that mutate SIDECAR_HEALTHY (a process-wide static).
    static FLAG_LOCK: Mutex<()> = Mutex::new(());

    fn fresh_state() -> PendingOpens {
        PendingOpens(Mutex::new(Vec::new()))
    }

    #[test]
    fn promote_healthy_and_drain_returns_fifo_and_clears_queue() {
        let _g = FLAG_LOCK.lock().unwrap();
        SIDECAR_HEALTHY.store(false, Ordering::Release);

        let state = fresh_state();
        state.0.lock().unwrap().push(PathBuf::from("a"));
        state.0.lock().unwrap().push(PathBuf::from("b"));
        state.0.lock().unwrap().push(PathBuf::from("c"));

        let drained = promote_healthy_and_drain(&state);
        assert_eq!(
            drained,
            vec![PathBuf::from("a"), PathBuf::from("b"), PathBuf::from("c")],
            "drain order should match push order"
        );
        assert!(state.0.lock().unwrap().is_empty(), "queue should be cleared");
        assert!(
            SIDECAR_HEALTHY.load(Ordering::Acquire),
            "SIDECAR_HEALTHY should be flipped to true"
        );

        // Reset for other tests.
        SIDECAR_HEALTHY.store(false, Ordering::Release);
    }

    #[test]
    fn promote_healthy_and_drain_on_empty_queue_still_flips_flag() {
        let _g = FLAG_LOCK.lock().unwrap();
        SIDECAR_HEALTHY.store(false, Ordering::Release);

        let state = fresh_state();
        let drained = promote_healthy_and_drain(&state);
        assert!(drained.is_empty());
        assert!(SIDECAR_HEALTHY.load(Ordering::Acquire));

        SIDECAR_HEALTHY.store(false, Ordering::Release);
    }

    #[test]
    fn try_queue_or_post_queues_when_unhealthy() {
        let _g = FLAG_LOCK.lock().unwrap();
        SIDECAR_HEALTHY.store(false, Ordering::Release);

        let state = fresh_state();
        let result = try_queue_or_post(&state, PathBuf::from("queued"));
        assert!(result.is_ok());
        assert_eq!(
            *state.0.lock().unwrap(),
            vec![PathBuf::from("queued")],
            "path should be in queue"
        );
    }

    #[test]
    fn try_queue_or_post_returns_path_when_healthy() {
        let _g = FLAG_LOCK.lock().unwrap();
        SIDECAR_HEALTHY.store(true, Ordering::Release);

        let state = fresh_state();
        let result = try_queue_or_post(&state, PathBuf::from("direct"));
        assert_eq!(
            result,
            Err(PathBuf::from("direct")),
            "caller should be handed back the path to POST directly"
        );
        assert!(state.0.lock().unwrap().is_empty(), "no queue side effect");

        SIDECAR_HEALTHY.store(false, Ordering::Release);
    }

    #[test]
    fn restart_clears_flag_under_lock_so_late_producer_queues() {
        // Inverse of drain_then_late_producer_under_lock_sees_healthy_flag:
        // restart_sidecar clears SIDECAR_HEALTHY via clear_healthy_under_lock.
        // A producer that races the clear can only mutate state while
        // holding the same mutex; once it does, it observes flag=false (set
        // inside the same lock by the clear) and queues the path. A bare
        // atomic store outside the lock would let a producer that read
        // flag=true before kill_sidecar still POST to the dying server.
        let _g = FLAG_LOCK.lock().unwrap();
        SIDECAR_HEALTHY.store(true, Ordering::Release);

        let state = fresh_state();

        // Simulate the locked clear that restart_sidecar performs.
        clear_healthy_under_lock(&state);

        // Late producer arriving after the clear observes flag=false and
        // queues the path instead of POSTing.
        let result = try_queue_or_post(&state, PathBuf::from("after-restart"));
        assert_eq!(result, Ok(()));
        assert_eq!(
            *state.0.lock().unwrap(),
            vec![PathBuf::from("after-restart")]
        );

        SIDECAR_HEALTHY.store(false, Ordering::Release);
    }

    #[test]
    fn drain_then_late_producer_under_lock_sees_healthy_flag() {
        // Reproduces the lock-ordering proof: after the consumer drains and
        // flips the flag, a subsequent producer that acquires the same lock
        // observes flag=true and returns Err(path) for direct-POST. No path
        // can be orphaned in the queue.
        let _g = FLAG_LOCK.lock().unwrap();
        SIDECAR_HEALTHY.store(false, Ordering::Release);

        let state = fresh_state();
        state.0.lock().unwrap().push(PathBuf::from("early"));

        // Consumer side.
        let drained = promote_healthy_and_drain(&state);
        assert_eq!(drained, vec![PathBuf::from("early")]);

        // Late producer that read flag=false BEFORE the consumer ran can only
        // mutate the queue while holding the lock; once it does, it sees
        // flag=true (set inside the same lock) and the helper hands the path
        // back instead of queuing it.
        let result = try_queue_or_post(&state, PathBuf::from("late"));
        assert_eq!(result, Err(PathBuf::from("late")));
        assert!(state.0.lock().unwrap().is_empty());

        SIDECAR_HEALTHY.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod url_constants_tests {
    use super::*;

    // Regression guard for #477 PR 2 + #637 + #686. The server's isHostAllowed
    // gate (api-routes.ts) rejects bare `localhost` Host headers; if these
    // constants drift back to `http://localhost:…`, the supervisor's
    // health-poll 403's for 15s and `npm run dev:tauri` reports
    // "Server failed to start after 3 restart attempts".
    #[test]
    fn supervisor_urls_use_loopback_ip_not_localhost() {
        for (name, url) in [
            ("HEALTH_URL", HEALTH_URL),
            ("OPEN_URL", OPEN_URL),
            ("LAUNCHER_NONCE_URL", LAUNCHER_NONCE_URL),
            ("LAUNCHER_START_URL", LAUNCHER_START_URL),
        ] {
            assert!(
                url.starts_with("http://127.0.0.1:"),
                "{name} must use 127.0.0.1 (got {url}) — see #477 PR 2"
            );
        }
    }
}

#[cfg(test)]
mod reveal_command_tests {
    use super::*;

    // Issue #299 — "Show in file explorer". The actual OS reveal cannot be
    // verified in CI; these tests assert only that the per-OS argument vector
    // is constructed correctly (the security-relevant part: the path is always
    // a discrete argv element appended to a fixed literal, never shell-spliced).

    #[test]
    fn windows_selects_the_file_with_single_select_arg() {
        // Explorer's documented contract is `/select,<path>` as ONE argv
        // element — splitting `/select,` and the path into two args makes
        // Explorer open the parent folder without selecting the file.
        let (program, args) = reveal_command_args(r"C:\Users\me\notes.md", "windows");
        assert_eq!(program, "explorer");
        assert_eq!(args, vec![r"/select,C:\Users\me\notes.md".to_string()]);
    }

    #[test]
    fn macos_reveals_the_file_with_dash_r() {
        let (program, args) = reveal_command_args("/Users/me/notes.md", "macos");
        assert_eq!(program, "open");
        assert_eq!(args, vec!["-R".to_string(), "/Users/me/notes.md".to_string()]);
    }

    #[test]
    fn linux_opens_the_containing_directory() {
        // No portable reveal verb on Linux — open the parent dir instead.
        let (program, args) = reveal_command_args("/home/me/notes.md", "linux");
        assert_eq!(program, "xdg-open");
        assert_eq!(args, vec!["/home/me".to_string()]);
    }

    #[test]
    fn linux_falls_back_to_path_when_no_parent() {
        // A bare filename with no directory component has no parent → use the
        // path as-is rather than passing an empty string to xdg-open.
        let (program, args) = reveal_command_args("notes.md", "freebsd");
        assert_eq!(program, "xdg-open");
        assert_eq!(args, vec!["notes.md".to_string()]);
    }

    #[test]
    fn path_is_never_shell_spliced_into_one_token() {
        // Defense-in-depth: a path containing shell metacharacters stays a
        // single, opaque argv element on macOS — it is data, not a command.
        let nasty = "/Users/me/$(rm -rf ~) file.md";
        let (_program, args) = reveal_command_args(nasty, "macos");
        assert_eq!(args, vec!["-R".to_string(), nasty.to_string()]);
    }
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

    // --- A6/A8: native_theme_outcome, composed with native_theme_action
    // exactly as set_native_theme's body does — the wiring seam for the
    // command itself, which needs a live WebviewWindow and can't be
    // unit-tested directly. ---

    #[test]
    fn outcome_macos_explicit_theme_overrides_and_skips_readback() {
        let action = native_theme_action("dark", false, NativeHost::MacOs);
        let mut read_called = false;
        let outcome = native_theme_outcome(action, || {
            read_called = true;
            Some("dark".to_string())
        });
        assert!(outcome.override_active);
        assert_eq!(outcome.os_theme, None);
        assert!(
            !read_called,
            "osTheme must never be sourced from a read that could echo our own forced theme"
        );
    }

    #[test]
    fn outcome_macos_system_releases_and_reads_authoritatively() {
        let action = native_theme_action("system", false, NativeHost::MacOs);
        let outcome = native_theme_outcome(action, || Some("dark".to_string()));
        assert!(!outcome.override_active);
        assert_eq!(outcome.os_theme, Some("dark".to_string()));
    }

    #[test]
    fn outcome_windows_never_reports_override_active_for_any_pref() {
        // Windows never calls set_theme, so window.theme() stays honest
        // regardless of which AppMode was forced — overrideActive must be
        // false for every pref, matching the platform contract table.
        for pref in ["dark", "light", "warm", "system", "bogus"] {
            let action = native_theme_action(pref, false, NativeHost::Windows);
            let outcome = native_theme_outcome(action, || Some("light".to_string()));
            assert!(
                !outcome.override_active,
                "windows overrideActive must be false (pref={pref})"
            );
            assert_eq!(outcome.os_theme, Some("light".to_string()));
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
        let mut read_called = false;
        let outcome = native_theme_outcome(action, || {
            read_called = true;
            Some("light".to_string())
        });
        assert!(!outcome.override_active);
        assert_eq!(outcome.os_theme, Some("light".to_string()));
        // The reading is untrustworthy on Linux but is still taken, to stay
        // consistent with `get_app_theme` — see `native_theme_outcome`, #1363.
        assert!(read_called);
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

/// Unit tests for the pure context-menu spec builder (#923). The real `Menu`
/// needs a Tauri manager and can't be built in a unit test, so we assert the
/// item spec instead — the part that decides which ids/labels/enabled-states
/// each context produces.
#[cfg(test)]
mod context_menu_tests {
    use super::*;

    fn req(kind: ContextMenuKind, is_editable: bool) -> ContextMenuRequest {
        ContextMenuRequest {
            kind,
            has_selection: false,
            is_editable,
            over_link: false,
            can_merge_cells: false,
            can_split_cell: false,
        }
    }

    fn custom_ids(spec: &[CtxItem]) -> Vec<&'static str> {
        let mut ids = Vec::new();
        for item in spec {
            match item {
                CtxItem::Custom(id, _, _) | CtxItem::Accelerated(id, _, _, _) => ids.push(*id),
                CtxItem::Submenu(_, children) => ids.extend(custom_ids(children)),
                _ => {}
            }
        }
        ids
    }

    fn enabled_of(spec: &[CtxItem], id: &str) -> Option<bool> {
        spec.iter().find_map(|i| match i {
            CtxItem::Custom(item_id, _, enabled) | CtxItem::Accelerated(item_id, _, enabled, _)
                if *item_id == id =>
            {
                Some(*enabled)
            }
            CtxItem::Submenu(_, children) => enabled_of(children, id),
            _ => None,
        })
    }

    #[test]
    fn link_menu_has_open_copy_remove_then_clipboard() {
        let spec = build_context_menu_spec(&req(ContextMenuKind::Link, true));
        assert_eq!(
            custom_ids(&spec),
            vec![
                "ctx:link:open",
                "ctx:link:copy",
                "ctx:link:edit",
                "ctx:link:remove"
            ]
        );
        // Native clipboard items follow.
        assert!(spec.contains(&CtxItem::Cut));
        assert!(spec.contains(&CtxItem::Paste));
    }

    #[test]
    fn table_menu_lists_all_structural_ops() {
        let spec = build_context_menu_spec(&req(ContextMenuKind::TableCell, true));
        for id in [
            "ctx:table:insertRowAbove",
            "ctx:table:insertRowBelow",
            "ctx:table:insertColLeft",
            "ctx:table:insertColRight",
            "ctx:table:deleteRow",
            "ctx:table:deleteCol",
            "ctx:table:mergeCells",
            "ctx:table:splitCell",
            "ctx:table:deleteTable",
        ] {
            assert!(custom_ids(&spec).contains(&id), "table menu missing {id}");
        }
        // Cells get clipboard too (right-click in a cell is still editable text).
        assert!(spec.contains(&CtxItem::Cut));
    }

    #[test]
    fn merge_and_split_gated_on_can_flags() {
        let mut r = req(ContextMenuKind::TableCell, true);
        r.can_merge_cells = true; // split stays false
        let spec = build_context_menu_spec(&r);
        assert_eq!(enabled_of(&spec, "ctx:table:mergeCells"), Some(true));
        assert_eq!(enabled_of(&spec, "ctx:table:splitCell"), Some(false));
    }

    #[test]
    fn editor_text_menu_has_undo_clipboard_paste_plain_select_all() {
        let spec = build_context_menu_spec(&req(ContextMenuKind::EditorText, true));
        assert_eq!(custom_ids(&spec), vec!["ctx:pastePlain"]);
        assert!(spec.contains(&CtxItem::Undo));
        assert!(spec.contains(&CtxItem::Redo));
        assert!(spec.contains(&CtxItem::SelectAll));
        assert!(spec.contains(&CtxItem::Paste));
        assert!(spec.contains(&CtxItem::Accelerated(
            "ctx:pastePlain",
            "Paste as Raw Text",
            true,
            "CmdOrCtrl+Shift+V",
        )));
    }

    #[test]
    fn selection_intents_are_present_only_for_a_non_empty_selection() {
        let mut r = req(ContextMenuKind::EditorText, true);
        assert!(!custom_ids(&build_context_menu_spec(&r)).contains(&"ctx:selection:askAi"));
        r.has_selection = true;
        let ids = custom_ids(&build_context_menu_spec(&r));
        assert!(ids.contains(&"ctx:selection:askAi"));
        assert!(ids.contains(&"ctx:selection:comment"));
        assert!(ids.contains(&"ctx:selection:privateNote"));
    }

    #[test]
    fn table_rows_and_columns_are_recursive_submenus() {
        let spec = build_context_menu_spec(&req(ContextMenuKind::TableCell, true));
        assert!(matches!(&spec[4], CtxItem::Submenu("Rows", _)));
        assert!(matches!(&spec[5], CtxItem::Submenu("Columns", _)));
    }

    #[test]
    fn read_only_disables_mutating_items_but_keeps_navigation() {
        // Read-only doc: table mutations + paste-plain are disabled;
        // Open/Copy Link stay enabled (they don't mutate the document).
        let table = build_context_menu_spec(&req(ContextMenuKind::TableCell, false));
        assert_eq!(enabled_of(&table, "ctx:table:deleteRow"), Some(false));
        assert_eq!(enabled_of(&table, "ctx:table:deleteTable"), Some(false));

        let text = build_context_menu_spec(&req(ContextMenuKind::EditorText, false));
        assert_eq!(enabled_of(&text, "ctx:pastePlain"), Some(false));

        let link = build_context_menu_spec(&req(ContextMenuKind::Link, false));
        assert_eq!(enabled_of(&link, "ctx:link:open"), Some(true));
        assert_eq!(enabled_of(&link, "ctx:link:copy"), Some(true));
        assert_eq!(enabled_of(&link, "ctx:link:remove"), Some(false));
    }

    #[test]
    fn kind_deserializes_from_camel_case() {
        // The JS side sends camelCase kind strings; serde must accept them.
        let r: ContextMenuRequest = serde_json::from_value(serde_json::json!({
            "kind": "tableCell",
            "hasSelection": true,
            "isEditable": true,
            "overLink": false,
            "canMergeCells": true,
            "canSplitCell": false,
        }))
        .expect("camelCase request should deserialize");
        assert!(matches!(r.kind, ContextMenuKind::TableCell));
        assert!(r.can_merge_cells);
    }
}

/// Unit tests for the Phase 2 tab-strip context-menu spec builder (#923).
#[cfg(test)]
mod tab_context_menu_tests {
    use super::*;

    fn req(can_close_others: bool, can_close_right: bool, has_path: bool) -> TabContextMenuRequest {
        TabContextMenuRequest {
            can_close_left: false,
            can_close_others,
            can_close_right,
            can_rename: true,
            can_save: true,
            save_as: false,
            can_copy_file_name: true,
            has_path,
            can_toggle_source_view: true,
            source_view_active: false,
        }
    }

    fn enabled_of(spec: &[CtxItem], id: &str) -> Option<bool> {
        spec.iter().find_map(|i| match i {
            CtxItem::Custom(item_id, _, enabled) if *item_id == id => Some(*enabled),
            _ => None,
        })
    }

    #[test]
    fn lists_all_actions_in_order() {
        let spec = build_tab_context_menu_spec(&req(true, true, true), "linux");
        let ids: Vec<&str> = spec
            .iter()
            .filter_map(|i| match i {
                CtxItem::Custom(id, _, _) => Some(*id),
                _ => None,
            })
            .collect();
        assert_eq!(
            ids,
            vec![
                "ctx:tab:close",
                "ctx:tab:closeLeft",
                "ctx:tab:closeOthers",
                "ctx:tab:closeRight",
                "ctx:tab:rename",
                "ctx:tab:save",
                "ctx:tab:toggleSourceView",
                "ctx:tab:copyFileName",
                "ctx:tab:copyPath",
                "ctx:tab:reveal",
            ]
        );
    }

    #[test]
    fn close_is_always_enabled() {
        // Even a lone scratchpad tab can be closed.
        let spec = build_tab_context_menu_spec(&req(false, false, false), "linux");
        assert_eq!(enabled_of(&spec, "ctx:tab:close"), Some(true));
    }

    #[test]
    fn close_others_and_right_gate_on_their_flags() {
        let spec = build_tab_context_menu_spec(&req(false, false, true), "linux");
        assert_eq!(enabled_of(&spec, "ctx:tab:closeOthers"), Some(false));
        assert_eq!(enabled_of(&spec, "ctx:tab:closeRight"), Some(false));

        let spec = build_tab_context_menu_spec(&req(true, true, true), "linux");
        assert_eq!(enabled_of(&spec, "ctx:tab:closeOthers"), Some(true));
        assert_eq!(enabled_of(&spec, "ctx:tab:closeRight"), Some(true));
    }

    #[test]
    fn path_actions_gate_on_has_path() {
        // Scratchpad / upload tab → no real path → Copy Path + Reveal disabled.
        let spec = build_tab_context_menu_spec(&req(true, true, false), "macos");
        assert_eq!(enabled_of(&spec, "ctx:tab:copyPath"), Some(false));
        assert_eq!(enabled_of(&spec, "ctx:tab:reveal"), Some(false));
    }

    #[test]
    fn reveal_label_is_os_specific() {
        assert_eq!(reveal_in_file_manager_label("macos"), "Reveal in Finder");
        assert_eq!(reveal_in_file_manager_label("windows"), "Show in File Explorer");
        assert_eq!(reveal_in_file_manager_label("linux"), "Show in File Manager");
        assert_eq!(reveal_in_file_manager_label("freebsd"), "Show in File Manager");
    }

    #[test]
    fn request_deserializes_from_camel_case() {
        let r: TabContextMenuRequest = serde_json::from_value(serde_json::json!({
            "canCloseOthers": true,
            "canCloseLeft": false,
            "canCloseRight": false,
            "canRename": true,
            "canSave": true,
            "saveAs": false,
            "canCopyFileName": true,
            "hasPath": true,
            "canToggleSourceView": true,
            "sourceViewActive": false,
        }))
        .expect("camelCase tab request should deserialize");
        assert!(r.can_close_others);
        assert!(!r.can_close_right);
        assert!(r.has_path);
    }
}

/// Unit tests for the Phase 3 annotation-card context-menu spec builder (#999).
#[cfg(test)]
mod annotation_context_menu_tests {
    use super::*;

    /// All-off baseline; flip the fields a test cares about.
    fn none() -> AnnotationContextMenuRequest {
        AnnotationContextMenuRequest {
            can_accept: false,
            can_dismiss: false,
            can_reply: false,
            can_edit: false,
            can_send_to_claude: false,
            can_copy: false,
            can_remove: false,
            is_note: false,
        }
    }

    fn ids(spec: &[CtxItem]) -> Vec<&str> {
        spec.iter()
            .filter_map(|i| match i {
                CtxItem::Custom(id, _, _) => Some(*id),
                _ => None,
            })
            .collect()
    }

    fn label_of<'a>(spec: &'a [CtxItem], id: &str) -> Option<&'a str> {
        spec.iter().find_map(|i| match i {
            CtxItem::Custom(item_id, label, _) if *item_id == id => Some(*label),
            _ => None,
        })
    }

    /// Separators never lead, trail, or double up — the empty-group collapse contract.
    fn separators_well_formed(spec: &[CtxItem]) -> bool {
        if spec.is_empty() {
            return true;
        }
        if matches!(spec.first(), Some(CtxItem::Separator))
            || matches!(spec.last(), Some(CtxItem::Separator))
        {
            return false;
        }
        !spec
            .windows(2)
            .any(|w| matches!(w[0], CtxItem::Separator) && matches!(w[1], CtxItem::Separator))
    }

    #[test]
    fn user_note_shows_compose_copy_archive() {
        // author=user, type=note, pending → Reply…/Edit…/Send to Claude · Copy · Archive.
        let mut r = none();
        r.can_reply = true;
        r.can_edit = true;
        r.can_send_to_claude = true;
        r.can_copy = true;
        r.can_remove = true;
        r.is_note = true;
        let spec = build_annotation_context_menu_spec(&r);
        assert_eq!(
            ids(&spec),
            vec![
                "ctx:annotation:reply",
                "ctx:annotation:edit",
                "ctx:annotation:sendToClaude",
                "ctx:annotation:copy",
                "ctx:annotation:remove",
            ]
        );
        assert_eq!(label_of(&spec, "ctx:annotation:remove"), Some("Archive"));
        assert!(separators_well_formed(&spec));
        // Exactly two separators (compose|clipboard, clipboard|destructive).
        assert_eq!(
            spec.iter()
                .filter(|i| matches!(i, CtxItem::Separator))
                .count(),
            2
        );
    }

    #[test]
    fn claude_comment_shows_review_reply_copy() {
        // author=claude, type=comment, pending → Accept/Dismiss · Reply… · Copy.
        let mut r = none();
        r.can_accept = true;
        r.can_dismiss = true;
        r.can_reply = true;
        r.can_copy = true;
        let spec = build_annotation_context_menu_spec(&r);
        assert_eq!(
            ids(&spec),
            vec![
                "ctx:annotation:accept",
                "ctx:annotation:dismiss",
                "ctx:annotation:reply",
                "ctx:annotation:copy",
            ]
        );
        // No Edit (author != user), no Remove/Send.
        assert!(label_of(&spec, "ctx:annotation:edit").is_none());
        assert!(separators_well_formed(&spec));
    }

    #[test]
    fn user_highlight_remove_label_and_no_reply() {
        // author=user, type=highlight, pending → Edit… · Copy · Remove (not Archive); no Reply.
        let mut r = none();
        r.can_edit = true;
        r.can_copy = true;
        r.can_remove = true;
        r.is_note = false;
        let spec = build_annotation_context_menu_spec(&r);
        assert_eq!(
            ids(&spec),
            vec![
                "ctx:annotation:edit",
                "ctx:annotation:copy",
                "ctx:annotation:remove",
            ]
        );
        assert_eq!(label_of(&spec, "ctx:annotation:remove"), Some("Remove"));
        assert!(label_of(&spec, "ctx:annotation:reply").is_none());
        assert!(separators_well_formed(&spec));
    }

    #[test]
    fn resolved_annotation_shows_only_copy_no_separators() {
        // Every gate off except copy → a single item, no leading/trailing separator.
        let mut r = none();
        r.can_copy = true;
        let spec = build_annotation_context_menu_spec(&r);
        assert_eq!(ids(&spec), vec!["ctx:annotation:copy"]);
        assert!(separators_well_formed(&spec));
        assert_eq!(
            spec.iter()
                .filter(|i| matches!(i, CtxItem::Separator))
                .count(),
            0
        );
    }

    #[test]
    fn all_off_is_empty() {
        let spec = build_annotation_context_menu_spec(&none());
        assert!(spec.is_empty());
        assert!(separators_well_formed(&spec));
    }

    #[test]
    fn review_and_destructive_only_collapses_middle_groups() {
        // Accept/Dismiss + Remove, nothing in compose/clipboard → exactly one separator
        // between the two surviving groups (middle empty groups don't emit dividers).
        let mut r = none();
        r.can_accept = true;
        r.can_dismiss = true;
        r.can_remove = true;
        let spec = build_annotation_context_menu_spec(&r);
        assert_eq!(
            ids(&spec),
            vec![
                "ctx:annotation:accept",
                "ctx:annotation:dismiss",
                "ctx:annotation:remove",
            ]
        );
        assert!(separators_well_formed(&spec));
        assert_eq!(
            spec.iter()
                .filter(|i| matches!(i, CtxItem::Separator))
                .count(),
            1
        );
    }

    #[test]
    fn request_deserializes_from_camel_case() {
        let r: AnnotationContextMenuRequest = serde_json::from_value(serde_json::json!({
            "canAccept": false,
            "canDismiss": false,
            "canReply": true,
            "canEdit": true,
            "canSendToClaude": true,
            "canCopy": true,
            "canRemove": true,
            "isNote": true,
        }))
        .expect("camelCase annotation request should deserialize");
        assert!(r.can_reply);
        assert!(r.can_edit);
        assert!(r.can_send_to_claude);
        assert!(r.is_note);
        assert!(!r.can_accept);
    }
}

/// Cross-platform unit tests for `classify_opened_url` (#630 sub-task #3). The
/// helper is unconditionally compiled and free of Tauri runtime handles — its
/// only I/O is a filesystem stat — so these run on every platform
/// even though its only production caller (`handle_opened_urls`) is macOS-gated.
/// CI runs `cargo test` on both ubuntu-latest and windows-latest, so every
/// assertion below must hold on both.
#[cfg(test)]
mod classify_opened_url_tests {
    use super::*;

    /// An empty-host, absolute-path `file://` URL converts to a filesystem
    /// path — and, since #1344, that is no longer sufficient. The converted
    /// path still has to clear the shared `validate_open_candidate` checks, and
    /// `x` carries no extension at all, so it rejects. `Url::to_file_path()` is
    /// platform-specific (Windows requires a drive letter, `/C:/x` -> `C:\x`;
    /// Unix takes the POSIX path as-is), so we cfg-gate the literal and match
    /// on the variant rather than the resolved path.
    #[test]
    fn empty_host_absolute_path_is_still_validated() {
        #[cfg(target_os = "windows")]
        let literal = "file:///C:/x";
        #[cfg(not(target_os = "windows"))]
        let literal = "file:///tmp/x";

        let url = Url::parse(literal).expect("valid file URL");
        let result = classify_opened_url(&url);
        assert!(
            matches!(
                &result,
                Err(OpenedUrlRejection::PathRejected(
                    RejectionReason::UnsupportedExtension { ext, .. }
                )) if ext.is_empty()
            ),
            "URL conversion succeeding is no longer sufficient (#1344); got {result:?}"
        );
    }

    #[test]
    fn smb_style_host_is_non_empty_host() {
        let url = Url::parse("file://smb-host/share").expect("valid file URL");
        assert_eq!(
            classify_opened_url(&url),
            Err(OpenedUrlRejection::NonEmptyHost),
            "SMB-style file URLs with a host must be rejected"
        );
    }

    /// Documents a known gap: issue #630 expected `file://localhost/x` to
    /// reject as `NonEmptyHost`, but the `url` crate normalizes the literal
    /// `localhost` host to an empty host for the `file` scheme (per the WHATWG
    /// URL spec / RFC 8089 `file://localhost/p` == `file:///p`). `host_str()`
    /// returns `None`, so the host gate never fires — the URL falls through to
    /// `to_file_path()`. This matches the ORIGINAL inline code's behavior
    /// (it also keyed off `host_str()`); this extraction is a pure refactor and
    /// does not regress it. Closing the gap requires inspecting the raw URL
    /// string and is left as a #630 follow-up.
    ///
    /// The downstream outcome is platform-specific: on Windows the bare
    /// `/x` path has no drive letter so conversion fails (`ConversionFailed`);
    /// on Unix `/x` converts fine and is then caught by the shared path
    /// validator, which #1344 appended. Note what that means: the host gate
    /// still never fires, so the #630 gap is untouched — but the path validator
    /// closes the hole in practice on both platforms, since a `localhost`-host
    /// URL that survived normalization would still have to name a real,
    /// supported file to be opened.
    #[test]
    fn localhost_host_normalizes_away_and_falls_through() {
        let url = Url::parse("file://localhost/x").expect("valid file URL");
        assert_eq!(
            url.host_str(),
            None,
            "the url crate normalizes localhost to an empty host for file://"
        );

        let result = classify_opened_url(&url);
        #[cfg(target_os = "windows")]
        assert_eq!(
            result,
            Err(OpenedUrlRejection::ConversionFailed),
            "bare /x has no Windows drive letter, so conversion fails"
        );
        #[cfg(not(target_os = "windows"))]
        assert_eq!(
            result,
            Err(OpenedUrlRejection::PathRejected(
                RejectionReason::UnsupportedExtension {
                    ext: String::new(),
                    path: PathBuf::from("/x"),
                }
            )),
            "on Unix /x converts fine, then fails the shared path validator"
        );
    }

    #[test]
    fn https_scheme_is_non_file_scheme() {
        let url = Url::parse("https://example.com/x").expect("valid https URL");
        assert_eq!(
            classify_opened_url(&url),
            Err(OpenedUrlRejection::NonFileScheme),
            "only the file scheme is openable from Opened events"
        );
    }

    /// `file:foo` is NOT cannot-be-a-base: the `file:` scheme is special, so
    /// the `url` crate normalizes it to `file:///foo` (empty host, absolute
    /// path `/foo`). It passes the scheme gate (`file`) and the host gate (no
    /// host), so it reaches `to_file_path()` -- whose result is genuinely
    /// platform-dependent, and is the *only* way `ConversionFailed` is
    /// reachable once those gates pass:
    ///   - Windows rejects the driveless path `/foo` (needs a drive letter or
    ///     UNC root) -> `Err(ConversionFailed)`.
    ///   - Unix accepts `/foo` as an absolute path, which then reaches the
    ///     shared path validator and fails it (no extension) ->
    ///     `Err(PathRejected(UnsupportedExtension))`.
    /// CI runs both arms (ubuntu + windows), so each is exercised.
    #[test]
    fn empty_host_file_url_classification_is_platform_dependent() {
        let url = Url::parse("file:foo").expect("valid file URL");
        assert_eq!(url.scheme(), "file", "scheme gate must pass");
        assert_eq!(url.host_str(), None, "host gate must pass");
        assert!(!url.cannot_be_a_base(), "file: is a special base scheme");
        let got = classify_opened_url(&url);
        #[cfg(windows)]
        assert_eq!(
            got,
            Err(OpenedUrlRejection::ConversionFailed),
            "Windows cannot convert the driveless path /foo to a file path"
        );
        #[cfg(not(windows))]
        assert_eq!(
            got,
            Err(OpenedUrlRejection::PathRejected(
                RejectionReason::UnsupportedExtension {
                    ext: String::new(),
                    path: PathBuf::from("/foo"),
                }
            )),
            "Unix accepts /foo as an absolute path, then the path validator rejects it"
        );
    }

    /// The four realistic negative shapes, each asserting the exact wrapped
    /// `RejectionReason` so the delegating reason-code map cannot drift.
    #[test]
    fn opened_url_path_rejections_are_table_driven() {
        let dir = tempfile::TempDir::new().expect("tempdir");

        // (1) Exists, but the extension is not in SUPPORTED_FILE_ASSOC_EXTS.
        //     (Not the same thing as OS-registered: `.htm` is accepted here and
        //     deliberately registered nowhere.)
        let exe = dir.path().join("secret.exe");
        std::fs::write(&exe, b"x").expect("write fixture");
        // (2) Exists, but has no extension at all.
        let bare = dir.path().join("README");
        std::fs::write(&bare, b"x").expect("write fixture");
        // (3) Supported extension, but nothing is there — the stale-alias case.
        let missing = dir.path().join("missing.md");
        // (4) A DIRECTORY whose name ends in `.md`. This is the case that
        //     proves the check is `is_file()` and not `exists()`, and it is the
        //     realistic Finder "Open With" shape.
        let subdir = dir.path().join("subdir.md");
        std::fs::create_dir(&subdir).expect("mkdir fixture");

        let cases: Vec<(PathBuf, RejectionReason)> = vec![
            (
                exe.clone(),
                RejectionReason::UnsupportedExtension {
                    ext: "exe".to_string(),
                    path: exe,
                },
            ),
            (
                bare.clone(),
                RejectionReason::UnsupportedExtension {
                    ext: String::new(),
                    path: bare,
                },
            ),
            (missing.clone(), RejectionReason::NotAFile { path: missing }),
            (subdir.clone(), RejectionReason::NotAFile { path: subdir }),
        ];

        for (path, expected) in cases {
            let url = Url::from_file_path(&path).expect("absolute path -> file URL");
            assert_eq!(
                classify_opened_url(&url),
                Err(OpenedUrlRejection::PathRejected(expected)),
                "unexpected classification for {}",
                path.display()
            );
        }
    }

    /// The Opened path's positive control, and its delegation proof in one: a
    /// Finder double-click of `DOC.MD` must open, which can only happen if this
    /// path reaches the shared helper's lowercasing match.
    ///
    /// UNC / network paths are refused by the shared validator itself, so the
    /// refusal covers BOTH OS entry points and — critically — lands before
    /// `is_file()`. `is_file()` on `\\host\share\...` performs the SMB
    /// handshake, leaking an NTLM hash from the shell process on a path the
    /// server was always going to reject (`resolveAndValidatePath` refuses both
    /// prefixes). A gate placed after the syscall it guards is decoration.
    ///
    /// Unconditionally compiled, like the check: `\\` is the Windows-exploitable
    /// form, but a Linux/macOS Opened handler must not start accepting `//`
    /// either just because it is locally harmless there.
    #[test]
    fn unc_paths_are_refused_before_any_filesystem_call() {
        for candidate in [r"\\attacker\share\notes.md", "//attacker/share/notes.md"] {
            let path = PathBuf::from(candidate);
            assert_eq!(
                validate_open_candidate(path.clone()),
                Err(RejectionReason::NotAFile { path }),
                "{candidate} must be refused by the shared validator"
            );
        }
    }

    /// `is_file()` follows symlinks deliberately (the server re-resolves and is
    /// the authority). That is a documented choice with a plausible-looking
    /// "safer" mutation — `symlink_metadata()` — which would silently refuse
    /// every symlinked document on both surfaces.
    #[cfg(unix)]
    #[test]
    fn a_symlink_to_a_supported_file_is_accepted() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let target = dir.path().join("real.md");
        std::fs::write(&target, b"x").expect("write fixture");
        let link = dir.path().join("link.md");
        std::os::unix::fs::symlink(&target, &link).expect("symlink");

        assert_eq!(
            validate_open_candidate(link.clone()),
            Ok(link),
            "a symlink to a supported regular file must be accepted, not resolved away"
        );
    }

    /// Deliberately NOT a table over `SUPPORTED_FILE_ASSOC_EXTS` — that table
    /// lives once, on the argv surface
    /// (`tests/file_association.rs::each_supported_extension_is_accepted`).
    /// Since #1344 both surfaces run the same `validate_open_candidate` against
    /// the same constant, so a second table would re-test the helper rather
    /// than this caller. What needs proving here is only that the delegation
    /// happens at all.
    #[test]
    fn opened_url_extension_check_is_case_insensitive() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let path = dir.path().join("DOC.MD");
        std::fs::write(&path, b"x").expect("write fixture");
        let url = Url::from_file_path(&path).expect("absolute path -> file URL");
        assert_eq!(
            classify_opened_url(&url),
            Ok(path),
            "the extension match must be case-insensitive on the Opened path"
        );
    }

    /// #1344 APPENDED the path check as step 4; it did not interleave it. A
    /// supported-looking extension must not smuggle a URL past the scheme or
    /// host gates.
    ///
    /// Named for what it actually pins. Distinguishing conversion-before-path
    /// would need a platform-specific driveless fixture; that case is covered
    /// separately by `empty_host_file_url_classification_is_platform_dependent`.
    #[test]
    fn check_order_is_scheme_then_host_before_path() {
        let https = Url::parse("https://example.com/a.md").expect("valid https URL");
        assert_eq!(
            classify_opened_url(&https),
            Err(OpenedUrlRejection::NonFileScheme),
            "a .md extension must not get an https URL past the scheme gate"
        );

        let smb = Url::parse("file://smb-host/share/a.md").expect("valid file URL");
        assert_eq!(
            classify_opened_url(&smb),
            Err(OpenedUrlRejection::NonEmptyHost),
            "a .md extension must not get a hosted URL past the host gate"
        );
    }

}

/// Tests for the startup-file rejection surfacing (issue #630): the path-free
/// reason-code mapping and the buffered-rejection take/clear semantics.
#[cfg(test)]
mod startup_rejection_tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Mutex as StdMutex;

    // Serialize tests that mutate STARTUP_REJECTION (a process-wide static).
    static REJECTION_LOCK: StdMutex<()> = StdMutex::new(());

    #[test]
    fn reason_code_is_stable_and_path_free() {
        // The codes are the cross-process contract with the App.svelte toast
        // map — assert the exact strings so a rename can't silently desync.
        assert_eq!(
            rejection_reason_code(&RejectionReason::UnsupportedExtension {
                ext: "exe".into(),
                path: PathBuf::from("/secret/place/file.exe"),
            }),
            "unsupported-extension"
        );
        assert_eq!(
            rejection_reason_code(&RejectionReason::NotAFile {
                path: PathBuf::from("/secret/place/dir"),
            }),
            "not-a-file"
        );
        assert_eq!(
            rejection_reason_code(&RejectionReason::SuspiciousColon {
                path: PathBuf::from("/secret/place/file.md:Zone.Identifier"),
                index: 7,
            }),
            "suspicious-path"
        );
    }

    #[test]
    fn reason_code_never_leaks_the_path() {
        // The reason code is a fixed enum string; assert it shares no substring
        // with a path that would be sensitive to leak into a DOM toast.
        let secret = "/Users/victim/Secret Plans.md";
        let code = rejection_reason_code(&RejectionReason::NotAFile {
            path: PathBuf::from(secret),
        });
        assert!(
            !code.contains("Secret") && !code.contains('/'),
            "reason code must not embed the rejected path"
        );
    }

    #[test]
    fn buffer_then_get_takes_once_then_returns_none() {
        let _g = REJECTION_LOCK.lock().unwrap();
        clear_startup_rejection();

        buffer_startup_rejection_code(rejection_reason_code(&RejectionReason::UnsupportedExtension {
            ext: "exe".into(),
            path: PathBuf::from("/x/file.exe"),
        }));
        assert_eq!(
            get_startup_rejection(),
            Some("unsupported-extension".to_string()),
            "first poll returns the buffered code"
        );
        assert_eq!(
            get_startup_rejection(),
            None,
            "the buffer is TAKEN — a second poll (e.g. WebView reload) returns None"
        );
    }

    #[test]
    fn clear_drops_a_buffered_rejection() {
        let _g = REJECTION_LOCK.lock().unwrap();
        clear_startup_rejection();

        buffer_startup_rejection_code(rejection_reason_code(&RejectionReason::NotAFile {
            path: PathBuf::from("/x/missing.md"),
        }));
        // restart_sidecar calls clear_startup_rejection — a stale rejection from
        // the previous launch must not survive into the next init-time drain.
        clear_startup_rejection();
        assert_eq!(
            get_startup_rejection(),
            None,
            "clear must drop the buffered rejection"
        );
    }

    #[test]
    fn buffer_is_last_write_wins() {
        let _g = REJECTION_LOCK.lock().unwrap();
        clear_startup_rejection();

        buffer_startup_rejection_code(rejection_reason_code(&RejectionReason::NotAFile {
            path: PathBuf::from("/x/a.md"),
        }));
        buffer_startup_rejection_code(rejection_reason_code(&RejectionReason::UnsupportedExtension {
            ext: "exe".into(),
            path: PathBuf::from("/x/b.exe"),
        }));
        assert_eq!(
            get_startup_rejection(),
            Some("unsupported-extension".to_string()),
            "the most recent buffered reason wins"
        );
        clear_startup_rejection();
    }

    /// Un-gated since #1344 (`opened_url_reason_code` is now unconditionally
    /// compiled), so this contract runs on ubuntu, windows AND macOS.
    #[test]
    fn opened_url_reason_codes_are_path_free_and_stable() {
        assert_eq!(
            opened_url_reason_code(&OpenedUrlRejection::NonFileScheme),
            "non-file-url"
        );
        assert_eq!(
            opened_url_reason_code(&OpenedUrlRejection::NonEmptyHost),
            "suspicious-path"
        );
        assert_eq!(
            opened_url_reason_code(&OpenedUrlRejection::ConversionFailed),
            "not-a-file"
        );

        // The delegating arm reuses the argv path's codes rather than minting
        // new ones — App.svelte's reason-code→message map already handles both.
        let unsupported = opened_url_reason_code(&OpenedUrlRejection::PathRejected(
            RejectionReason::UnsupportedExtension {
                ext: "exe".into(),
                path: PathBuf::from("/secret/place/file.exe"),
            },
        ));
        assert_eq!(unsupported, "unsupported-extension");
        let not_a_file = opened_url_reason_code(&OpenedUrlRejection::PathRejected(
            RejectionReason::NotAFile {
                path: PathBuf::from("/Users/victim/Secret Plans.md"),
            },
        ));
        assert_eq!(not_a_file, "not-a-file");

        // Mirrors `reason_code_never_leaks_the_path`: delegating must never
        // start putting a path on the wire.
        for code in [unsupported, not_a_file] {
            assert!(
                !code.contains('/') && !code.contains("Secret"),
                "delegated reason code must not embed the rejected path"
            );
        }
    }

    /// THE delivery-ordering contract, and the reason `surface_startup_rejection`
    /// was split around a closure.
    ///
    /// Without this, two one-line mutations reverted the #1344 fix with a fully
    /// green suite: deleting the buffer write made every path emit-only again
    /// (the original cold-start drop), and swapping buffer/nudge let a live
    /// listener drain an empty slot (the nudge is payload-free, so there is
    /// nothing to fall back on). Both are killed here by asserting from INSIDE
    /// the nudge that the code is already readable.
    #[test]
    fn the_code_is_buffered_before_the_nudge_fires() {
        let _g = REJECTION_LOCK.lock().unwrap();
        clear_startup_rejection();

        let mut nudged = false;
        surface_startup_rejection_with("unsupported-extension", || {
            nudged = true;
            // A real listener answers the nudge by calling get_startup_rejection.
            // Doing that here is the whole point: it must already be there.
            assert_eq!(
                get_startup_rejection(),
                Some("unsupported-extension".to_string()),
                "the buffer must be populated BEFORE the nudge is emitted, or a \
                 listener that answers immediately drains nothing"
            );
        });
        assert!(nudged, "the nudge must actually be invoked");
        clear_startup_rejection();
    }

    /// A failed emit must not cost the toast — the code stays queued for the
    /// client's next init-time drain. This is the justification printed in
    /// `surface_startup_rejection`'s `log::warn!`, now enforced.
    #[test]
    fn a_failed_nudge_leaves_the_code_buffered() {
        let _g = REJECTION_LOCK.lock().unwrap();
        clear_startup_rejection();

        surface_startup_rejection_with("not-a-file", || { /* emit failed; do nothing */ });

        assert_eq!(
            get_startup_rejection(),
            Some("not-a-file".to_string()),
            "a dropped nudge costs one event, not the toast"
        );
        clear_startup_rejection();
    }

    /// One OS batch yields exactly one buffered code, so the toast the user gets
    /// does not depend on where the client's async drain happened to land.
    #[test]
    fn a_batch_collapses_to_one_deterministic_code() {
        let mut empty = RejectionBatch::default();
        assert_eq!(empty.resolve(), None, "nothing rejected, nothing to surface");
        empty.record("unsupported-extension");
        assert_eq!(
            empty.resolve(),
            Some("unsupported-extension"),
            "a lone rejection keeps its specific reason"
        );

        let mut mixed = RejectionBatch::default();
        mixed.record("unsupported-extension");
        mixed.record("not-a-file");
        assert_eq!(
            mixed.resolve(),
            Some("multiple-rejected"),
            "a mixed batch has no single true reason, so it must not claim one"
        );

        let mut same = RejectionBatch::default();
        same.record("not-a-file");
        same.record("not-a-file");
        assert_eq!(
            same.resolve(),
            Some("multiple-rejected"),
            "multiplicity is reported even when the reason agrees — four of five \
             files opening is the case a singular message misdescribes"
        );
    }
}

#[cfg(test)]
mod autostart_tests {
    use super::*;

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
