//! Linux reaping via prctl(PR_SET_PDEATHSIG).
//!
//! Architecture (per bubblewrap --die-with-parent and runc):
//!
//! 1. Call prctl(PR_SET_PDEATHSIG, SIGTERM) in THIS process. When our parent
//!    (Node/Tandem) dies, the kernel will send SIGTERM to us.
//! 2. CRITICAL race fix: PR_SET_PDEATHSIG is cleared when the kernel reparents
//!    us, so if parent died BEFORE prctl returned, we've missed the death and
//!    must exit immediately. Check `getppid() == expected_parent_pid` — the
//!    naive `getppid() == 1` check is wrong under systemd subreapers.
//! 3. fork() — parent half supervises, child half execs Claude.
//! 4. In supervisor: install SIGTERM/SIGINT handler that forwards to child and
//!    arms a SIGALRM for the grace-period SIGKILL escalation.
//! 5. waitpid() on child. Exit with child's exit code (or 128 + signum).
//!
//! Threading: this binary MUST be single-threaded. PR_SET_PDEATHSIG fires on
//! the thread that called prctl, not the process. With async runtimes
//! (tokio etc.), the signal can be delivered to a worker thread that's about
//! to exit, silently dropping the signal. Pure libc/nix.

use crate::common::{ReaperOpts, GRACE_PERIOD_SECS};
use nix::sys::signal::{
    self, kill, sigaction, SaFlags, SigAction, SigHandler, SigSet, Signal,
};
use nix::sys::wait::{waitpid, WaitStatus};
use nix::unistd::{alarm, execvp, fork, getppid, ForkResult, Pid};
use std::ffi::CString;
use std::sync::atomic::{AtomicI32, Ordering};

static CHILD_PID: AtomicI32 = AtomicI32::new(0);

extern "C" fn forward_term(sig: i32) {
    let pid = CHILD_PID.load(Ordering::SeqCst);
    if pid > 0 {
        if let Ok(s) = Signal::try_from(sig) {
            let _ = kill(Pid::from_raw(pid), s);
        }
        // Escalate to SIGKILL if child doesn't exit within grace period.
        alarm::set(GRACE_PERIOD_SECS);
    }
}

extern "C" fn force_kill(_sig: i32) {
    let pid = CHILD_PID.load(Ordering::SeqCst);
    if pid > 0 {
        let _ = kill(Pid::from_raw(pid), Signal::SIGKILL);
    }
}

pub fn run(opts: ReaperOpts) -> i32 {
    // 1. Set PDEATHSIG. Use libc directly — nix's prctl wrapper is awkward.
    let prctl_result = unsafe {
        libc::prctl(
            libc::PR_SET_PDEATHSIG,
            libc::SIGTERM as libc::c_ulong,
            0,
            0,
            0,
        )
    };
    if prctl_result != 0 {
        eprintln!("tandem-reaper: prctl(PR_SET_PDEATHSIG) failed");
        return 1;
    }

    // 2. Race check: parent may have died between Node spawning us and our
    //    prctl call. PDEATHSIG was set on whoever our parent is NOW; if that's
    //    not the expected parent, we've been reparented and missed the death.
    //
    // The window between spawn and prctl is a few syscalls (~1ms). PID reuse
    // during that window requires the kernel to wrap PIDs AND assign Node's
    // exact PID to a new process AND have Node die — practically impossible
    // without an active attacker forking thousands of processes. Acceptable
    // residual risk; documented per security review I6.
    let actual_ppid = getppid().as_raw() as u32;
    if actual_ppid != opts.parent_pid {
        eprintln!(
            "tandem-reaper: parent already died (expected ppid={}, got {})",
            opts.parent_pid, actual_ppid
        );
        return 0;
    }

    // 3. fork — child execs Claude, parent supervises.
    let program = match CString::new(opts.child_program.as_str()) {
        Ok(c) => c,
        Err(_) => {
            eprintln!("tandem-reaper: child program path contains NUL byte");
            return 2;
        }
    };
    let mut argv: Vec<CString> = Vec::with_capacity(opts.child_args.len() + 1);
    argv.push(program.clone());
    for arg in &opts.child_args {
        match CString::new(arg.as_str()) {
            Ok(c) => argv.push(c),
            Err(_) => {
                eprintln!("tandem-reaper: child arg contains NUL byte");
                return 2;
            }
        }
    }

    match unsafe { fork() } {
        Ok(ForkResult::Child) => {
            // execvp inherits our PDEATHSIG (it's preserved across execve UNLESS
            // the target is setuid/setgid). The child Claude will receive SIGTERM
            // if WE die. That's the correct semantic: if the supervisor dies,
            // the child should too.
            let _ = execvp(&program, &argv);
            // execvp only returns on failure.
            eprintln!("tandem-reaper: execvp({}) failed", opts.child_program);
            std::process::exit(127);
        }
        Ok(ForkResult::Parent { child }) => {
            CHILD_PID.store(child.as_raw(), Ordering::SeqCst);

            // 4. Install signal handlers. SIGTERM/SIGINT relay to child; SIGALRM
            //    is the escalation timer set by forward_term.
            let term_action = SigAction::new(
                SigHandler::Handler(forward_term),
                SaFlags::empty(),
                SigSet::empty(),
            );
            let alrm_action = SigAction::new(
                SigHandler::Handler(force_kill),
                SaFlags::empty(),
                SigSet::empty(),
            );
            unsafe {
                let _ = sigaction(Signal::SIGTERM, &term_action);
                let _ = sigaction(Signal::SIGINT, &term_action);
                let _ = sigaction(Signal::SIGHUP, &term_action);
                let _ = sigaction(Signal::SIGALRM, &alrm_action);
            }

            // 5. Wait for child.
            loop {
                match waitpid(child, None) {
                    Ok(WaitStatus::Exited(_, code)) => return code,
                    Ok(WaitStatus::Signaled(_, sig, _)) => return 128 + (sig as i32),
                    Ok(_) => continue,
                    Err(nix::errno::Errno::EINTR) => continue,
                    Err(e) => {
                        eprintln!("tandem-reaper: waitpid failed: {}", e);
                        return 1;
                    }
                }
            }
        }
        Err(e) => {
            eprintln!("tandem-reaper: fork failed: {}", e);
            return 1;
        }
    }
}
