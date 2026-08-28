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

/// Gracefully stop the sidecar (flush dirty docs + save session, #1088),
/// hard-kill as fallback, then spawn it again.
#[tauri::command]
pub(crate) fn restart_sidecar(app: tauri::AppHandle) {
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
pub(crate) fn kill_sidecar(handle: &tauri::AppHandle) {
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

pub(crate) fn build_http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

/// Spawn the Node.js sidecar and wait for the health endpoint.
/// Retries up to MAX_RESTARTS times with exponential backoff on crash.
pub(crate) async fn start_sidecar(
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
pub(crate) async fn wait_for_port_release(client: &reqwest::Client, deadline_secs: u64) -> bool {
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
