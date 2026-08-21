//! Absolute paths to Windows system binaries, so we never let the loader pick.
//!
//! `Command::new("netsh")` does **not** hand a bare name to `CreateProcess` —
//! Rust resolves it first, in `std::sys::process::windows::search_paths`:
//!
//! 1. the child `PATH`, but only when set via `Command::env`
//! 2. **the application directory**
//! 3. `GetSystemDirectoryW` — System32
//! 4. `GetWindowsDirectoryW` — `C:\Windows`
//! 5. the inherited parent `PATH`
//!
//! The current directory appears nowhere, so `NoDefaultCurrentDirectoryInExePath`
//! is irrelevant here and step 2 is the whole exposure: Tandem installs per-user
//! into `%LOCALAPPDATA%\Tandem` with `RequestExecutionLevel user`, so that
//! directory is fully writable by the unelevated user and is searched *ahead of*
//! System32. Anything that can write there can win the lookup for `netsh`.
//!
//! **Why `GetSystemDirectoryW` and not `%SystemRoot%`.** The environment block
//! belongs to whoever launched the process, so an anchor built by concatenating
//! `std::env::var("SystemRoot")` is attacker-controlled input wearing a
//! mitigation's clothes — and it is *weaker* than the bare name in one respect,
//! since poisoning an env var needs no filesystem write at all. This API reads
//! session state instead. It is also literally the call Rust makes at step 3, so
//! anchoring through it changes which candidate wins without changing where the
//! binary is found in the healthy case.
//!
//! **WOW64 redirection is correct behaviour here, not a bug to work around.**
//! In a 32-bit process this returns `SysWOW64`, which is where that process's
//! usable binaries live. Never reach for `Sysnative`: it does not exist for a
//! native 64-bit process, and the shipped Windows build is
//! `x86_64-pc-windows-msvc` only (`.github/workflows/tauri-release.yml`).
//!
//! **Every resolver here fails closed.** Returning the bare name on failure
//! would perform exactly the unanchored lookup this module exists to prevent,
//! so callers get `None` and map it onto their own "tool not found" error.

#![cfg(target_os = "windows")]

use std::path::PathBuf;

use windows_sys::Win32::System::SystemInformation::{
    GetSystemDirectoryW, GetWindowsDirectoryW,
};

/// Call one of the `Get*DirectoryW` pair, which share a buffer protocol.
///
/// Both return the length **excluding** the terminating null on success, and the
/// required size **including** it on overflow — so `len > buffer.len()` is an
/// unambiguous overflow signal (a success can be at most `len - 1`, since the
/// null has to fit).
fn read_dir_api(api: unsafe extern "system" fn(*mut u16, u32) -> u32) -> Option<PathBuf> {
    // MAX_PATH covers every real system directory; the retry exists because the
    // APIs' contract allows a longer one, and a silently truncated path would be
    // worse than no path.
    let mut buffer = vec![0u16; 260];
    // SAFETY: the pointer and length describe `buffer`, and the API writes at
    // most `len` UTF-16 units. It never retains the pointer.
    let mut len = unsafe { api(buffer.as_mut_ptr(), buffer.len() as u32) };

    if len as usize > buffer.len() {
        buffer = vec![0u16; len as usize];
        len = unsafe { api(buffer.as_mut_ptr(), buffer.len() as u32) };
    }

    // 0 is the documented failure return; a second overflow means the directory
    // grew between the two calls, which we decline rather than guess at.
    if len == 0 || len as usize > buffer.len() {
        return None;
    }

    Some(PathBuf::from(String::from_utf16(&buffer[..len as usize]).ok()?))
}

/// `%SystemRoot%\System32` (or `SysWOW64` under WOW64), read from the OS.
///
/// `None` when the call fails or reports a length the retry still cannot hold —
/// see the fail-closed note in the module docs.
pub fn system_dir() -> Option<PathBuf> {
    read_dir_api(GetSystemDirectoryW)
}

/// `%SystemRoot%` itself — `C:\Windows`. Only `explorer.exe` needs this.
pub fn windows_dir() -> Option<PathBuf> {
    read_dir_api(GetWindowsDirectoryW)
}

/// Reject anything that would escape the directory it is joined onto.
///
/// `PathBuf::join` REPLACES the base when given an absolute component, so
/// `join("C:\\evil.exe")` silently discards the anchor entirely — the one input
/// that could turn these resolvers back into the thing they exist to prevent.
/// Every caller passes a literal today; this keeps that from being load-bearing.
fn is_plain_relative(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(':')
        && !name.starts_with('\\')
        && !name.starts_with('/')
        && !name.split(['\\', '/']).any(|part| part == "..")
}

/// Absolute path to a binary that lives directly in System32 (`netsh.exe`,
/// `reg.exe`, `netstat.exe`, `tasklist.exe`).
pub fn system32_exe(name: &str) -> Option<PathBuf> {
    if !is_plain_relative(name) {
        return None;
    }
    Some(system_dir()?.join(name))
}

/// Absolute path to a binary that lives in `%SystemRoot%` rather than System32.
///
/// `explorer.exe` is the only one, and it is a worse case than the System32
/// binaries rather than a milder one: `C:\Windows` is step **4** of the search
/// order, so a bare `"explorer"` is outranked by the application directory
/// *and* by System32.
pub fn windows_exe(name: &str) -> Option<PathBuf> {
    if !is_plain_relative(name) {
        return None;
    }
    Some(windows_dir()?.join(name))
}

/// Absolute path to Windows PowerShell 5.1.
///
/// It is NOT in System32 itself — it sits in `WindowsPowerShell\v1.0\` beneath
/// it, which is why a bare `Command::new("powershell")` misses both System32 and
/// `C:\Windows` and falls all the way through to the inherited `PATH`. That made
/// it the widest-open of the sites this module closes.
pub fn windows_powershell_exe() -> Option<PathBuf> {
    Some(system_dir()?.join("WindowsPowerShell\\v1.0\\powershell.exe"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_dir_resolves_to_an_existing_directory() {
        let dir = system_dir().expect("GetSystemDirectoryW must succeed on Windows");
        assert!(dir.is_dir(), "{dir:?} should be a directory");
        assert!(dir.is_absolute(), "{dir:?} should be absolute");
    }

    /// The point of the module: the resolved path is the system copy.
    ///
    /// The obvious companion assertion — "not beside our own binary" — is NOT
    /// here on purpose. A test binary's `current_exe()` is `target/debug/deps/`,
    /// so comparing against it can never fire whatever `system32_exe` returns;
    /// it would read as coverage of the security property while providing none.
    /// What actually pins that property is the source-text check in
    /// `tests/build/cowork-subnet-probe-contract.test.ts`, which fails if any
    /// spawn site goes back to a bare program name.
    #[test]
    fn system32_exe_resolves_under_the_system_directory() {
        let netsh = system32_exe("netsh.exe").expect("netsh.exe path");
        assert!(netsh.is_absolute());
        assert!(netsh.is_file(), "{netsh:?} should exist on any Windows install");
        assert_eq!(netsh.parent(), system_dir().as_deref());
    }

    /// Regression guard for the sub-path: `powershell.exe` is one level deeper
    /// than every other binary this module resolves, so a `system32_exe` copy
    /// paste would produce a path that never exists.
    #[test]
    fn windows_powershell_lives_below_system32() {
        let ps = windows_powershell_exe().expect("powershell.exe path");
        assert!(ps.is_file(), "{ps:?} should exist on a desktop Windows install");
        assert_eq!(ps.parent().and_then(|p| p.file_name()), Some(std::ffi::OsStr::new("v1.0")));
    }

    #[test]
    fn windows_exe_resolves_under_the_windows_directory() {
        let explorer = windows_exe("explorer.exe").expect("explorer.exe path");
        assert!(explorer.is_file(), "{explorer:?} should exist on any Windows install");
        assert_eq!(explorer.parent(), windows_dir().as_deref());
        // The two directories are distinct, and confusing them is the whole
        // reason `explorer` needs its own resolver.
        assert_ne!(windows_dir(), system_dir());
    }

    /// An absolute or escaping `name` must be refused, not joined.
    ///
    /// `PathBuf::join` REPLACES the base on an absolute component, so without
    /// the guard `system32_exe("C:\\evil.exe")` returns `C:\evil.exe` — the
    /// resolver handing back an arbitrary path while looking like it anchored
    /// one. Unreachable from today's literal-only call sites; this is what keeps
    /// that from being the only thing standing between the two.
    #[test]
    fn a_resolver_refuses_a_name_that_would_escape_the_anchor() {
        for bad in ["C:\\evil.exe", "\\\\server\\share\\evil.exe", "..\\..\\evil.exe", "/evil", ""] {
            assert_eq!(system32_exe(bad), None, "system32_exe({bad:?}) must refuse");
            assert_eq!(windows_exe(bad), None, "windows_exe({bad:?}) must refuse");
        }
        // The legitimate sub-path form must still be accepted.
        assert!(system32_exe("WindowsPowerShell\\v1.0\\powershell.exe").is_some());
    }

    /// Failure is `None`, never a bare name.
    ///
    /// This is the property every caller's fail-closed arm depends on, and it is
    /// the one a well-meaning "make it more robust" edit would break — a
    /// `.unwrap_or_else(|| name.into())` here would reinstate the exact
    /// unanchored lookup the module exists to prevent, while every other test in
    /// this file kept passing.
    #[test]
    fn a_resolver_never_returns_a_bare_name() {
        for path in [
            system32_exe("netsh.exe").expect("netsh.exe path"),
            windows_powershell_exe().expect("powershell.exe path"),
        ] {
            assert!(path.is_absolute(), "{path:?} must never be a bare name");
            assert!(path.components().count() > 1, "{path:?} must never be a bare name");
        }
    }
}
