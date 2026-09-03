mod autostart;
mod context_menu;
mod cowork_commands;
mod native_theme;
mod pending_update;
pub mod keychain;
mod sentry_reporting;
mod sidecar;
mod startup_rejection;
mod token_store;
mod uninstall_scrub;

// #1371: both of these are deliberately UNGATED even though their only consumer
// today (`firewall.rs`) is Windows-only. A `#[cfg(target_os = "windows")]` module
// is never parsed on another target, so gating them would put the two pieces of
// genuinely tricky logic — a process deadline that must bound the whole call, and
// an in-flight guard replacing the serialization the main thread used to provide
// for free — where they could not be unit-tested locally. `#[allow(dead_code)]`
// on `bounded_command` covers non-Windows release builds, where nothing calls it
// — scoped with `cfg_attr` (as `sidecar.rs`'s `PortHolder` is) so that on Windows, where the
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
// Absolute System32 paths, so a bare program name is never resolved by the
// loader — the application directory is searched ahead of System32.
#[cfg(target_os = "windows")]
mod system_paths;
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
// set because `startup_rejection_tests` exercises them on every CI leg. That
// module moved to `startup_rejection.rs` with Unit 11f and reaches these
// through `crate::`, so the `test` arm is still load-bearing and still earned
// by that one module: `classify_opened_url_tests`, the test module that stayed,
// uses `classify_opened_url` and `OpenedUrlRejection` but never
// `opened_url_reason_code`.
pub(crate) use open_candidate::rejection_reason_code;
#[cfg(any(target_os = "macos", test))]
pub(crate) use open_candidate::{classify_opened_url, opened_url_reason_code, OpenedUrlRejection};
#[cfg(test)]
pub(crate) use open_candidate::validate_open_candidate;

// Re-exported rather than qualified at ~20 call sites, the same idiom as
// `open_candidate` above and for a stronger reason: `use crate::{…}` in a
// sibling module is how the rest of the crate already reaches these names, so
// re-exporting keeps every call site — here and in files this unit does not
// touch — byte-identical across the split. Qualifying instead would compile
// here and break a sibling that git merged clean, with no conflict to warn
// anyone. `get_startup_rejection` is deliberately absent: `#[tauri::command]`
// generates a sibling `__cmd__…` macro that a plain `use` of the function does
// not import, so `generate_handler!` module-qualifies it as 11b–11d did.
//
// The launch-mode half of start-at-login moved into `autostart.rs` alongside
// the registration commands. `autostart_seen_and_mark` carries its item's own
// `#[cfg(target_os = "linux")]`: an ungated re-export of a gated item is an
// unconditional E0432 on the other two platforms, which is the shape that broke
// Unit 11c and that only CI can see.
pub(crate) use autostart::{
    is_autostart_launch, resolve_autostart_launch, should_start_hidden, AUTOSTART_DISABLE_ENV,
    AUTOSTART_FLAG,
};
#[cfg(target_os = "linux")]
pub(crate) use autostart::autostart_seen_and_mark;
pub(crate) use startup_rejection::{
    clear_startup_rejection, surface_startup_rejection, RejectionBatch, CODE_MULTIPLE_DEFERRED,
    CODE_OPEN_DEFERRED, CODE_OPEN_FAILED,
};

// Bare `PathBuf` survives only in the `#[cfg(test)]` modules now. Every
// unconditionally-compiled use went to `open_candidate.rs` with the
// open-candidate cluster (#1415), and the Windows Cowork self-heal pass — the
// last non-test user — went to `cowork_commands.rs` with Unit 11d. An ungated
// import warns on the Linux and macOS release builds; keeping the
// `target_os = "windows"` half after 11d would warn on a Windows RELEASE build,
// which no CI leg and no `cargo test` can see.
#[cfg(test)]
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Url;
use tauri::{Emitter, Manager};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_prevent_default::Flags;
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_window_state::StateFlags;

use crate::sidecar::{
    build_http_client, port_holder_for_dialog, shutdown_sidecar_on_exit, start_sidecar,
    stop_sidecar_gracefully, wait_for_port_release, PortHolder, GRACEFUL_SHUTDOWN_DEADLINE_SECS,
    HTTP_CLIENT_TIMEOUT, MCP_PORT, POST_KILL_PORT_RELEASE_SECS, RestartGate,
    ShuttingDownGuard as SidecarShuttingDownGuard, SidecarState, SpawnOutcome, WS_PORT,
};
#[cfg(target_os = "windows")]
use crate::sidecar::{wait_for_sidecar_unlock, SIDECAR_UNLOCK_DEADLINE_SECS};

const OPEN_URL: &str = "http://127.0.0.1:3479/api/open";
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

/// Exact-match argv flag predicate, skipping `argv[0]`.
///
/// The skip is a security invariant, not a nicety: an executable literally
/// *named* `--tandem-autostart` (or `--uninstall-scrub`) must not be able to
/// self-trigger the behavior by being renamed. One definition so a third flag
/// can't copy the invariant a third time and get it subtly wrong.
pub(crate) fn has_argv_flag(args: &[String], flag: &str) -> bool {
    args.iter().skip(1).any(|a| a == flag)
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
/// producer could read flag=true between the sidecar kill and the clear, then
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
/// `startup_rejection::surface_startup_rejection_with` has one: the real callers
/// need an `AppHandle`, which cannot be constructed in a unit test.
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
/// `startup_rejection::surface_startup_rejection_with`. The `Send` bounds and
/// `&'static str` are
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
    let mut direct: Vec<ScreenedOpenPath> = Vec::new();
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
/// not exist yet (see `startup_rejection::STARTUP_REJECTION`) — but a direct
/// loopback POST
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

    // UI element inspector — opt-in `ui-inspector` feature, development only.
    // `cargo tauri dev --features ui-inspector`, then `ui-inspector pick`.
    //
    // Registration order is not load-bearing here (it registers no global
    // subscriber and intercepts no events), but it stays after single-instance
    // like every other plugin. The window-scoped `ui-inspector:default`
    // permission is granted at runtime in setup() — see the note there for why
    // it is not a capability file.
    //
    // `max_history(100)` and `crop_padding(8)` are the upstream defaults, kept
    // explicit so they are visible where they can be tuned.
    //
    // `storage_dir` is NOT the default, and the reason is the CLI's discovery
    // rule: `ui-inspector` resolves `--project` by walking *up* from its own CWD
    // looking for a directory that CONTAINS `.ui-inspector`. The plugin's
    // default resolves the store against the app process's CWD, which under
    // `cargo tauri dev` is `src-tauri/` — a DESCENDANT of the repo root, so
    // every CLI call from the repo root (where we actually work) would fail
    // discovery with exit 3, indistinguishable from "the app isn't running".
    //
    // `CARGO_MANIFEST_DIR` is baked at compile time and is always
    // `<repo>/src-tauri`, so this pins the store to the repo root regardless of
    // how the binary is launched. A compile-time path is normally a smell; it
    // is acceptable here only because nothing ships this feature — no release
    // build passes it (see Cargo.toml), so the build machine and the run
    // machine are the same machine. If that ever stops being true, this
    // baked-in path is the first thing that breaks.
    //
    // Treat the store as sensitive: it holds whatever document was open.
    // Gitignored; never attach a reference to an issue or PR.
    //
    // `capture_screenshots(false)` is NOT a preference — native capture is
    // broken on Windows and leaving it on makes the whole plugin unusable
    // here, because a failed capture fails the ENTIRE capture: no reference is
    // written at all, and every `ui-inspector pick` returns
    // "no native window matched the Tauri process and window title".
    //
    // Root cause, measured on this machine (#1633) against the same live pid,
    // the same moment, and the same xcap 0.9.8:
    //
    //   called from OUTSIDE tandem-desktop -> 15 windows, both Tandem windows present
    //   called from INSIDE  tandem-desktop -> 13 windows, ZERO matching self pid
    //
    // `xcap::Window::all()` omits the calling process's own windows on
    // Windows. The plugin's `find_window` filters that list by
    // `std::process::id()` and returns `WindowNotFound` when the result is
    // empty, so the pid filter can never match from in-process. Nothing at the
    // integration layer can fix it — it needs an upstream capture path that
    // works on the app's own HWND. Upstream's E2E evidence is macOS-only, which
    // is consistent with this never having been exercised on Windows.
    //
    // Everything else works with it off, verified end to end: DOM/ARIA
    // metadata, ranked locators (`data-testid` first at confidence 1.0), the
    // Svelte source location and component ancestry, persistence, and live
    // `ui-inspector resolve`. That is the bulk of the value for an agent; the
    // pixels are the part we lose.
    //
    // Flip this back to the upstream default (screenshots on) once the capture
    // path is fixed, and delete this comment with it.
    #[cfg(feature = "ui-inspector")]
    {
        let mut inspector = tauri_plugin_ui_inspector::Builder::new();
        inspector
            .storage_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../.ui-inspector"))
            .max_history(100)
            .crop_padding(8)
            .capture_screenshots(false);
        builder = builder.plugin(inspector.build());
    }

    // Windows-only kill-on-job-close ownership of the sidecar (#987). Managed
    // here (not in the fluent chain below) so the `#[cfg]` is a clean statement.
    // Held for the parent process's lifetime; the OS closes the job handle on
    // parent exit — graceful OR crash/taskkill — reaping the sidecar. macOS and
    // Linux rely on the existing RunEvent::Exit + shutdown_sidecar_on_exit path.
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
        .on_menu_event(context_menu::forward_context_menu_event)
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

            // UI element inspector permission grant (`ui-inspector` feature).
            //
            // This is a RUNTIME capability, not a file under
            // `src-tauri/capabilities/`, and the difference is not stylistic.
            // Capability files are resolved by `tauri-build` against the crates
            // actually in the dependency graph, so a static file naming
            // `ui-inspector:default` would fail to build every time the feature
            // is OFF — which is every release build and every default `cargo
            // test`. `Manager::add_capability` (tauri's `dynamic-acl` feature,
            // pulled in by our `ui-inspector` feature) is the only grant that
            // appears and disappears together with the dependency.
            //
            // Scoped to the `main` window to match capabilities/default.json.
            // `?` rather than a warn: a silent grant failure would leave the
            // picker hanging on an IPC call the ACL rejects, with the CLI
            // reporting only a timeout — and this build is developer-only, so
            // failing loudly costs a user nothing.
            #[cfg(feature = "ui-inspector")]
            {
                // `Manager` (which carries `add_capability`) is already in
                // scope from the module-level `use tauri::{Emitter, Manager}`.
                app.add_capability(
                    r#"{
                        "identifier": "ui-inspector-capability",
                        "description": "Dev-only element picker (ui-inspector feature).",
                        "windows": ["main"],
                        "permissions": ["ui-inspector:default"]
                    }"#,
                )?;
                log::info!("UI inspector enabled — run `ui-inspector pick` to select an element");
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
            pending_update::evaluate_pending_update_marker(app.handle());

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
                // `RestartGate` is a CAS, and it releases only what it took: a
                // blind store would clear a gate held by someone else. And if
                // the gate is already held — some other path won the race before
                // we got here — we must NOT run start_sidecar anyway: doing so
                // is the exact concurrent-spawn failure this gate exists to
                // prevent, just from the other direction. Skip, like
                // `restart_sidecar` itself does on a gate miss.
                let Some(gate) = RestartGate::try_acquire() else {
                    log::warn!(
                        "initial start_sidecar found RESTART_IN_PROGRESS already held — skipping to avoid a concurrent spawn"
                    );
                    return;
                };
                let start_result = start_sidecar(&handle, &client, cold_start_file.as_deref()).await;
                drop(gate);

                // Exhaustive on purpose. `SpawnOutcome`'s own contract is that
                // every caller matches on it, and the `if let Err(..)` this
                // replaces made that claim false: `Ok(Declined)` fell straight
                // through to `check_for_update`, i.e. an update check fired on a
                // session that is quitting. Reachable only when the quit lands
                // while this initial spawn is still in flight, so the damage is
                // small — but a contract with one silent exception is not one.
                match start_result {
                    Ok(SpawnOutcome::Started) => {}
                    // No dialog and no update check: the thing that declined us
                    // IS the shutdown (or the update install already in flight).
                    // A "server failed" modal raised into a closing app is worse
                    // than nothing, and the failure arm's
                    // `report_pending_opens_with` would queue work for a session
                    // that is ending anyway.
                    Ok(SpawnOutcome::Declined) => {
                        log::warn!(
                            "Initial start_sidecar declined — the sidecar is shutting down; no dialog, no update check"
                        );
                        return;
                    }
                    Err(e) => {
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
                    match tauri::async_runtime::spawn_blocking(cowork_commands::cowork_heal_pass).await {
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
            native_theme::get_app_theme,
            native_theme::set_native_theme,
            sentry_enabled,
            cowork_commands::cowork_scan_workspaces,
            cowork_commands::cowork_toggle_integration,
            cowork_commands::cowork_rescan,
            cowork_commands::cowork_get_status,
            cowork_commands::cowork_get_meta,
            cowork_commands::cowork_detect_vethernet_subnet,
            cowork_commands::cowork_apply_token,
            cowork_commands::cowork_install_into_workspace,
            cowork_commands::cowork_uninstall_from_workspace,
            cowork_commands::cowork_set_lan_ip_override,
            cowork_commands::cowork_retry_admin_elevation,
            sidecar::restart_sidecar,
            startup_rejection::get_startup_rejection,
            pending_update::get_pending_update_hint,
            check_for_update_now,
            show_in_file_manager,
            context_menu::show_context_menu,
            context_menu::show_tab_context_menu,
            context_menu::show_annotation_context_menu,
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
                // Graceful stop, then the hard kill as fallback (#1756). Every
                // quit gesture reaches Exit — tray Quit, macOS ⌘Q/Dock Quit
                // (which never raise ExitRequested), the Linux no-tray window
                // close (which raises ExitRequested unreliably — twice on some
                // desktops), and the updater's restart on non-Windows.
                //
                // The one exit that never arrives here, by design: the Windows
                // updater restart. `download_and_install` ends in the plugin's
                // own `std::process::exit(0)`, so the pre-install graceful stop
                // in `perform_install` is the only flush on that path, and that
                // function keeps its own gate for exactly that reason.
                tauri::RunEvent::Exit => shutdown_sidecar_on_exit(_app),
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
                let Some(gate) = RestartGate::try_acquire() else {
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
                };
                let client = handle.state::<reqwest::Client>().inner().clone();
                // Pass the cold-start file through, unlike `restart_sidecar`,
                // which passes None because setup() already opened it. Here
                // setup() FAILED, so nothing was opened — dropping it would
                // silently land a user who double-clicked a .md on welcome.md.
                let result = start_sidecar(&handle, &client, cold_start_file.as_deref()).await;
                // Released before anything user-facing, so Settings → Restart
                // server is usable again while the second dialog is on screen.
                // Explicit `drop` rather than letting it fall out of scope: the
                // early release is the point, and a dialog can sit on screen for
                // minutes.
                drop(gate);

                match result {
                    Ok(SpawnOutcome::Started) => {
                        log::info!("Server-start retry succeeded");
                        // setup()'s failure path returned before this; without
                        // it a recovered session gets no update check for 8h.
                        check_for_update(&handle, false).await;
                    }
                    // A decline is not a success. Reading it as one logged
                    // "Server-start retry succeeded" and ran an update check on
                    // the one dialog whose entire job is to say the server did
                    // not start — and it is reachable, because `spawn_allowed()`
                    // is false for the whole of an update download, not just
                    // during an exit.
                    Ok(SpawnOutcome::Declined) => {
                        log::warn!(
                            "Server-start retry declined — the sidecar is shutting down"
                        );
                        // No `check_for_update`: an install is already in flight
                        // (or we are quitting), and that is what declined us.
                        if !crate::sidecar::is_exiting() {
                            // Same shape as the sibling gate a few lines up: the
                            // modal is already dismissed, so a bare return means
                            // the user's explicit click produced nothing at all
                            // on screen.
                            report_pending_opens_with(
                                handle.state::<PendingOpens>().inner(),
                                true,
                                |code| surface_startup_rejection(&handle, code),
                            );
                            show_server_error_dialog(
                                &handle,
                                "The server can't be started right now — an update is being installed. Try again once it finishes.",
                                None,
                                cold_start_file,
                                false,
                            );
                        }
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
    // The helper's `program` is the answer everywhere except Windows, where the
    // anchored path below shadows it — so on Windows it is deliberately unread.
    #[cfg_attr(target_os = "windows", allow(unused_variables))]
    let (program, args) = reveal_command_args(&path, std::env::consts::OS);

    // Anchor the Windows program HERE rather than inside `reveal_command_args`.
    // That helper takes `target_os` as a parameter precisely so all four arms
    // run on the Linux CI leg; reading the system directory inside its Windows
    // arm would make the one arm that ships the least-tested and force it to
    // assert the *unanchored* form in CI. Environment access belongs at the
    // spawn site.
    //
    // `explorer.exe` is the worst of the bare-name sites, not the mildest: it
    // lives in `%SystemRoot%`, which the loader reaches only after the
    // (user-writable) application directory AND System32 — and this is the one
    // spawn a webview gesture triggers directly. See `system_paths`.
    #[cfg(target_os = "windows")]
    let program = crate::system_paths::windows_exe("explorer.exe").ok_or_else(|| {
        "Failed to reveal in file manager: could not resolve the Windows directory.".to_string()
    })?;

    match std::process::Command::new(program).args(&args).spawn() {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("Failed to reveal {path} in file manager: {e}")),
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

/// Tell the user their install click landed on an install that is already
/// running.
///
/// A dialog rather than a bare log or an `Err`, for the reason
/// `RestartGate::try_acquire`'s decline states: the user's explicit click — the
/// banner CTA, or OK on the tray's "install this update" prompt — would
/// otherwise produce nothing at all on screen. Returning `Err` from
/// `install_update` is not a substitute: `useUpdaterBanner.svelte.ts`'s `catch`
/// only `console.warn`s, so the WebView half has no user-visible surface either.
fn show_update_in_progress_dialog(app: &tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

    let mut builder = app
        .dialog()
        .message(
            "An update is already being installed.\n\n\
             Wait for it to finish — Tandem restarts on its own when it is done.",
        )
        .title("Update In Progress")
        .kind(MessageDialogKind::Info);
    builder = attach_main_window_or_warn(app, builder, "show_update_in_progress_dialog");
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
    //
    // Hold `SIDECAR_SHUTTING_DOWN` across the stop AND across the download so the
    // three spawn producers (Settings -> Restart server, start_sidecar's retry
    // loop, the Retry Server Start dialog) decline instead of racing a fresh
    // child into the slot we are about to overwrite on disk.
    //
    // An RAII guard, not a store plus a clear on the failure arm: the flag spans
    // `download_and_install(..).await`, so a panic or a dropped task would latch
    // it for the process lifetime and leave `restart_sidecar` and Retry Server
    // Start permanent silent no-ops. Its `Drop` keeps the `compare_exchange`,
    // which is the `EXITING` interlock — an update that fails DURING an exit
    // must not re-permit spawns. On the success arm the process exits — on
    // Windows inside `download_and_install`'s own `std::process::exit(0)`, on
    // other platforms inside `app.restart()` (which returns `!`) — so the guard
    // never releases there, which is what we want. #1756.
    //
    // `try_acquire`, not a bare acquire: `install_update` is a plain command
    // with no re-entrancy gate, so two clicks on "Restart to install" run two of
    // these futures. Under a bare store, the first to finish would release the
    // latch out from under the second — which is still downloading over the
    // binary — and re-permit a spawn into that slot. See `ShuttingDownGuard`.
    let Some(_shutting_down) = SidecarShuttingDownGuard::try_acquire() else {
        // Do not just log. The modal is already dismissed (tray path) or the
        // banner CTA is about to re-arm (`INSTALL_WATCHDOG_MS` = 30s, and a
        // download longer than 30s is ordinary), so a bare return means the
        // user's explicit click produced nothing at all on screen — the same
        // decision already made for `RestartGate::try_acquire` above.
        log::warn!("Update install to v{version} ignored — an install is already in flight");
        show_update_in_progress_dialog(app);
        return;
    };
    let client = app.state::<reqwest::Client>().inner().clone();

    // Collect human-readable warnings so we can thread them into the failure
    // dialog if download_and_install later fails. Declared before the graceful
    // stop because that stop's verdict is the first thing that can go into it,
    // and the cfg blocks below both contribute too.
    let mut pre_install_warnings: Vec<String> = Vec::new();

    // On Windows this is the ONLY flush on the update path: `download_and_install`
    // ends in the updater plugin's own `std::process::exit(0)`, so `RunEvent::Exit`
    // never fires and `shutdown_sidecar_on_exit` never runs. A dropped verdict
    // here is an update that proceeds having discarded unsaved edits while every
    // dialog says it worked — which is why `StopReport` is `#[must_use]`.
    //
    // BOTH outcomes are logged at `warn`, and the success half is not
    // decoration. `smoke-lines.md` row 3 asks the tester to grep `tandem.log`
    // for an update run with unsaved edits — and on Windows there is no verdict
    // line to read, because `RunEvent::Exit` never fires. Every other line on
    // this path is `info!`, below the release floor, so without this the row's
    // positive half could not be satisfied at all and a silent log was
    // indistinguishable from a stop that never ran.
    //
    // The success string below is a code↔doc pair like the respawn-guard lines,
    // so it is pinned like one: `respawn_guard_lines_are_warns_and_match_the
    // _smoke_checklist` in `sidecar.rs` requires it to appear exactly once here,
    // as the first argument of an uncommented `log::warn!(`, and to be present
    // in `smoke-lines.md`. Row 3 was prose when this string was added, which
    // meant the commit whose subject was "add a guard for exactly this" created
    // an unguarded instance of exactly this; the row now carries the literal.
    match stop_sidecar_gracefully(app, &client, GRACEFUL_SHUTDOWN_DEADLINE_SECS)
        .await
        .unflushed_warning("Pre-install")
    {
        Some(msg) => {
            log::warn!("{msg}");
            pre_install_warnings.push(msg);
        }
        None => log::warn!(
            "Pre-install: graceful sidecar shutdown complete — unsaved edits were flushed before the update"
        ),
    }

    // Wait for port release and (on Windows) file-lock release concurrently.
    // Port-down alone isn't sufficient on Windows: TerminateProcess returns
    // before the OS releases the exe file handle.

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
                pending_update::record_pending_update(&app, &version);
            }
        },
    ).await {
        Ok(()) => {
            log::info!("Update to v{version} installed — restarting");
            app.restart();
        }
        Err(e) => {
            log::error!("Update install failed: {e}");
            // The app keeps running, so spawns must be re-permitted — done by
            // `_shutting_down`'s `Drop` at the end of this function, not by an
            // explicit clear here. An explicit clear covered only the path that
            // reaches it; the guard also covers a panic and a dropped task.
            // We observed the failure in-process and are about to show a native
            // dialog about it, so a surviving marker would nag next boot about
            // something the user was just told.
            pending_update::clear_pending_update(app);
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
        // flag=true before the sidecar kill still POST to the dying server.
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
    use crate::sidecar::{HEALTH_TIMEOUT, HEALTH_URL, MCP_PORT, WS_PORT};

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
