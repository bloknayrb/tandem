//! Windows reaping via Job Object + KILL_ON_JOB_CLOSE.
//!
//! Architecture (per Chromium sandbox/win/src/job.cc and Deno runtime/ops/process.rs):
//!
//! 1. Open parent process handle (SYNCHRONIZE access). Must happen before any
//!    other setup so a parent dying mid-setup is observable.
//! 2. Create a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Do NOT set
//!    JOB_OBJECT_LIMIT_BREAKAWAY_OK (would let children call CreateProcess with
//!    CREATE_BREAKAWAY_FROM_JOB).
//! 3. Assign *this process* to the job. When this process exits — for any
//!    reason — the OS closes its handles, the job's last handle closes, and
//!    the kernel kills every process in the job (including the child Claude
//!    and any descendants).
//! 4. Spawn child SUSPENDED, assign to job, resume. The SUSPENDED window
//!    prevents the child from forking grandchildren before they inherit job
//!    membership.
//! 5. WaitForSingleObject on the parent handle. When parent dies, this returns
//!    and we exit — closing our job handle, triggering KILL_ON_JOB_CLOSE on
//!    every member.

use crate::common::ReaperOpts;
use std::ffi::OsStr;
use std::iter::once;
use std::mem;
use std::os::windows::ffi::OsStrExt;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, WAIT_FAILED, WAIT_OBJECT_0};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, SetInformationJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{
    CreateProcessW, GetCurrentProcess, GetExitCodeProcess, OpenProcess, ResumeThread,
    CREATE_SUSPENDED, INFINITE, PROCESS_INFORMATION,
    PROCESS_SYNCHRONIZE, STARTUPINFOW,
};

/// Returns the exit code this reaper should propagate.
pub fn run(opts: ReaperOpts) -> i32 {
    unsafe {
        // Nested-job audit (Win8+ supports nested jobs; older does not). If we
        // are already in a job whose outer limits forbid breakaway, our own
        // KILL_ON_JOB_CLOSE still works for OUR children — but operators
        // running Tandem under unusual job-controlled hosts (some installers,
        // Docker Desktop, certain terminal hosts) deserve a log line.
        let mut already_in_job: windows::Win32::Foundation::BOOL = Default::default();
        if IsProcessInJob(GetCurrentProcess(), None, &mut already_in_job).is_ok()
            && already_in_job.as_bool()
        {
            eprintln!(
                "tandem-reaper: notice — already running under a parent Job Object; \
                 nested-job semantics apply (Win8+ supports nesting, older does not)"
            );
        }

        // 1. Open parent handle FIRST. If parent already died, OpenProcess fails
        //    or the handle is signaled immediately — either way we detect it.
        let parent_handle = match OpenProcess(PROCESS_SYNCHRONIZE, false, opts.parent_pid) {
            Ok(h) if !h.is_invalid() => h,
            _ => {
                eprintln!(
                    "tandem-reaper: cannot open parent process {} — already exited?",
                    opts.parent_pid
                );
                return 0;
            }
        };

        // 2. Create Job Object with KILL_ON_JOB_CLOSE. No name (anonymous).
        let job = match CreateJobObjectW(None, PCWSTR::null()) {
            Ok(j) if !j.is_invalid() => j,
            _ => {
                eprintln!("tandem-reaper: CreateJobObjectW failed");
                let _ = CloseHandle(parent_handle);
                return 1;
            }
        };

        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let info_ptr = &info as *const _ as *const _;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            info_ptr,
            mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .is_err()
        {
            eprintln!("tandem-reaper: SetInformationJobObject failed");
            let _ = CloseHandle(job);
            let _ = CloseHandle(parent_handle);
            return 1;
        }

        // 3. Assign self to the job. Reaper exit (any cause) → handle closes →
        //    kernel kills everyone in the job.
        if AssignProcessToJobObject(job, GetCurrentProcess()).is_err() {
            eprintln!("tandem-reaper: AssignProcessToJobObject(self) failed");
            let _ = CloseHandle(job);
            let _ = CloseHandle(parent_handle);
            return 1;
        }

        // 4. Spawn child SUSPENDED so it can't fork grandchildren before
        //    inheriting job membership.
        let mut cmdline = build_command_line(&opts.child_program, &opts.child_args);
        let mut si = STARTUPINFOW::default();
        si.cb = mem::size_of::<STARTUPINFOW>() as u32;
        let mut pi = PROCESS_INFORMATION::default();

        let create_result = CreateProcessW(
            None,
            Some(PWSTR(cmdline.as_mut_ptr())),
            None,
            None,
            false,
            CREATE_SUSPENDED,
            None,
            None,
            &si,
            &mut pi,
        );

        if create_result.is_err() {
            eprintln!(
                "tandem-reaper: CreateProcessW failed for {}",
                opts.child_program
            );
            let _ = CloseHandle(job);
            let _ = CloseHandle(parent_handle);
            return 1;
        }

        // Assign child to job, then resume.
        if AssignProcessToJobObject(job, pi.hProcess).is_err() {
            eprintln!("tandem-reaper: AssignProcessToJobObject(child) failed");
            // Child is suspended and unassigned — kill it explicitly before bailing.
            let _ = windows::Win32::System::Threading::TerminateProcess(pi.hProcess, 1);
            let _ = CloseHandle(pi.hThread);
            let _ = CloseHandle(pi.hProcess);
            let _ = CloseHandle(job);
            let _ = CloseHandle(parent_handle);
            return 1;
        }
        if ResumeThread(pi.hThread) == u32::MAX {
            eprintln!("tandem-reaper: ResumeThread failed");
            // Child is still in the job, will be killed on our exit.
        }
        let _ = CloseHandle(pi.hThread);

        // 5. Wait for parent OR child to exit, whichever comes first.
        let handles = [parent_handle, pi.hProcess];
        let wait_result = windows::Win32::System::Threading::WaitForMultipleObjects(
            &handles,
            false,
            INFINITE,
        );

        let child_exit = if wait_result == WAIT_OBJECT_0 {
            // Parent died first. Falling off the end of main → handles close →
            // job KILL_ON_JOB_CLOSE fires → child + descendants reaped by OS.
            // We don't need to do anything; just return.
            0
        } else if wait_result.0 == WAIT_OBJECT_0.0 + 1 {
            // Child died first (Claude exited on its own). Capture exit code.
            let mut code: u32 = 0;
            if GetExitCodeProcess(pi.hProcess, &mut code).is_ok() {
                code as i32
            } else {
                1
            }
        } else if wait_result == WAIT_FAILED {
            eprintln!("tandem-reaper: WaitForMultipleObjects failed");
            1
        } else {
            1
        };

        let _ = CloseHandle(pi.hProcess);
        let _ = CloseHandle(parent_handle);
        // Intentionally DO NOT close `job` early — leave it for process teardown
        // so the OS performs the kill atomically with our exit.
        let _ = job;

        child_exit
    }
}

/// Build a Windows command line string from program + args, quoting per
/// CommandLineToArgvW rules. Returns a NUL-terminated UTF-16 buffer.
fn build_command_line(program: &str, args: &[String]) -> Vec<u16> {
    let mut s = String::new();
    s.push('"');
    s.push_str(&program.replace('"', "\\\""));
    s.push('"');
    for arg in args {
        s.push(' ');
        // Conservative quoting: always quote, escape embedded quotes + trailing backslashes.
        s.push('"');
        let mut backslashes = 0usize;
        for ch in arg.chars() {
            if ch == '\\' {
                backslashes += 1;
                s.push(ch);
            } else if ch == '"' {
                // Double each backslash, then escape the quote.
                for _ in 0..backslashes {
                    s.push('\\');
                }
                s.push_str("\\\"");
                backslashes = 0;
            } else {
                backslashes = 0;
                s.push(ch);
            }
        }
        // Double trailing backslashes so the closing quote isn't escaped.
        for _ in 0..backslashes {
            s.push('\\');
        }
        s.push('"');
    }
    OsStr::new(&s).encode_wide().chain(once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmdline_quotes_simple_args() {
        let out = build_command_line("claude", &["--flag".into(), "value".into()]);
        let s = String::from_utf16(&out[..out.len() - 1]).unwrap();
        assert_eq!(s, r#""claude" "--flag" "value""#);
    }

    #[test]
    fn cmdline_escapes_embedded_quotes() {
        let out = build_command_line("claude", &[r#"a"b"#.into()]);
        let s = String::from_utf16(&out[..out.len() - 1]).unwrap();
        assert_eq!(s, r#""claude" "a\"b""#);
    }

    #[test]
    fn cmdline_escapes_trailing_backslashes() {
        let out = build_command_line("claude", &[r"foo\".into()]);
        let s = String::from_utf16(&out[..out.len() - 1]).unwrap();
        // trailing backslash must be doubled so it doesn't escape the closing quote
        assert_eq!(s, r#""claude" "foo\\""#);
    }
}
