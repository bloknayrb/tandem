//! macOS reaping via kqueue(EVFILT_PROC, NOTE_EXIT).
//!
//! macOS has no prctl(PR_SET_PDEATHSIG) equivalent. The canonical approach
//! (per Chromium base/process/kill_mac.cc) is to register a kevent watching
//! the parent's PID for NOTE_EXIT, then block on kevent() until parent dies.
//!
//! Architecture:
//!
//! 1. kqueue() — create a kernel event queue.
//! 2. EV_SET(EVFILT_PROC, parent_pid, NOTE_EXIT) + kevent() to register.
//! 3. CRITICAL race fix: after registration, re-check getppid() — if it
//!    doesn't match the expected parent, parent already died (reparented to
//!    launchd, pid 1).
//! 4. fork() — child execs Claude; parent half blocks on kevent.
//! 5. When kevent returns (parent died), SIGTERM Claude, sleep up to 5s,
//!    SIGKILL if still alive. Exit with child's exit code (or 128+signum if
//!    child died from a signal during normal operation).

use crate::common::{ReaperOpts, GRACE_PERIOD_SECS};
use nix::sys::event::{EventFilter, EventFlag, FilterFlag, KEvent, Kqueue};
use nix::sys::signal::{kill, Signal};
use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
use nix::unistd::{execvp, fork, getppid, ForkResult, Pid};
use std::ffi::CString;
use std::thread;
use std::time::{Duration, Instant};

pub fn run(opts: ReaperOpts) -> i32 {
    // 1. Create kqueue.
    let kq = match Kqueue::new() {
        Ok(fd) => fd,
        Err(e) => {
            eprintln!("tandem-reaper: kqueue() failed: {}", e);
            return 1;
        }
    };

    // 2. Register EVFILT_PROC on parent_pid with NOTE_EXIT.
    let kev = KEvent::new(
        opts.parent_pid as usize,
        EventFilter::EVFILT_PROC,
        EventFlag::EV_ADD | EventFlag::EV_ENABLE | EventFlag::EV_ONESHOT,
        FilterFlag::NOTE_EXIT,
        0,
        0,
    );
    if let Err(e) = kq.kevent(&[kev], &mut [], None) {
        eprintln!(
            "tandem-reaper: kevent register on ppid {} failed: {}",
            opts.parent_pid, e
        );
        return 1;
    }

    // 3. Race check after registration.
    let actual_ppid = getppid().as_raw() as u32;
    if actual_ppid != opts.parent_pid {
        eprintln!(
            "tandem-reaper: parent already died (expected ppid={}, got {})",
            opts.parent_pid, actual_ppid
        );
        return 0;
    }

    // 4. fork + exec Claude.
    let program = match CString::new(opts.child_program.as_str()) {
        Ok(c) => c,
        Err(_) => return 2,
    };
    let mut argv: Vec<CString> = Vec::with_capacity(opts.child_args.len() + 1);
    argv.push(program.clone());
    for arg in &opts.child_args {
        match CString::new(arg.as_str()) {
            Ok(c) => argv.push(c),
            Err(_) => return 2,
        }
    }

    let child_pid = match unsafe { fork() } {
        Ok(ForkResult::Child) => {
            let _ = execvp(&program, &argv);
            eprintln!("tandem-reaper: execvp({}) failed", opts.child_program);
            std::process::exit(127);
        }
        Ok(ForkResult::Parent { child }) => child,
        Err(e) => {
            eprintln!("tandem-reaper: fork failed: {}", e);
            return 1;
        }
    };

    // Also watch the child for NOTE_EXIT so we wake up when EITHER dies.
    let child_kev = KEvent::new(
        child_pid.as_raw() as usize,
        EventFilter::EVFILT_PROC,
        EventFlag::EV_ADD | EventFlag::EV_ENABLE | EventFlag::EV_ONESHOT,
        FilterFlag::NOTE_EXIT,
        0,
        0,
    );
    if let Err(e) = kq.kevent(&[child_kev], &mut [], None) {
        eprintln!("tandem-reaper: kevent register on child failed: {}", e);
        // Child likely exited between fork() and EV_ADD (ESRCH). Drain it.
        if let Ok(WaitStatus::Exited(_, code)) =
            waitpid(child_pid, Some(WaitPidFlag::WNOHANG))
        {
            return code;
        }
        if let Ok(WaitStatus::Signaled(_, sig, _)) =
            waitpid(child_pid, Some(WaitPidFlag::WNOHANG))
        {
            return 128 + (sig as i32);
        }
        // Child still alive AND kevent failed for a non-ESRCH reason (EACCES
        // under a tightened sandbox, EBADF if the kqueue fd was clobbered,
        // etc.). We cannot reliably watch the child, so the parent-only
        // watch could leave Claude as a zombie when it later exits. Kill it
        // proactively rather than block indefinitely.
        eprintln!(
            "tandem-reaper: cannot watch child via kqueue — killing it to avoid zombie"
        );
        let _ = kill(child_pid, Signal::SIGKILL);
        let _ = waitpid(child_pid, None);
        return 1;
    }

    // 5. Block until one of the two kevents fires.
    let mut events = [KEvent::new(
        0,
        EventFilter::EVFILT_PROC,
        EventFlag::empty(),
        FilterFlag::empty(),
        0,
        0,
    )];

    loop {
        match kq.kevent(&[], &mut events, None) {
            Ok(n) if n > 0 => break,
            Ok(_) => continue,
            Err(nix::errno::Errno::EINTR) => continue,
            Err(e) => {
                eprintln!("tandem-reaper: kevent wait failed: {}", e);
                break;
            }
        }
    }

    // Which exited? ident == parent_pid means parent died → kill child.
    let woke_for_parent = events[0].ident() as u32 == opts.parent_pid;

    if woke_for_parent {
        // SIGTERM, wait up to grace period, SIGKILL.
        let _ = kill(child_pid, Signal::SIGTERM);
        let deadline = Instant::now() + Duration::from_secs(GRACE_PERIOD_SECS as u64);
        loop {
            match waitpid(child_pid, Some(WaitPidFlag::WNOHANG)) {
                Ok(WaitStatus::StillAlive) => {
                    if Instant::now() >= deadline {
                        let _ = kill(child_pid, Signal::SIGKILL);
                        let _ = waitpid(child_pid, None);
                        return 128 + (Signal::SIGTERM as i32);
                    }
                    thread::sleep(Duration::from_millis(100));
                }
                Ok(WaitStatus::Exited(_, code)) => return code,
                Ok(WaitStatus::Signaled(_, sig, _)) => return 128 + (sig as i32),
                Ok(_) => continue,
                Err(nix::errno::Errno::EINTR) => continue,
                Err(_) => return 1,
            }
        }
    } else {
        // Child died on its own — collect status.
        match waitpid(child_pid, None) {
            Ok(WaitStatus::Exited(_, code)) => code,
            Ok(WaitStatus::Signaled(_, sig, _)) => 128 + (sig as i32),
            _ => 1,
        }
    }
}
