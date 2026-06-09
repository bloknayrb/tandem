//! Windows Job Object ownership for the Node sidecar — guarantees the sidecar
//! dies with its parent (the Tauri shell) regardless of HOW the parent exits.
//!
//! ## Why (issue #987)
//!
//! `RunEvent::Exit => kill_sidecar(app)` only fires on a *graceful* shutdown.
//! When the shell is force-quit (`taskkill /F`, a crash, or a dev-runner
//! rebuild that SIGKILLs the parent), `RunEvent::Exit` never runs and the
//! spawned `node-sidecar` is orphaned — it keeps listening on 3478/3479. The
//! next launch then *reuses* that already-healthy orphan (the debug-build
//! reuse path in `start_sidecar`), so server-code changes silently don't take
//! effect on "restart". This caused ~an hour of false-negative confusion while
//! dogfooding #985 / PR #986.
//!
//! ## How
//!
//! A Windows **Job Object** created with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates every assigned process when
//! the job's last handle closes. Because the parent process holds the only
//! handle (kept alive in app state for the whole process lifetime), the OS
//! closes it on parent exit — graceful OR not, including `taskkill /F` and
//! crashes — and reaps the sidecar. This is the recommended Windows answer to
//! "child must not outlive parent" and covers the most common dev case the
//! issue calls out.
//!
//! `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` is deliberately NOT set: we want the
//! sidecar (and any grandchildren it spawns — e.g. `freePort` helpers) bound to
//! the job so the whole tree dies together.
//!
//! ## Non-Windows
//!
//! This module is Windows-only. On macOS/Linux the graceful
//! `RunEvent::Exit => kill_sidecar` path remains the primary mechanism; a
//! native parent-death reaper for those platforms (Linux `PR_SET_PDEATHSIG` on
//! a single-threaded reaper binary, macOS kqueue + `getppid` recheck) was the
//! separate #800 spike that never landed and is tracked there. The Windows job
//! object is the highest-value, lowest-risk slice and ships here.

#![cfg(target_os = "windows")]

use std::sync::Mutex;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

/// Owns the job-object handle for the parent process's lifetime. Held in Tauri
/// app state via `.manage(...)`. Dropping it (or the OS closing the handle on
/// process exit) triggers `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, killing every
/// assigned sidecar process.
///
/// The handle is created lazily on first `assign` and reused across sidecar
/// restarts: a restarted sidecar (new PID) is assigned to the SAME job, so the
/// kill-on-close guarantee continues to cover it.
pub struct SidecarJob {
    /// `0` (null) until the job is created. Stored as `isize` so the struct is
    /// trivially `Send`/`Sync`-assertable; cast back to `HANDLE` at use sites.
    /// Wrapped in a `Mutex` because Tauri state is shared across threads and
    /// `assign` mutates on first use.
    handle: Mutex<isize>,
}

// SAFETY: the only field is a raw job-object handle guarded by a Mutex. Windows
// job-object handles are process-global kernel objects safe to use from any
// thread; the Mutex serializes the lazy-create + assign sequence.
unsafe impl Send for SidecarJob {}
unsafe impl Sync for SidecarJob {}

impl SidecarJob {
    pub fn new() -> Self {
        Self {
            handle: Mutex::new(0),
        }
    }

    /// Assign the sidecar process (`pid`) to the kill-on-close job object,
    /// creating the job on first call. Best-effort: every failure is logged and
    /// swallowed so a job-object hiccup can never block sidecar startup — the
    /// graceful `RunEvent::Exit` path still covers clean shutdowns. Returns
    /// `true` only when the process was successfully assigned.
    pub fn assign(&self, pid: u32) -> bool {
        let mut guard = match self.handle.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                log::error!("SidecarJob mutex poisoned — recovering");
                poisoned.into_inner()
            }
        };

        // Lazy-create the job object on first use.
        if *guard == 0 {
            // SAFETY: standard CreateJobObjectW call with no name/security attrs.
            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job.is_null() {
                log::warn!(
                    "CreateJobObjectW failed (err {}) — sidecar will rely on RunEvent::Exit only",
                    last_error()
                );
                return false;
            }

            // Configure kill-on-close: when the last handle to the job closes
            // (parent exit, including crash/taskkill), terminate all members.
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: `info` outlives the call; size matches the struct.
            let ok = unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                log::warn!(
                    "SetInformationJobObject(KILL_ON_JOB_CLOSE) failed (err {}) — closing job",
                    last_error()
                );
                unsafe { CloseHandle(job) };
                return false;
            }
            *guard = job as isize;
            log::info!("Created sidecar job object (kill-on-job-close)");
        }

        let job = *guard as HANDLE;

        // Open the sidecar process with the rights AssignProcessToJobObject
        // needs (SET_QUOTA | TERMINATE). `inherit = FALSE`.
        // SAFETY: standard OpenProcess; returns null on failure (checked).
        let proc_handle = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if proc_handle.is_null() {
            log::warn!(
                "OpenProcess(pid={pid}) failed (err {}) — sidecar not assigned to job",
                last_error()
            );
            return false;
        }

        // SAFETY: both handles are valid here; checked above.
        let assigned = unsafe { AssignProcessToJobObject(job, proc_handle) };
        // The process handle is no longer needed once assignment is decided —
        // the job holds its own reference to the process.
        unsafe { CloseHandle(proc_handle) };

        if assigned == 0 {
            // A common benign cause: the process is already in another job that
            // disallows nesting (older Windows). Log and fall back to the
            // graceful kill path rather than failing startup.
            log::warn!(
                "AssignProcessToJobObject(pid={pid}) failed (err {}) — relying on RunEvent::Exit",
                last_error()
            );
            return false;
        }

        log::info!("Assigned sidecar (pid={pid}) to kill-on-job-close job object");
        true
    }
}

impl Default for SidecarJob {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for SidecarJob {
    fn drop(&mut self) {
        if let Ok(guard) = self.handle.lock() {
            let h = *guard as HANDLE;
            if !h.is_null() && h != INVALID_HANDLE_VALUE {
                // Closing the last handle triggers KILL_ON_JOB_CLOSE — the
                // belt to the parent-exit suspenders. On normal exit the OS
                // closes handles anyway; this makes the intent explicit and
                // covers the rare case where state is dropped before exit.
                unsafe { CloseHandle(h) };
            }
        }
    }
}

/// Last-error code for logging. Thin wrapper so call sites read cleanly.
fn last_error() -> u32 {
    // SAFETY: GetLastError is always safe to call.
    unsafe { windows_sys::Win32::Foundation::GetLastError() }
}
