mod autostart;
pub mod keychain;
mod sentry_reporting;
mod token_store;
mod uninstall_scrub;

// #1371: both of these are deliberately UNGATED even though their only consumer
// today (`firewall.rs`) is Windows-only. A `#[cfg(target_os = "windows")]` module
// is never parsed on another target, so gating them would put the two pieces of
// genuinely tricky logic — a process deadline that must bound the whole call, and
// an in-flight guard replacing the serialization the main thread used to provide
// for free — where they could not be unit-tested locally. `#[allow(dead_code)]`
// on `bounded_command` covers non-Windows release builds, where nothing calls it
// — scoped with `cfg_attr` (as `PortHolder` is) so that on Windows, where the
// module IS live, a genuinely unused helper added later still warns.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
mod bounded_command;
mod single_flight;

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

/// OS open-candidate screening (#1415): `SUPPORTED_FILE_ASSOC_EXTS`, the two
/// rejection enums and their reason-code mappers, `validate_open_candidate`,
/// `extract_file_arg`, `classify_opened_url` — and `ScreenedOpenPath`, whose
/// private tuple field is the whole reason this is a separate module rather
/// than more of `lib.rs`. See that file's module docs for why the boundary,
/// not the struct, is the mechanism.
pub mod open_candidate;

// Re-exported at the crate root: `src-tauri/tests/file_association.rs` imports
// these as `app_lib::…`, and this file's `#[cfg(test)]` submodules reach them
// through `use super::*`.
pub use open_candidate::{
    extract_file_arg, RejectionReason, ScreenedOpenPath, SUPPORTED_FILE_ASSOC_EXTS,
};

// `rejection_reason_code` has unconditional call sites here (the
// `single-instance` callback and cold start). The other two are reached only
// from the macOS-gated `handle_opened_urls`, so their import carries the same
// cfg as the caller rather than an `allow(unused_imports)` — `test` is in the
// set because `startup_rejection_tests` exercises them on every CI leg.
pub(crate) use open_candidate::rejection_reason_code;
#[cfg(any(target_os = "macos", test))]
pub(crate) use open_candidate::{classify_opened_url, opened_url_reason_code, OpenedUrlRejection};
#[cfg(test)]
pub(crate) use open_candidate::validate_open_candidate;

// Bare `PathBuf` survives only in `cfg`-gated regions of this file — the
// Windows Cowork self-heal pass and the `#[cfg(test)]` modules. Every
// unconditionally-compiled use went to `open_candidate.rs` with the
// open-candidate cluster (#1415), so an ungated import warns on the Linux and
// macOS release builds.
#[cfg(any(test, target_os = "windows"))]
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
/// How long each `start_sidecar` attempt waits for `/health` before declaring
/// the sidecar dead.
///
/// This times a wait that HAPPENS INSIDE the sidecar: `waitForPort` in
/// `src/server/platform.ts` polls for the TCP port to release (15s default)
/// before Hocuspocus/MCP can bind and answer `/health`. So this constant must
/// stay comfortably above that one — at 15s each, a sidecar that legitimately
/// waited out a slow Windows TIME_WAIT release would be killed by its own
/// shell, which is the post-update failure this pairing exists to prevent.
///
/// It is NOT universal margin. The store-lock acquisition in
/// `src/server/index.ts` retries for up to a further 30s when a genuinely live
/// process holds `store.lock` (a stray `tandem start`, a second app-data dir).
/// That case is a different failure with its own deadline and its own error
/// message; we deliberately do not size this constant for it.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const HTTP_CLIENT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long to wait for the sidecar to exit after POST /api/shutdown before
/// hard-killing it. The Node shutdown's disk flush is 5s-bounded
/// (src/server/index.ts), so 6s covers the flush plus the session save in the
/// common case while keeping the restart button responsive (#1088).
const GRACEFUL_SHUTDOWN_DEADLINE_SECS: u64 = 6;
/// How long `perform_install` waits for the killed sidecar to stop answering
/// `/health` before starting the update download/install anyway.
///
/// Note what this actually observes: `wait_for_port_release` polls the HTTP
/// endpoint, so it detects "the server is gone", NOT "the OS has released the
/// TCP port" — a socket in TIME_WAIT is invisible to it. The rename would be
/// `wait_for_server_gone`; the name is kept for churn reasons but do not read a
/// port-state guarantee into it.
///
/// 15s rather than 5s because the machine is at its slowest exactly here —
/// mid-update, with antivirus scanning freshly written files — and a kill that
/// takes longer than the deadline means we start overwriting files while the
/// old process may still be alive. The polling loop returns the instant the
/// server stops answering, so a wider ceiling costs a healthy machine nothing.
const POST_KILL_PORT_RELEASE_SECS: u64 = 15;
/// How long `perform_install` waits for Windows to release the sidecar exe's
/// file handle so the NSIS installer can overwrite it. Same reasoning, same
/// budget as POST_KILL_PORT_RELEASE_SECS — TerminateProcess returns before the
/// OS drops the handle.
#[cfg(target_os = "windows")]
const SIDECAR_UNLOCK_DEADLINE_SECS: u64 = 15;
/// How long `port_holder_for_dialog` waits for `describe_port_holder`'s
/// `netstat`/`tasklist` calls before giving up and showing the generic
/// message. Unlike the deadlines above, this isn't coupled to another
/// timeout elsewhere — it only bounds a best-effort diagnostic on the
/// terminal failure dialog, so a wedged lookup fails toward "less detail",
/// never toward blocking the dialog itself.
#[cfg(target_os = "windows")]
const PORT_HOLDER_LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESTARTS: u32 = 3;
/// The two TCP ports the sidecar binds. Used by the port-holder diagnostic on
/// the exhausted-restarts path; keep in sync with the URL constants above and
/// with DEFAULT_WS_PORT / DEFAULT_MCP_PORT in src/shared/constants.ts. Pinned
/// against the URL constants by `port_constants_match_urls`.
const WS_PORT: u16 = 3478;
const MCP_PORT: u16 = 3479;
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(8 * 60 * 60);

/// Cadence of the Cowork self-heal pass (see `cowork_heal_pass`): installs
/// plugin entries into workspaces that appear after the integration was
/// enabled (e.g. the user's first Cowork run) without requiring a settings
/// visit. The first tick fires immediately at launch.
#[cfg(target_os = "windows")]
const COWORK_HEAL_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Set to `true` once the sidecar's /health endpoint has responded 200 AND the
/// pending-opens queue has been drained. Read by the `RunEvent::Opened` handler
/// to decide between posting immediately vs queueing. Static (process-wide):
/// there is exactly one sidecar per process.
static SIDECAR_HEALTHY: AtomicBool = AtomicBool::new(false);

/// Set when the app has stopped trying to start the server, cleared when it
/// starts trying again (#1416).
///
/// Without it, `SIDECAR_HEALTHY` staying false forever means `try_queue_or_post`
/// keeps taking the queue branch after the app has given up: file 1 gets a
/// dialog and a toast, files 2..N queue into a queue with no consumer, logging
/// at `info` — below the release `LevelFilter::Warn` floor. No tab, no toast, no
/// warn, which is exactly the bug #1416 was filed about, one file later.
///
/// Read and written ONLY under the `PendingOpens` mutex — like the WRITE side of
/// `SIDECAR_HEALTHY` — so it serialises with the producer for free; see the
/// ordering proof on [`try_queue_or_post`]. The comparison is deliberately
/// narrowed to writes: `await_sidecar_healthy` polls `SIDECAR_HEALTHY` unlocked,
/// so "exactly like `SIDECAR_HEALTHY`" would be a false licence to add an
/// unlocked reader here. The latch has no such reader, and must not grow one. Clearing is deliberately generous
/// (any new start attempt clears it, from any route): a stale set costs one
/// unnecessary fail-fast, a stale clear costs the silence this exists to end.
static SIDECAR_GAVE_UP: AtomicBool = AtomicBool::new(false);

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
///
/// Ungated since #1416: `post_paths_and_surface` gives it callers on every
/// platform.
const CODE_MULTIPLE_REJECTED: &str = "multiple-rejected";

/// Wire code for "the candidate passed shell validation, and then failed to open
/// anyway" — a non-2xx from `/api/open`, a transport failure, or an open that
/// arrived after the app stopped trying to start the server (#1416).
///
/// Deliberately ONE code for all three, not three: the user's remedy is identical
/// (try again / reopen the file), the distinction is a diagnostic `tandem.log`
/// already records with the real error text, and every extra code is another
/// string that can desync from a stale WebView. Distinct from the *validation*
/// codes because nothing about the file was wrong — `messageForStartupRejection`
/// maps it to the deliberately vague "That file couldn't be opened in Tandem."
const CODE_OPEN_FAILED: &str = "open-failed";

/// Wire codes for "queued, not yet delivered, and the queue is RETAINED".
///
/// Split from [`CODE_OPEN_FAILED`] because that code's message is flatly past
/// tense — "That file couldn't be opened in Tandem." — and for a retained queue
/// that is a false statement: `promote_healthy_and_drain` will open the file if
/// the user ever restarts the server, which the failure dialog explicitly tells
/// them how to do. Asserting a finality the design does not have is the same
/// defect as the "Abandoning N queued file open(s)" line deleted in this change,
/// and it would be read by the one user in a position to act on it.
///
/// Two codes rather than one because the singular message cannot describe a
/// five-file drop, mirroring the [`CODE_MULTIPLE_REJECTED`] split.
const CODE_OPEN_DEFERRED: &str = "open-deferred";
const CODE_MULTIPLE_DEFERRED: &str = "multiple-deferred";

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
/// every platform — its principal caller, `handle_opened_urls`, is macOS-only and
/// cannot be tested from Windows or Linux CI, which is precisely why the logic
/// must not live inside it.
///
/// Since #1416 the batch also carries POST failures (`CODE_OPEN_FAILED`), so ONE
/// accumulator spans validation *and* delivery for a single OS batch. That is
/// what keeps "one batch, one surface call" true **for everything that resolves
/// synchronously with the batch**: a Finder multi-select of a `.pdf` (refused)
/// plus a 60 MB `.md` (refused by the server) would otherwise write twice into
/// the one-slot buffer and the user would see a count badge whose value depended
/// on where the client's async drain landed.
///
/// **The claim stops at the async boundary, deliberately.** A path that returns
/// `OpenRoute::Queued` has no outcome yet, and may not have one for minutes —
/// its verdict arrives from `report_pending_opens_with` when the user answers
/// the server-failure dialog. Carrying the accumulator across that gap was
/// considered and rejected: it would have to stay open for a user-timescale
/// wait, trading a merge bug for a staleness bug. Instead the client keys its
/// toast dedup on the CODE (`startup-file-rejected:${code}`), so a validation
/// reason and a later delivery verdict can never merge into one count badge.
#[derive(Default)]
struct RejectionBatch {
    first: Option<&'static str>,
    count: usize,
}

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

// ---------------------------------------------------------------------------
// Pending-update boot marker (#1118, the ADR-043 deferred follow-up)
//
// `AppHandle::restart()` is divergent, and on Windows the updater plugin does
// not even reach it: `install_inner` ends in an unconditional
// `std::process::exit(0)` after a `ShellExecuteW` whose return is discarded
// (tauri-plugin-updater-2.10.1 `src/updater.rs:865`). Either way the process
// that started an update is gone before it can observe the outcome, so "the
// installer ran and the shell came back on the old binary" is completely
// silent today. A small file on disk is the smallest carrier of "an update was
// in flight" across the boundary that divergent exit destroys.
//
// Everything here is DELIBERATELY UNGATED — no `#[cfg(target_os = ...)]`. A
// cfg'd body in this file is parsed but never type-checked on other hosts
// (cfg-stripping runs before name resolution), so gated logic would be proven
// by nothing until CI's three-OS `rust-test` matrix. Keeping the logic in
// ungated helpers that take `&Path` / `&str` is what makes `cargo test` on any
// one host actually mean something.
// ---------------------------------------------------------------------------

/// Marker file recording an in-flight update, written beside the `autostart-seen`
/// marker at the app-data root.
const PENDING_UPDATE_MARKER: &str = "update-pending.json";

/// Contents of [`PENDING_UPDATE_MARKER`]. Rust-only file, never read by the
/// sidecar or the WebView, so the field names stay snake_case.
///
/// `ts` is DIAGNOSTIC ONLY — nothing branches on it. It exists so a support log
/// can say when the attempt happened; adding a staleness rule here would be a
/// behaviour change, not a tidy-up.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct PendingUpdateMarker {
    target_version: String,
    ts: u64,
}

/// What the boot-time read concluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingUpdateVerdict {
    /// No marker, or one too damaged to trust. Nothing to say.
    NoMarker,
    /// The running version matches the version we were installing.
    Completed,
    /// A marker survived and we are NOT running the version it names.
    MayHaveFailed,
}

/// Shape guard for a version string read back off disk. READER-SIDE ONLY.
///
/// The writer deliberately does not validate, so an unusual-but-legitimate
/// version fails toward SILENCE (written, then read back as `NoMarker` and
/// deleted) rather than toward a false "your update may not have completed".
/// Validating on the write side too would produce the same silence with an
/// extra branch. The `debug` log is what leaves a trace if this ever bites.
fn plausible_version(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '+' || c == '-')
}

/// Pure verdict function — no I/O, no Tauri types, total over well-formed input.
///
/// Normalization (trim, strip one leading `v`) is defence-in-depth: the version
/// we write comes from `Update::version`, which the plugin has already
/// normalized. It costs nothing and removes a whole class of "nagged after a
/// successful update" bug if that ever stops being true.
///
/// KNOWN RESIDUAL, and it is the one most likely to be hit: this answers "did
/// the shell binary's version change", NOT "did the update complete". A Windows
/// half-install where NSIS replaced `Tandem.exe` but not `node-sidecar.exe` —
/// a state `perform_install` explicitly tolerates, see the "still locked" and
/// "still responding" warnings — lands here as `Completed`. Recorded in ADR-043
/// beside "no rollback". Closing it needs the marker to carry an expected
/// sidecar version, which is a different change.
fn classify_pending_update(
    marker: Option<PendingUpdateMarker>,
    running_version: &str,
) -> PendingUpdateVerdict {
    let Some(marker) = marker else {
        return PendingUpdateVerdict::NoMarker;
    };
    // `trim()` here is belt-and-braces for the `running_version` side;
    // whitespace on the marker side is already screened upstream by
    // `read_pending_update_marker`, which trims before its shape guard.
    let normalize = |s: &str| {
        let t = s.trim();
        t.strip_prefix('v').unwrap_or(t).to_string()
    };
    if normalize(&marker.target_version) == normalize(running_version) {
        PendingUpdateVerdict::Completed
    } else {
        PendingUpdateVerdict::MayHaveFailed
    }
}

/// Write the marker. Returns `Result` ONLY so tests can assert on it — the
/// production caller discards it, because a marker write must never fail an
/// update (#1118: "best-effort").
///
/// The timestamp is computed here rather than by the caller so the panic audit
/// has one function to read. `.unwrap_or_default()` is load-bearing, not
/// idiom: `duration_since(UNIX_EPOCH)` errors on a clock set before the epoch,
/// and the idiomatic `.unwrap()` would panic INSIDE a closure unwinding through
/// the plugin's `download()`, aborting the tokio task so that NEITHER match arm
/// in `perform_install` runs and no error dialog ever appears — a silently
/// failed update, exactly what this issue exists to prevent.
///
/// Not atomic, and deliberately so: `cowork_atomic_json::with_locked_json` is
/// Windows-only AND carries a 30-second exclusive-lock budget, and a marker
/// write that can stall an update by 30s is the regression #1118 forbids. The
/// reachable bad states without it (truncate-then-die, ext4 delayed-allocation
/// zero-fill) are both parse failures, and both are swept by the unconditional
/// clear in `evaluate_pending_update_marker`.
fn write_pending_update_marker(dir: &std::path::Path, target_version: &str) -> std::io::Result<()> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let marker = PendingUpdateMarker {
        target_version: target_version.to_string(),
        ts,
    };
    let body = serde_json::to_string(&marker)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(PENDING_UPDATE_MARKER), body)
}

/// Read the marker. TOTAL — returns `Option`, never `Result`.
///
/// Missing dir, missing file, permission error, non-UTF-8, 0-byte, malformed
/// JSON, missing fields and implausible versions all collapse to `None`, so a
/// corrupt marker can never fail a boot. Owning the shape guard here is what
/// lets `classify_pending_update` stay total over well-formed input.
fn read_pending_update_marker(dir: &std::path::Path) -> Option<PendingUpdateMarker> {
    let raw = std::fs::read_to_string(dir.join(PENDING_UPDATE_MARKER)).ok()?;
    let mut marker: PendingUpdateMarker = serde_json::from_str(&raw).ok()?;
    // Trim BEFORE the guard, not after. `plausible_version` rejects every ASCII
    // space, so with the order reversed a marker carrying a stray trailing
    // newline would be screened out here and silently become `NoMarker` — the
    // failure would be invisible, and `classify_pending_update`'s own `trim()`
    // would be unreachable through the only real producer.
    marker.target_version = marker.target_version.trim().to_string();
    if !plausible_version(&marker.target_version) {
        log::debug!("Ignoring pending-update marker with implausible target_version");
        return None;
    }
    Some(marker)
}

/// Remove the marker. `true` when it is provably gone — removed, or already
/// absent.
///
/// No existence pre-check: that is what makes this a silent no-op on a clean
/// boot, which in turn is what lets `evaluate_pending_update_marker` call it
/// unconditionally on every verdict instead of carrying a "did a file exist"
/// discriminator that would widen the reader back into a `Result`.
fn clear_pending_update_marker(dir: &std::path::Path) -> bool {
    match std::fs::remove_file(dir.join(PENDING_UPDATE_MARKER)) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => {
            log::warn!("Could not remove pending-update marker: {e}");
            false
        }
    }
}

/// Buffered pending-update hint CODE, drained by the WebView.
///
/// A SEPARATE static from `STARTUP_REJECTION`, not a reuse: that buffer is one
/// last-write-wins slot, so sharing it would let a file-open rejection and an
/// update hint clobber each other.
///
/// Same buffer-then-payload-free-nudge shape and the same reason: this is
/// classified in `setup()`, before `App.svelte` exists at all, let alone its
/// listener. Emitting an event there drops silently on the exact failure mode it
/// is meant to surface. See `STARTUP_REJECTION` above for why "the WebView is
/// surely up by now" is not an inference we are allowed to make.
static PENDING_UPDATE_HINT: Mutex<Option<String>> = Mutex::new(None);

/// Run `f` against the hint buffer, recovering from (and reporting) a poisoned
/// mutex. Mirrors `with_rejection`; `.lock().unwrap()` is itself a panic path
/// and this code must not add one to the boot sequence.
fn with_pending_hint<R>(what: &str, f: impl FnOnce(&mut Option<String>) -> R) -> R {
    match PENDING_UPDATE_HINT.lock() {
        Ok(mut guard) => f(&mut guard),
        Err(poisoned) => {
            log::error!("PENDING_UPDATE_HINT mutex poisoned during {what} — recovering");
            f(&mut poisoned.into_inner())
        }
    }
}

/// Stable, path-free, version-free reason code for the pending-update banner.
const CODE_UPDATE_MAY_NOT_HAVE_COMPLETED: &str = "update-may-not-have-completed";

/// Payload-free nudge meaning "call `get_pending_update_hint`".
const EVENT_PENDING_UPDATE_HINT: &str = "pending-update-hint";

/// Buffer first, then nudge — split from the Tauri wrapper so the ORDERING is
/// testable without an `AppHandle`. A nudge that outran the buffer would hand a
/// live listener an empty slot and drop the hint permanently.
///
/// `&'static str`, not `&str`, and that is a safety property rather than a style
/// choice: it is what makes "a formatted string carrying a version or a path"
/// a compile error instead of something review has to notice. Same contract as
/// `buffer_startup_rejection_code`.
fn surface_pending_update_hint_with(code: &'static str, nudge: impl FnOnce()) {
    with_pending_hint("buffer", |slot| *slot = Some(code.to_string()));
    nudge();
}

/// Deliver a pending-update hint to the WebView.
fn surface_pending_update_hint(app: &tauri::AppHandle, code: &'static str) {
    surface_pending_update_hint_with(code, || {
        if let Err(e) = app.emit(EVENT_PENDING_UPDATE_HINT, ()) {
            // Already buffered, so the worst case is the banner waiting for the
            // client's init drain.
            log::warn!("Failed to emit {EVENT_PENDING_UPDATE_HINT}: {e}");
        }
    });
}

/// Client-drained accessor. TAKES, so a WebView reload cannot replay a banner
/// the user already saw.
#[tauri::command]
fn get_pending_update_hint() -> Option<String> {
    with_pending_hint("take", |slot| slot.take())
}

/// Record that an update install is in flight. Returns `()` — there is nothing
/// for the caller to inspect, propagate or `?`, which is what makes
/// "best-effort" a type-level property rather than a convention.
fn record_pending_update(app: &tauri::AppHandle, target_version: &str) {
    // NB: no `strip_win_prefix()` here, and that is deliberate. That rule
    // governs paths handed to the Node sidecar, which cannot resolve `\\?\`.
    // `std::fs` handles the extended-length prefix correctly, so stripping it
    // would be the bug.
    let dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("app_data_dir unavailable for pending-update marker: {e}");
            return;
        }
    };
    match write_pending_update_marker(&dir, target_version) {
        Ok(()) => log::info!("Recorded pending update to v{target_version}"),
        Err(e) => log::warn!("Could not write pending-update marker: {e}"),
    }
}

/// Drop the marker after an install failure that we OBSERVED in-process.
///
/// The `Err` arm already shows the user a native error dialog, so a surviving
/// marker would nag on the next boot about something they were told to their
/// face.
fn clear_pending_update(app: &tauri::AppHandle) {
    match app.path().app_data_dir() {
        Ok(dir) => {
            clear_pending_update_marker(&dir);
        }
        Err(e) => log::warn!("app_data_dir unavailable to clear pending-update marker: {e}"),
    }
}

/// Decide what to do with a verdict once the clear has been attempted.
///
/// Pure, so the policy is exhaustively testable without a filesystem that can
/// be made to fail `remove_file` — which is not something a test running as
/// root can arrange.
///
/// **A hint that cannot be made one-shot is worse than no hint.** If the clear
/// failed — a read-only app-data dir, a marker locked by an AV scanner or a
/// roaming-profile sync — the same `MayHaveFailed` verdict would fire on every
/// subsequent boot, and the take-once buffer would re-raise the banner each
/// time with no way for the user to stop it. That is the one residual FALSE
/// POSITIVE in this design, so it is suppressed rather than shipped: a missed
/// diagnostic is recoverable, a permanent un-dismissable nag is not.
fn verdict_after_clear(verdict: PendingUpdateVerdict, cleared: bool) -> PendingUpdateVerdict {
    if cleared {
        return verdict;
    }
    match verdict {
        PendingUpdateVerdict::MayHaveFailed => PendingUpdateVerdict::NoMarker,
        other => other,
    }
}

/// Boot-time evaluation, as an UNGATED seam over `&Path` / `&str`.
///
/// This exists as its own function for one reason: the one-shot clear is the
/// single invariant whose failure produces a permanent, every-boot,
/// un-dismissable nag for every affected user, and with the logic living inside
/// an `AppHandle`-taking function it was pinned by nothing — deleting the clear
/// outright left `cargo test`, the client suites, biome and typecheck all green.
/// The only thing that would have caught it was a hardware-gated manual smoke
/// bullet on the very platforms whose unavailability is why #1118 sat deferred.
/// Taking `&Path`/`&str` — the same seam every other helper in this module uses
/// — is what lets that invariant execute on every host and every CI leg.
///
/// Read → classify → clear → apply the suppression policy. Idempotent by
/// construction and with no latch: the read is destructive, so a second call
/// finds `NoMarker`, clears a file that is already gone, and hints nothing.
fn evaluate_pending_update_at(
    dir: &std::path::Path,
    running_version: &str,
) -> PendingUpdateVerdict {
    let verdict = classify_pending_update(read_pending_update_marker(dir), running_version);

    // Unconditional, on every verdict: `clear` is a no-op when absent, which is
    // how a corrupt marker gets removed without a "did a file exist" branch.
    // One-shot is the issue's explicit requirement ("never nag twice for the
    // same attempt"); the banner's own "Check for updates" CTA is the
    // remediation, and on a boot where the sidecar never came up it is the ONLY
    // one available for the next 8 hours (the launch-time `check_for_update`
    // sits behind `start_sidecar`'s failure `return`, and the periodic task
    // discards its first immediate tick).
    let cleared = clear_pending_update_marker(dir);
    if !cleared {
        log::error!(
            "Could not clear the pending-update marker — suppressing the hint rather than \
             raising a banner that would return on every boot with no way to dismiss it"
        );
    }
    verdict_after_clear(verdict, cleared)
}

/// Boot-time evaluation. Returns `()`; every step is either infallible or
/// `match`ed to a log line, so this cannot turn `setup()` into an `Err` and the
/// app can never fail to start because of the marker.
///
/// Runs in `setup()` rather than after `wait_for_health()` — which is what the
/// issue text suggested — because `start_sidecar`'s health-`Ok` arm is reached
/// ONLY when `wait_for_health` returns `Ok`, and a half-installed update IS a
/// boot where the sidecar does not come up healthy. Evaluating there would
/// suppress the hint on exactly the boots it exists for.
///
/// Everything decidable without Tauri lives in `evaluate_pending_update_at`;
/// what is left here is dir resolution, logging and the emit.
fn evaluate_pending_update_marker(app: &tauri::AppHandle) {
    let dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("app_data_dir unavailable to read pending-update marker: {e}");
            return;
        }
    };
    // `package_info().version` and NOT `env!("CARGO_PKG_VERSION")`. `env!` reads
    // Cargo.toml; the updater's own comparison baseline is
    // `app.package_info().version` (tauri.conf.json) — see
    // tauri-plugin-updater `updater.rs:169`. They agree today only because
    // `tests/plugin/plugin-version-pin.test.ts` pins both to package.json, and
    // reading a different field than the updater compares would turn a missed
    // surface in the six-surface version bump into a warning banner on every
    // user's machine after every successful update.
    let running = app.package_info().version.to_string();

    match evaluate_pending_update_at(&dir, &running) {
        PendingUpdateVerdict::NoMarker => {}
        PendingUpdateVerdict::Completed => {
            log::info!("Update to v{running} verified — clearing pending-update marker");
        }
        PendingUpdateVerdict::MayHaveFailed => {
            log::warn!("Pending-update marker survived an update — running v{running}");
            surface_pending_update_hint(app, CODE_UPDATE_MAY_NOT_HAVE_COMPLETED);
        }
    }
}

/// Tauri command — the pending-update banner's "Check for updates" CTA.
///
/// `async fn`, mirroring `install_update`: Tauri runs async commands on the
/// async runtime rather than the IPC thread, which matters because the manual
/// path reaches `show_update_available_dialog` and that ends in `blocking_show()`.
///
/// `manual: true` so the user gets immediate feedback on an explicit action —
/// including the "you're up to date" dialog, which on a failed-update boot is
/// itself useful information.
#[tauri::command]
async fn check_for_update_now(app: tauri::AppHandle) {
    check_for_update(&app, true).await;
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
struct PendingOpens(Mutex<Vec<ScreenedOpenPath>>);

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
pub(crate) fn promote_healthy_and_drain(state: &PendingOpens) -> Vec<ScreenedOpenPath> {
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
///
/// Also clears `SIDECAR_GAVE_UP` (#1416): this call marks the start of a new
/// attempt, and an open arriving during it must queue for the drain rather than
/// fail fast against a verdict the app has already withdrawn. `restart_sidecar`
/// calls this ~6s before `start_sidecar` begins (graceful stop first), so doing
/// it here rather than only at `start_sidecar`'s top closes that window.
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
    SIDECAR_GAVE_UP.store(false, Ordering::Release);
}

/// Clear the give-up latch under the `PendingOpens` mutex — "we are trying
/// again". Called as the FIRST statement of `start_sidecar`, which is what makes
/// a missed latch self-healing rather than a wedge: the retry dialog's callback
/// is explicitly not guaranteed to run (see `show_server_error_dialog`), so the
/// latch must never be the only thing standing between the user and a working
/// queue.
pub(crate) fn begin_start_attempt(state: &PendingOpens) {
    let _guard = match state.0.lock() {
        Ok(g) => g,
        Err(poisoned) => {
            log::error!("PendingOpens mutex poisoned during start-attempt clear — recovering");
            poisoned.into_inner()
        }
    };
    SIDECAR_GAVE_UP.store(false, Ordering::Release);
}

/// Report opens this attempt did not deliver, and latch the give-up when nothing
/// further will be attempted automatically (#1416).
///
/// **Non-destructive, and that is the contract.** The queue survives so a retry
/// can still deliver it: `show_server_error_dialog`'s retry deliberately threads
/// `cold_start_file` back in ("setup() FAILED, so nothing was opened"), and the
/// macOS Apple-Event paths live in this queue rather than in that argument — so
/// taking the queue here would mean the user performs a positive recovery action
/// that appears to succeed and still loses the file. The only take is
/// [`promote_healthy_and_drain`], which is a real delivery.
///
/// `terminal` means "no further attempt is offered from here" and controls only
/// the latch. `surface` is the injection seam, for the same reason
/// [`surface_startup_rejection_with`] has one: the real callers need an
/// `AppHandle`, which cannot be constructed in a unit test.
///
/// Returns the number of undelivered opens (0 = nothing was pending, and nothing
/// is surfaced — a failed restart of an app that never had a pending open must
/// not toast about files).
fn report_pending_opens_with(
    state: &PendingOpens,
    terminal: bool,
    surface: impl FnOnce(&'static str),
) -> usize {
    let pending = {
        let guard = match state.0.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                log::error!("PendingOpens mutex poisoned during report — recovering");
                poisoned.into_inner()
            }
        };
        if terminal {
            // Under the same lock as the producer's flag read, so a concurrent
            // `try_queue_or_post` either queues (before) or fails fast (after),
            // never lands in between.
            SIDECAR_GAVE_UP.store(true, Ordering::Release);
        }
        guard.len()
    };
    if pending == 0 {
        return 0;
    }
    // At `warn`, which is the release floor: this replaces #1414's abandoned-queue
    // line and covers every exit from `start_sidecar`, not just loop exhaustion.
    log::warn!(
        "{pending} queued file open(s) undelivered — the server did not start; the queue is \
         retained so a retry can still deliver them"
    );
    // DEFERRED, not failed: the queue survives, so the toast must not claim the
    // finality this log line explicitly denies. Same 1-vs-N collapse rule as
    // `RejectionBatch`, but over its own pair of codes.
    surface(if pending == 1 {
        CODE_OPEN_DEFERRED
    } else {
        CODE_MULTIPLE_DEFERRED
    });
    pending
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
pub(crate) fn try_queue_or_post(state: &PendingOpens, path: ScreenedOpenPath) -> OpenRoute {
    // Decide (and mutate the queue) under the lock; LOG AFTER the guard drops.
    // `log::warn!` is real blocking I/O in a release build — a file-sink write
    // plus `tauri-plugin-log`'s `TargetKind::Webview` emit — where the sibling
    // `info!` is a no-op below the `LevelFilter::Warn` floor. Doing it inside
    // would put the first blocking I/O into a critical section every producer
    // contends for, and an N-file Finder multi-select after a give-up would
    // serialise N of them. Mirrors `report_pending_opens_with`'s guard-then-log
    // shape.
    let mut note: Option<(bool, ScreenedOpenPath)> = None;
    let route = {
        let mut guard = match state.0.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                log::error!("PendingOpens mutex poisoned — recovering and queueing");
                poisoned.into_inner()
            }
        };
        if SIDECAR_HEALTHY.load(Ordering::Acquire) {
            // Healthy wins over the latch: a server that is answering makes any
            // earlier give-up verdict stale.
            OpenRoute::PostNow(path)
        } else if SIDECAR_GAVE_UP.load(Ordering::Acquire) {
            // Queueing here would be a promise nothing can keep — no drain is
            // coming. Say so instead of accumulating paths silently (#1416).
            note = Some((true, path));
            OpenRoute::ServerUnavailable
        } else {
            note = Some((false, path.clone()));
            guard.push(path);
            OpenRoute::Queued
        }
    };
    match note {
        Some((true, path)) => log::warn!(
            "Not opening {} — the server is unavailable and no start attempt is in flight",
            path.display()
        ),
        Some((false, path)) => {
            log::info!("Queueing file (sidecar not yet healthy): {}", path.display())
        }
        None => {}
    }
    route
}

/// What [`try_queue_or_post`] decided to do with one candidate path.
///
/// A named enum rather than `Result<(), PathBuf>`, where `Err(path)` confusingly
/// meant "success, POST it": there are three outcomes now, and a `match` makes a
/// mis-handled arm a compile error. That matters more than usual here because the
/// only non-test caller is macOS-only, and cfg-stripping runs before type
/// checking — so a Linux `cargo test` parse-checks that arm and nothing more.
///
/// `ServerUnavailable` deliberately carries no path: the caller turns it into a
/// path-free wire code, and the path is already logged.
#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
pub(crate) enum OpenRoute {
    /// Queued; the drain after the next successful health check delivers it.
    Queued,
    /// The sidecar is healthy — POST this path now.
    PostNow(ScreenedOpenPath),
    /// The app gave up on starting the server; nothing will drain a queue.
    ServerUnavailable,
}

/// Fetch the auth token off the reactor.
///
/// A keyring read is an XPC round-trip to `securityd` that can *write* on first
/// run; the callers below run on a tokio worker (or, for the Apple-Event batch,
/// used to run on the main event-loop thread), and neither is a place to block
/// synchronously. Mirrors `port_holder_for_dialog`'s `spawn_blocking` shape.
async fn best_effort_token_off_thread(context: &'static str) -> Option<String> {
    match tauri::async_runtime::spawn_blocking(move || best_effort_token(context)).await {
        Ok(token) => token,
        Err(e) => {
            log::warn!("Token retrieval task failed for {context}: {e}");
            None
        }
    }
}

/// POST a batch of paths to `/api/open` and surface the outcome to the user
/// EXACTLY ONCE (#1416).
///
/// Failures used to be `log::warn!`-only, which in a release build
/// (`LevelFilter::Warn` floor, `tandem.log`) is a file the user never opens: they
/// double-clicked a document, the window came forward, and they were looking at
/// `welcome.md` with no explanation. The server refuses things the Rust validator
/// cannot see — a 50 MB cap, UNC paths, an unreadable-by-permissions file, a
/// `.docx` the parser rejects — so this is a reachable class, not a corner.
///
/// `batch` comes IN rather than starting empty: validation rejections and
/// delivery failures from the same OS batch must resolve through one accumulator,
/// or a mixed Finder multi-select writes twice into the one-slot
/// `STARTUP_REJECTION` buffer and the toast the user sees depends on where the
/// client's async drain lands (the race `RejectionBatch` exists to remove).
///
/// Generic over both the poster and the sink so it is unit-testable with neither
/// an HTTP server nor an `AppHandle` — the same seam, for the same reason, as
/// [`surface_startup_rejection_with`]. The `Send` bounds and `&'static str` are
/// load-bearing: real callers hand the returned future to
/// `tauri::async_runtime::spawn`, which requires `Future + Send + 'static`, while
/// the test's `block_on` imposes neither — so without them the test would compile
/// and the call sites would not.
async fn post_paths_and_surface<F, Fut>(
    what: &'static str,
    paths: Vec<ScreenedOpenPath>,
    mut batch: RejectionBatch,
    post: F,
    surface: impl FnOnce(&'static str) + Send,
) where
    F: Fn(ScreenedOpenPath) -> Fut + Send,
    Fut: std::future::Future<Output = Result<(), String>> + Send,
{
    for path in paths {
        if let Err(e) = post(path.clone()).await {
            log::warn!("request_open_file ({what}) failed for {}: {e}", path.display());
            batch.record(CODE_OPEN_FAILED);
        }
    }
    if let Some(code) = batch.resolve() {
        surface(code);
    }
}

/// [`post_paths_and_surface`] bound to a live app: this is where the closures
/// live, so the macOS-only Apple-Event arm can be a single `spawn` of a named
/// function with none.
///
/// That is not a style preference. `handle_opened_urls` is `#[cfg(target_os =
/// "macos")]` and cfg-stripping happens during expansion, before name resolution
/// and type checking — a type error, a borrow error or a wrong arity inside it
/// compiles clean on Linux and Windows with only a dead-code warning. Its real
/// gate is the `rust-test (macos-latest)` leg of CI, so the less that lives
/// there, the less rides on one CI leg.
async fn post_batch_for_app(
    what: &'static str,
    app: tauri::AppHandle,
    paths: Vec<ScreenedOpenPath>,
    batch: RejectionBatch,
) {
    if paths.is_empty() {
        // Surface first, THEN return: a fully-rejected or fully-queued batch still
        // has something to say, it just has nothing to POST — and this is what
        // keeps the keyring read off that path (it is the common shape of the
        // realistic user error since #1344: a double-clicked .pdf, a stale alias).
        if let Some(code) = batch.resolve() {
            surface_startup_rejection(&app, code);
        }
        return;
    }
    let client = app.state::<reqwest::Client>().inner().clone();
    // Fetched once per batch, after the guard above. The at-most-once, lazy and
    // failure-memoised properties the old `batch_token` memo hand-rolled are
    // structural here: there is one fetch site, and it is unreachable when there
    // is nothing to POST. Falls back to anonymous on failure; loopback bypasses
    // Bearer enforcement, so that is non-fatal.
    let token = best_effort_token_off_thread(what).await;
    post_paths_and_surface(
        what,
        paths,
        batch,
        // Hoisted-then-cloned deliberately: an `Fn` closure may only borrow, so a
        // bare `async move` over the captured `token` is E0507.
        |path| {
            let client = client.clone();
            let token = token.clone();
            async move { request_open_file(&client, token.as_deref(), &path).await }
        },
        |code| surface_startup_rejection(&app, code),
    )
    .await;
}

/// Handle a batch of file URLs delivered via macOS `RunEvent::Opened` (Apple
/// Event `kAEOpenDocuments`). Posts directly when the sidecar is healthy,
/// queues when it is not.
#[cfg(target_os = "macos")]
fn handle_opened_urls(app: &tauri::AppHandle, urls: Vec<tauri::Url>) {
    // Deliberately BEFORE validation: a fully-rejected batch still needs a
    // visible window, because the thing it produces is a toast.
    show_main_window_for_user(app);
    // ONE accumulator for everything this batch resolves SYNCHRONOUSLY —
    // validation refusals, opens that arrived after the app gave up, and (inside
    // `post_batch_for_app`) delivery failures. Those must produce exactly one
    // surface call: two would write twice into the one-slot buffer and the user
    // would see a count badge whose value depends on where the client's async
    // drain landed. Paths that come back `Queued` are NOT in that set — their
    // verdict arrives later from `report_pending_opens_with`, and the client's
    // per-code dedup key is what keeps the two from merging. See
    // `RejectionBatch` and #1416.
    let mut rejected = RejectionBatch::default();
    let mut direct: Vec<std::path::PathBuf> = Vec::new();
    for url in urls {
        match classify_opened_url(&url) {
            // try_queue_or_post serializes the SIDECAR_HEALTHY check + the push
            // through the same mutex used by promote_healthy_and_drain. This is
            // the load-bearing piece of the drain-race fix: any producer that
            // acquires the lock either pushes (and gets drained) or sees
            // flag=true (and is handed back the path to POST directly). No
            // load-before-push window remains.
            Ok(path) => match try_queue_or_post(app.state::<PendingOpens>().inner(), path) {
                OpenRoute::Queued => {}
                OpenRoute::PostNow(path) => direct.push(path),
                OpenRoute::ServerUnavailable => rejected.record(CODE_OPEN_FAILED),
            },
            Err(reason) => {
                log::warn!("Ignoring URL from Opened event ({reason}): {url}");
                rejected.record(opened_url_reason_code(&reason));
            }
        }
    }
    // Unconditional, and deliberately a bare `spawn` of a named function: this
    // arm is compiled only on macOS, so everything that can fail to type-check
    // belongs in `post_batch_for_app`, which has ungated callers. It surfaces
    // `rejected` even when there is nothing to POST.
    tauri::async_runtime::spawn(post_batch_for_app("Opened", app.clone(), direct, rejected));
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
                    // A failure here used to be `log::warn!`-only: the window came
                    // forward showing the previous tabs and nothing said the file
                    // had not opened (#1416). One path, so the batch resolves to
                    // the singular `open-failed`.
                    tauri::async_runtime::spawn(post_batch_for_app(
                        "second-instance",
                        app.clone(),
                        vec![path],
                        RejectionBatch::default(),
                    ));
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
            let cold_start_file: Option<ScreenedOpenPath> = {
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

            // #1118: read the pending-update marker before anything else starts.
            // Deliberately here and not after `wait_for_health()` (which is what
            // the issue text suggested): `start_sidecar` reaches its health-`Ok`
            // arm only when `wait_for_health` returns `Ok`, and a half-installed
            // update IS a boot where the sidecar does not come up healthy — so
            // evaluating there would suppress the hint on exactly the boots it
            // exists for. Same position and same reasoning as the
            // `surface_startup_rejection` call above: no listener is wired yet in
            // `setup()`, which is precisely the case the buffer covers.
            evaluate_pending_update_marker(app.handle());

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Copy sample files BEFORE sidecar spawn so the server's
                // auto-open finds them during its startup sequence
                if let Err(e) = copy_sample_files(&handle) {
                    log::warn!("Sample file copy failed (non-fatal): {e}");
                }

                // Hold RESTART_IN_PROGRESS across the initial spawn. The window
                // mounts while this is still looping — and that loop is now up
                // to ~2 minutes (HEALTH_TIMEOUT 30s x 4 attempts) — so Settings
                // → Network → Restart server is clickable the whole time. Without
                // the gate, `restart_sidecar` would find it free and run a second
                // start_sidecar concurrently, racing this one over SidecarState
                // and orphaning a child. That is the exact failure the gate was
                // added for; only this call site was outside it.
                // CAS rather than a bare store, and release only what we took:
                // a blind store would clear a gate held by someone else. And if
                // the gate is already held — some other path won the race before
                // we got here — we must NOT run start_sidecar anyway: doing so
                // is the exact concurrent-spawn failure this gate exists to
                // prevent, just from the other direction. Skip, like
                // `restart_sidecar` itself does on a gate miss.
                if RESTART_IN_PROGRESS
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
                {
                    log::warn!(
                        "initial start_sidecar found RESTART_IN_PROGRESS already held — skipping to avoid a concurrent spawn"
                    );
                    return;
                }
                let start_result = start_sidecar(&handle, &client, cold_start_file.as_deref()).await;
                RESTART_IN_PROGRESS.store(false, Ordering::Release);

                if let Err(e) = start_result {
                    log::error!("Sidecar failed: {e}");
                    // NOT terminal: the dialog below offers "Retry Server Start",
                    // which re-runs `start_sidecar` with the queue intact. So this
                    // warns (evidence for every exit, including the five `?`
                    // bail-outs the old tail block sat past) without latching and
                    // without destroying anything. The latch is set on the Close
                    // branch of that dialog instead. #1416
                    report_pending_opens_with(
                        handle.state::<PendingOpens>().inner(),
                        false,
                        |_code| {
                            // Deliberately no toast here: the modal is about to say
                            // the server failed and offer the retry that would open
                            // these files. "Some of those files couldn't be opened"
                            // alongside it would contradict the button.
                        },
                    );
                    // Ask the OS what is actually holding the port instead of
                    // telling the user to go find out.
                    let holder = port_holder_for_dialog().await;
                    show_server_error_dialog(&handle, &e, holder, cold_start_file, true);
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
            get_pending_update_hint,
            check_for_update_now,
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
            // The emitted event carries a stable code, no error detail, so the
            // WebView's toast can never leak paths, env vars, errno text, or
            // the auth token.
            //
            // NB: "the detail stays in the log sink" is not the same as "the
            // detail is not user-visible" — `tauri-plugin-log` registers
            // `TargetKind::Webview` at LevelFilter::Warn in release, so this
            // `log::error!` is forwarded to the WebView as a `log://log` event
            // (nothing in src/client currently listens). The emit below is what
            // carries the contract; the log line is not a second, quieter
            // channel. Keep sensitive detail out of both.
            log::error!("[restart_sidecar] failed to restart sidecar: {e}");
            eprintln!("[restart_sidecar] failed to restart sidecar: {e}");
            // Terminal: nothing retries automatically from here. The queue is
            // retained (Settings -> Network -> Restart server still delivers it),
            // but until someone tries again a further open must fail fast rather
            // than join a queue with no consumer. #1416
            report_pending_opens_with(handle.state::<PendingOpens>().inner(), true, |code| {
                surface_startup_rejection(&handle, code)
            });
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

/// Look up the port holder for the error dialog, off the reactor and bounded.
///
/// Two guards, both load-bearing on Windows: `spawn_blocking` because
/// `describe_port_holder` runs external processes synchronously, and a
/// timeout because it runs them with no deadline of their own. A wedged
/// `netstat` (huge connection table, a misbehaving NDIS/LSP filter) must not
/// stop the user from getting a dialog at all — a generic message beats
/// silence on the one path whose entire job is to tell the user something
/// went wrong. On other platforms `describe_port_holder` is a pure `None`
/// stub, so the async/timeout machinery would only add ceremony around a
/// function that can't block or panic.
#[cfg(not(target_os = "windows"))]
async fn port_holder_for_dialog() -> Option<PortHolder> {
    describe_port_holder(&[WS_PORT, MCP_PORT])
}

#[cfg(target_os = "windows")]
async fn port_holder_for_dialog() -> Option<PortHolder> {
    let lookup = tauri::async_runtime::spawn_blocking(|| describe_port_holder(&[WS_PORT, MCP_PORT]));
    match tokio::time::timeout(PORT_HOLDER_LOOKUP_TIMEOUT, lookup).await {
        Ok(Ok(holder)) => holder,
        Ok(Err(e)) => {
            log::debug!("Port-holder lookup panicked: {e}");
            None
        }
        Err(_) => {
            log::warn!("Port-holder lookup timed out — showing the generic message");
            None
        }
    }
}

/// Parent a dialog builder to the main window if it exists, else warn and
/// leave it parentless. Shared by every `show_*_dialog` function below —
/// `fn_name` names the caller in the log line so a parentless dialog is
/// traceable to which one fired.
fn attach_main_window_or_warn<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    builder: tauri_plugin_dialog::MessageDialogBuilder<R>,
    fn_name: &str,
) -> tauri_plugin_dialog::MessageDialogBuilder<R> {
    match app.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(window) => builder.parent(&window),
        None => {
            log::warn!("{fn_name}: main window not found — dialog will appear parentless");
            builder
        }
    }
}

/// The terminal "your server didn't start" dialog, with a one-shot retry.
///
/// This is the dialog a user hits after a Windows auto-update when the old
/// sidecar's port hasn't released yet. Two things it does that the previous
/// version did not:
///
/// 1. **Names the holder.** `holder` comes from `describe_port_holder`, so the
///    message says "Port 3479 appears to be held by node.exe (PID 12345)"
///    instead of asking the user to run `netstat` themselves.
/// 2. **Offers a retry** (`allow_retry`), which re-runs `start_sidecar` — whose
///    freshly spawned sidecar calls `freePort()` on both ports as its first act.
///    The kill therefore stays in `src/server/platform.ts`, its single owner; a
///    second `taskkill` implementation here would duplicate that logic AND add a
///    PID-reuse race whose bad outcome is killing the wrong process. Note this
///    dialog only appears after `start_sidecar` already ran that same
///    `freePort()` up to MAX_RESTARTS+1 times without success — the retry's
///    real new leverage is elapsed time, not a fresh kill mechanism, so the
///    message text says "try to end", not "will end".
///
/// `allow_retry: false` on the second showing — an unbounded retry loop at ~2
/// minutes a cycle is worse than an honest dead end, and the dead end names the
/// real remaining exit (Settings → Network → Restart server).
///
/// Non-blocking `.show(cb)` deliberately: `blocking_show()` from inside a
/// `tauri::async_runtime::spawn` task parks this task's worker (see
/// `show_update_available_dialog`'s doc comment), and the callback form is what
/// lets the retry spawn async work. Note the callback's `bool` is `true` only
/// for the first (OK) label — Esc and the title-bar X both arrive as `false`,
/// i.e. as Close.
fn show_server_error_dialog(
    app: &tauri::AppHandle,
    error: &str,
    holder: Option<PortHolder>,
    cold_start_file: Option<ScreenedOpenPath>,
    allow_retry: bool,
) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let mut message = format!("Tandem's server failed to start.\n\nError: {error}\n\n");
    match &holder {
        Some(h) => message.push_str(&h.message()),
        None => message.push_str(&format!(
            "Ports {WS_PORT} and {MCP_PORT} must be free for Tandem's server to start."
        )),
    }
    if allow_retry {
        // Say what the retry will actually DO. When we have identified a live
        // process, retrying attempts to terminate it — "free the port" does
        // not read as "end node.exe, discarding its unsaved state" to a
        // non-technical user, and the likeliest collision in this codebase's
        // own workflow is a dev server the user cares about. "Attempts" rather
        // than a flat promise: by the time this dialog shows, `start_sidecar`
        // has already run `freePort()` against this same holder up to
        // MAX_RESTARTS+1 times without success, so a holder that survived all
        // of those (elevated/protected, or something that respawns) may well
        // survive one more — don't claim certainty the mechanism hasn't earned.
        // When the port is merely in TIME_WAIT there is nothing to kill and
        // the retry works only because time passed; promising to "free the
        // port" there would be a lie.
        match holder.as_ref().and_then(|h| h.killable_process()) {
            Some(proc) => message.push_str(&format!(
                "\n\nRetry Server Start will try to end {proc} and start Tandem's server again. \
                 This can take up to two minutes."
            )),
            None => message.push_str(
                "\n\nRetry Server Start will try again, which usually succeeds once Windows \
                 has released the port. This can take up to two minutes.",
            ),
        }
    } else {
        message.push_str(
            "\n\nClose this dialog, then use Settings \u{2192} Network \u{2192} Restart server \
             to try again.",
        );
    }

    let mut builder = app
        .dialog()
        .message(message)
        .title("Server Error")
        .kind(MessageDialogKind::Error);
    builder = attach_main_window_or_warn(app, builder, "show_server_error_dialog");

    if !allow_retry {
        builder.show(|_| {});
        return;
    }

    // "Retry Server Start", not "Retry": the WebView shows its own Retry button
    // in the "Server unavailable" empty state ~3s into this failure, and that
    // one only re-dials the Hocuspocus WebSocket. Two same-labelled buttons
    // meaning different things is worse than a longer label.
    let handle = app.clone();
    let declined_handle = app.clone();
    builder
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Retry Server Start".to_string(),
            "Close".to_string(),
        ))
        .show(move |retry| {
            if !retry {
                // Declining the retry is what makes the failure terminal, and it
                // is decided here rather than at the `start_sidecar` call site —
                // that site cannot know which button the user will press. Without
                // this arm the latch never fires on the cold-start path, so the
                // SECOND double-clicked file queues into a queue with no consumer
                // and is silent at `info`, below the release log floor: verbatim
                // the #1416 bug, one file later. The toast also lands here rather
                // than before the modal, i.e. at the moment it becomes true.
                report_pending_opens_with(
                    declined_handle.state::<PendingOpens>().inner(),
                    true,
                    |code| surface_startup_rejection(&declined_handle, code),
                );
                return;
            }
            tauri::async_runtime::spawn(async move {
                // Take the gate INSIDE the task, not around the `.show()` call:
                // the plugin discards `run_on_main_thread` errors and its dialog
                // thread can unwind, so a callback is not guaranteed to run. A
                // gate acquired outside would then be stranded for the process
                // lifetime, permanently disabling `restart_sidecar`.
                if RESTART_IN_PROGRESS
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
                {
                    // Do not just log: the modal is already dismissed, so a
                    // bare return means the user's explicit click produced
                    // nothing at all on screen. (Reachable when they hit
                    // Settings → Network → Restart server first.)
                    log::warn!("Server-start retry ignored — a restart is already in flight");
                    show_server_error_dialog(
                        &handle,
                        "A server restart is already in progress",
                        None,
                        cold_start_file,
                        false,
                    );
                    return;
                }
                let client = handle.state::<reqwest::Client>().inner().clone();
                // Pass the cold-start file through, unlike `restart_sidecar`,
                // which passes None because setup() already opened it. Here
                // setup() FAILED, so nothing was opened — dropping it would
                // silently land a user who double-clicked a .md on welcome.md.
                let result = start_sidecar(&handle, &client, cold_start_file.as_deref()).await;
                // Release before anything user-facing, so Settings → Restart
                // server is usable again while the second dialog is on screen.
                RESTART_IN_PROGRESS.store(false, Ordering::Release);

                match result {
                    Ok(()) => {
                        log::info!("Server-start retry succeeded");
                        // setup()'s failure path returned before this; without
                        // it a recovered session gets no update check for 8h.
                        check_for_update(&handle, false).await;
                    }
                    Err(e) => {
                        log::error!("Server-start retry failed: {e}");
                        // Terminal: the second dialog is `allow_retry = false`.
                        report_pending_opens_with(
                            handle.state::<PendingOpens>().inner(),
                            true,
                            |code| surface_startup_rejection(&handle, code),
                        );
                        let holder = port_holder_for_dialog().await;
                        show_server_error_dialog(&handle, &e, holder, cold_start_file, false);
                    }
                }
            });
        });
}

/// True when `path` is a UNC / network path, in either separator flavour.
///
/// Pure string test with no syscall, for the reason `windows-path-safety.ts`
/// documents once for the whole codebase: on Windows the syscall IS the threat.
/// Callers must run this *before* touching the filesystem, never on the result
/// of resolving it (#1417).
///
/// Deliberately stricter than `cowork_workspace_scan::is_unc_path`, which
/// permits `\\?\C:\…` because containment under %LOCALAPPDATA% confines it.
/// Here there is no containment to lean on, and `strip_win_prefix()` is
/// supposed to have removed the extended-length prefix upstream anyway, so the
/// blunt form is correct: a false reject costs a failed "reveal in Explorer",
/// a false accept costs a credential hash.
///
/// Matches on "two leading separators, either flavour" rather than on the two
/// homogeneous pairs. Windows treats `/` and `\` as interchangeable, so
/// `/\host\share` and `\/host/share` are UNC too — enumerating `\\` and `//`
/// alone was a two-character bypass of this and of both TypeScript predicates
/// (#1417).
pub(crate) fn is_unc_or_network_path(path: &str) -> bool {
    let mut chars = path.chars();
    matches!(
        (chars.next(), chars.next()),
        (Some('\\' | '/'), Some('\\' | '/'))
    )
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
    // #1417: `path` is a raw string from the webview, and `explorer /select,…`
    // makes EXPLORER perform the SMB handshake on our behalf — the credential
    // leak happens in a process we do not control and never see fail. Needs
    // editor XSS or a compromised client to reach, so this is defence in depth,
    // but it is one string comparison against a hash disclosure.
    if is_unc_or_network_path(&path) {
        return Err("Refusing to reveal a network path in the file manager.".to_string());
    }
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
    // FIRST statement, before the debug fast path below returns: this call IS the
    // new attempt, so any earlier give-up verdict is withdrawn here. A clear
    // written after the fast path would never run on it. See `begin_start_attempt`.
    begin_start_attempt(handle.state::<PendingOpens>().inner());

    // Debug-only: skip spawn if a server is already running (e.g. `npm run dev:standalone`
    // alongside `cargo tauri dev`). In release builds the installed app must own its
    // sidecar exclusively — a stale `tsx watch` dev session, an older release process,
    // or any other listener on the MCP/WS ports can answer /health but be incompatible
    // with this app's auth token / session state, leaving the UI stuck on "Disconnected".
    // The sidecar's own `freePort()` step on start handles port conflicts cleanly.
    if cfg!(debug_assertions) && check_health(&client).await {
        log::info!("Server already healthy — skipping sidecar spawn (debug build)");
        // Promote + drain here too, or this early return is a silent hole: the
        // server IS healthy, we just did not spawn it, so `SIDECAR_HEALTHY` would
        // stay false forever and every Apple-Event open would queue with no
        // consumer — no tab, no toast, and nothing above the release log floor.
        // Dev-only, but it is the one door in #1416 with nothing on screen at all.
        let drained = promote_healthy_and_drain(handle.state::<PendingOpens>().inner());
        post_batch_for_app("drain", handle.clone(), drained, RejectionBatch::default()).await;
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
                post_batch_for_app("drain", handle.clone(), drained, RejectionBatch::default())
                    .await;

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

    // #1414's abandoned-queue warn used to live here. It has moved to
    // `report_pending_opens_with`, called from every `start_sidecar` caller —
    // this block sat AFTER the retry loop, so the five `?` bail-outs above
    // (resource_dir, app_data_dir, `.sidecar()`, `.spawn()`, the SidecarState
    // lock) returned before it and produced no evidence at all. It also TOOK the
    // queue, which destroyed the very paths the "Retry Server Start" button
    // exists to deliver (#1416). The queue is now retained; the caller reports
    // cover every exit, including this one.
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

/// One parsed `netstat -ano` TCP row, reduced to the fields that decide whether
/// it contends with our bind.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
struct NetstatRow {
    local_port: u16,
    /// True when the row is a listening socket. Windows LOCALIZES the State
    /// column, so this is not just a string compare: a foreign address of
    /// `0.0.0.0:0` / `[::]:0` is the structural signature of a listener and no
    /// connected state produces it.
    listening: bool,
    pid: u32,
}

/// Parse one `netstat -ano` line, keeping only rows that could block a bind on
/// our loopback address.
///
/// Two subtleties, both regression-tested:
/// - The port is taken from the LAST `:` of the local-address column, not by
///   substring match — a substring match also hits `:34790` and the `[::]` prefix.
/// - A listener on a specific non-loopback interface (WSL/Hyper-V vEthernet,
///   Docker, a VPN adapter) does NOT prevent a `127.0.0.1` bind, so naming it
///   would blame an innocent process for a failure it did not cause.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_netstat_row(line: &str) -> Option<NetstatRow> {
    // Proto | Local Address | Foreign Address | State | PID
    let cols: Vec<&str> = line.split_whitespace().collect();
    if cols.len() < 5 || !cols[0].eq_ignore_ascii_case("TCP") {
        return None;
    }
    let (local_addr, local_port_str) = cols[1].rsplit_once(':')?;
    if !matches!(local_addr, "127.0.0.1" | "0.0.0.0" | "[::]" | "[::1]") {
        return None;
    }
    let local_port = local_port_str.parse::<u16>().ok()?;
    let foreign_port = cols[2].rsplit_once(':').and_then(|(_, p)| p.parse::<u16>().ok());
    // The PID is parsed as u32, which is what makes it safe to interpolate into
    // the tasklist filter later: a u32's Display output is `[0-9]+` by
    // construction, so no metacharacter can survive. This is the typed
    // equivalent of the `/^\d+$/` guard in src/server/platform.ts.
    let pid = cols[4].parse::<u32>().ok()?;
    Some(NetstatRow {
        local_port,
        listening: cols[3].eq_ignore_ascii_case("LISTENING") || foreign_port == Some(0),
        pid,
    })
}

/// Shared scan behind `parse_netstat_listening_pid` and
/// `parse_netstat_lingering_port` below: find the first row matching one of
/// `ports` whose `listening` flag equals `listening`. The two callers differ
/// only in which flag value they want and what they extract from the match.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn find_netstat_row(output: &str, ports: &[u16], listening: bool) -> Option<NetstatRow> {
    output.lines().find_map(|line| {
        let row = parse_netstat_row(line)?;
        (row.listening == listening && ports.contains(&row.local_port)).then_some(row)
    })
}

/// Parse `netstat -ano` output for a process LISTENING on one of `ports`.
/// Returns the first `(port, pid)` match in output order.
///
/// Kept out of the `cfg(windows)` block so its tests run on every CI platform;
/// the allow keeps a non-Windows release build warning-free.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_netstat_listening_pid(output: &str, ports: &[u16]) -> Option<(u16, u32)> {
    find_netstat_row(output, ports, true).map(|row| (row.local_port, row.pid))
}

/// Find a port held by a lingering CONNECTION rather than by a live listener —
/// the Windows TIME_WAIT case.
///
/// This is the failure that motivated the whole change and it is invisible to
/// the function above: a killed listener leaves no LISTENING row, but its
/// accepted connections sit in TIME_WAIT (owner PID 0) and Windows still
/// refuses a fresh bind on that port. Without this pass the dialog falls back
/// to generic text in exactly the headline scenario.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_netstat_lingering_port(output: &str, ports: &[u16]) -> Option<u16> {
    find_netstat_row(output, ports, false).map(|row| row.local_port)
}

/// Parse the image name out of `tasklist /NH /FO CSV` output.
///
/// Returns None for the `INFO: No tasks are running which match…` line that
/// tasklist prints — on exit code 0 — when the PID no longer exists.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_tasklist_image_name(output: &str) -> Option<String> {
    for line in output.lines() {
        let line = line.trim();
        // CSV rows are quoted: `"node.exe","12345","Console","1","50,000 K"`.
        // Anything not starting with a quote is a header, an INFO line, or an
        // ERROR line — never a row.
        let Some(rest) = line.strip_prefix('"') else {
            continue;
        };
        let Some((name, _)) = rest.split_once('"') else {
            continue;
        };
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    None
}

/// Run a Windows system binary and capture stdout, or None on any failure.
///
/// Anchored to `%SystemRoot%\System32\` rather than resolved through PATH:
/// `Command::new("netstat")` searches the application directory (and, absent
/// `NoDefaultCurrentDirectoryInExePath`, the cwd) ahead of System32, and both
/// binaries are guaranteed at the fixed path. CREATE_NO_WINDOW keeps a
/// GUI-subsystem app from flashing a console window.
///
/// Fails CLOSED when `SystemRoot` is unset, empty, or non-UTF-8: falling back to
/// the bare name would do exactly the unanchored PATH lookup this exists to
/// avoid, and `SystemRoot` is a per-process env var that an unelevated launcher
/// can set before starting an elevated app. Every caller degrades to generic
/// text on None, so a skipped diagnostic costs nothing. (`freePortWindows` in
/// src/server/platform.ts makes the opposite call, deliberately — its lookup is
/// load-bearing for startup rather than cosmetic.)
#[cfg(target_os = "windows")]
fn run_system32_tool(exe: &str, args: &[&str]) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let root = std::env::var("SystemRoot").ok()?;
    if root.trim().is_empty() {
        return None;
    }
    let program = format!("{root}\\System32\\{exe}");
    let output = std::process::Command::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    // netstat/tasklist both report "nothing matched" on exit 0, so a non-zero
    // status is a genuine tool failure and the parsers handle the empty case.
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// What is holding one of the sidecar's ports, and whether the retry can do
/// anything about it. An enum rather than a `{ message, killable_process }`
/// struct deliberately: those two fields were only ever kept in sync by both
/// return sites of `describe_port_holder` being written carefully by hand —
/// nothing stopped a future construction site from naming a process in
/// `message` while leaving `killable_process` `None`, which is exactly the
/// kind of contradictory-dialog bug this type exists to prevent. With the
/// population as the only source of truth, `message()` and
/// `killable_process()` below derive both user-facing strings from the same
/// value, so that drift is unrepresentable rather than merely avoided.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) enum PortHolder {
    /// A live process we can name and that a retry would terminate.
    Listener { port: u16, pid: u32, name: Option<String> },
    /// Windows TIME_WAIT: the old sidecar is gone, so there is no owning
    /// process, but the OS hasn't released the port yet. Nothing to kill;
    /// the retry works only because time passed.
    Lingering { port: u16 },
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
impl PortHolder {
    /// User-facing sentence, already hedged. Never logged or emitted — it goes
    /// straight into the native dialog.
    fn message(&self) -> String {
        match self {
            PortHolder::Listener { port, pid, name } => {
                format!("Port {port} appears to be held by {}.", describe_process(*pid, name.as_deref()))
            }
            PortHolder::Lingering { port } => format!(
                "Port {port} is still tied up by a connection from a previous run \
                 (Windows releases these after a short delay). No other program is using it."
            ),
        }
    }

    /// A description of the process a retry would terminate, or `None` for
    /// the `Lingering` case where there is nothing to kill.
    fn killable_process(&self) -> Option<String> {
        match self {
            PortHolder::Listener { pid, name, .. } => Some(describe_process(*pid, name.as_deref())),
            PortHolder::Lingering { .. } => None,
        }
    }
}

/// Shared by `PortHolder::message` and `PortHolder::killable_process` so the
/// two can't describe the same process differently.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn describe_process(pid: u32, name: Option<&str>) -> String {
    match name {
        Some(n) => format!("{n} (PID {pid})"),
        None => format!("PID {pid}"),
    }
}

/// Describe what is holding one of `ports`.
///
/// Two populations, and the second one is the headline case:
///
/// 1. **A live listener** — a stale sidecar, a `npm run dev:server`, an
///    unrelated app. Nameable, and `freePort()` will terminate it on retry.
/// 2. **A lingering connection (Windows TIME_WAIT)** — the update case. The old
///    sidecar is gone, so there is no LISTENING row and no owning process, but
///    Windows still refuses the bind. Nothing to kill; the retry works because
///    the state expires. Reporting this honestly is the difference between "we
///    don't know" and "wait a moment and try again".
///
/// Best-effort and read-only: every failure returns None and the caller falls
/// back to generic text. Blocking (up to three `Command::output()` calls) — async
/// callers must wrap it in `spawn_blocking` AND bound it with a timeout, since a
/// wedged netstat would otherwise delay the error dialog indefinitely.
///
/// The wording is deliberately hedged. Between the netstat lookup and the
/// tasklist lookup the PID can be recycled, and `docs/troubleshooting.md` tells
/// users to `taskkill` what we name here — so we re-verify that the same PID
/// still holds the same port before reporting, and still say "appears to be"
/// rather than asserting it.
#[cfg(target_os = "windows")]
fn describe_port_holder(ports: &[u16]) -> Option<PortHolder> {
    let netstat = run_system32_tool("netstat.exe", &["-ano"])?;

    let Some(first) = parse_netstat_listening_pid(&netstat, ports) else {
        // No listener — check for the TIME_WAIT population before giving up.
        let port = parse_netstat_lingering_port(&netstat, ports)?;
        return Some(PortHolder::Lingering { port });
    };
    let (port, pid) = first;

    let name = run_system32_tool(
        "tasklist.exe",
        &["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"],
    )
    .and_then(|out| parse_tasklist_image_name(&out));

    // Re-verify: if the holder changed while we were looking it up, anything we
    // print is about a process that no longer owns the port.
    let second = parse_netstat_listening_pid(&run_system32_tool("netstat.exe", &["-ano"])?, ports);
    if second != Some(first) {
        log::debug!("Port holder changed during lookup — not reporting");
        return None;
    }

    Some(PortHolder::Listener { port, pid, name })
}

/// Non-Windows: no diagnostic. The failures this serves are Windows-specific
/// (a stale listener surviving an update, or TIME_WAIT after the restart), and
/// the dialog degrades to its generic text when this returns None.
#[cfg(not(target_os = "windows"))]
fn describe_port_holder(_ports: &[u16]) -> Option<PortHolder> {
    None
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
    // client latch its dedupe on a preference the OS does not have,
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
// Most commands have Windows-native and non-Windows stub variants so that
// tauri::generate_handler![] compiles on all platforms.
//
// `cowork_detect_vethernet_subnet` is the deliberate exception (#1371): it is ONE
// ungated `async fn` whose blocking *body* is what gets cfg-split. Do not
// "restore consistency" by splitting the command itself — the async /
// spawn_blocking / single-flight wiring is the fix for the main-thread freeze,
// and a cfg-gated command would put that wiring back where no non-Windows build
// ever type-checks it.

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

/// Outcome of the enable path's final step: persisting `enabled = true` (plus
/// the vEthernet CIDR and scan timestamp) to `cowork-meta.json`.
///
/// By this point the firewall rule and plugin entries are already live —
/// everything upstream of this call succeeded — so a persist failure here is
/// a partial commit, not a clean failure. MUST fail loud, mirroring the
/// disable branch's identical decision at its own `meta_persist` write, whose
/// comment reads: "this write is the disable's CORE contract ... fail loud
/// instead of returning a green toast over a stale state". Before this fix the
/// enable arm was the asymmetric outlier: warn-only, falling through to `Ok`,
/// so `cowork_toggle_integration`
/// could resolve while `cowork_get_status` went on honestly reporting
/// `enabled: false` with nothing to explain the gap — #1437.
///
/// Retrying is the recovery path, not a courtesy: the client's
/// `handleToggleChange` reads `status.enabled` to decide which handler fires,
/// and that reads `false` here, so there is no client path to
/// `cowork_toggle_integration(false)` to undo anything with — enabling again
/// is the only way off this state (safe to repeat: the firewall add and the
/// per-workspace writes above it are both idempotent). The disk state this
/// leaves — `enabled: false` with the firewall rule and plugin entries
/// already live — is exactly what today's silent `Ok` already produces, so
/// returning `Err` here doesn't create a new exposure, only a visible one;
/// and the leftover allow rule is inert under the default 127.0.0.1 bind
/// (the same argument the disable branch's "Firewall removal is ADVISORY"
/// comment makes for its own leftover-rule case; the launcher never sets
/// `TANDEM_BIND_HOST`, see `integrations_probe.rs`).
///
/// About the count the `Err` message does name: it is `workspace_count` from
/// the call site, i.e. `workspaces.len()` — the number of workspaces the
/// enable WALKED, not the number whose plugin entry was actually written. The
/// partial-install branch above this call deliberately tolerates a
/// `success_count` lower than that, so on a partial install this message can
/// name more workspaces than got an entry. Threading `success_count` down
/// here would close that gap at the cost of another parameter on a message
/// this rarely reached; the one case worth being exact about is zero, and
/// that one is special-cased below so the message never claims plugin entries
/// that were never written.
///
/// Pure and free of the Windows-only firewall/workspace-scan types around its
/// call site, so it's testable without them — same reasoning as
/// `parse_netstat_listening_pid` above ("kept out of the cfg(windows) block
/// so its tests run on every CI platform; the allow keeps a non-Windows
/// release build warning-free"). **Caveat that reasoning doesn't cover: this
/// function's own body is close to the assertion it's tested against — the
/// actual defect this fixes is at the call site inside
/// `#[cfg(target_os = "windows")] fn cowork_toggle_integration`, which a
/// non-Windows `cargo test` never compiles. The test below pins this
/// function's Ok/Err mapping; it does NOT prove the call site type-checks or
/// behaves. That's the `windows-latest` leg of `ci.yml`'s `rust-test` job
/// plus manual verification — see the PR body.**
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn enable_persist_outcome(persist: Result<(), String>, workspace_count: usize) -> Result<String, String> {
    match persist {
        Ok(()) => Ok(format!("Cowork enabled: {workspace_count} workspace(s) configured")),
        Err(e) => {
            // Name only what actually happened. The enable arm walks workspaces
            // and installs a plugin entry per workspace, so on a machine with
            // no Cowork workspaces there are no plugin entries to report — and
            // an error message that claims otherwise sends the user looking for
            // files that were never written.
            let installed = if workspace_count == 0 {
                "Cowork's firewall rule was added".to_string()
            } else {
                format!(
                    "Cowork's firewall rule and plugin entries for {workspace_count} workspace(s) were installed"
                )
            };
            Err(format!(
                "{installed}, but Tandem couldn't save that the integration is on ({e}). \
                 It will keep showing as off until you try enabling again."
            ))
        }
    }
}

#[cfg(test)]
mod enable_persist_outcome_tests {
    use super::*;

    #[test]
    fn ok_when_persist_succeeds() {
        assert_eq!(
            enable_persist_outcome(Ok(()), 3),
            Ok("Cowork enabled: 3 workspace(s) configured".to_string())
        );
    }

    #[test]
    fn fails_loud_when_persist_fails() {
        // #1437: before this fix, a persist failure here was swallowed into a
        // `log::warn!` and the command still returned `Ok`, so the invoke
        // resolved while `cowork_get_status` went on honestly reporting
        // `enabled: false` with nothing to explain the gap. This test pins
        // only this function's Ok/Err mapping and its message contents — it
        // cannot compile the call site inside `cowork_toggle_integration`
        // (Windows-cfg-gated), so it cannot by itself prove the fix landed
        // correctly there. See the doc comment above and the PR body.
        let result = enable_persist_outcome(Err("disk full".to_string()), 3);
        let msg = result.expect_err("persist failure must surface as Err, not a silent Ok");
        assert!(msg.contains("disk full"));
        assert!(msg.contains("firewall rule"));
        assert!(msg.contains("plugin entries for 3 workspace(s)"));
        assert!(msg.contains("try enabling again"));
    }

    #[test]
    fn persist_failure_with_no_workspaces_does_not_claim_plugin_entries() {
        // The enable arm installs one plugin entry per workspace, so with zero
        // workspaces there are none — claiming otherwise sends the user hunting
        // for files that were never written.
        let result = enable_persist_outcome(Err("disk full".to_string()), 0);
        let msg = result.expect_err("persist failure must surface as Err, not a silent Ok");
        assert!(msg.contains("disk full"));
        assert!(msg.contains("firewall rule"));
        assert!(
            !msg.contains("plugin entries"),
            "message must not claim plugin entries were installed when none were: {msg}"
        );
    }
}

/// Did this workspace's `installed_plugins.json` write actually land?
///
/// **The subtlety this exists to name: an `Ok` does not mean it landed.**
/// Both `install_tandem_plugin_into_workspace` and
/// `uninstall_tandem_plugin_from_workspace` return
/// `Ok(WorkspaceWriteReport { installed_plugins: WriteStatus::Failed(..) })`
/// for a per-file failure -- e.g. a revalidation failure in the uninstall path
/// (`cowork_installer.rs`) -- reserving `Err` for a failure to even reach the
/// file. So `r.is_ok()` counts a workspace that still holds its plugin entry
/// as a success.
///
/// Both arms of `cowork_toggle_integration` decide "did this workspace
/// succeed?" more than once -- for the hard all-failed check and again for the
/// #1438 degraded-success warning -- and the two must not disagree. They did:
/// the disable arm's warning used a bare `is_ok()` while its own all-failed
/// check used the `WriteStatus` test right above it, so a partial uninstall
/// whose failures were all non-`Err` produced no warning at all. That is the
/// commonest failure shape and precisely the case the warning was added for.
/// Routing every such decision through this one predicate is what keeps them
/// in step.
#[cfg(target_os = "windows")]
fn workspace_entry_written(
    report: &Result<cowork_installer::WorkspaceWriteReport, cowork_atomic_json::CoworkError>,
) -> bool {
    matches!(
        report,
        Ok(r) if matches!(
            r.installed_plugins,
            cowork_installer::WriteStatus::Ok | cowork_installer::WriteStatus::AlreadyPresent
        )
    )
}

#[cfg(all(test, target_os = "windows"))]
mod workspace_entry_written_tests {
    use super::workspace_entry_written;
    use crate::cowork_atomic_json::CoworkError;
    use crate::cowork_installer::{WorkspaceWriteReport, WriteStatus};

    fn report(status: WriteStatus) -> Result<WorkspaceWriteReport, CoworkError> {
        Ok(WorkspaceWriteReport {
            workspace_id: "ws".into(),
            vm_id: "vm".into(),
            installed_plugins: status,
            known_marketplaces: WriteStatus::Ok,
            cowork_settings: WriteStatus::Ok,
        })
    }

    #[test]
    fn ok_and_already_present_count_as_written() {
        assert!(workspace_entry_written(&report(WriteStatus::Ok)));
        assert!(workspace_entry_written(&report(WriteStatus::AlreadyPresent)));
    }

    #[test]
    fn an_ok_carrying_a_failed_status_is_not_written() {
        // The whole reason this predicate exists. `is_ok()` says true here, and
        // that is what made the #1438 partial-uninstall warning silent for the
        // commonest failure shape: `uninstall_tandem_plugin_from_workspace`
        // returns Ok(..Failed) on a revalidation failure, not Err.
        assert!(!workspace_entry_written(&report(WriteStatus::Failed(
            "revalidation failed".into()
        ))));
        assert!(!workspace_entry_written(&report(WriteStatus::Locked)));
        assert!(!workspace_entry_written(&report(WriteStatus::SchemaDrift)));
    }

    #[test]
    fn a_hard_error_is_not_written() {
        let err: Result<WorkspaceWriteReport, CoworkError> =
            Err(CoworkError::InsecureAcl {
                path: std::path::PathBuf::from("C:/ws"),
            });
        assert!(!workspace_entry_written(&err));
    }
}

/// The `Ok` payload of `cowork_toggle_integration` (#1438).
///
/// The command has always encoded *degraded success* in its `Ok` arm — a
/// partial multi-workspace install on enable, a leftover firewall rule or a
/// partial uninstall on disable — as English folded into the success string.
/// Every client call site awaited the invoke and threw the string away, so all
/// three rendered as an unqualified green success and the only surviving record
/// was a `log::warn!` on a Tauri log the user has no route to. A user with three
/// workspaces where two failed to install saw "Enabled" and a check badge.
///
/// Splitting the payload rather than teaching the client to read the message is
/// deliberate. Branching on message text would couple the client to Rust string
/// literals, and a reworded warning would then silently stop rendering — the
/// same class of failure, moved one layer out and made harder to see.
///
/// `warnings` empty means clean success. It is never used to report failure:
/// that is still the `Err` arm, and the two must not blur. A warning here means
/// "the operation committed, and here is what is imperfect about the result".
#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CoworkToggleReport {
    message: String,
    warnings: Vec<String>,
}

/// The user-facing caveat for a firewall rule that could not be removed.
///
/// A `const` rather than an inline literal because the disable arm is the only
/// producer and a test is the only other reader; keeping them on one string
/// stops the test from passing against a copy of the wording rather than the
/// wording. The allow mirrors `partial_workspace_warning`'s: the only non-test
/// reader is inside the `cfg(target_os = "windows")` arm.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const COWORK_LEFTOVER_FIREWALL_WARNING: &str =
    "A leftover firewall rule may remain. It's harmless — Tandem's server only listens on this computer.";

/// The caveat for a workspace pass where some — but not all — workspaces
/// succeeded.
///
/// `None` when there is nothing to say: no workspaces at all, or every one of
/// them succeeded. All-failed is NOT this function's case — both arms of the
/// toggle return `Err` before reaching here, because an operation that landed
/// nowhere is a failure, not a degraded success.
///
/// Kept outside the `cfg(target_os = "windows")` gate so its tests run on every
/// CI leg; the allow keeps a non-Windows release build warning-free. Direct
/// precedent: `parse_netstat_listening_pid` and its siblings above.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn partial_workspace_warning(
    verb: &str,
    success_count: usize,
    total: usize,
    failures: &[String],
) -> Option<String> {
    if total == 0 || success_count >= total {
        return None;
    }
    let failed = total - success_count;
    // The failure detail is included because the alternative is a warning the
    // user cannot act on. It is the same summary the `Err` arm already builds
    // for the all-failed case, so this adds no new disclosure surface.
    let detail = if failures.is_empty() {
        String::new()
    } else {
        format!(" Details: {}", failures.join("; "))
    };
    Some(format!(
        "{failed} of {total} Cowork workspace(s) could not be {verb}.{detail}"
    ))
}

#[cfg(test)]
mod partial_workspace_warning_tests {
    use super::{partial_workspace_warning, COWORK_LEFTOVER_FIREWALL_WARNING};

    /// The regression #1438 is about: a partial install used to be visible only
    /// in a `log::warn!`, so this asserts something is produced at all — and
    /// that it names both halves of the ratio, since "some failed" without a
    /// count is not actionable.
    #[test]
    fn a_partial_pass_produces_a_warning_naming_the_ratio() {
        let w = partial_workspace_warning(
            "configured",
            1,
            3,
            &["ws-a/vm-1: Locked".into(), "ws-b/vm-2: SchemaDrift".into()],
        )
        .expect("a partial pass must produce a warning");
        assert!(w.contains("2 of 3"), "{w}");
        assert!(w.contains("configured"), "{w}");
        // The detail is what makes it actionable — a user cannot act on
        // "2 of 3 failed" alone.
        assert!(w.contains("ws-a/vm-1: Locked"), "{w}");
        assert!(w.contains("ws-b/vm-2: SchemaDrift"), "{w}");
    }

    #[test]
    fn a_clean_pass_produces_nothing() {
        assert_eq!(partial_workspace_warning("configured", 3, 3, &[]), None);
    }

    /// Zero workspaces is a clean outcome, not a degraded one. Warning there
    /// would put a caveat on every enable on a machine that has no Cowork
    /// workspaces at all — the common case for a new install.
    #[test]
    fn no_workspaces_at_all_produces_nothing() {
        assert_eq!(partial_workspace_warning("configured", 0, 0, &[]), None);
    }

    /// Defensive: a count above the total is a caller bug, and the honest
    /// answer is silence rather than a warning claiming a negative failure
    /// count. `total - success_count` would panic in debug builds.
    #[test]
    fn a_success_count_above_the_total_produces_nothing_rather_than_panicking() {
        assert_eq!(partial_workspace_warning("configured", 4, 3, &[]), None);
    }

    /// All-failed is deliberately NOT this function's case — both toggle arms
    /// return `Err` before reaching it. Pinned so a future refactor that routes
    /// all-failed through here has to make that decision on purpose: it would
    /// otherwise turn a hard failure into a green toast with a caveat.
    #[test]
    fn all_failed_still_produces_a_warning_because_the_caller_never_asks() {
        let w = partial_workspace_warning("configured", 0, 2, &["a".into(), "b".into()]);
        assert!(w.is_some(), "the shape is unconditional; the CALLER is the gate");
    }

    /// Empty failure detail is a degenerate but reachable shape (a caller that
    /// knows the ratio but not the reasons). It must not emit a dangling
    /// "Details:" with nothing after it.
    #[test]
    fn no_failure_detail_means_no_details_clause() {
        let w = partial_workspace_warning("cleaned up", 1, 2, &[]).expect("still a warning");
        assert!(!w.contains("Details"), "{w}");
        assert!(w.contains("1 of 2"), "{w}");
    }

    /// The firewall caveat is advisory, and the wording carries the reason it
    /// is advisory. A rewrite that drops the "only listens on this computer"
    /// half turns a reassurance into an alarm.
    #[test]
    fn the_leftover_firewall_warning_says_why_it_is_harmless() {
        assert!(COWORK_LEFTOVER_FIREWALL_WARNING.contains("harmless"));
        assert!(COWORK_LEFTOVER_FIREWALL_WARNING.contains("only listens on this computer"));
    }
}

/// Enable or disable the Cowork integration.
///
/// On enable: fetches auth token, detects vEthernet subnet, adds allow firewall
/// rule, walks workspaces, installs plugin entries. When the firewall rule needs
/// elevation Tandem doesn't have: fail-closed — does NOT write plugin entries at
/// all. On disable: uninstalls plugin entries, removes firewall rules.
#[cfg(target_os = "windows")]
#[tauri::command]
fn cowork_toggle_integration(enabled: bool) -> Result<CoworkToggleReport, String> {
    use cowork_installer::{install_tandem_plugin_into_workspace, uninstall_tandem_plugin_from_workspace};
    use cowork_workspace_scan::find_cowork_workspaces;

    if enabled {
        // Fetch token.
        let token = token_store::get_or_create_token()?;

        // Detect vEthernet subnet.
        // The generous budget, not the advisory one: a false timeout HERE aborts
        // an enable that would have succeeded, where a false timeout on the
        // advisory probe costs only a re-check.
        let cidr = firewall::detect_vethernet_subnet(firewall::SUBNET_PROBE_TIMEOUT_ENABLE)
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
            // walk workspaces. Under the shipped default the server binds
            // 127.0.0.1, so the rule buys nothing; but with a routable
            // TANDEM_BIND_HOST an install missing it is one the VM cannot
            // reach, advertised as working. Bailing is correct for both.
            if let firewall::FirewallError::AdminDeclined = e {
                // The firewall rule needs elevation Tandem does not have (it never
                // runs elevated, so no UAC prompt ever appears). Do NOT attempt a
                // deny rule — it needs the same elevation and always fails, and the
                // server binds 127.0.0.1 so port 3479 was never network-exposed.
                // Record the outcome and surface the structured error for the UI's
                // honest copy. No plugin entries are written.
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

        // Stale-token reconciliation — rewrites entries still carrying a previous
        // auth token. Deliberately AFTER the successful add: a fail-closed firewall
        // add must never be followed by any workspace write.
        let rewritten_stale_entries =
            cowork_installer::reconcile_stale_workspace_tokens(&workspaces, &token);
        if !rewritten_stale_entries.is_empty() {
            log::info!(
                "[cowork] reconcile: rewrote {} stale token entry(s)",
                rewritten_stale_entries.len()
            );
        }

        let workspace_count = workspaces.len();
        // Degraded-success caveats, surfaced on the Ok payload (#1438).
        let mut warnings: Vec<String> = Vec::new();

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
            let success_count = reports.iter().filter(|r| workspace_entry_written(r)).count();

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
                // #1438: the log is not a route the user has. Carry the caveat
                // out on the Ok payload so the panel can say so.
                let failure_summary: Vec<String> = reports
                    .iter()
                    .filter(|r| !workspace_entry_written(r))
                    .map(|r| match r {
                        Ok(report) => format!(
                            "{}/{}: {:?}",
                            report.workspace_id, report.vm_id, report.installed_plugins
                        ),
                        Err(e) => e.to_string(),
                    })
                    .collect();
                warnings.extend(partial_workspace_warning(
                    "configured",
                    success_count,
                    workspaces.len(),
                    &failure_summary,
                ));
            }
        }

        let persist = cowork_meta::update(|m| {
            m.enabled = true;
            m.vethernet_cidr_detected = Some(cidr.clone());
            m.workspaces_last_scanned_at = Some(iso_now());
            m.uac_declined_last_attempt = false;
            m.uac_declined_at = None;
        });
        if let Err(e) = &persist {
            log::warn!("[cowork] failed to persist meta after enable: {e}");
        }
        // Both halves survive the #1437 + #1438 merge, and the order matters.
        // `enable_persist_outcome` owns the FAILURE decision (#1437: a persist
        // failure after the firewall rule and plugin entries are live is a
        // partial commit and must fail loud, not resolve green over a stale
        // state). `warnings` carries DEGRADED SUCCESS (#1438). They compose in
        // exactly one direction: a persist failure discards the warnings,
        // because the operation did not succeed and a caveat list beside an
        // error would imply it did. Warnings ride only on the Ok arm.
        enable_persist_outcome(persist, workspace_count)
            .map(|message| CoworkToggleReport { message, warnings })
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
            let success_count = reports.iter().filter(|r| workspace_entry_written(r)).count();

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
        // failures as non-fatal. (Caveat: leaving the rule is inert only under the default
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

        let mut warnings: Vec<String> = Vec::new();
        if firewall_failed {
            warnings.push(COWORK_LEFTOVER_FIREWALL_WARNING.to_string());
        }
        // A partial uninstall is the same defect as the partial install above:
        // it was `log::warn!`-only, so a user with three workspaces where two
        // still hold plugin entries saw an unqualified "Cowork disabled".
        //
        // The predicate must be the SAME one `workspace_all_failed` uses above,
        // not a bare `is_ok()`. `uninstall_tandem_plugin_from_workspace` returns
        // `Ok(WorkspaceWriteReport { installed_plugins: WriteStatus::Failed(..) })`
        // on a revalidation failure (`cowork_installer.rs`) -- an `Ok` that means
        // the entry is still there. Counting that as a success made this warning
        // silent for the commonest failure shape, i.e. for exactly the case the
        // bullet above describes, while `workspace_all_failed` right above was
        // already treating it as a failure. The enable arm's `failure_summary`
        // uses the WriteStatus predicate; this one is now symmetric with it.
        let uninstall_failures: Vec<String> = reports
            .iter()
            .filter(|r| !workspace_entry_written(r))
            .map(|r| match r {
                Ok(report) => format!(
                    "{}/{}: {:?}",
                    report.workspace_id, report.vm_id, report.installed_plugins
                ),
                Err(e) => e.to_string(),
            })
            .collect();
        warnings.extend(partial_workspace_warning(
            "cleaned up",
            workspaces.len().saturating_sub(uninstall_failures.len()),
            workspaces.len(),
            &uninstall_failures,
        ));
        Ok(CoworkToggleReport { message: "Cowork disabled".to_string(), warnings })
    }
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cowork_toggle_integration(_enabled: bool) -> Result<CoworkToggleReport, String> {
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

/// Coalesces concurrent advisory subnet probes (#1371).
///
/// Moving the command off the main thread removes an accidental mutex — Tauri
/// dispatches sync commands inline on the UI thread, so two could never overlap.
/// "Check again" is user-repeatable, so without this a burst of clicks would
/// become a burst of `powershell.exe` processes.
///
/// **What this deliberately does NOT cover.** `cowork_toggle_integration` runs
/// its own detection (`detect_vethernet_subnet`, below) and does not join this
/// flight. Joining would mean either handing Enable a coalesced advisory answer —
/// which `cowork-invoke.ts` forbids outright, because "the VM can stop between
/// the two" — or making Enable wait out an advisory probe, and since Enable is
/// still a sync command that wait would land on the main thread, adding freeze to
/// fix freeze. The honest bound is therefore at most TWO concurrent probes: one
/// coalesced advisory, plus at most one from Enable (whose handler blocks the UI
/// thread, so it cannot double-fire). The repeatable button is fully coalesced.
static SUBNET_PROBE_FLIGHT: single_flight::SingleFlight<Result<String, String>> =
    single_flight::SingleFlight::new();

/// Detect the Hyper-V vEthernet subnet (advisory pre-flight).
///
/// ONE ungated `async fn` with a cfg-split body, on purpose — see the section
/// comment above. `async fn` + `spawn_blocking` is the fix, and the pair is not
/// interchangeable with `#[tauri::command(async)]` on a sync fn: `tauri-macros`
/// labels that shape `"sync_threadpool"`, but the string is only a tracing span
/// field — `body_async` calls the sync fn *inside* the future and
/// `respond_async_serialized_inner` hands it to `async_runtime::spawn`, i.e.
/// tokio's WORKER pool, where a blocking process wait also stalls every other
/// `respond_async` command.
#[tauri::command]
async fn cowork_detect_vethernet_subnet() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        SUBNET_PROBE_FLIGHT
            .run(detect_subnet_advisory_blocking)
            // `None` means the flight was abandoned, which can only happen if the
            // leader panicked. Unparseable by `parseFirewallErrorVariant`, so it
            // surfaces as `status: "unknown"` and a console.error — the right
            // destination for a genuine bug, and never a blocked Enable button.
            .unwrap_or_else(|| Err("subnet probe was abandoned".to_string()))
    })
    .await
    .map_err(|e| format!("subnet probe task failed: {e}"))?
}

#[cfg(target_os = "windows")]
fn detect_subnet_advisory_blocking() -> Result<String, String> {
    firewall::detect_vethernet_subnet(firewall::SUBNET_PROBE_TIMEOUT_ADVISORY)
        .map_err(|e| serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()))
}
#[cfg(not(target_os = "windows"))]
fn detect_subnet_advisory_blocking() -> Result<String, String> {
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
/// then re-run through the five-step guard (`revalidate_resolved_path`) to
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

    // Defense-in-depth: re-run the five-step guard against the stored path to
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
/// scan time, which is re-checked against invariant §3 before any file I/O.
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
            let success_count = reports.iter().filter(|r| workspace_entry_written(r)).count();

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

/// Retry the enable flow after an admin-declined attempt (#1560).
///
/// This delegates to `cowork_toggle_integration(true)` and nothing else. It used
/// to clear `uac_declined_*` first, through `cowork_meta::update(...)?` — and the
/// `?` was the bug: the canonical cause of that update failing is an unwritable
/// `cowork-meta.json`, which is precisely when the admin-declined modal is up and
/// Retry is the user's escape hatch. Under that fault the button returned early,
/// every time, and the enable was never attempted at all.
///
/// The separate clear is gone rather than merely reordered, because on every path
/// it was either redundant or wrong:
///
/// - **Toggle succeeds.** Its enable arm's own `cowork_meta::update` sets
///   `uac_declined_last_attempt = false` and `uac_declined_at = None` immediately
///   before the only `Ok(...)` it returns. The flag is cleared by the toggle,
///   through the same code path, so a second write adds nothing.
/// - **Toggle hits `AdminDeclined`.** That arm deliberately *re-sets* the flag
///   with a fresh `uac_declined_at`, which is what re-arms the modal for a decline
///   that just happened. A pre-emptive clear is undone a few lines later.
/// - **Toggle fails any other way** (netsh missing, subnet detection failed, every
///   workspace install failed). Meta is untouched, so the clear was the only
///   writer — and clearing it there is the wrong outcome: it retires the modal
///   after a retry that did not enable anything, leaving the user with a transient
///   inline error and no standing signal that Cowork is still off.
///
/// So there is no clear result to report, and no partial-commit shape to report it
/// as. Whether a *failed* meta persist inside the toggle should itself be fatal is
/// a separate question, tracked by #1559; whatever that decides, this command
/// forwards the toggle's verdict unchanged.
///
/// Note for anyone tracing the UAC wording: Tandem never elevates itself.
/// `firewall::run_netsh` spawns a plain `netsh`, so `AdminDeclined` is *inferred*
/// from netsh's exit code and stderr — no UAC prompt is ever raised on this path,
/// and none can be accepted or declined.
#[cfg(target_os = "windows")]
#[tauri::command]
fn cowork_retry_admin_elevation() -> Result<CoworkToggleReport, String> {
    cowork_toggle_integration(true)
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cowork_retry_admin_elevation() -> Result<CoworkToggleReport, String> {
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
    builder = attach_main_window_or_warn(app, builder, "show_update_available_dialog");
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
    builder = attach_main_window_or_warn(app, builder, "show_up_to_date_dialog");
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
    builder = attach_main_window_or_warn(app, builder, "show_update_error_dialog");
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

/// Log + record the "sidecar didn't release the port in time" warning shared
/// by `perform_install`'s Windows and non-Windows branches. Interpolates the
/// const rather than hardcoding the duration: this string reaches the failure
/// dialog, and a hardcoded duration would silently go stale on the next bump.
fn warn_port_still_responding(warnings: &mut Vec<String>) {
    let msg = format!(
        "Sidecar still responding after {POST_KILL_PORT_RELEASE_SECS}s kill deadline -- proceeding with install anyway"
    );
    log::warn!("{msg}");
    warnings.push(msg);
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
            wait_for_port_release(&client, POST_KILL_PORT_RELEASE_SECS),
            wait_for_sidecar_unlock(SIDECAR_UNLOCK_DEADLINE_SECS),
        );
        if !port_ok {
            warn_port_still_responding(&mut pre_install_warnings);
        }
        if !file_ok {
            let msg = format!(
                "Sidecar exe still locked after {SIDECAR_UNLOCK_DEADLINE_SECS}s -- installer may prompt for retry"
            );
            log::warn!("{msg}");
            pre_install_warnings.push(msg);
        }
    }
    #[cfg(not(target_os = "windows"))]
    if !wait_for_port_release(&client, POST_KILL_PORT_RELEASE_SECS).await {
        warn_port_still_responding(&mut pre_install_warnings);
    }

    match update.download_and_install(
        |chunk_len, total| {
            if let Some(t) = total {
                log::debug!("Update download: {chunk_len}/{t} bytes");
            }
        },
        // #1118: the pending-update marker is written HERE, at download-finish,
        // and neither of the two places that look obvious.
        //
        // NOT before `download_and_install`: `build_updater` sets no timeout, so
        // the marker would span the whole download, and any process death during
        // it strands a marker with no `Err` arm to clean up — tray Quit, the
        // Linux-without-tray window close, a crash, a sleep-kill. Not
        // hypothetical: the sidecar is already dead by this point, so the WebView
        // sits in "Server unavailable" for the entire download, actively inviting
        // a quit. Every one of those would become a false "your update may not
        // have completed" on the next boot.
        //
        // NOT on the `Ok` arm below (which is what ADR-043 §6 sketched): that arm
        // is dead code on Windows, where the plugin's `install_inner` ends in an
        // unconditional `std::process::exit(0)`.
        //
        // This closure fires two lines before `verify_signature`, so a signature
        // failure does write a marker — that path returns `Err` on every platform
        // and the `Err` arm below clears it.
        {
            let app = app.clone();
            let version = version.to_string();
            move || {
                log::info!("Update downloaded -- installing");
                record_pending_update(&app, &version);
            }
        },
    ).await {
        Ok(()) => {
            log::info!("Update to v{version} installed — restarting");
            app.restart();
        }
        Err(e) => {
            log::error!("Update install failed: {e}");
            // We observed the failure in-process and are about to show a native
            // dialog about it, so a surviving marker would nag next boot about
            // something the user was just told.
            clear_pending_update(app);
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
    use std::sync::Mutex;

    // Serialize tests that mutate SIDECAR_HEALTHY (a process-wide static).
    static FLAG_LOCK: Mutex<()> = Mutex::new(());

    fn fresh_state() -> PendingOpens {
        PendingOpens(Mutex::new(Vec::new()))
    }

    /// The only way this module can produce a queue element since #1415:
    /// create a real supported file and run it through the screener.
    ///
    /// Before the newtype these tests wrote `PathBuf::from("a")` straight into
    /// `state.0` and handed `PathBuf::from("queued")` to `try_queue_or_post`.
    /// Both are now `error[E0308]: mismatched types` — that compiler refusal,
    /// not any assertion below, is the guarantee the issue asked for. What the
    /// assertions still cover is unchanged: FIFO drain order, the
    /// queue-vs-direct-POST branch, and the two lock-ordering proofs.
    ///
    /// Note this module is a SIBLING of `open_candidate`, not a descendant, so
    /// it cannot reach the private tuple field either — a `#[cfg(test)] mod`
    /// living inside `open_candidate.rs` could, which is why none does.
    fn screened(dir: &tempfile::TempDir, stem: &str) -> ScreenedOpenPath {
        let path = dir.path().join(format!("{stem}.md"));
        std::fs::write(&path, b"x").expect("write fixture");
        validate_open_candidate(path).expect("fixture must pass the screener")
    }

    #[test]
    fn promote_healthy_and_drain_returns_fifo_and_clears_queue() {
        let _g = FLAG_LOCK.lock().unwrap();
        SIDECAR_HEALTHY.store(false, Ordering::Release);

        let dir = tempfile::TempDir::new().expect("tempdir");
        let (a, b, c) = (screened(&dir, "a"), screened(&dir, "b"), screened(&dir, "c"));

        let state = fresh_state();
        state.0.lock().unwrap().push(a.clone());
        state.0.lock().unwrap().push(b.clone());
        state.0.lock().unwrap().push(c.clone());

        let drained = promote_healthy_and_drain(&state);
        assert_eq!(
            drained,
            vec![a, b, c],
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

        let dir = tempfile::TempDir::new().expect("tempdir");
        let queued = screened(&dir, "queued");

        let state = fresh_state();
        let result = try_queue_or_post(&state, queued.clone());
        assert!(matches!(result, OpenRoute::Queued));
        assert_eq!(
            *state.0.lock().unwrap(),
            vec![queued],
            "path should be in queue"
        );
    }

    #[test]
    fn try_queue_or_post_returns_path_when_healthy() {
        let _g = FLAG_LOCK.lock().unwrap();
        SIDECAR_HEALTHY.store(true, Ordering::Release);

        let dir = tempfile::TempDir::new().expect("tempdir");
        let direct = screened(&dir, "direct");

        let state = fresh_state();
        let result = try_queue_or_post(&state, direct.clone());
        assert!(
            matches!(result, OpenRoute::PostNow(ref p) if p == &direct),
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
        let dir = tempfile::TempDir::new().expect("tempdir");
        let late = screened(&dir, "after-restart");
        let result = try_queue_or_post(&state, late.clone());
        assert!(matches!(result, OpenRoute::Queued));
        assert_eq!(*state.0.lock().unwrap(), vec![late]);

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

        let dir = tempfile::TempDir::new().expect("tempdir");
        let early = screened(&dir, "early");
        let late = screened(&dir, "late");

        let state = fresh_state();
        state.0.lock().unwrap().push(early.clone());

        // Consumer side.
        let drained = promote_healthy_and_drain(&state);
        assert_eq!(drained, vec![early]);

        // Late producer that read flag=false BEFORE the consumer ran can only
        // mutate the queue while holding the lock; once it does, it sees
        // flag=true (set inside the same lock) and the helper hands the path
        // back instead of queuing it.
        let result = try_queue_or_post(&state, late.clone());
        assert!(matches!(result, OpenRoute::PostNow(ref p) if p == &late));
        assert!(state.0.lock().unwrap().is_empty());

        SIDECAR_HEALTHY.store(false, Ordering::Release);
    }

    // ---- #1416: the undelivered-queue report and the give-up latch --------
    //
    // These live HERE, not in `startup_rejection_tests`, and every one takes
    // `FLAG_LOCK`: they mutate the process-wide `SIDECAR_GAVE_UP` /
    // `SIDECAR_HEALTHY` statics, and cargo runs test fns on parallel threads. A
    // latch-setting test holding no `FLAG_LOCK` would let
    // `try_queue_or_post_queues_when_unhealthy` observe gave-up=true and get
    // `ServerUnavailable` instead of `Queued` — intermittent, one CI leg at a
    // time, and it would read as a flaky runner rather than as an unserialised
    // latch. Each resets BOTH flags before returning.

    #[test]
    fn report_surfaces_without_destroying_the_queue() {
        // The property BLOCKER-1 protects: "Retry Server Start" re-runs
        // start_sidecar with the queue intact, so reporting must not take it.
        // Taking it here means the user performs a recovery action that appears
        // to succeed and still loses the file.
        let _g = FLAG_LOCK.lock().unwrap();
        SIDECAR_HEALTHY.store(false, Ordering::Release);
        SIDECAR_GAVE_UP.store(false, Ordering::Release);

        let state = fresh_state();
        let dir = tempfile::TempDir::new().expect("tempdir");
        let (a, b) = (screened(&dir, "a"), screened(&dir, "b"));
        state.0.lock().unwrap().push(a.clone());
        state.0.lock().unwrap().push(b.clone());

        let mut surfaced: Vec<&'static str> = Vec::new();
        let n = report_pending_opens_with(&state, false, |code| surfaced.push(code));

        assert_eq!(n, 2);
        assert_eq!(
            surfaced,
            vec!["multiple-deferred"],
            "two undelivered opens must report multiplicity, exactly once — and as \
             DEFERRED, because the queue they are still sitting in survives"
        );
        assert_eq!(
            *state.0.lock().unwrap(),
            vec![a, b],
            "the queue must survive so a retry can still deliver it"
        );
        assert!(
            !SIDECAR_GAVE_UP.load(Ordering::Acquire),
            "a non-terminal report must not latch — the retry is still on offer"
        );

        SIDECAR_HEALTHY.store(false, Ordering::Release);
        SIDECAR_GAVE_UP.store(false, Ordering::Release);
    }

    #[test]
    fn a_single_undelivered_open_keeps_the_singular_code() {
        let _g = FLAG_LOCK.lock().unwrap();
        SIDECAR_GAVE_UP.store(false, Ordering::Release);

        let state = fresh_state();
        let dir = tempfile::TempDir::new().expect("tempdir");
        state.0.lock().unwrap().push(screened(&dir, "only"));

        let mut surfaced: Vec<&'static str> = Vec::new();
        report_pending_opens_with(&state, false, |code| surfaced.push(code));

        assert_eq!(
            surfaced,
            vec!["open-deferred"],
            "a retained queue must not claim the file failed for good — a later \
             restart still delivers it"
        );

        SIDECAR_GAVE_UP.store(false, Ordering::Release);
    }

    #[test]
    fn an_empty_pending_queue_surfaces_nothing() {
        // The common case by far: a failed restart of an app that never had a
        // pending open. A toast about files there would be pure noise.
        let _g = FLAG_LOCK.lock().unwrap();
        SIDECAR_GAVE_UP.store(false, Ordering::Release);

        let state = fresh_state();
        let mut surfaced: Vec<&'static str> = Vec::new();
        let n = report_pending_opens_with(&state, true, |code| surfaced.push(code));

        assert_eq!(n, 0);
        assert!(surfaced.is_empty(), "nothing pending, nothing to say");
        assert!(
            SIDECAR_GAVE_UP.load(Ordering::Acquire),
            "the latch is about the server, not about the queue — it still fires"
        );

        SIDECAR_GAVE_UP.store(false, Ordering::Release);
    }

    #[test]
    fn a_terminal_report_latches_give_up_and_a_new_attempt_clears_it() {
        let _g = FLAG_LOCK.lock().unwrap();
        SIDECAR_HEALTHY.store(false, Ordering::Release);
        SIDECAR_GAVE_UP.store(false, Ordering::Release);

        let state = fresh_state();
        let dir = tempfile::TempDir::new().expect("tempdir");
        state.0.lock().unwrap().push(screened(&dir, "x"));

        report_pending_opens_with(&state, true, |_| {});
        assert!(SIDECAR_GAVE_UP.load(Ordering::Acquire));

        // Both re-entry points withdraw the verdict: restart_sidecar's clear and
        // start_sidecar's first statement. A latch that stuck would make every
        // open after one bad restart fail fast forever.
        clear_healthy_under_lock(&state);
        assert!(!SIDECAR_GAVE_UP.load(Ordering::Acquire));

        report_pending_opens_with(&state, true, |_| {});
        assert!(SIDECAR_GAVE_UP.load(Ordering::Acquire));
        begin_start_attempt(&state);
        assert!(!SIDECAR_GAVE_UP.load(Ordering::Acquire));

        SIDECAR_HEALTHY.store(false, Ordering::Release);
        SIDECAR_GAVE_UP.store(false, Ordering::Release);
    }

    #[test]
    fn try_queue_or_post_fails_fast_after_give_up() {
        // #1416's second half: without the latch, file 1 gets a dialog and a
        // toast while files 2..N queue into a queue with no consumer, logging at
        // `info` — below the release LevelFilter::Warn floor. Silent, verbatim.
        let _g = FLAG_LOCK.lock().unwrap();
        SIDECAR_HEALTHY.store(false, Ordering::Release);
        SIDECAR_GAVE_UP.store(true, Ordering::Release);

        let dir = tempfile::TempDir::new().expect("tempdir");
        let state = fresh_state();
        let result = try_queue_or_post(&state, screened(&dir, "after-give-up"));
        assert!(matches!(result, OpenRoute::ServerUnavailable));
        assert!(
            state.0.lock().unwrap().is_empty(),
            "a fail-fast open must not join the dead queue"
        );

        // A healthy server makes the verdict stale, latch or no latch.
        SIDECAR_HEALTHY.store(true, Ordering::Release);
        let result = try_queue_or_post(&state, screened(&dir, "healthy-wins"));
        assert!(matches!(result, OpenRoute::PostNow(_)));

        // And a new attempt puts queueing back.
        SIDECAR_HEALTHY.store(false, Ordering::Release);
        begin_start_attempt(&state);
        let result = try_queue_or_post(&state, screened(&dir, "trying-again"));
        assert!(matches!(result, OpenRoute::Queued));

        SIDECAR_HEALTHY.store(false, Ordering::Release);
        SIDECAR_GAVE_UP.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod url_constants_tests {
    use super::*;

    // The port constants used by the port-holder diagnostic must agree with the
    // URL literals — they are two spellings of the same fact, and a diagnostic
    // probing the wrong port silently degrades to "no holder found".
    #[test]
    fn port_constants_match_urls() {
        assert!(
            HEALTH_URL.contains(&format!(":{MCP_PORT}/")),
            "MCP_PORT ({MCP_PORT}) must match HEALTH_URL ({HEALTH_URL})"
        );
        assert_eq!(WS_PORT + 1, MCP_PORT, "WS/MCP ports are adjacent by convention");
    }

    // HEALTH_TIMEOUT times a wait that happens INSIDE the sidecar: waitForPort
    // in src/server/platform.ts polls up to 15s for the TCP port to release
    // before the server can bind and answer /health. If this drops back to 15s
    // the shell kills sidecars that were legitimately waiting — the post-update
    // "Server failed to start after 3 restart attempts" failure.
    //
    // This can only pin ITS half of the coupling; Rust cannot read the TS
    // default. The other half is pinned by "defaults to a 15s ceiling" in
    // tests/server/platform.test.ts. Raising waitForPort's default without
    // raising this constant leaves BOTH tests green and reopens the bug —
    // the two must move together.
    #[test]
    fn health_timeout_exceeds_sidecar_port_wait() {
        assert!(
            HEALTH_TIMEOUT.as_secs() >= 30,
            "HEALTH_TIMEOUT ({}s) must stay well above waitForPort's 15s default \
             in src/server/platform.ts",
            HEALTH_TIMEOUT.as_secs()
        );
    }

    // Regression guard for #477 PR 2 + #637 + #686. The server's isHostAllowed
    // gate (api-routes.ts) rejects bare `localhost` Host headers; if these
    // constants drift back to `http://localhost:…`, the supervisor's
    // health-poll 403's for the whole HEALTH_TIMEOUT window and
    // `npm run dev:tauri` reports "Server failed to start after 3 restart
    // attempts".
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
mod port_holder_tests {
    use super::*;

    // Verbatim `netstat -ano` output shape (captured on Windows 11), trimmed to
    // the rows that matter. Fixture realism is the point: a hand-written table
    // would not have caught the `[::]:` prefix, which is why the parser splits
    // on the LAST colon rather than matching a substring.
    const NETSTAT: &str = "
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1520
  TCP    127.0.0.1:3479         0.0.0.0:0              LISTENING       12345
  TCP    [::]:445               [::]:0                 LISTENING       4
";

    #[test]
    fn finds_the_ipv4_listener_on_a_requested_port() {
        assert_eq!(parse_netstat_listening_pid(NETSTAT, &[3478, 3479]), Some((3479, 12345)));
    }

    #[test]
    fn finds_an_ipv6_listener() {
        let out = "  TCP    [::]:3479              [::]:0                 LISTENING       777\n";
        assert_eq!(parse_netstat_listening_pid(out, &[3479]), Some((3479, 777)));
        // The bracketed address contains colons of its own — a substring match
        // on ":3479" would work here but break on the negative cases below.
        assert_eq!(parse_netstat_listening_pid(out, &[3478]), None);
    }

    #[test]
    fn does_not_match_a_longer_port_with_the_same_prefix() {
        let out = "  TCP    127.0.0.1:34790        0.0.0.0:0              LISTENING       999\n";
        assert_eq!(parse_netstat_listening_pid(out, &[3479]), None);
    }

    #[test]
    fn ignores_non_listening_rows() {
        // An ESTABLISHED row on the same port is a client connection, not the
        // process holding the port against a fresh bind.
        let out = "  TCP    127.0.0.1:3479         127.0.0.1:5500         ESTABLISHED     42\n";
        assert_eq!(parse_netstat_listening_pid(out, &[3479]), None);
    }

    #[test]
    fn ignores_listeners_on_non_contending_interfaces() {
        // A WSL/Hyper-V/Docker adapter listening on its own address does not
        // prevent a 127.0.0.1 bind, so it is not the cause of our failure —
        // naming it would blame an innocent process, and the retry would kill it.
        let out = "  TCP    172.28.16.1:3479       0.0.0.0:0              LISTENING       777\n";
        assert_eq!(parse_netstat_listening_pid(out, &[3479]), None);
    }

    #[test]
    fn treats_a_wildcard_foreign_port_as_listening() {
        // Windows LOCALIZES the State column, so a non-English host never says
        // "LISTENING". A foreign address of *:0 is the structural signature of
        // a listening socket and no connected state produces it.
        let out = "  TCP    127.0.0.1:3479         0.0.0.0:0              ABIERTO         31\n";
        assert_eq!(parse_netstat_listening_pid(out, &[3479]), Some((3479, 31)));
    }

    #[test]
    fn finds_a_lingering_connection_when_there_is_no_listener() {
        // THE headline case: the old sidecar is gone (no LISTENING row) but its
        // connections sit in TIME_WAIT with owner PID 0, and Windows still
        // refuses the bind. Without this pass the dialog falls back to generic
        // text in exactly the scenario the feature was built for.
        let out = "  TCP    127.0.0.1:3479         127.0.0.1:52000        TIME_WAIT       0\n";
        assert_eq!(parse_netstat_listening_pid(out, &[3479]), None);
        assert_eq!(parse_netstat_lingering_port(out, &[3479]), Some(3479));
    }

    #[test]
    fn a_live_listener_is_not_reported_as_lingering() {
        assert_eq!(parse_netstat_lingering_port(NETSTAT, &[3479]), None);
    }

    #[test]
    fn returns_none_for_empty_or_garbage_output() {
        assert_eq!(parse_netstat_listening_pid("", &[3479]), None);
        assert_eq!(parse_netstat_listening_pid("not a table at all", &[3479]), None);
        assert_eq!(parse_netstat_lingering_port("", &[3479]), None);
        // Header row: rejected on the Proto column (it is not "TCP").
        assert_eq!(
            parse_netstat_listening_pid("  Proto  Local Address  Foreign Address  State  PID", &[3479]),
            None
        );
    }

    #[test]
    fn reads_the_image_name_from_a_tasklist_csv_row() {
        // Verbatim `tasklist /FI "PID eq 4" /NH /FO CSV` output.
        let out = "\"System\",\"4\",\"Services\",\"0\",\"5,060 K\"\n";
        assert_eq!(parse_tasklist_image_name(out), Some("System".to_string()));
    }

    #[test]
    fn returns_none_when_no_task_matches() {
        // tasklist prints this on EXIT CODE 0 for a PID that no longer exists,
        // so exit status cannot be used to detect the miss.
        let out = "INFO: No tasks are running which match the specified criteria.\n";
        assert_eq!(parse_tasklist_image_name(out), None);
    }

    // The parser tests above pin the pure logic against captured fixtures; this
    // one exercises the real pipeline — System32 resolution, CREATE_NO_WINDOW,
    // the live output format, and the re-verification pass — by holding a port
    // ourselves and asking who has it. Without it, a wrong argument vector or a
    // netstat output-format drift would pass every other test in this module.
    #[cfg(target_os = "windows")]
    #[test]
    fn describes_a_port_this_test_process_is_holding() {
        let listener =
            std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().expect("local_addr").port();

        let holder = describe_port_holder(&[port]).expect("a held port must be described");
        let described = holder.message();

        assert!(
            described.contains(&format!("Port {port}")),
            "should name the port it was asked about: {described}"
        );
        assert!(
            described.contains(&format!("PID {}", std::process::id())),
            "should name this test process (pid {}): {described}",
            std::process::id()
        );
        // Without this the tasklist half could fail entirely and the test would
        // still pass on the PID-only fallback format.
        assert!(
            described.to_ascii_lowercase().contains(".exe"),
            "should resolve the image name via tasklist, not fall back to PID-only: {described}"
        );
        // A live listener is killable, so the dialog is allowed to say the
        // retry will try to end it. The TIME_WAIT branch must report None here.
        assert!(
            matches!(holder, PortHolder::Listener { .. }),
            "a live listener must be reported as the Listener variant"
        );
        assert!(
            holder.killable_process().is_some(),
            "a live listener must be reported as killable"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn describes_nothing_when_the_port_is_free() {
        let port = {
            let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
            probe.local_addr().expect("local_addr").port()
        }; // dropped — port released
        assert_eq!(describe_port_holder(&[port]), None);
    }

    #[test]
    fn returns_none_for_empty_or_malformed_output() {
        assert_eq!(parse_tasklist_image_name(""), None);
        assert_eq!(parse_tasklist_image_name("garbage without quotes"), None);
        assert_eq!(parse_tasklist_image_name("\"\",\"4\""), None);
        // Unterminated quote — never a real row.
        assert_eq!(parse_tasklist_image_name("\"node.exe"), None);
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

    /// #1417. `show_in_file_manager` builds `explorer /select,<path>` from a raw
    /// webview string, so a UNC path makes EXPLORER perform the SMB handshake —
    /// the credential leak happens in a process we do not control and never see
    /// fail. The check is a pure string test with no syscall, because on Windows
    /// the syscall IS the threat.
    #[test]
    fn unc_and_network_paths_are_recognized_in_both_separator_flavours() {
        assert!(is_unc_or_network_path(r"\\attacker\share\x"));
        assert!(is_unc_or_network_path("//attacker/share/x"));
        assert!(is_unc_or_network_path(r"\\?\UNC\attacker\share"));
        assert!(is_unc_or_network_path("//?/UNC/attacker/share"));
        // Stricter than cowork_workspace_scan::is_unc_path on purpose: there is
        // no containment check here to confine an extended-length local path,
        // and strip_win_prefix() should have removed it upstream anyway.
        assert!(is_unc_or_network_path(r"\\?\C:\Windows"));
        // Mixed separators. Windows treats `/` and `\` as interchangeable, so
        // two leading separators of ANY flavour are UNC. Enumerating the two
        // homogeneous pairs — which is what this used to do, and what both TS
        // predicates did — was a two-character bypass.
        assert!(is_unc_or_network_path(r"/\attacker\share\x"));
        assert!(is_unc_or_network_path(r"\/attacker/share/x"));
    }

    #[test]
    fn ordinary_local_paths_are_not_mistaken_for_network_paths() {
        assert!(!is_unc_or_network_path(r"C:\Users\me\notes.md"));
        assert!(!is_unc_or_network_path("/home/me/notes.md"));
        assert!(!is_unc_or_network_path("/Users/me/notes.md"));
        assert!(!is_unc_or_network_path("notes.md"));
        // A single leading slash is a normal posix absolute path, not UNC.
        assert!(!is_unc_or_network_path("/notes.md"));
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
            validate_open_candidate(link.clone()).map(ScreenedOpenPath::into_inner),
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
            classify_opened_url(&url).map(ScreenedOpenPath::into_inner),
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

    // ---- #1416: the post-validation failure code and its batch ------------
    //
    // No statics are touched here, so these need neither `REJECTION_LOCK` nor
    // `pending_opens_tests`'s `FLAG_LOCK`.

    #[test]
    fn open_failed_code_is_stable() {
        // The cross-process contract with `messageForStartupRejection`'s
        // explicit `case "open-failed"`. A rename on either side desyncs
        // silently, because the client's `default` renders the same text.
        assert_eq!(CODE_OPEN_FAILED, "open-failed");
    }

    #[test]
    fn deferred_codes_are_stable_and_distinct_from_the_failure_codes() {
        assert_eq!(CODE_OPEN_DEFERRED, "open-deferred");
        assert_eq!(CODE_MULTIPLE_DEFERRED, "multiple-deferred");
        // The split is the point: a retained queue still opens on the next
        // successful start, so it must never render as the past-tense failure
        // message. Collapsing these back onto the failure codes would restore
        // the false statement this pair exists to remove.
        assert_ne!(CODE_OPEN_DEFERRED, CODE_OPEN_FAILED);
        assert_ne!(CODE_MULTIPLE_DEFERRED, CODE_MULTIPLE_REJECTED);
    }

    /// Drive `post_paths_and_surface` with an injected poster.
    ///
    /// `tauri::async_runtime::block_on` works in a plain `#[test]` — it lazily
    /// initialises its own runtime and needs no `AppHandle`, no `#[tokio::test]`
    /// and no tokio dev-dependency.
    fn run_batch(paths: &[&str], failing: &[&str], seed: Option<&'static str>) -> Vec<&'static str> {
        let mut surfaced: Vec<&'static str> = Vec::new();
        let mut batch = RejectionBatch::default();
        if let Some(code) = seed {
            batch.record(code);
        }
        // Real screened paths, because `post_paths_and_surface` now takes
        // `ScreenedOpenPath` and the newtype has no test-only constructor by
        // design (#1415). The names are matched on the file name below, so the
        // tempdir prefix is invisible to every caller.
        let dir = tempfile::TempDir::new().expect("tempdir");
        let owned: Vec<ScreenedOpenPath> = paths
            .iter()
            .map(|name| {
                let path = dir.path().join(name);
                std::fs::write(&path, b"x").expect("write fixture");
                validate_open_candidate(path).expect("fixture must pass the screener")
            })
            .collect();
        tauri::async_runtime::block_on(post_paths_and_surface(
            "test",
            owned,
            batch,
            // The `fail` decision is computed OUTSIDE the async block on
            // purpose: an `Fn` closure may only borrow, so an `async move` that
            // captured `failing` itself would be E0507 on the second call.
            |path| {
                let name = path
                    .as_path()
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let fail = failing.iter().any(|f| name == *f);
                async move {
                    if fail {
                        Err("boom".to_string())
                    } else {
                        Ok(())
                    }
                }
            },
            |code| surfaced.push(code),
        ));
        surfaced
    }

    #[test]
    fn a_fully_successful_batch_surfaces_nothing() {
        assert!(
            run_batch(&["a.md", "b.md"], &[], None).is_empty(),
            "opening two files successfully must not toast"
        );
    }

    #[test]
    fn a_failed_post_surfaces_the_open_failed_code_once() {
        // The #1416 bug itself: this used to be a `log::warn!` and nothing else,
        // which in a release build is a file the user never opens.
        assert_eq!(run_batch(&["big.md"], &["big.md"], None), vec!["open-failed"]);
        // Two failures are still ONE surface call, and report multiplicity.
        assert_eq!(
            run_batch(&["a.md", "b.md", "c.md"], &["a.md", "c.md"], None),
            vec!["multiple-rejected"]
        );
    }

    #[test]
    fn a_validation_rejection_and_a_post_failure_share_one_toast() {
        // One Finder multi-select: a .pdf refused by the validator and a 60 MB
        // .md refused by the server. Two surface calls would write twice into
        // the one-slot buffer, and `useNotifications` would show a count badge
        // whose value depends on where the client's async drain landed — the
        // exact race `RejectionBatch` exists to remove.
        let surfaced = run_batch(&["huge.md"], &["huge.md"], Some("unsupported-extension"));
        assert_eq!(
            surfaced,
            vec!["multiple-rejected"],
            "the batch spans validation AND delivery, and resolves exactly once"
        );
    }

    #[test]
    fn a_batch_with_nothing_to_post_still_surfaces_its_rejections() {
        // A fully-rejected batch (the common shape since #1344: a double-clicked
        // .pdf, a stale alias) has nothing to POST and still has something to
        // say. `post_batch_for_app`'s early return mirrors this by surfacing
        // BEFORE it returns — that ordering is not covered here, since it needs
        // an AppHandle; this pins the helper's half of it.
        assert_eq!(run_batch(&[], &[], Some("not-a-file")), vec!["not-a-file"]);
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

#[cfg(test)]
mod pending_update_tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    // Serialize the tests that touch PENDING_UPDATE_HINT (a process-wide
    // static), exactly as `startup_rejection_tests` does with REJECTION_LOCK.
    static HINT_LOCK: StdMutex<()> = StdMutex::new(());

    fn marker(v: &str) -> PendingUpdateMarker {
        PendingUpdateMarker {
            target_version: v.to_string(),
            ts: 1_700_000_000,
        }
    }

    // --- write / read round trip -------------------------------------------

    #[test]
    fn write_then_read_round_trips() {
        let dir = tempfile::TempDir::new().unwrap();
        write_pending_update_marker(dir.path(), "0.24.0").unwrap();

        let got = read_pending_update_marker(dir.path()).expect("marker should read back");
        assert_eq!(got.target_version, "0.24.0");
        // The timestamp is computed inside the writer. A `ts` stuck at 0 means
        // the clock step silently degraded (`unwrap_or_default`) on a machine
        // where it should not have.
        assert_ne!(got.ts, 0, "writer must stamp a real timestamp");
        assert!(got.ts > 1_600_000_000, "ts should be a plausible epoch: {}", got.ts);
    }

    #[test]
    fn read_returns_none_for_missing_file_and_missing_dir() {
        let dir = tempfile::TempDir::new().unwrap();
        assert_eq!(read_pending_update_marker(dir.path()), None);
        assert_eq!(
            read_pending_update_marker(&dir.path().join("does-not-exist")),
            None
        );
    }

    #[test]
    fn read_returns_none_for_malformed_json_and_zero_byte_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join(PENDING_UPDATE_MARKER);

        std::fs::write(&path, b"{ not json").unwrap();
        assert_eq!(read_pending_update_marker(dir.path()), None, "malformed JSON");

        std::fs::write(&path, b"").unwrap();
        assert_eq!(read_pending_update_marker(dir.path()), None, "zero-byte file");

        // Well-formed JSON, wrong shape — the `ts` field is missing.
        std::fs::write(&path, br#"{"target_version":"0.24.0"}"#).unwrap();
        assert_eq!(read_pending_update_marker(dir.path()), None, "missing field");
    }

    #[test]
    fn read_rejects_implausible_version() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join(PENDING_UPDATE_MARKER);

        for bad in [
            "x".repeat(500),
            "0.24.0\u{0}\u{1}".to_string(),
            String::new(),
            "0.24.0 && rm -rf /".to_string(),
        ] {
            let body = serde_json::to_string(&PendingUpdateMarker {
                target_version: bad.clone(),
                ts: 1,
            })
            .unwrap();
            std::fs::write(&path, body).unwrap();
            assert_eq!(
                read_pending_update_marker(dir.path()),
                None,
                "should reject implausible version: {bad:?}"
            );
        }

        // Control: the guard must not be so tight that real versions bounce.
        for good in ["0.24.0", "1.0.0-rc.1", "0.24.0+build.5", "v0.24.0"] {
            let body = serde_json::to_string(&marker(good)).unwrap();
            std::fs::write(&path, body).unwrap();
            assert!(
                read_pending_update_marker(dir.path()).is_some(),
                "should accept real version: {good}"
            );
        }
    }

    // --- classifier ---------------------------------------------------------

    #[test]
    fn classify_matching_version_is_completed() {
        assert_eq!(
            classify_pending_update(Some(marker("0.24.0")), "0.24.0"),
            PendingUpdateVerdict::Completed
        );
        // Defence-in-depth — `Update::version` reaches us already normalized, so
        // this pins nothing that can realistically drift. It is here so a future
        // writer that does NOT normalize cannot silently start nagging after
        // every successful update. `plausible_version` accepts a leading `v`, so
        // unlike whitespace this branch IS reachable through the read path.
        assert_eq!(
            classify_pending_update(Some(marker("v0.24.0")), "0.24.0"),
            PendingUpdateVerdict::Completed
        );
    }

    #[test]
    fn whitespace_is_trimmed_on_the_read_path_before_the_shape_guard() {
        // Order matters and is easy to get backwards. `plausible_version`
        // rejects every ASCII space, so if the reader guarded before trimming, a
        // marker carrying a stray trailing newline would silently read back as
        // `None` -> `NoMarker` -> no banner, and `classify`'s own `trim()` would
        // be unreachable through the only real producer.
        let dir = tempfile::TempDir::new().unwrap();
        let body = serde_json::to_string(&PendingUpdateMarker {
            target_version: "  0.24.0\n".to_string(),
            ts: 1,
        })
        .unwrap();
        std::fs::write(dir.path().join(PENDING_UPDATE_MARKER), body).unwrap();

        let got = read_pending_update_marker(dir.path()).expect("whitespace must be trimmed, not rejected");
        assert_eq!(got.target_version, "0.24.0");
        assert_eq!(
            classify_pending_update(Some(got), "0.24.0"),
            PendingUpdateVerdict::Completed
        );
    }

    #[test]
    fn classify_mismatched_version_is_may_have_failed() {
        // The load-bearing direction: an inverted comparison here would make the
        // whole feature silently never fire, and every other test would pass.
        assert_eq!(
            classify_pending_update(Some(marker("0.24.0")), "0.23.0"),
            PendingUpdateVerdict::MayHaveFailed
        );
        assert_eq!(
            classify_pending_update(Some(marker("0.24.0")), "0.24.1"),
            PendingUpdateVerdict::MayHaveFailed
        );
    }

    #[test]
    fn classify_none_is_no_marker() {
        assert_eq!(
            classify_pending_update(None, "0.23.0"),
            PendingUpdateVerdict::NoMarker
        );
    }

    // --- clear --------------------------------------------------------------

    #[test]
    fn clear_is_idempotent_and_reports_absence() {
        let dir = tempfile::TempDir::new().unwrap();

        // Already absent must report success, or every clean boot would warn.
        assert!(clear_pending_update_marker(dir.path()));

        write_pending_update_marker(dir.path(), "0.24.0").unwrap();
        assert!(clear_pending_update_marker(dir.path()));
        assert_eq!(read_pending_update_marker(dir.path()), None);
        assert!(clear_pending_update_marker(dir.path()), "second clear");
    }

    // --- panic containment --------------------------------------------------

    #[test]
    fn write_into_a_path_blocked_by_a_file_returns_err_not_panic() {
        let dir = tempfile::TempDir::new().unwrap();
        // A regular file where the marker's directory should be: `create_dir_all`
        // fails. The point is that it returns Err rather than panicking — a
        // panic here unwinds through the plugin's `download()` and kills both
        // match arms in `perform_install`, so the user gets no error dialog.
        let blocked = dir.path().join("blocked");
        std::fs::write(&blocked, b"i am a file").unwrap();

        let result = write_pending_update_marker(&blocked, "0.24.0");
        assert!(result.is_err(), "expected Err, got {result:?}");
    }

    // --- buffer + nudge ordering --------------------------------------------

    #[test]
    fn surface_pending_update_hint_with_buffers_before_nudging() {
        let _g = HINT_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        with_pending_hint("test-reset", |slot| *slot = None);

        // The nudge is payload-free, so a listener answers it by draining the
        // buffer. If the nudge fired first the slot would be empty and the hint
        // would be dropped permanently.
        let mut seen_during_nudge: Option<String> = None;
        surface_pending_update_hint_with(CODE_UPDATE_MAY_NOT_HAVE_COMPLETED, || {
            seen_during_nudge = with_pending_hint("test-peek", |slot| slot.clone());
        });

        assert_eq!(
            seen_during_nudge.as_deref(),
            Some(CODE_UPDATE_MAY_NOT_HAVE_COMPLETED),
            "buffer must be populated BEFORE the nudge fires"
        );

        with_pending_hint("test-reset", |slot| *slot = None);
    }

    #[test]
    fn get_pending_update_hint_takes_once() {
        let _g = HINT_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        with_pending_hint("test-reset", |slot| *slot = None);

        surface_pending_update_hint_with(CODE_UPDATE_MAY_NOT_HAVE_COMPLETED, || {});

        assert_eq!(
            get_pending_update_hint().as_deref(),
            Some(CODE_UPDATE_MAY_NOT_HAVE_COMPLETED)
        );
        // Take-once: a WebView reload re-runs the init drain, and a peek-style
        // accessor would replay the banner the user already dismissed.
        assert_eq!(get_pending_update_hint(), None, "second read must be empty");

        with_pending_hint("test-reset", |slot| *slot = None);
    }

    // --- the one-shot clear, and the policy that guards it -----------------

    #[test]
    fn evaluating_a_mismatch_hints_once_and_consumes_the_marker() {
        // THE load-bearing test of this change. One-shot is the issue's explicit
        // requirement, and its failure mode is the worst one available: a
        // permanent, every-boot, un-dismissable banner for every affected user.
        // Before this test existed, deleting the clear outright left `cargo
        // test`, the client suites, biome and typecheck all green.
        let dir = tempfile::TempDir::new().unwrap();
        write_pending_update_marker(dir.path(), "0.24.0").unwrap();

        assert_eq!(
            evaluate_pending_update_at(dir.path(), "0.23.0"),
            PendingUpdateVerdict::MayHaveFailed
        );
        assert!(
            !dir.path().join(PENDING_UPDATE_MARKER).exists(),
            "the marker must be gone after it has been surfaced once"
        );
        // A second boot must say nothing at all.
        assert_eq!(
            evaluate_pending_update_at(dir.path(), "0.23.0"),
            PendingUpdateVerdict::NoMarker,
            "a second evaluation must not re-raise the hint"
        );
    }

    #[test]
    fn evaluating_a_match_reports_completed_and_consumes_the_marker() {
        let dir = tempfile::TempDir::new().unwrap();
        write_pending_update_marker(dir.path(), "0.24.0").unwrap();

        assert_eq!(
            evaluate_pending_update_at(dir.path(), "0.24.0"),
            PendingUpdateVerdict::Completed
        );
        assert!(!dir.path().join(PENDING_UPDATE_MARKER).exists());
    }

    #[test]
    fn evaluating_a_corrupt_marker_says_nothing_and_still_removes_it() {
        // The clear is unconditional precisely so a marker too damaged to
        // classify does not linger forever. If the clear were moved onto the
        // hint branch, this file would survive every boot.
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join(PENDING_UPDATE_MARKER), b"{ not json").unwrap();

        assert_eq!(
            evaluate_pending_update_at(dir.path(), "0.23.0"),
            PendingUpdateVerdict::NoMarker
        );
        assert!(
            !dir.path().join(PENDING_UPDATE_MARKER).exists(),
            "a corrupt marker must not linger"
        );
    }

    #[test]
    fn evaluating_a_clean_boot_is_a_silent_no_op() {
        let dir = tempfile::TempDir::new().unwrap();
        assert_eq!(
            evaluate_pending_update_at(dir.path(), "0.23.0"),
            PendingUpdateVerdict::NoMarker
        );
    }

    #[test]
    fn a_failed_clear_suppresses_the_hint_but_nothing_else() {
        // Exhaustive over the policy. A `remove_file` failure cannot be staged
        // in a test running as root, which is exactly why the decision is a pure
        // function rather than a branch buried in the I/O path.
        use PendingUpdateVerdict::{Completed, MayHaveFailed, NoMarker};
        for v in [NoMarker, Completed, MayHaveFailed] {
            assert_eq!(verdict_after_clear(v, true), v, "a successful clear changes nothing");
        }
        assert_eq!(verdict_after_clear(NoMarker, false), NoMarker);
        assert_eq!(verdict_after_clear(Completed, false), Completed);
        // The one residual false positive in the design: a hint that cannot be
        // made one-shot would return every boot with no way to dismiss it, so it
        // is suppressed rather than shipped.
        assert_eq!(
            verdict_after_clear(MayHaveFailed, false),
            NoMarker,
            "an un-clearable marker must not raise a permanent nag"
        );
    }

    #[test]
    fn hint_code_is_stable_and_carries_no_version_or_path() {
        // Cross-process contract with the client's message map.
        assert_eq!(
            CODE_UPDATE_MAY_NOT_HAVE_COMPLETED,
            "update-may-not-have-completed"
        );
        assert!(!CODE_UPDATE_MAY_NOT_HAVE_COMPLETED.contains('/'));
        assert!(!CODE_UPDATE_MAY_NOT_HAVE_COMPLETED.contains('\\'));
        assert!(
            !CODE_UPDATE_MAY_NOT_HAVE_COMPLETED
                .chars()
                .any(|c| c.is_ascii_digit()),
            "the code must not carry a version"
        );
    }
}
