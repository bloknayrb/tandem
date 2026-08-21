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

use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

/// `%SystemRoot%\System32` (or `SysWOW64` under WOW64), read from the OS.
///
/// `None` when the call fails or reports a length the retry still cannot hold —
/// see the fail-closed note in the module docs.
pub fn system_dir() -> Option<PathBuf> {
    // MAX_PATH covers every real system directory; the retry exists because the
    // API's contract allows a longer one, and a silently truncated path would be
    // worse than no path.
    let mut buffer = vec![0u16; 260];
    // SAFETY: the pointer and length describe `buffer`, and the API writes at
    // most `len` UTF-16 units. It never retains the pointer.
    let mut len = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };

    if len as usize > buffer.len() {
        // Documented overflow signal: the return is the required size INCLUDING
        // the terminating null, unlike the success return.
        buffer = vec![0u16; len as usize];
        len = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    }

    // 0 is the documented failure return; a second overflow means the directory
    // grew between the two calls, which we decline rather than guess at.
    if len == 0 || len as usize > buffer.len() {
        return None;
    }

    Some(PathBuf::from(String::from_utf16(&buffer[..len as usize]).ok()?))
}

/// Absolute path to a binary that lives directly in System32 (`netsh.exe`,
/// `reg.exe`, `netstat.exe`, `tasklist.exe`).
pub fn system32_exe(name: &str) -> Option<PathBuf> {
    Some(system_dir()?.join(name))
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

    /// The point of the module: the resolved path must be the system copy, not
    /// something adjacent to our own binary.
    #[test]
    fn system32_exe_is_absolute_and_not_beside_the_application() {
        let netsh = system32_exe("netsh.exe").expect("netsh.exe path");
        assert!(netsh.is_absolute());
        assert!(netsh.is_file(), "{netsh:?} should exist on any Windows install");

        let app_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from));
        if let Some(app_dir) = app_dir {
            assert_ne!(netsh.parent(), Some(app_dir.as_path()));
        }
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

    /// An anchored path must still be handed to `Command` as a single argument
    /// with no quoting of our own — the module's no-string-concatenation rule
    /// applies to the program slot too.
    #[test]
    fn resolved_paths_carry_no_quoting() {
        let netsh = system32_exe("netsh.exe").expect("netsh.exe path");
        let text = netsh.to_string_lossy();
        assert!(!text.contains('"'), "{text} should not be pre-quoted");
    }
}
