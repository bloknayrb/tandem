//! Shared types across platform impls.

pub struct ReaperOpts {
    pub parent_pid: u32,
    pub child_program: String,
    pub child_args: Vec<String>,
}

/// Grace period between SIGTERM and SIGKILL escalation when reaping the child.
/// Matches the convention used by systemd, runc, and Chromium's launcher.
#[cfg(unix)]
pub const GRACE_PERIOD_SECS: u32 = 5;
