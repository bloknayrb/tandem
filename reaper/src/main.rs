//! tandem-reaper — cross-platform process reaper.
//!
//! Spawned by Tandem's Node process to wrap Claude Code. Guarantees Claude
//! is killed by the OS when Tandem's Node process dies, regardless of cause
//! (clean exit, SIGKILL, OOM, BSOD).
//!
//! Argv: <parent_pid> <child_program> [child_args...]
//!
//! A second mode, for the desktop shell's own Node sidecar (#1988, Linux only):
//!
//!   tandem-reaper --exec-with-pdeathsig <parent_pid> <absolute_program> [args...]
//!
//! It does NOT fork and supervise. It arms `PR_SET_PDEATHSIG(SIGTERM)` on
//! itself, checks that its parent is still `parent_pid`, then `execv`s the
//! program in place — same pid, argv, environment and pipes — so the program
//! inherits the parent-death signal. tauri-plugin-shell 2.5 has no `pre_exec`
//! hook, which is why this step lives here. `--supports-exec-with-pdeathsig`
//! exits 0 where the mode exists, so the shell can probe for it (an older
//! reaper reads the flag as a bad pid and exits 2). Neither flag can collide
//! with the Node launcher's numeric-first-argument contract above.
//!
//! Platform primitives:
//!   Windows: Job Object + JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
//!   Linux:   prctl(PR_SET_PDEATHSIG, SIGTERM) + saved-ppid race check
//!   macOS:   kqueue(EVFILT_PROC, NOTE_EXIT) on parent pid + getppid race check
//!
//! Exit code = child's exit code, or 128 + signum if child died from a signal.

use std::process::ExitCode;

mod common;

#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "macos")]
mod macos;

/// The exec-in-place mode's flag. See the module docs.
const EXEC_WITH_PDEATHSIG: &str = "--exec-with-pdeathsig";
/// Exits 0 where `EXEC_WITH_PDEATHSIG` is supported.
const SUPPORTS_EXEC_WITH_PDEATHSIG: &str = "--supports-exec-with-pdeathsig";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some(SUPPORTS_EXEC_WITH_PDEATHSIG) {
        return ExitCode::from(if cfg!(target_os = "linux") { 0 } else { 2 });
    }
    if args.get(1).map(String::as_str) == Some(EXEC_WITH_PDEATHSIG) {
        return ExitCode::from(exec_with_pdeathsig(&args[2..]) as u8);
    }
    if args.len() < 3 {
        eprintln!("usage: tandem-reaper <parent_pid> <child_program> [child_args...]");
        return ExitCode::from(2);
    }

    let parent_pid: u32 = match args[1].parse() {
        Ok(p) if p > 0 => p,
        _ => {
            eprintln!("tandem-reaper: invalid parent_pid: {}", args[1]);
            return ExitCode::from(2);
        }
    };
    let child_program = args[2].clone();
    let child_args: Vec<String> = args.iter().skip(3).cloned().collect();

    let opts = common::ReaperOpts {
        parent_pid,
        child_program,
        child_args,
    };

    let exit_code = {
        #[cfg(windows)]
        {
            windows::run(opts)
        }
        #[cfg(target_os = "linux")]
        {
            linux::run(opts)
        }
        #[cfg(target_os = "macos")]
        {
            macos::run(opts)
        }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
        {
            eprintln!("tandem-reaper: unsupported platform");
            255
        }
    };

    ExitCode::from(exit_code as u8)
}

/// `--exec-with-pdeathsig <parent_pid> <absolute_program> [args...]`. Returns
/// only on failure: 2 for a usage error, 3 when the parent had already died,
/// 127 when the exec itself failed, 1 when `prctl` failed.
fn exec_with_pdeathsig(rest: &[String]) -> i32 {
    if rest.len() < 2 {
        eprintln!(
            "usage: tandem-reaper {EXEC_WITH_PDEATHSIG} <parent_pid> <absolute_program> [args...]"
        );
        return 2;
    }
    let parent_pid: u32 = match rest[0].parse() {
        Ok(p) if p > 0 => p,
        _ => {
            eprintln!("tandem-reaper: invalid parent_pid: {}", rest[0]);
            return 2;
        }
    };
    #[cfg(target_os = "linux")]
    {
        linux::exec_with_pdeathsig(parent_pid, &rest[1], &rest[2..])
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = parent_pid;
        eprintln!("tandem-reaper: {EXEC_WITH_PDEATHSIG} is Linux-only");
        2
    }
}
