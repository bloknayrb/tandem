//! Linux: the Node sidecar dies with the shell (#1988).
//!
//! ## What
//!
//! On Linux the shell starts `node-sidecar` through the bundled
//! `tandem-reaper --exec-with-pdeathsig <shell pid> <node-sidecar> ...`. In the
//! child, that mode arms `prctl(PR_SET_PDEATHSIG, SIGTERM)`, checks that its
//! parent is still this process, and `execv`s node-sidecar in place — same pid,
//! argv, environment and pipes (`reaper/src/linux.rs`). So a shell that dies
//! without running `RunEvent::Exit` (a `kill -9`, a crash) takes the sidecar
//! with it, and the sidecar gets SIGTERM, not SIGKILL, so it runs its normal
//! shutdown and flushes unsaved edits.
//!
//! tauri-plugin-shell 2.5's `Command` has no `pre_exec` hook, and its
//! `CommandChild` (which `SidecarState`, the kill paths and the drain task all
//! hold) cannot be built from a `std::process::Child`, which is why the
//! `prctl` runs in an exec trampoline rather than in this process.
//!
//! ## Why a dedicated thread
//!
//! Linux delivers the parent-death signal when the **thread** that forked the
//! child exits, not when the process does (`prctl(2)`: "the parent" is the
//! creating thread). `start_sidecar` is async and runs on whichever tokio
//! thread polls it, and tokio retires threads: blocking-pool threads exit after
//! sitting idle, and `block_in_place` hands a worker's core to a new thread.
//! Forking from one of those would SIGTERM a perfectly healthy sidecar
//! mid-session. So every Linux sidecar spawn (`start_sidecar`, and through it
//! `restart_sidecar`) runs on ONE named thread that loops for the life of the
//! process: its `Sender` lives in a `static`, so its receive loop never ends,
//! and each job runs under `catch_unwind`, so a panicking job cannot end it.
//! `reaper/tests/exec_pdeathsig.rs` demonstrates the thread semantics against
//! the real binary. **Never move the Linux sidecar spawn off this thread.**
//!
//! `catch_unwind` holds because `src-tauri` builds with the default
//! `panic = "unwind"`. Were the release profile ever `panic = "abort"`, a panic
//! anywhere would take the whole shell down, sidecar included — so either
//! profile keeps the sidecar from outliving its anchor.
//!
//! ## Fallback
//!
//! The trampoline is used only when the bundled reaper answers
//! `--supports-exec-with-pdeathsig` with exit 0 within `PROBE_DEADLINE`. A yes
//! is cached for the process; a no is probed again on the next spawn, so one
//! transient failure (an `ETXTBSY` mid-update, an `EAGAIN`) does not pin every
//! later restart to direct spawns. A missing reaper, an empty stub (the
//! `cargo test` setup and CI create those), an older reaper that reads the flag
//! as a bad pid, or a probe that does not answer in time all fall back to
//! spawning node-sidecar directly, as before, with one `tandem.log` warning —
//! a missing parent-death signal must never become a sidecar that cannot start.
//! For the same reason, an anchor thread that failed to start does not block
//! the spawn: `run_on_anchor_or_inline` runs it on the caller instead, and the
//! command it runs is then always the direct one, because without the anchor
//! the probe cannot answer yes.
//!
//! ## macOS
//!
//! Not covered, and accepted (#1988): a force-quit shell leaves node-sidecar
//! alive until the next launch's `freePort` reclaims 3478/3479. Relaunch
//! recovery is the bound. See `docs/release-smoke-checklist.md` §2.

#![cfg(target_os = "linux")]

use std::ffi::{OsStr, OsString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::bounded_command::{output_with_timeout, BoundedOutcome};

/// The reaper's exec-in-place mode (`reaper/src/main.rs`).
pub(crate) const TRAMPOLINE_FLAG: &str = "--exec-with-pdeathsig";
/// Exits 0 where `TRAMPOLINE_FLAG` is supported.
pub(crate) const PROBE_FLAG: &str = "--supports-exec-with-pdeathsig";
/// The `externalBin` name of the reaper, beside `SIDECAR_BIN_NAME`.
pub(crate) const REAPER_BIN_NAME: &str = "tandem-reaper";

type Job = Box<dyn FnOnce() + Send + 'static>;

struct Anchor {
    tx: Mutex<mpsc::Sender<Job>>,
    /// Whether the thread started. Fixed at init: a started thread never ends
    /// (see the module doc), and a failed one is never retried.
    running: bool,
}

static ANCHOR: OnceLock<Anchor> = OnceLock::new();

fn anchor() -> &'static Anchor {
    ANCHOR.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Job>();
        let spawned = std::thread::Builder::new()
            .name("sidecar-anchor".into())
            .spawn(move || {
                // Ends only when every Sender is gone, and one lives in the
                // `static` above for the life of the process.
                for job in rx {
                    let _ = catch_unwind(AssertUnwindSafe(job));
                }
            });
        if let Err(e) = &spawned {
            // The receiver went with the failed thread, so every `submit`
            // reports the error rather than hanging.
            log::error!("Could not start the sidecar anchor thread: {e}");
        }
        Anchor {
            tx: Mutex::new(tx),
            running: spawned.is_ok(),
        }
    })
}

/// Run `f` on the anchor thread; the receiver yields its result. `Err` when
/// the anchor thread is unavailable. A panicking `f` drops its sender, so the
/// receiver reports a closed channel, and the thread carries on.
pub(crate) fn submit<T, F>(f: F) -> Result<tokio::sync::oneshot::Receiver<T>, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    let job: Job = Box::new(move || {
        let _ = tx.send(f());
    });
    anchor()
        .tx
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .send(job)
        .map_err(|_| "the sidecar anchor thread is not running".to_string())?;
    Ok(rx)
}

/// `submit` and await it.
pub(crate) async fn run_on_anchor<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    submit(f)?
        .await
        .map_err(|_| "the sidecar anchor job failed".to_string())
}

/// `run_on_anchor`, except that when the anchor thread never started, `f` runs
/// on the calling thread (with a warning) instead of failing. Only for a job
/// whose fork does not need the anchor's lifetime — the sidecar spawn, whose
/// command is the direct one whenever the anchor is down, because the
/// trampoline is chosen only after a probe the anchor ran answered yes.
pub(crate) async fn run_on_anchor_or_inline<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    if !anchor().running {
        log::warn!(
            "The sidecar anchor thread is not running — spawning the sidecar on the \
             calling thread, without the parent-death signal (#1988)"
        );
        return Ok(f());
    }
    run_on_anchor(f).await
}

/// The reaper's argument vector for the trampoline: everything after the
/// program. `node` is the absolute path the plugin's sidecar resolution
/// produced; the reaper refuses anything else.
pub(crate) fn pdeathsig_exec_args(parent_pid: u32, node: &OsStr, server_js: &str) -> Vec<OsString> {
    vec![
        OsString::from(TRAMPOLINE_FLAG),
        OsString::from(parent_pid.to_string()),
        node.to_owned(),
        OsString::from(server_js),
        OsString::from("--tauri-sidecar"),
    ]
}

/// A yes from the probe, cached for the process. A no is not cached.
static TRAMPOLINE_OK: AtomicBool = AtomicBool::new(false);
/// Whether the fallback warning has been logged.
static TRAMPOLINE_NO_LOGGED: AtomicBool = AtomicBool::new(false);

/// How long the probe may take before it reads false. The real answer is an
/// immediate exit; this only stops a wedged reaper from holding the anchor
/// thread, and with it every later sidecar spawn, forever.
const PROBE_DEADLINE: Duration = Duration::from_secs(2);

/// Does the bundled reaper at `reaper` support the trampoline? A short child
/// (any spawn error, such as an empty stub's exec format error, reads false),
/// run on the anchor thread so this blocking wait never sits on a tokio worker.
/// A yes is cached for the process; a no is probed again next time, and only
/// the first no is logged.
pub(crate) async fn trampoline_available(reaper: &Path) -> bool {
    if TRAMPOLINE_OK.load(Ordering::Acquire) {
        return true;
    }
    let reaper = reaper.to_owned();
    let ok = run_on_anchor(move || probe(&reaper)).await.unwrap_or(false);
    if ok {
        TRAMPOLINE_OK.store(true, Ordering::Release);
    } else if !TRAMPOLINE_NO_LOGGED.swap(true, Ordering::AcqRel) {
        log::warn!(
            "tandem-reaper does not support {TRAMPOLINE_FLAG} — starting the sidecar directly, \
             so it will NOT exit with the shell on a force-quit (#1988)"
        );
    }
    ok
}

fn probe(reaper: &Path) -> bool {
    if !reaper.is_absolute() {
        return false;
    }
    let mut cmd = Command::new(reaper);
    cmd.arg(PROBE_FLAG);
    exits_zero_within(cmd, PROBE_DEADLINE)
}

/// Whether `cmd` exits 0 within `deadline`. A child still running then is
/// killed by `output_with_timeout` (#1371), and reads false.
fn exits_zero_within(cmd: Command, deadline: Duration) -> bool {
    match output_with_timeout(cmd, deadline) {
        Ok(BoundedOutcome::Completed(out)) => out.status.success(),
        Ok(BoundedOutcome::TimedOut { .. }) => {
            log::warn!("tandem-reaper probe did not exit in time — reading it as no (#1988)");
            false
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::ThreadId;

    fn on_anchor<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
        submit(f).expect("anchor running").blocking_recv().ok()
    }

    #[test]
    fn every_job_runs_on_one_long_lived_thread_that_is_not_the_caller() {
        let a: ThreadId = on_anchor(|| std::thread::current().id()).expect("first job");
        let b: ThreadId = on_anchor(|| std::thread::current().id()).expect("second job");
        assert_eq!(a, b, "two jobs, one thread");
        assert_ne!(a, std::thread::current().id());
        let name = on_anchor(|| std::thread::current().name().map(str::to_owned)).flatten();
        assert_eq!(name.as_deref(), Some("sidecar-anchor"));
    }

    #[test]
    fn a_panicking_job_does_not_end_the_thread() {
        let before = on_anchor(|| std::thread::current().id()).expect("job");
        // The default hook would print the panic; keep the test output clean.
        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let panicked: Option<()> = on_anchor(|| panic!("a job bug"));
        std::panic::set_hook(hook);
        assert!(panicked.is_none(), "a panicked job yields no result");
        let after = on_anchor(|| std::thread::current().id()).expect("the next job still runs");
        assert_eq!(before, after, "same thread after the panic");
    }

    #[test]
    fn the_trampoline_args_put_the_flag_first_and_keep_the_sidecar_argv() {
        let args = pdeathsig_exec_args(4242, OsStr::new("/opt/Tandem/node-sidecar"), "/r/index.js");
        assert_eq!(
            args,
            vec![
                OsString::from("--exec-with-pdeathsig"),
                OsString::from("4242"),
                OsString::from("/opt/Tandem/node-sidecar"),
                OsString::from("/r/index.js"),
                OsString::from("--tauri-sidecar"),
            ]
        );
    }

    #[test]
    fn the_probe_reads_false_for_a_missing_an_empty_or_a_relative_reaper() {
        let dir = std::env::temp_dir().join(format!("tandem-anchor-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let empty = dir.join("tandem-reaper");
        std::fs::write(&empty, b"").expect("empty stub");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&empty, std::fs::Permissions::from_mode(0o755))
                .expect("chmod");
        }
        assert!(!probe(&dir.join("missing")));
        assert!(!probe(&empty), "an empty stub cannot be the trampoline");
        assert!(!probe(Path::new("tandem-reaper")));
        // A program that exits non-zero for the probe flag (an older reaper
        // reads it as a bad pid and exits 2) is not the trampoline either.
        if Path::new("/bin/false").exists() {
            assert!(!probe(Path::new("/bin/false")));
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_probe_that_outlives_the_deadline_reads_false() {
        if !Path::new("/bin/sleep").exists() {
            return;
        }
        let mut cmd = Command::new("/bin/sleep");
        cmd.arg("30");
        let started = std::time::Instant::now();
        assert!(!exits_zero_within(cmd, Duration::from_millis(100)));
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the deadline bounds the wait"
        );
        if Path::new("/bin/true").exists() {
            assert!(exits_zero_within(
                Command::new("/bin/true"),
                Duration::from_secs(5)
            ));
        }
    }

    #[test]
    fn the_anchor_started_in_tests() {
        assert!(anchor().running);
    }

    /// Pins the spawn site to the anchor thread from source: nothing else would
    /// notice a refactor that moved the Linux spawn back onto a tokio worker,
    /// which works until the worker retires and SIGTERMs a healthy sidecar.
    #[test]
    fn start_sidecar_spawns_on_the_anchor_thread_on_linux() {
        let src = include_str!("sidecar.rs");
        let start = src
            .find("pub(crate) async fn start_sidecar")
            .expect("start_sidecar must exist");
        let body = &src[start..];
        let body = &body[..body.find("\n}\n").expect("end of start_sidecar")];
        assert!(
            body.contains("sidecar_anchor::run_on_anchor_or_inline(move ||"),
            "the Linux sidecar spawn must run on the anchor thread"
        );
        assert!(body.contains("let mut cmd = linux_sidecar_command(handle"));
        assert!(src.contains("sidecar_anchor::trampoline_available(&reaper_path)"));
        assert!(src.contains("sidecar_anchor::pdeathsig_exec_args("));
        // Exactly one direct `cmd.spawn()` outside the anchor, and it is
        // compiled only off Linux.
        let direct = body
            .find("let spawned = cmd.spawn()")
            .expect("the non-Linux spawn");
        assert!(body[..direct]
            .trim_end()
            .ends_with("#[cfg(not(target_os = \"linux\"))]"));
    }
}
