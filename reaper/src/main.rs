//! tandem-reaper — cross-platform process reaper.
//!
//! Spawned by Tandem's Node process to wrap Claude Code. Guarantees Claude
//! is killed by the OS when Tandem's Node process dies, regardless of cause
//! (clean exit, SIGKILL, OOM, BSOD).
//!
//! Argv: <parent_pid> <child_program> [child_args...]
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

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
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
