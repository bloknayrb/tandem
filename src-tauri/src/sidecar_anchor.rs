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
//! `--supports-exec-with-pdeathsig` with exit 0, probed once per process. A
//! missing reaper, an empty stub (the `cargo test` setup and CI create those),
//! or an older reaper that reads the flag as a bad pid all fall back to
//! spawning node-sidecar directly, as before, with one `tandem.log` warning —
//! a missing parent-death signal must never become a sidecar that cannot start.
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
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};

/// The reaper's exec-in-place mode (`reaper/src/main.rs`).
pub(crate) const TRAMPOLINE_FLAG: &str = "--exec-with-pdeathsig";
/// Exits 0 where `TRAMPOLINE_FLAG` is supported.
pub(crate) const PROBE_FLAG: &str = "--supports-exec-with-pdeathsig";
/// The `externalBin` name of the reaper, beside `SIDECAR_BIN_NAME`.
pub(crate) const REAPER_BIN_NAME: &str = "tandem-reaper";

type Job = Box<dyn FnOnce() + Send + 'static>;

static ANCHOR: OnceLock<Mutex<mpsc::Sender<Job>>> = OnceLock::new();

fn anchor() -> &'static Mutex<mpsc::Sender<Job>> {
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
        if let Err(e) = spawned {
            // The receiver went with the failed thread, so every `submit`
            // reports the error rather than hanging.
            log::error!("Could not start the sidecar anchor thread: {e}");
        }
        Mutex::new(tx)
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

static TRAMPOLINE_OK: OnceLock<bool> = OnceLock::new();

/// Does the bundled reaper at `reaper` support the trampoline? Probed once per
/// process (a short child; any spawn error, such as an empty stub's exec
/// format error, reads false), and run on the anchor thread so this blocking
/// wait never sits on a tokio worker. A false answer is logged once.
pub(crate) async fn trampoline_available(reaper: &Path) -> bool {
    if let Some(ok) = TRAMPOLINE_OK.get() {
        return *ok;
    }
    let reaper = reaper.to_owned();
    let ok = run_on_anchor(move || probe(&reaper)).await.unwrap_or(false);
    let first = TRAMPOLINE_OK.set(ok).is_ok();
    if first && !ok {
        log::warn!(
            "tandem-reaper does not support {TRAMPOLINE_FLAG} — starting the sidecar directly, \
             so it will NOT exit with the shell on a force-quit (#1988)"
        );
    }
    *TRAMPOLINE_OK.get().unwrap_or(&ok)
}

fn probe(reaper: &Path) -> bool {
    if !reaper.is_absolute() {
        return false;
    }
    Command::new(reaper)
        .arg(PROBE_FLAG)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
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
            body.contains("sidecar_anchor::run_on_anchor(move || cmd.spawn()"),
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
