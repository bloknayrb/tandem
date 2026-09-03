//! The Node sidecar's process lifecycle (#987, #1088, #1236, #1416).
//!
//! **Extracted from `lib.rs` (Unit 11e).** A pure move: spawn, graceful stop,
//! hard kill, restart, the health/port polling that decides whether the child
//! is alive, the two spawn-env path resolvers, and the Windows port-holder
//! diagnostic that names what is squatting :3478/:3479 -- reproduced verbatim,
//! with `port_holder_tests`.
//!
//! **What deliberately did NOT come with it.** `SIDECAR_HEALTHY` and
//! `SIDECAR_GAVE_UP` read like sidecar state and are not: both are documented
//! as read and written ONLY under the `PendingOpens` mutex, their writers are
//! `promote_healthy_and_drain` / `clear_healthy_under_lock` /
//! `begin_start_attempt`, and `pending_opens_tests` is their test module.
//! Splitting a flag from the mutex that supplies its ordering proof is the
//! hazard `SIDECAR_GAVE_UP`'s own doc comment warns about. `await_sidecar_healthy`
//! polls one of them and belongs to the presence flow; `show_server_error_dialog`
//! shares `attach_main_window_or_warn` with every other dialog; `perform_install`
//! is a consumer of this module, not part of it. All are 11f's.
//!
//! **Privacy running downward is not name resolution, and the import block below
//! is the difference.** A private crate-root item IS visible here -- `sidecar`
//! is a descendant of the root -- but a bare path written in `lib.rs` does not
//! resolve in a child module, so all eleven crate-root names the moved bodies
//! call need naming explicitly. Two of those imports are invisible to a grep of
//! the moved text: `Emitter` and `Manager` are trait imports that `.emit(` and
//! the ten `.state()` calls need for method resolution, and their absence is an
//! `E0599` rather than an unresolved name.
//!
//! **`sidecar_job` is gated and the import must mirror it.** `mod sidecar_job;`
//! in `lib.rs` is itself `#[cfg(target_os = "windows")]`, so off Windows the
//! module does not exist at all and an ungated `use crate::sidecar_job;` is an
//! unconditional E0432 on macOS and Linux while compiling clean on a Windows dev
//! box. Unit 11c shipped exactly that and only CI caught it. `token_store` and
//! `sentry_reporting` are ungated modules with ungated call sites here, so they
//! come in plain. `run_system32_tool` already writes
//! `crate::system_paths::system32_exe` fully qualified and needs no import --
//! `system_paths` is Windows-gated too.
//!
//! **`#[tauri::command]` names are not module-qualified**, so `restart_sidecar`
//! stays `restart_sidecar` on the wire; the `generate_handler!` entry in
//! `lib.rs` becomes `sidecar::`-qualified, matching `pending_update::`,
//! `context_menu::`, `native_theme::` and `cowork_commands::`. Its `pub(crate)`
//! is not merely a privacy fix: tauri-macros emits the two helper macros with
//! `#[macro_export]` only when the fn's visibility is public or restricted, so a
//! private cross-module command leaves `sidecar::__cmd__restart_sidecar!`
//! unresolvable.
//!
//! **External guards.** `tests/docs/tauri-command-registration-claims.test.ts`
//! derives the handler list from the macro block and the definitions from disk,
//! so a wrong module qualification -- which compiles and silently kills the
//! command at runtime -- fails there. `url_constants_tests` stays in `lib.rs`
//! and imports `HEALTH_URL` / `HEALTH_TIMEOUT` / `WS_PORT` / `MCP_PORT` from
//! here: it pins the whole loopback-URL family, including `OPEN_URL` and the two
//! `LAUNCHER_*_URL`s that did not move, and moving it would have widened three
//! constants outside this cluster for a test's sake.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{Emitter, Manager};
use tauri_plugin_shell::ShellExt;

use crate::{
    begin_start_attempt, clear_healthy_under_lock, clear_startup_rejection, post_batch_for_app,
    promote_healthy_and_drain, report_pending_opens_with, strip_win_prefix,
    surface_startup_rejection, PendingOpens, RejectionBatch, LAUNCHER_DEFERRED,
};
use crate::{sentry_reporting, token_store};
#[cfg(target_os = "windows")]
use crate::sidecar_job;

/// Keep in sync with DEFAULT_MCP_PORT in src/shared/constants.ts (port 3479).
/// Must use 127.0.0.1, not `localhost` — `isHostAllowed` (api-routes.ts) narrowed
/// out the bare `localhost` hostname in #477 PR 2, so a `Host: localhost:3479`
/// request returns 403 Forbidden and the supervisor's health-poll times out.
pub(crate) const HEALTH_URL: &str = "http://127.0.0.1:3479/health";

/// Graceful-shutdown endpoint on the sidecar (#1088). POSTing here triggers
/// the Node shutdown sequence (dirty-doc flush + session save) before exit.
/// Keep in sync with API_SHUTDOWN in src/shared/api-paths.ts.
const SHUTDOWN_URL: &str = "http://127.0.0.1:3479/api/shutdown";

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
pub(crate) const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const HTTP_CLIENT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long to wait for the sidecar to exit after POST /api/shutdown before
/// hard-killing it. The Node shutdown's disk flush is 5s-bounded
/// (src/server/index.ts), so 6s covers the flush plus the session save in the
/// common case while keeping the restart button responsive (#1088).
pub(crate) const GRACEFUL_SHUTDOWN_DEADLINE_SECS: u64 = 6;
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
pub(crate) const POST_KILL_PORT_RELEASE_SECS: u64 = 15;
/// How long `perform_install` waits for Windows to release the sidecar exe's
/// file handle so the NSIS installer can overwrite it. Same reasoning, same
/// budget as POST_KILL_PORT_RELEASE_SECS — TerminateProcess returns before the
/// OS drops the handle.
#[cfg(target_os = "windows")]
pub(crate) const SIDECAR_UNLOCK_DEADLINE_SECS: u64 = 15;
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
pub(crate) const WS_PORT: u16 = 3478;
pub(crate) const MCP_PORT: u16 = 3479;
/// The interface the sidecar is told to bind. Keep in sync with
/// DEFAULT_BIND_HOST in src/shared/constants.ts, and with the loopback literal
/// in the URL constants above — pinned by `port_constants_match_urls`.
///
/// Passed explicitly at the spawn site because the child inherits this process's
/// environment (see the spawn-site comment), so an ambient `TANDEM_BIND_HOST`
/// would otherwise move the sidecar off loopback under a shell that still polls
/// 127.0.0.1.
pub(crate) const SIDECAR_BIND_HOST: &str = "127.0.0.1";

/// Total wall-clock budget for the graceful stop attempted from
/// `RunEvent::Exit` (#1756), in seconds.
///
/// **The arithmetic is not `deadline + 1`.** `wait_for_port_release` checks its
/// own deadline only at the top of the loop, and the `check_health` inside the
/// last iteration can itself block for the full `HTTP_CLIENT_TIMEOUT`; the POST
/// to `/api/shutdown` that precedes it can also take the full client timeout
/// (that is exactly what happens when `TANDEM_MCP_PORT` is non-default and the
/// hardcoded `SHUTDOWN_URL` misses — #1825). So the true worst case of
/// `stop_sidecar_gracefully` is `deadline + 2 x HTTP_CLIENT_TIMEOUT`, and the
/// outer timeout has to sit above that or it becomes the binding constraint and
/// truncates a flush that was still making progress. The `+ 1` is slack.
///
/// Pinned to the literal 17 by `shutdown_guard_tests` — a bare restatement of
/// this expression would be a tautology.
const EXIT_GRACEFUL_BUDGET_SECS: u64 =
    GRACEFUL_SHUTDOWN_DEADLINE_SECS + 2 * HTTP_CLIENT_TIMEOUT.as_secs() + 1;
const EXIT_GRACEFUL_BUDGET: Duration = Duration::from_secs(EXIT_GRACEFUL_BUDGET_SECS);

/// Set once, on the way out, by `shutdown_sidecar_on_exit`. **One-way: nothing
/// ever clears it.** Read by `spawn_allowed`, so a spawn producer that wakes up
/// during the exit budget declines instead of orphaning a child.
///
/// Deliberately separate from `SIDECAR_SHUTTING_DOWN`: the updater clears that
/// one on its failure arm (the app keeps running), and an update that fails
/// *during* an exit must not re-permit spawns.
static EXITING: AtomicBool = AtomicBool::new(false);

/// Set by `perform_install` around its pre-install graceful stop and released by
/// `ShuttingDownGuard`'s `Drop`. Unlike `EXITING` this one is meant to be
/// bounded — **and only the guard makes that true.** Held across
/// `download_and_install().await`, a panic or a dropped task would otherwise
/// latch it for the process lifetime, leaving `restart_sidecar` and "Retry
/// Server Start" permanent silent no-ops.
pub(crate) static SIDECAR_SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// RAII latch for `SIDECAR_SHUTTING_DOWN`.
///
/// `Drop` runs on the normal return, on an unwind, and when the enclosing future
/// is dropped mid-await — which is the whole point: the flag is held across
/// `download_and_install().await`, and the failure arm's explicit clear covered
/// only the path that reaches it.
///
/// `Drop` keeps the `compare_exchange(true, false)` rather than a bare store,
/// and that CAS is the `EXITING` interlock: if an exit began while the install
/// ran, `EXITING` is already latched and `spawn_allowed()` stays false whatever
/// this releases. On the success arm the process exits inside the updater
/// (`std::process::exit` on Windows) or via `app.restart()`, which returns `!` —
/// so `Drop` simply never runs there, which is correct.
pub(crate) struct ShuttingDownGuard(());

impl ShuttingDownGuard {
    pub(crate) fn acquire() -> Self {
        SIDECAR_SHUTTING_DOWN.store(true, Ordering::Release);
        ShuttingDownGuard(())
    }
}

impl Drop for ShuttingDownGuard {
    fn drop(&mut self) {
        let _ =
            SIDECAR_SHUTTING_DOWN.compare_exchange(true, false, Ordering::AcqRel, Ordering::Acquire);
    }
}

/// May a sidecar child be spawned right now?
///
/// Three producers can reach a spawn while the app is stopping the sidecar:
/// `restart_sidecar` (Settings -> Network -> Restart server), `start_sidecar`'s
/// own retry loop, and the "Retry Server Start" dialog. A child that lands after
/// the exit-path kill is orphaned on macOS/Linux (on Windows the job object at
/// the spawn site still reaps it).
fn spawn_allowed() -> bool {
    !EXITING.load(Ordering::Acquire) && !SIDECAR_SHUTTING_DOWN.load(Ordering::Acquire)
}

/// Is the application on its way out?
///
/// The distinction a `SpawnOutcome::Declined` consumer needs: an update install
/// declined the spawn and the user should be told, an exit declined it and there
/// is nowhere to tell them. `spawn_allowed()` alone cannot separate the two.
pub(crate) fn is_exiting() -> bool {
    EXITING.load(Ordering::Acquire)
}

/// Tracks the sidecar child process so we can kill it on shutdown.
pub(crate) struct SidecarState(pub(crate) Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

/// Guards against concurrent `restart_sidecar` invocations. The command
/// returns immediately (stop + respawn run on the async runtime), so the
/// WebView's restart button re-enables while a restart is still in flight; a
/// second click used to race two stop/start tasks (two spawned children, one
/// orphaned out of `SidecarState`). The graceful-stop wait (#1088) widens
/// that window to ~6s, so gate it explicitly: while a restart is in flight,
/// further requests are logged no-ops.
pub(crate) static RESTART_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// RAII holder for `RESTART_IN_PROGRESS`.
///
/// The gate has to be released on **every** way out of a restart attempt —
/// success, failure, and (since #1756) a decline. Three call sites each ending
/// in a hand-written `store(false)` is three chances to add a fourth exit that
/// forgets one, and a forgotten release is invisible: `RESTART_IN_PROGRESS`
/// latches for the process lifetime and both the Restart button and "Retry
/// Server Start" become permanent no-ops that look like they worked.
///
/// A dropped release is now a deleted `Drop` impl, which
/// `restart_gate_releases_on_drop` catches.
pub(crate) struct RestartGate(());

impl RestartGate {
    /// `None` when a restart is already in flight.
    pub(crate) fn try_acquire() -> Option<Self> {
        RESTART_IN_PROGRESS
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| RestartGate(()))
    }
}

impl Drop for RestartGate {
    fn drop(&mut self) {
        RESTART_IN_PROGRESS.store(false, Ordering::Release);
    }
}

/// Gracefully stop the sidecar (flush dirty docs + save session, #1088),
/// hard-kill as fallback, then spawn it again.
#[tauri::command]
pub(crate) fn restart_sidecar(app: tauri::AppHandle) {
    let Some(gate) = RestartGate::try_acquire() else {
        log::warn!("restart_sidecar ignored — a restart is already in flight");
        return;
    };
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
        // Moved into the task, so the gate is released on every way out of it —
        // including the early return below and a panic. See `RestartGate`.
        let _gate = gate;
        // The shutdown check belongs HERE, not in the command body above: the
        // command returns immediately and the WebView's click can land long
        // before this task is polled, so a check up there is stale by the time
        // it matters. #1756.
        if !spawn_allowed() {
            log::warn!("restart_sidecar ignored — the sidecar is shutting down");
            return;
        }
        // Graceful stop before the hard kill (#1088): POST /api/shutdown so
        // the Node shutdown sequence flushes up to ~60s of unsaved edits and
        // persists the session, then wait up to 6s for exit. A bare kill()
        // here discarded those edits and made server/WebView histories
        // diverge on every restart.
        stop_sidecar_gracefully(&handle, &client, GRACEFUL_SHUTDOWN_DEADLINE_SECS).await;
        // Restart never re-injects the cold-start file: the original `setup()`
        // invocation already opened it and registered it in `openDocuments`.
        match start_sidecar(&handle, &client, None).await {
            Ok(SpawnOutcome::Started) => {}
            // A decline is not a restart. By this point the command body has
            // already run `clear_healthy_under_lock` and `clear_startup_rejection`,
            // so `SIDECAR_HEALTHY` is false with no sidecar coming back: exactly
            // #1416's condition (opens queue into a queue with no consumer) with
            // a Restart button that looks like it worked — `NetworkSettings.svelte`
            // only sees a resolved command and no error. So surface it the same
            // way the failure arm does, with its own code.
            //
            // Except while EXITING: the app is quitting, a toast has nowhere to
            // land, and `report_pending_opens_with(.., true, ..)` would latch a
            // give-up verdict for a session that is ending anyway.
            Ok(SpawnOutcome::Declined) => {
                if EXITING.load(Ordering::Acquire) {
                    log::info!(
                        "[restart_sidecar] declined — the app is exiting; nothing to surface"
                    );
                } else {
                    log::warn!(
                        "[restart_sidecar] declined — the sidecar is shutting down (update install in flight)"
                    );
                    report_pending_opens_with(handle.state::<PendingOpens>().inner(), true, |code| {
                        surface_startup_rejection(&handle, code)
                    });
                    // Same event as the failure arm, because the same toast is
                    // the right surface: the button did not restart the server.
                    // The distinct payload code is a log-side distinction only —
                    // `App.svelte`'s listener ignores the payload and hardcodes
                    // its message, so do not read this as a different toast.
                    if let Err(emit_err) =
                        handle.emit("sidecar-restart-failed", "SIDECAR_RESTART_DECLINED")
                    {
                        log::error!("[restart_sidecar] failed to emit decline event: {emit_err}");
                    }
                }
            }
            Err(e) => {
                // The emitted event carries a stable code, no error detail, so
                // the WebView's toast can never leak paths, env vars, errno
                // text, or the auth token.
                //
                // NB: "the detail stays in the log sink" is not the same as "the
                // detail is not user-visible" — `tauri-plugin-log` registers
                // `TargetKind::Webview` at LevelFilter::Warn in release, so this
                // `log::error!` is forwarded to the WebView as a `log://log`
                // event (nothing in src/client currently listens). The emit
                // below is what carries the contract; the log line is not a
                // second, quieter channel. Keep sensitive detail out of both.
                log::error!("[restart_sidecar] failed to restart sidecar: {e}");
                eprintln!("[restart_sidecar] failed to restart sidecar: {e}");
                // Terminal: nothing retries automatically from here. The queue
                // is retained (Settings -> Network -> Restart server still
                // delivers it), but until someone tries again a further open
                // must fail fast rather than join a queue with no consumer.
                // #1416
                report_pending_opens_with(handle.state::<PendingOpens>().inner(), true, |code| {
                    surface_startup_rejection(&handle, code)
                });
                if let Err(emit_err) =
                    handle.emit("sidecar-restart-failed", "SIDECAR_RESTART_FAILED")
                {
                    log::error!("[restart_sidecar] failed to emit failure event: {emit_err}");
                }
            }
        }
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
pub(crate) async fn port_holder_for_dialog() -> Option<PortHolder> {
    describe_port_holder(&[WS_PORT, MCP_PORT])
}

#[cfg(target_os = "windows")]
pub(crate) async fn port_holder_for_dialog() -> Option<PortHolder> {
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

/// What a graceful stop actually achieved. Carried out of
/// `stop_sidecar_gracefully` and into the single exit-path verdict line, because
/// the release log floor is `Warn` (`lib.rs`'s `tauri_plugin_log` builder) and
/// every step-by-step `info!` below it is invisible on an installed build — the
/// build the smoke checklist is run against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GracefulStop {
    /// No owned child, so nothing was POSTed. **Unsaved edits are not flushed.**
    Skipped,
    /// The POST failed or answered non-2xx; the hard kill is all that follows.
    PostFailed,
    /// POST accepted, but the server was still answering `/health` at the
    /// deadline.
    TimedOut,
    /// POST accepted and the server stopped answering — the flush ran.
    Flushed,
}

impl GracefulStop {
    /// The token that appears in the verdict line, and therefore in
    /// `docs/release-smoke-checklist.md`. Pinned by
    /// `verdict_line_carries_the_substrings_the_smoke_checklist_greps`.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            GracefulStop::Skipped => "Skipped",
            GracefulStop::PostFailed => "PostFailed",
            GracefulStop::TimedOut => "TimedOut",
            GracefulStop::Flushed => "Flushed",
        }
    }
}

/// The verdict plus the one field the 202 body carries.
pub(crate) struct StopReport {
    pub(crate) verdict: GracefulStop,
    /// `data.alreadyInProgress` from the 202 (`src/server/mcp/routes/shutdown.ts`):
    /// something else had already invoked the shutdown sequence. Worth carrying
    /// because it is the difference between "our POST started the flush" and
    /// "we joined one already running", which changes what a `TimedOut` means.
    pub(crate) already_in_progress: bool,
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
pub(crate) async fn stop_sidecar_gracefully(
    handle: &tauri::AppHandle,
    client: &reqwest::Client,
    deadline_secs: u64,
) -> StopReport {
    let state: tauri::State<'_, SidecarState> = handle.state();
    let owns_child = match state.0.lock() {
        Ok(guard) => guard.is_some(),
        Err(poisoned) => poisoned.into_inner().is_some(),
    };
    let report = graceful_stop_request(client, deadline_secs, Endpoints::PRODUCTION, owns_child).await;
    kill_sidecar_inner(handle);
    report
}

/// The two sidecar URLs a graceful stop touches, kept together so a test can
/// swap both at once and neither can be forgotten.
///
/// **Not #1825's fix.** `PRODUCTION` still holds the hardcoded :3479 constants;
/// this only makes them injectable, which is what lets a unit test observe a
/// real POST and a real port-release wait.
#[derive(Clone, Copy)]
struct Endpoints<'a> {
    shutdown: &'a str,
    health: &'a str,
}

impl Endpoints<'static> {
    const PRODUCTION: Self = Endpoints {
        shutdown: SHUTDOWN_URL,
        health: HEALTH_URL,
    };
}

/// The network half of the graceful stop, with no `AppHandle` and no kill.
///
/// Split out for two reasons. It is what `graceful::attempt` runs under the exit
/// budget (the kill there is `kill_sidecar_on_exit`, which needs the witness
/// token), and it is the only shape a unit test can drive — `AppHandle` is not
/// constructible outside a running Tauri app, which is why the `owned_child`
/// read and the URL are parameters rather than reads of module state.
async fn graceful_stop_request(
    client: &reqwest::Client,
    deadline_secs: u64,
    endpoints: Endpoints<'_>,
    owns_child: bool,
) -> StopReport {
    let Endpoints {
        shutdown: shutdown_url,
        health: health_url,
    } = endpoints;
    // Log the gate both ways with its target: after #1756 this decides whether a
    // Quit flushes the user's edits or silently skips the flush, and
    // `owns_child` is now pid-keyed (see `on_child_terminated_in`) so a crashed
    // sidecar reads as "not owned" rather than as a live handle.
    //
    // NB: `SHUTDOWN_URL` (and `HEALTH_URL`, which `wait_for_port_release` polls)
    // hardcode :3479 and **the shell never verifies it owns what answers there**.
    // Two consequences, and #1756 widened the second from two explicit user
    // actions (Restart server, Install update) to every Quit:
    //   - with a non-default `TANDEM_MCP_PORT` the POST misses, costs its own 5s
    //     client timeout, `posted` stays false, the port wait is skipped and the
    //     hard kill follows — bounded, but not immediate;
    //   - with a FOREIGN Tandem on :3479 (a `tandem start`, a second app-data
    //     instance) the POST hits *that* server, which flushes and exits, while
    //     this log line claims a graceful stop. `owns_child` only says we hold a
    //     child handle, never that the child is what is listening.
    // `wait_for_port_release` polls `/health` with the same absence of an
    // identity check. #1825 (derive the URL) and #1812 (identity) are the fixes;
    // both are out of scope here. The spawn site now pins `TANDEM_MCP_PORT` /
    // `TANDEM_PORT` / `TANDEM_BIND_HOST` explicitly, which removes the ambient-env
    // half of the first case but nothing of the second.
    if owns_child {
        log::info!("Graceful stop: we own the sidecar child — POSTing {shutdown_url}");
        let mut already_in_progress = false;
        let posted = match client.post(shutdown_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                already_in_progress = read_already_in_progress(resp).await;
                true
            }
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
        let verdict = if !posted {
            GracefulStop::PostFailed
        } else if wait_for_server_gone(client, deadline_secs, health_url).await {
            log::info!("Sidecar exited gracefully after /api/shutdown");
            GracefulStop::Flushed
        } else {
            log::warn!(
                "Sidecar still up {deadline_secs}s after /api/shutdown — falling back to hard kill"
            );
            GracefulStop::TimedOut
        };
        StopReport {
            verdict,
            already_in_progress,
        }
    } else {
        // `warn`, not `info`: in release the log floor is Warn, and this is the
        // branch on which a Quit silently loses work. Naming the consequence is
        // the point — "skipping POST" alone reads like a tidy no-op.
        log::warn!(
            "Graceful stop: no owned sidecar child — skipping the graceful stop; unsaved edits are NOT flushed (would have POSTed {shutdown_url})"
        );
        StopReport {
            verdict: GracefulStop::Skipped,
            already_in_progress: false,
        }
    }
}

/// Read `data.alreadyInProgress` out of the 202 body, defaulting to `false`.
///
/// Deliberately total: a body we cannot read or parse is not a shutdown failure
/// — the 202 already told us the sequence was accepted — so it costs one debug
/// line and a `false`, never a changed verdict.
async fn read_already_in_progress(resp: reqwest::Response) -> bool {
    match resp.json::<serde_json::Value>().await {
        Ok(body) => body
            .get("data")
            .and_then(|d| d.get("alreadyInProgress"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        Err(e) => {
            log::debug!("Graceful shutdown 202 body unreadable ({e}) — assuming not already in progress");
            false
        }
    }
}

/// Kill the sidecar process if one is running.
///
/// Private on purpose. Three functions in this module call it —
/// `stop_sidecar_gracefully` (on both arms of its `owns_child` gate),
/// `start_sidecar`'s health-failure arm, and `kill_sidecar_on_exit` — and the
/// first two have already done their own graceful work or are killing a child
/// that never became healthy. Everything on the application's exit path goes
/// through `kill_sidecar_on_exit`, which cannot be called without a
/// `graceful::GracefulAttempted` token. See #1756.
fn kill_sidecar_inner(handle: &tauri::AppHandle) {
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

/// The hard kill, as the exit path's fallback. Takes a token that only
/// `graceful::attempt` can mint.
///
/// **What the witness actually constrains, stated without overclaiming.** It
/// constrains an author who keeps calling `kill_sidecar_on_exit`: they cannot
/// reach it without going through `graceful::attempt` first. It does **not**
/// make dropping the graceful stop a compile error — `kill_sidecar_inner` is
/// private to this same module and callable directly, so an edit that swaps the
/// exit path onto it compiles, leaving `kill_sidecar_on_exit` and
/// `GracefulAttempted` behind as a `dead_code` *warning* (there is no
/// `deny(warnings)` and neither CI nor pre-push runs clippy).
///
/// **And the token proves `attempt` was called, not that the call meant
/// anything**: `attempt` invoked with a zero budget still hands one back. Two
/// things do detect that now — `graceful_attempt_posts_and_waits_for_the_reply`
/// (a real POST against a loopback listener, which a `timeout(1ms)` or a skipped
/// POST fails), and the single exit verdict line, where a neutered attempt reads
/// as `elapsed ≈ 1ms` with `timed_out=true`. `#[must_use]` would be inert here —
/// the token is consumed as an argument — so it is deliberately absent.
fn kill_sidecar_on_exit(handle: &tauri::AppHandle, _proof: graceful::GracefulAttempted) {
    kill_sidecar_inner(handle);
}

/// Decide whether a `Terminated` event for `terminated_pid` should clear a
/// `SidecarState` slot currently holding `slot_pid`.
///
/// Extracted so it is testable: `CommandChild` has no public constructor, so a
/// populated slot cannot be built out of the real payload type.
///
/// **A bare `take()` here would be a bug with teeth.** Drain tasks are per spawn
/// attempt and are never cancelled, and `Terminated` is delivered over a
/// `channel(1)` behind `child.wait()` plus a write lock
/// (`tauri-plugin-shell` `process/mod.rs`), so child A's `Terminated` can land
/// *after* child B has been stored. Clearing the slot then would orphan B and
/// make the next Quit skip the flush — #1756 reintroduced by its own fix.
///
/// **Accepted residual: OS pid reuse.** The key is the pid alone, so a recycled
/// pid — child A dies, the OS hands its number to child B, then A's `Terminated`
/// finally lands — would clear a live slot, and the next Quit would read "not
/// owned" and skip the flush. It takes a pid reused inside one delivery window
/// on a machine that just respawned the sidecar; noted rather than engineered
/// around, since the alternative (a spawn generation counter alongside the pid)
/// buys nothing else.
fn terminated_clears_slot(slot_pid: Option<u32>, terminated_pid: u32) -> bool {
    slot_pid == Some(terminated_pid)
}

/// A slot payload that can name its pid.
///
/// Exists so `clear_terminated_slot`'s `take()` branch is reachable from a test.
/// `CommandChild` has no public constructor, so before this a populated slot
/// could not be built at all and inverting the predicate stayed green.
trait SlotPid {
    fn slot_pid(&self) -> u32;
}

impl SlotPid for tauri_plugin_shell::process::CommandChild {
    fn slot_pid(&self) -> u32 {
        self.pid()
    }
}

/// The pid-keyed clear itself, generic over the slot payload so both branches
/// are drivable from a unit test.
fn clear_terminated_slot<T: SlotPid>(slot: &Mutex<Option<T>>, pid: u32) {
    let mut guard = match slot.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let slot_pid = guard.as_ref().map(SlotPid::slot_pid);
    if terminated_clears_slot(slot_pid, pid) {
        guard.take();
        log::info!("Sidecar pid {pid} terminated — cleared the owned-child slot");
    } else {
        log::info!(
            "Sidecar pid {pid} terminated — slot holds {slot_pid:?}, leaving it (newer child)"
        );
    }
}

/// Clear the owned-child slot when the child we stored has died.
///
/// Nothing else does this: before #1756 the drain task's `Terminated` arm set a
/// local flag only, so after a sidecar crash the slot kept a dead handle and
/// `owns_child` stayed true. That mattered once Quit started POSTing:
/// `SHUTDOWN_URL` is hardcoded :3479, so we would have shut down whatever now
/// listens there (a `tandem start`, a second app-data instance).
///
/// Deliberately does NOT kill anything — the child is already gone, and a kill
/// attached to this aliasing window is the bug above with a weapon.
fn on_child_terminated_in(state: &SidecarState, pid: u32) {
    clear_terminated_slot(&state.0, pid);
}

/// `AppHandle` wrapper for `on_child_terminated_in`. The drain task is
/// `'static`, so it cannot hold a `State<'_, SidecarState>`; it holds a cloned
/// handle and resolves the state here.
fn on_child_terminated(handle: &tauri::AppHandle, pid: u32) {
    match handle.try_state::<SidecarState>() {
        Some(state) => on_child_terminated_in(state.inner(), pid),
        None => log::warn!("Sidecar pid {pid} terminated — SidecarState unmanaged, nothing to clear"),
    }
}

/// The graceful stop attempted from `RunEvent::Exit`, and the token that proves
/// it was attempted.
///
/// A private submodule, not a bare struct in `sidecar.rs`: a witness defined in
/// the parent module is constructible by the parent, which is exactly the code
/// it is supposed to constrain. Privacy runs downward, so `GracefulAttempted`'s
/// private field is unreachable from `shutdown_sidecar_on_exit`.
mod graceful {
    use super::{
        build_http_client, graceful_stop_request, Endpoints, GracefulStop, SidecarState,
        HTTP_CLIENT_TIMEOUT,
    };
    use std::panic::AssertUnwindSafe;
    use std::time::Duration;
    use tauri::Manager;

    /// Unconstructible outside this module: the field is private and there is no
    /// public constructor.
    pub(super) struct GracefulAttempted(());

    /// What the attempt actually did — rendered into the single exit verdict
    /// line, so "0 ms, verdict=Skipped, owned_child=false" is distinguishable
    /// from a real flush. A smoke check that greps static banner strings is
    /// defeated by any edit that keeps the strings (#1746); the verdict is the
    /// half that cannot be kept while changing what happened.
    pub(super) struct Outcome {
        pub(super) attempted: bool,
        pub(super) timed_out: bool,
        pub(super) owned_child: bool,
        pub(super) panicked: bool,
        /// `None` when no `StopReport` came back: the outer budget fired
        /// mid-flight, the body panicked, or there was no HTTP client to try
        /// with. Rendered as `verdict=none`.
        pub(super) verdict: Option<GracefulStop>,
        pub(super) already_in_progress: bool,
    }

    /// Everything the attempt needs off the `AppHandle`, read **before** the
    /// attempt so that `attempt` itself is `AppHandle`-free and therefore
    /// unit-testable. Windows are hidden here too — see `prepare`.
    pub(super) struct Prep {
        pub(super) owned_child: bool,
        /// `None` only when there is no managed client and building one failed.
        pub(super) client: Option<reqwest::Client>,
    }

    /// Hide the windows and read what the attempt needs off the handle.
    ///
    /// Hide every window BEFORE blocking: `cleanup_before_exit` — which is what
    /// hides them on Windows — runs AFTER this callback returns (`tauri`
    /// `app.rs`, the `RuntimeRunEvent::Exit` arm), so without this a tray Quit
    /// leaves a live, unresponsive window on screen for the whole budget and
    /// Windows paints "Not Responding" past HungAppTimeout. `hide()` from the
    /// main thread is handled inline, so it still works with the loop being
    /// destroyed.
    ///
    /// Every read here is a `try_state` or a poison-tolerant lock, so none of
    /// them panics on unmanaged state. It still carries its own `catch_unwind`
    /// for the same reason `attempt` does — on macOS this whole callback runs
    /// inside tao's `applicationWillTerminate:`, where an unwind is abort/UB
    /// rather than "skips the rest", and `webview_windows()` takes a lock this
    /// code does not own. A panic here degrades to "no client, nothing owned",
    /// which `attempt` reports as `attempted=false, verdict=none`.
    pub(super) fn prepare(handle: &tauri::AppHandle) -> Prep {
        std::panic::catch_unwind(AssertUnwindSafe(|| prepare_inner(handle))).unwrap_or_else(
            |payload| {
                log::error!(
                    "Exit: preparing the graceful stop panicked ({}) — skipping to the hard kill",
                    panic_detail(payload.as_ref())
                );
                Prep {
                    owned_child: false,
                    client: None,
                }
            },
        )
    }

    fn prepare_inner(handle: &tauri::AppHandle) -> Prep {
        for window in handle.webview_windows().values() {
            if let Err(e) = window.hide() {
                // `warn`, not `debug`: `debug` is below the floor in EVERY build
                // (dev is Info, release is Warn), so this line existed nowhere.
                log::warn!("Exit: could not hide window before shutdown: {e}");
            }
        }

        let owned_child = handle
            .try_state::<SidecarState>()
            .map(|state| match state.0.lock() {
                Ok(guard) => guard.is_some(),
                Err(poisoned) => poisoned.into_inner().is_some(),
            })
            .unwrap_or(false);

        // Reuse the managed client so the exit path inherits the same 5s timeout
        // the budget arithmetic assumes. Never `unwrap()` the fallback build: a
        // failure there must skip to the kill, not abort inside an ObjC frame.
        let client = match handle.try_state::<reqwest::Client>() {
            Some(client) => Some(client.inner().clone()),
            None => match build_http_client(HTTP_CLIENT_TIMEOUT) {
                Ok(client) => Some(client),
                Err(e) => {
                    log::warn!("Exit: no HTTP client ({e}) — skipping the graceful stop");
                    None
                }
            },
        };

        Prep {
            owned_child,
            client,
        }
    }

    /// Run the bounded graceful stop on the calling (main) thread.
    ///
    /// `block_on` is safe here: `tauri::async_runtime` is a never-dropped
    /// multi-thread tokio runtime and `main` is a plain `fn main` with no
    /// runtime `enter()` guard, so there is no "cannot block the current thread
    /// from within a runtime" panic and nothing in the awaited path touches the
    /// event loop (every await is tokio IO/time; no lock is held across one).
    ///
    /// The `catch_unwind` is not defensive tidiness. On macOS this runs inside
    /// tao's `applicationWillTerminate:`, i.e. inside an ObjC frame, where an
    /// unwind is abort/UB rather than "skips the rest".
    ///
    /// **No `AppHandle` on purpose.** `owned_child` and the `Endpoints` are
    /// parameters rather than reads of module state precisely so this function
    /// can be driven by a unit test against a loopback listener — which is what
    /// catches the neutered attempt (zero budget, `timeout(1ms)`, a skipped
    /// POST) that the witness token cannot. The budget and deadline are
    /// interpolated from the PARAMETERS, never from `EXIT_GRACEFUL_BUDGET_SECS`:
    /// logging the constant while running a different value is exactly how a
    /// neutered call site would print "budget 17s".
    pub(super) fn attempt(
        prep: Prep,
        budget: Duration,
        deadline_secs: u64,
        endpoints: Endpoints<'_>,
    ) -> (Outcome, GracefulAttempted) {
        let Prep {
            owned_child,
            client,
        } = prep;
        let Some(client) = client else {
            return (
                Outcome {
                    attempted: false,
                    timed_out: false,
                    owned_child,
                    panicked: false,
                    verdict: None,
                    already_in_progress: false,
                },
                GracefulAttempted(()),
            );
        };
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let budget_secs = budget.as_secs_f64();
            log::info!("Exit: stopping sidecar gracefully (budget {budget_secs}s, deadline {deadline_secs}s)");
            // **`timeout()` is constructed INSIDE the async block, not passed
            // into `block_on` as an argument.** `tokio::time::timeout` builds a
            // `Sleep`, and `Sleep::new_timeout` calls `scheduler::Handle::
            // current()` eagerly — which panics with "there is no reactor
            // running" when there is no runtime on the calling thread. An
            // argument is evaluated BEFORE `block_on` enters the runtime, and
            // this runs on the tao main thread, so the argument form panicked
            // every time: `catch_unwind` swallowed it, the outcome came back
            // `panicked`, and the hard kill ran with no flush — #1756 intact
            // behind a fix that looked right. Wrapping it in an `async` block
            // defers construction to the first poll, which is inside the
            // runtime. `graceful_attempt_posts_and_waits_for_the_reply` is what
            // found this and is what keeps it found.
            match tauri::async_runtime::block_on(async {
                tokio::time::timeout(
                    budget,
                    graceful_stop_request(&client, deadline_secs, endpoints, owned_child),
                )
                .await
            }) {
                Ok(report) => Outcome {
                    attempted: true,
                    timed_out: false,
                    owned_child,
                    panicked: false,
                    verdict: Some(report.verdict),
                    already_in_progress: report.already_in_progress,
                },
                Err(_) => {
                    log::warn!(
                        "Exit: graceful sidecar stop exceeded its {budget_secs}s budget — hard kill follows"
                    );
                    Outcome {
                        attempted: true,
                        timed_out: true,
                        owned_child,
                        panicked: false,
                        verdict: None,
                        already_in_progress: false,
                    }
                }
            }
        }));
        let outcome = result.unwrap_or_else(|payload| {
            // Carry the payload into the line. On the Windows GUI subsystem
            // stderr is a closed handle and no `panic::set_hook` is installed,
            // so the default hook's message goes nowhere — dropping the payload
            // here (`|_|`) meant a panicking exit logged no cause at all.
            let detail = panic_detail(payload.as_ref());
            log::error!(
                "Exit: graceful sidecar stop panicked ({detail}) — falling back to the hard kill"
            );
            Outcome {
                // The attempt WAS made — it panicked partway. Reporting
                // `attempted: false` here manufactured the exact "nothing
                // happened" line the verdict is supposed to distinguish.
                attempted: true,
                timed_out: false,
                owned_child,
                panicked: true,
                verdict: None,
                already_in_progress: false,
            }
        });
        (outcome, GracefulAttempted(()))
    }

    /// The two payload shapes `panic!` produces in practice.
    fn panic_detail(payload: &(dyn std::any::Any + Send)) -> String {
        if let Some(s) = payload.downcast_ref::<&'static str>() {
            (*s).to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "non-string panic payload".to_string()
        }
    }
}

/// `RunEvent::Exit` handler (#1756).
///
/// `RunEvent::Exit` rather than `ExitRequested` because it is the one event
/// every quit gesture reaches: macOS ⌘Q / Dock Quit go through
/// `applicationWillTerminate:` -> `LoopDestroyed` and never raise
/// `ExitRequested`, the Linux no-tray window close raises `ExitRequested`
/// twice, and `prevent_exit()` is a no-op for a restart-coded exit.
///
/// Before this, Quit was a bare `kill_sidecar`, discarding up to ~60s of
/// unsaved edits, the tab set, and leaving the store lock behind.
pub(crate) fn shutdown_sidecar_on_exit(app: &tauri::AppHandle) {
    let started = std::time::Instant::now();
    let (outcome, proof) = exit_sequence(|| graceful::prepare(app), Endpoints::PRODUCTION);
    // Unconditional, and outside the `catch_unwind` inside `attempt`, so a
    // panicked graceful stop still ends with the child dead.
    kill_sidecar_on_exit(app, proof);
    log::warn!("{}", exit_verdict_line(started.elapsed(), &outcome));
}

/// The `AppHandle`-free middle of the exit sequence: latch `EXITING`, prepare,
/// then run the bounded graceful stop with the parameters a real Quit uses.
///
/// **Hoisted out of `shutdown_sidecar_on_exit` because that function's body is
/// reachable by no test** — it needs an `AppHandle` — and three edits inside it
/// re-break #1756 while the whole suite stays green: passing
/// `Duration::from_millis(1)` instead of `EXIT_GRACEFUL_BUDGET` (every Quit then
/// times out in 1 ms and hard-kills), forwarding a zero deadline, and deleting
/// the `EXITING` latch (the respawn race returns). `graceful::attempt` being
/// well covered does not help: the defect lives in what the caller HANDS it.
///
/// So `prepare` and `endpoints` are parameters, and nothing else is: pointed at
/// a loopback listener, the forwarded budget and deadline become *observable*
/// rather than merely asserted-equal at a call site. A 1 ms budget cannot await
/// a reply that arrives 200 ms later, and a zero deadline sends
/// `wait_for_server_gone` through a loop body that never runs, so
/// `exit_sequence_forwards_the_budget_and_deadline_a_real_quit_uses` reports
/// `timed_out` / `verdict=TimedOut` where a real Quit reports a flush. `prepare`
/// is a closure rather than a ready-made `Prep` so the `EXITING`-before-prepare
/// ordering is observable too, not just the flag's final value.
///
/// The residual is the two arguments bound at the call site above, alongside the
/// already documented `RunEvent::Exit` arm in `lib.rs`.
fn exit_sequence(
    prepare: impl FnOnce() -> graceful::Prep,
    endpoints: Endpoints<'_>,
) -> (graceful::Outcome, graceful::GracefulAttempted) {
    // One-way, and set BEFORE anything that takes the SidecarState lock — which
    // `prepare` does, to read `owned_child`. That ordering is what closes the
    // respawn race: either the store site sees the flag under the lock and kills
    // its fresh child, or the kill sees the stored child. The residual is a
    // child between `cmd.spawn()` and the lock at the instant the process exits
    // — unavoidable, and covered by the job object on Windows.
    EXITING.store(true, Ordering::Release);
    let prep = prepare();
    graceful::attempt(
        prep,
        EXIT_GRACEFUL_BUDGET,
        GRACEFUL_SHUTDOWN_DEADLINE_SECS,
        endpoints,
    )
}

/// The one line that has to reach `tandem.log` on an installed build.
///
/// **`warn`, and a single line, because of the release log floor.** `lib.rs`
/// builds `tauri_plugin_log` at `LevelFilter::Warn` in release, so every
/// `log::info!` on the graceful path — including "Sidecar exited gracefully
/// after /api/shutdown" — is invisible on exactly the build
/// `docs/release-smoke-checklist.md` is run against. Three greps over three
/// `info!` strings would have passed on a dev build and found nothing on an
/// installer.
///
/// Built as a pure function so the format can be pinned by
/// `verdict_line_carries_the_substrings_the_smoke_checklist_greps`: the
/// checklist's grep and this string must agree byte-for-byte, and a test is the
/// only thing that keeps them agreeing (#1746).
fn exit_verdict_line(elapsed: std::time::Duration, outcome: &graceful::Outcome) -> String {
    format!(
        "Exit: sidecar shutdown complete (elapsed={}ms, verdict={}, attempted={}, timed_out={}, owned_child={}, already_in_progress={}, panicked={})",
        elapsed.as_millis(),
        outcome.verdict.map_or("none", GracefulStop::as_str),
        outcome.attempted,
        outcome.timed_out,
        outcome.owned_child,
        outcome.already_in_progress,
        outcome.panicked
    )
}

pub(crate) fn build_http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

/// What a `start_sidecar` success actually was.
///
/// **Never overload `Ok(())`.** A decline is not a start, and the two consumers
/// that used to read it as one both misreported: "Retry Server Start" logged
/// "Server-start retry succeeded" and ran an update check on the one dialog
/// whose job is to say the server did not start, and `restart_sidecar` — which
/// has already cleared `SIDECAR_HEALTHY` and the startup rejection in its
/// command body — left the Restart button looking like it worked while opens
/// queued into a queue with no consumer (#1416's condition).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SpawnOutcome {
    /// A healthy sidecar is available: we spawned one, or (debug builds only) an
    /// external `dev:standalone` server was already answering `/health`.
    Started,
    /// `spawn_allowed()` was false — an exit or an update install is in flight —
    /// so no child was spawned and none will be. **Not a failure and not a
    /// success**; the caller decides what to surface, and during an exit the
    /// answer is "nothing".
    Declined,
}

/// Spawn the Node.js sidecar and wait for the health endpoint.
/// Retries up to MAX_RESTARTS times with exponential backoff on crash.
///
/// **Returns `Ok(SpawnOutcome::Declined)` when the app is shutting down**
/// (#1756), rather than the terminal `Err` after the retry loop: that `Err`
/// reaches `restart_sidecar`'s failure arm (`report_pending_opens_with(.., true,
/// ..)` plus an emitted `sidecar-restart-failed`) and the "Retry Server Start"
/// dialog, i.e. a user-facing rejection raised while the app is quitting.
/// `Declined` is neither, and every caller must match on it.
pub(crate) async fn start_sidecar(
    handle: &tauri::AppHandle,
    client: &reqwest::Client,
    cold_start_file: Option<&std::path::Path>,
) -> Result<SpawnOutcome, String> {
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
        return Ok(SpawnOutcome::Started);
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
        // Cheap early-out. This is the courtesy check, NOT the one that closes
        // the race — that one is under the SidecarState lock at the store site
        // below, because the flag can be set at any point between here and
        // there. #1756.
        if !spawn_allowed() {
            log::info!("start_sidecar: shutdown in progress — not spawning");
            return Ok(SpawnOutcome::Declined);
        }
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
            .env("TANDEM_DATA_DIR", app_data_dir_str.as_str())
            // Pin the sidecar's listening addresses to the ones this shell has
            // hardcoded in `HEALTH_URL` / `SHUTDOWN_URL` / `WS_PORT` / `MCP_PORT`.
            //
            // **`tauri-plugin-shell` DOES inherit the parent environment.**
            // `Command::new` (`tauri-plugin-shell-2.3.5/src/process/mod.rs:162-179`)
            // never calls `env_clear()`; `env_clear` (`:205-208`) runs only when
            // the caller asks for it; `spawn` (`:305-320`) converts to a plain
            // `std::process::Command` and hands it to `SharedChild::spawn`,
            // which inherits by default. So an ambient `TANDEM_MCP_PORT` in the
            // environment that launched the desktop app reached the child and
            // moved it off :3479 (`src/server/index.ts:97-98`, `:503`); the
            // shell would then miss its own child on every health poll and,
            // after #1756, POST `/api/shutdown` at whatever else answers :3479
            // on **every Quit**. Setting these explicitly is what makes the
            // child's addresses the ones the constants above name. It does not
            // fix #1825 (the URLs are still hardcoded) and gives the POST no
            // identity check (#1812) — a foreign server already on :3479 is
            // still mistaken for ours.
            .env("TANDEM_PORT", WS_PORT.to_string())
            .env("TANDEM_MCP_PORT", MCP_PORT.to_string())
            .env("TANDEM_BIND_HOST", SIDECAR_BIND_HOST);

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
        // source). Passed explicitly because the shell reads it from its OWN
        // process env and the child's copy must match this launch's opt-in
        // state, not whatever was ambient — the plugin does inherit the parent
        // env (see the port block above), so this is a pin, not a bridge.
        // Unset → not forwarded → sidecar reporting stays off (default posture).
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

        // Captured BEFORE `child` is moved into `SidecarState` below, and keyed
        // per spawn attempt: the drain task uses it to clear the slot only when
        // the child that died is the child the slot holds (#1756).
        let child_pid = child.pid();
        // The task is `'static`, so it cannot borrow a `State<'_, SidecarState>`.
        let terminated_handle = handle.clone();

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
                        // Clear the owned-child slot so a crashed sidecar stops
                        // reading as "we own :3479". Pid-keyed, and no kill —
                        // see `on_child_terminated_in`. #1756.
                        on_child_terminated(&terminated_handle, child_pid);
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
            // The load-bearing half of the respawn guard (#1756), re-read under
            // the very lock the exit path's kill takes. `EXITING` is set before
            // that kill, so either we see the flag here or the kill sees the
            // child we just stored — the window between them cannot swallow a
            // spawn. `child.kill()` directly rather than `kill_sidecar_inner`,
            // which would re-take this lock; the child is not in the slot yet.
            if !spawn_allowed() {
                log::warn!(
                    "start_sidecar: shutdown began while spawning — killing the fresh child (pid {child_pid})"
                );
                if let Err(e) = child.kill() {
                    log::error!("Failed to kill sidecar spawned during shutdown: {e}");
                }
                return Ok(SpawnOutcome::Declined);
            }
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

                return Ok(SpawnOutcome::Started);
            }
            Err(e) => {
                log::error!("Health check failed: {e}");
                kill_sidecar_inner(handle);
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
    check_health_at(client, HEALTH_URL).await
}

async fn check_health_at(client: &reqwest::Client, health_url: &str) -> bool {
    if let Ok(resp) = client.get(health_url).send().await {
        return resp.status().is_success();
    }
    false
}

/// Poll until the health endpoint stops responding (port released).
/// Returns true if released within the deadline, false on timeout.
pub(crate) async fn wait_for_port_release(client: &reqwest::Client, deadline_secs: u64) -> bool {
    wait_for_server_gone(client, deadline_secs, HEALTH_URL).await
}

/// `wait_for_port_release` with the polled URL as a parameter.
///
/// The parameter exists so `graceful_stop_request` can be pointed at a test
/// listener; `wait_for_port_release` keeps the no-URL signature its four other
/// callers use. Taking the URL rather than deriving it is deliberately NOT a fix
/// for #1825 — the constants are still hardcoded at every production call site.
async fn wait_for_server_gone(
    client: &reqwest::Client,
    deadline_secs: u64,
    health_url: &str,
) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(deadline_secs);
    while tokio::time::Instant::now() < deadline {
        if !check_health_at(client, health_url).await {
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
/// Anchored through [`system_paths::system32_exe`] rather than resolved by the
/// loader: `Command::new("netstat")` searches the application directory ahead of
/// System32, and both binaries are guaranteed at the fixed path. That module
/// carries the full search order, and why the anchor comes from
/// `GetSystemDirectoryW` rather than `%SystemRoot%` — an env var the launching
/// process controls, which as a mitigation is weaker than the bare name it
/// replaces. CREATE_NO_WINDOW keeps a GUI-subsystem app from flashing a console
/// window.
///
/// Fails CLOSED when the system directory cannot be resolved: falling back to
/// the bare name would do exactly the unanchored lookup this exists to avoid.
/// Every caller degrades to generic text on None, so a skipped diagnostic costs
/// nothing. (`freePortWindows` in src/server/platform.ts makes the opposite
/// call, deliberately — its lookup is load-bearing for startup rather than
/// cosmetic, and Node cannot reach `GetSystemDirectoryW` without a native
/// module.)
#[cfg(target_os = "windows")]
fn run_system32_tool(exe: &str, args: &[&str]) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let program = crate::system_paths::system32_exe(exe)?;
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
    pub(crate) fn message(&self) -> String {
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
    pub(crate) fn killable_process(&self) -> Option<String> {
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
pub(crate) async fn wait_for_sidecar_unlock(deadline_secs: u64) -> bool {
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

/// Guards and arithmetic for the graceful-quit path (#1756).
///
/// A separate module from `port_holder_tests`, which is the netstat parser's.
///
/// **What these tests cannot see, stated plainly.** The `RunEvent::Exit`
/// handler itself cannot be driven without `tauri = { features = ["test"] }` and
/// making `shutdown_sidecar_on_exit` / `graceful::prepare` /
/// `kill_sidecar_on_exit` generic over `R: Runtime`; that is deliberately not
/// done here, so nothing pins that `RunEvent::Exit` is wired to
/// `shutdown_sidecar_on_exit` at all, nor that `graceful::prepare` hides the
/// windows before blocking.
///
/// What they DO now see, and did not before: `graceful::attempt` is
/// `AppHandle`-free, so `graceful_attempt_posts_and_waits_for_the_reply` drives
/// a real POST against a loopback listener and fails on a zero budget, a
/// `timeout(1ms)` or a skipped POST — the neutered attempt the
/// `GracefulAttempted` witness cannot catch. The witness's own limit is stated
/// on `kill_sidecar_on_exit`: it is not the compile error the first draft
/// claimed.
#[cfg(test)]
mod shutdown_guard_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// `EXITING` and `SIDECAR_SHUTTING_DOWN` are process-wide statics; serialize
    /// the tests that write them.
    static FLAG_LOCK: Mutex<()> = Mutex::new(());

    fn set_flags(exiting: bool, shutting_down: bool) {
        EXITING.store(exiting, Ordering::Release);
        SIDECAR_SHUTTING_DOWN.store(shutting_down, Ordering::Release);
    }

    #[test]
    fn spawn_allowed_over_all_four_flag_combinations() {
        let _guard = FLAG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        set_flags(false, false);
        assert!(spawn_allowed(), "neither flag set — spawning is permitted");
        set_flags(true, false);
        assert!(!spawn_allowed(), "EXITING alone must block a spawn");
        set_flags(false, true);
        assert!(
            !spawn_allowed(),
            "SIDECAR_SHUTTING_DOWN alone must block a spawn"
        );
        set_flags(true, true);
        assert!(!spawn_allowed(), "both flags set must block a spawn");
        // An update that fails DURING an exit clears only its own flag; the
        // one-way EXITING must still hold the door shut.
        SIDECAR_SHUTTING_DOWN.store(false, Ordering::Release);
        assert!(
            !spawn_allowed(),
            "clearing the updater's flag must not re-permit spawns during an exit"
        );
        set_flags(false, false);
    }

    #[test]
    fn terminated_clears_only_the_slot_holding_that_pid() {
        assert!(
            terminated_clears_slot(Some(4242), 4242),
            "the slot holds the child that died — clear it"
        );
        assert!(
            !terminated_clears_slot(Some(4243), 4242),
            "a newer child is stored — clearing it would orphan the live sidecar"
        );
        assert!(
            !terminated_clears_slot(None, 4242),
            "an empty slot has nothing to clear"
        );
    }

    #[test]
    fn on_child_terminated_in_leaves_an_empty_slot_empty() {
        let state = SidecarState(Mutex::new(None));
        on_child_terminated_in(&state, 4242);
        assert!(state.0.lock().unwrap().is_none());
    }

    /// Stands in for `CommandChild`, which has no public constructor. Without
    /// it the `guard.take()` branch of `clear_terminated_slot` was executed by
    /// no test at all and inverting the predicate stayed green.
    struct FakeChild(u32);

    impl SlotPid for FakeChild {
        fn slot_pid(&self) -> u32 {
            self.0
        }
    }

    #[test]
    fn clear_terminated_slot_takes_a_matching_pid_and_keeps_a_newer_one() {
        let matching = Mutex::new(Some(FakeChild(4242)));
        clear_terminated_slot(&matching, 4242);
        assert!(
            matching.lock().unwrap().is_none(),
            "the slot holds the child that died — it must be taken"
        );

        let newer = Mutex::new(Some(FakeChild(4243)));
        clear_terminated_slot(&newer, 4242);
        assert_eq!(
            newer.lock().unwrap().as_ref().map(FakeChild::slot_pid),
            Some(4243),
            "a newer child is stored — taking it would orphan the live sidecar"
        );
    }

    /// The exact substrings `docs/release-smoke-checklist.md` greps for.
    ///
    /// The checklist cannot read the code and the code cannot read the
    /// checklist, so this test is the whole of the agreement between them: a
    /// rename of any field, or a switch back to several `info!` lines, turns it
    /// red instead of turning a smoke row into a grep that silently matches
    /// nothing (#1746).
    #[test]
    fn verdict_line_carries_the_substrings_the_smoke_checklist_greps() {
        let flushed = graceful::Outcome {
            attempted: true,
            timed_out: false,
            owned_child: true,
            panicked: false,
            verdict: Some(GracefulStop::Flushed),
            already_in_progress: false,
        };
        let line = exit_verdict_line(Duration::from_millis(1234), &flushed);
        for needle in [
            "Exit: sidecar shutdown complete",
            "elapsed=1234ms",
            "verdict=Flushed",
            "timed_out=false",
            "owned_child=true",
            "already_in_progress=false",
            "panicked=false",
            "attempted=true",
        ] {
            assert!(line.contains(needle), "verdict line lost {needle:?}: {line}");
        }

        // The other half of the point: a neutered or skipped attempt must not be
        // able to produce the string above.
        let skipped = graceful::Outcome {
            attempted: false,
            timed_out: false,
            owned_child: false,
            panicked: false,
            verdict: None,
            already_in_progress: false,
        };
        let line = exit_verdict_line(Duration::from_millis(0), &skipped);
        assert!(line.contains("verdict=none"), "{line}");
        assert!(!line.contains("verdict=Flushed"), "{line}");
        assert!(!line.contains("owned_child=true"), "{line}");
    }

    /// A one-shot loopback stand-in for the sidecar's `/api/shutdown`, returning
    /// its address and a handle yielding the request head it read.
    ///
    /// Shared by the two tests that need a REAL POST and a real port-release
    /// wait — `graceful::attempt` directly, and the whole `exit_sequence` — so
    /// that both observe the same 200 ms reply delay and the same
    /// closed-port-afterwards behaviour. Each runs in ~250 ms.
    fn stub_shutdown_endpoint() -> (std::net::SocketAddr, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("local_addr");
        // Non-blocking accept with its own deadline, so a regression that stops
        // POSTing turns the caller RED instead of hanging the suite forever on
        // `join()` — a hung pre-push run is worse than a failing one.
        listener.set_nonblocking(true).expect("set_nonblocking");
        let server = std::thread::spawn(move || {
            let accept_by = std::time::Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        if std::time::Instant::now() >= accept_by {
                            return "<no connection within 5s>".to_string();
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(e) => return format!("<accept failed: {e}>"),
                }
            };
            // Stop listening the instant we have the connection. The health poll
            // that follows must hit a CLOSED port and fail fast; a listener still
            // accepting would leave that GET unanswered until the client's 5 s
            // timeout, which is the only way this test could get slow or flaky.
            drop(listener);
            stream.set_nonblocking(false).expect("blocking stream");
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("read timeout");
            let mut buf = [0u8; 2048];
            let n = match stream.read(&mut buf) {
                Ok(n) => n,
                Err(e) => return format!("<read failed: {e}>"),
            };
            let head = String::from_utf8_lossy(&buf[..n]).to_string();
            // The delay is the assertion's teeth: `elapsed >= 200 ms` is only
            // reachable by actually awaiting this reply.
            std::thread::sleep(Duration::from_millis(200));
            let body = br#"{"data":{"shuttingDown":true,"alreadyInProgress":true}}"#;
            let resp = format!(
                "HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(resp.as_bytes()).expect("write head");
            stream.write_all(body).expect("write body");
            stream.flush().expect("flush");
            head
        });
        (addr, server)
    }

    /// A real POST and a real port-release wait, against a loopback listener.
    ///
    /// This is what a `Duration::from_millis(1)` budget, a skipped POST or a
    /// zero deadline cannot survive — the three mutants the witness token waves
    /// through. It runs in ~250 ms.
    #[test]
    fn graceful_attempt_posts_and_waits_for_the_reply() {
        let (addr, server) = stub_shutdown_endpoint();

        let shutdown = format!("http://{addr}/api/shutdown");
        let health = format!("http://{addr}/health");
        let prep = graceful::Prep {
            owned_child: true,
            client: Some(build_http_client(HTTP_CLIENT_TIMEOUT).expect("build client")),
        };

        let started = std::time::Instant::now();
        let (outcome, _proof) = graceful::attempt(
            prep,
            EXIT_GRACEFUL_BUDGET,
            GRACEFUL_SHUTDOWN_DEADLINE_SECS,
            Endpoints {
                shutdown: &shutdown,
                health: &health,
            },
        );
        let elapsed = started.elapsed();

        let head = server.join().expect("server thread");
        assert!(
            head.starts_with("POST /api/shutdown "),
            "the graceful stop must POST /api/shutdown, got: {head:?}"
        );
        assert!(outcome.attempted, "the attempt must report itself attempted");
        assert!(!outcome.timed_out, "17s is not a binding budget here");
        assert!(!outcome.panicked);
        assert!(outcome.owned_child, "owned_child is passed in, not re-read");
        assert_eq!(
            outcome.verdict,
            Some(GracefulStop::Flushed),
            "the port stopped answering after the 202 — that is a flush"
        );
        assert!(
            outcome.already_in_progress,
            "the 202 body said alreadyInProgress; discarding it must be visible"
        );
        assert!(
            elapsed >= Duration::from_millis(200),
            "the reply was awaited, not skipped (elapsed {elapsed:?})"
        );
    }

    /// The same POST and port-release wait, but driven through `exit_sequence` —
    /// i.e. through the budget and deadline the exit path CHOOSES rather than the
    /// ones a test hands `graceful::attempt`.
    ///
    /// `graceful_attempt_posts_and_waits_for_the_reply` is green for every one of
    /// these mutants, because it supplies the constants itself. What this pins is
    /// what `exit_sequence` forwards, and both values are pinned by CONSEQUENCE
    /// rather than by an equality on a call site (which any literal substituted
    /// one line later would still satisfy):
    ///   - a `Duration::from_millis(1)` budget cannot await a reply that arrives
    ///     200 ms later — `timed_out` becomes true and `verdict` becomes `none`;
    ///   - a zero deadline sends `wait_for_server_gone` into a `while now <
    ///     deadline` loop whose body never runs, so the closed port is never
    ///     observed and the verdict is `TimedOut`, not `Flushed`.
    /// Either one hard-kills every Quit with the user's edits unflushed (#1756).
    #[test]
    fn exit_sequence_forwards_the_budget_and_deadline_a_real_quit_uses() {
        let _serialise = FLAG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        set_flags(false, false);
        let (addr, server) = stub_shutdown_endpoint();

        let shutdown = format!("http://{addr}/api/shutdown");
        let health = format!("http://{addr}/health");
        // Read INSIDE the closure: the flag's final value cannot tell a latch set
        // before the `SidecarState` lock from one set after it, and "before" is
        // the whole point of the latch.
        let latched_before_prepare = std::cell::Cell::new(false);

        let started = std::time::Instant::now();
        let (outcome, _proof) = exit_sequence(
            || {
                latched_before_prepare.set(EXITING.load(Ordering::Acquire));
                graceful::Prep {
                    owned_child: true,
                    client: Some(build_http_client(HTTP_CLIENT_TIMEOUT).expect("build client")),
                }
            },
            Endpoints {
                shutdown: &shutdown,
                health: &health,
            },
        );
        let elapsed = started.elapsed();

        assert!(
            latched_before_prepare.get(),
            "EXITING must be latched BEFORE the prepare that takes the SidecarState lock — \
             that ordering is what closes the respawn race"
        );
        assert!(
            EXITING.load(Ordering::Acquire),
            "and it must still be latched afterwards"
        );

        let head = server.join().expect("server thread");
        assert!(
            head.starts_with("POST /api/shutdown "),
            "the exit sequence must POST /api/shutdown, got: {head:?}"
        );
        assert!(!outcome.timed_out, "a 1ms budget is what makes this true");
        assert_eq!(
            outcome.verdict,
            Some(GracefulStop::Flushed),
            "a zero deadline never polls the closed port, and reports TimedOut here"
        );
        assert!(outcome.attempted);
        assert!(!outcome.panicked);
        assert!(
            elapsed >= Duration::from_millis(200),
            "the reply was awaited under the real budget (elapsed {elapsed:?})"
        );

        set_flags(false, false);
    }

    /// A `prepare` that yields no client must stay DISTINGUISHABLE from a real
    /// attempt, and must still latch `EXITING`.
    ///
    /// `graceful::prepare` itself is not reachable from a test — it needs an
    /// `AppHandle` — so a `prepare` neutered to return `client: None`
    /// unconditionally survives this suite. What does not survive is that
    /// surviving *silently*: the exit verdict line then reads `attempted=false,
    /// verdict=none`, which is the one string
    /// `verdict_line_carries_the_substrings_the_smoke_checklist_greps` proves a
    /// real flush cannot produce. The smoke checklist reads that line.
    #[test]
    fn exit_sequence_reports_a_clientless_prepare_as_no_attempt() {
        let _serialise = FLAG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        set_flags(false, false);

        // No client, so nothing is dialled and `Endpoints::PRODUCTION` is inert —
        // this test never touches :3479.
        let (outcome, _proof) = exit_sequence(
            || graceful::Prep {
                owned_child: true,
                client: None,
            },
            Endpoints::PRODUCTION,
        );

        assert!(EXITING.load(Ordering::Acquire), "the latch is unconditional");
        assert!(!outcome.attempted, "no client is not an attempt");
        assert_eq!(outcome.verdict, None);
        assert!(!outcome.timed_out);
        assert!(!outcome.panicked);
        assert!(
            outcome.owned_child,
            "owned_child comes from prepare and must survive the short-circuit — \
             otherwise 'we owned a child and flushed nothing' is unreportable"
        );

        let line = exit_verdict_line(Duration::from_millis(0), &outcome);
        assert!(line.contains("attempted=false"), "{line}");
        assert!(line.contains("verdict=none"), "{line}");

        set_flags(false, false);
    }

    /// The decline arm is not the only way out of `restart_sidecar`, and none of
    /// them may leave the gate held. `RESTART_IN_PROGRESS` latching is invisible:
    /// the Restart button and Retry Server Start both become no-ops that look
    /// like they worked.
    #[test]
    fn restart_gate_releases_on_drop() {
        let _serialise = FLAG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        RESTART_IN_PROGRESS.store(false, Ordering::Release);
        {
            let gate = RestartGate::try_acquire().expect("a free gate is acquirable");
            assert!(RESTART_IN_PROGRESS.load(Ordering::Acquire));
            assert!(
                RestartGate::try_acquire().is_none(),
                "a held gate must refuse a second acquire"
            );
            drop(gate);
        }
        assert!(
            !RESTART_IN_PROGRESS.load(Ordering::Acquire),
            "Drop must release the gate"
        );
    }

    /// `SIDECAR_SHUTTING_DOWN` is held across `download_and_install(..).await`.
    /// Before the guard, only the explicit clear on the `Err` arm released it, so
    /// a panic or a dropped task latched it for the process lifetime and made
    /// `spawn_allowed()` false forever.
    #[test]
    fn shutting_down_guard_releases_on_drop() {
        let _serialise = FLAG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        set_flags(false, false);
        {
            let _guard = ShuttingDownGuard::acquire();
            assert!(SIDECAR_SHUTTING_DOWN.load(Ordering::Acquire));
            assert!(!spawn_allowed(), "the install must block spawns while held");
        }
        assert!(!SIDECAR_SHUTTING_DOWN.load(Ordering::Acquire));
        assert!(spawn_allowed(), "and re-permit them once the install is done");
    }

    /// The `Drop` keeps the `compare_exchange`, and that CAS is the `EXITING`
    /// interlock: an update that fails DURING an exit must not re-permit spawns.
    #[test]
    fn shutting_down_guard_drop_cannot_re_permit_spawns_during_an_exit() {
        let _serialise = FLAG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        set_flags(false, false);
        {
            let _guard = ShuttingDownGuard::acquire();
            EXITING.store(true, Ordering::Release);
        }
        assert!(
            !spawn_allowed(),
            "releasing the updater's flag must not unlatch EXITING"
        );
        set_flags(false, false);
    }

    #[test]
    fn exit_budget_covers_the_deadline_plus_two_client_timeouts() {
        assert_eq!(
            EXIT_GRACEFUL_BUDGET_SECS,
            GRACEFUL_SHUTDOWN_DEADLINE_SECS + 2 * HTTP_CLIENT_TIMEOUT.as_secs() + 1
        );
        // The literal is the load-bearing half: restating the definition alone
        // would be a tautology that survives any change to the inputs.
        assert_eq!(GRACEFUL_SHUTDOWN_DEADLINE_SECS, 6);
        assert_eq!(HTTP_CLIENT_TIMEOUT.as_secs(), 5);
        assert_eq!(EXIT_GRACEFUL_BUDGET_SECS, 17);
        assert_eq!(EXIT_GRACEFUL_BUDGET, Duration::from_secs(17));
    }
}
