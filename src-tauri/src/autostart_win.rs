//! Windows start-at-login registration, written by Tandem itself (#2160).
//!
//! ## Why not `tauri-plugin-autostart`
//!
//! The plugin's 2.7 line moves to `auto-launch` 0.6, whose Windows `enable()`
//! defaults to `WindowsEnableMode::Dynamic`: it writes the machine-wide
//! `HKEY_LOCAL_MACHINE\...\Run` value whenever the process can (any elevated
//! launch, or any launch with UAC off) and falls back to `HKCU` only on
//! access-denied. The plugin's `Builder` offers no way to choose. Tandem
//! installs per user into `%LOCALAPPDATA%`, and `refresh_registration` calls
//! `enable()` on every eligible launch, so one "Run as administrator" launch
//! would make every user of the machine run, at logon, an executable only the
//! installing user can write — and a later non-elevated disable could not
//! remove it.
//!
//! So on Windows the plugin is not a dependency at all (`Cargo.toml`), and this
//! module writes the registration `auto-launch` 0.5 wrote — the same two values,
//! under the same name — to `HKEY_CURRENT_USER` only. There is no hive
//! parameter anywhere in this file: every key is opened from
//! `HKEY_CURRENT_USER`, and `tests/build/autostart-windows-scope.test.ts` fails
//! if `HKEY_LOCAL_MACHINE` ever appears here.
//!
//! ## What changed from the 0.5 registration, deliberately
//!
//! - The executable path is **quoted** in the Run value (`win_run_command`).
//! - `disable()` treats an already-absent value as success; `is_enabled()`
//!   reads a missing Run key as "off" rather than an error.
//! - `enable()` refuses to bake an executable that sits in another user's
//!   profile (`exe_in_another_users_profile`), the over-the-shoulder-elevation
//!   twin of the HKLM problem.
//!
//! Everything else — the value name, the StartupApproved "enabled" bytes, the
//! rule for reading them — matches 0.5, so a registration written by an
//! earlier Tandem reads as on, is refreshed in place, and is still removed by
//! `uninstall_scrub.rs`. The pure halves live ungated in `autostart.rs` so the
//! ubuntu CI leg tests them; the round-trip tests below run on the Windows leg
//! against a scratch key.

use std::io;

use windows_sys::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS, WIN32_ERROR,
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_BINARY, REG_EXPAND_SZ, REG_SAM_FLAGS,
    REG_SZ,
};

use crate::autostart::{
    exe_in_another_users_profile, win_run_command, win_startup_approved_allows, AUTOSTART_FLAG,
    WIN_RUN_SUBKEY, WIN_STARTUP_APPROVED_ENABLED, WIN_STARTUP_APPROVED_SUBKEY,
};
use crate::uninstall_scrub::AUTOSTART_APP_NAME;

/// One registration: where its two values live (relative to `HKCU`) and what
/// they are called. Parameterized only so the tests can point it at a scratch
/// key; production uses [`LIVE`].
pub(crate) struct Registration<'a> {
    pub run_subkey: &'a str,
    pub approved_subkey: &'a str,
    pub value_name: &'a str,
}

/// The real registration: `HKCU\...\Run\Tandem` plus its StartupApproved twin.
pub(crate) const LIVE: Registration<'static> = Registration {
    run_subkey: WIN_RUN_SUBKEY,
    approved_subkey: WIN_STARTUP_APPROVED_SUBKEY,
    value_name: AUTOSTART_APP_NAME,
};

/// NUL-terminated UTF-16 for a `PCWSTR` argument.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn os_error(code: WIN32_ERROR) -> io::Error {
    io::Error::from_raw_os_error(code as i32)
}

fn check(code: WIN32_ERROR) -> io::Result<()> {
    if code == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(os_error(code))
    }
}

/// An open registry key, closed on drop.
struct Key(HKEY);

impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a handle `RegOpenKeyExW` returned and nothing else
        // closes it.
        unsafe {
            RegCloseKey(self.0);
        }
    }
}

/// Open `subkey` under `HKEY_CURRENT_USER`. `Ok(None)` when it does not exist.
fn open_hkcu(subkey: &str, access: REG_SAM_FLAGS) -> io::Result<Option<Key>> {
    let name = wide(subkey);
    let mut handle: HKEY = std::ptr::null_mut();
    // SAFETY: `name` is NUL-terminated and outlives the call; `handle` is a
    // valid out-pointer.
    let rc = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, name.as_ptr(), 0, access, &mut handle) };
    match rc {
        ERROR_SUCCESS => Ok(Some(Key(handle))),
        ERROR_FILE_NOT_FOUND => Ok(None),
        other => Err(os_error(other)),
    }
}

/// The type and raw bytes of `value` under `key`; `Ok(None)` when absent.
///
/// The value can grow between the size probe and the read (Task Manager or
/// another Tandem rewriting it), which the read reports as `ERROR_MORE_DATA`;
/// that is retried a bounded number of times rather than surfaced as a failure
/// that would read the toggle as off.
fn query_value(key: &Key, value: &str) -> io::Result<Option<(u32, Vec<u8>)>> {
    let name = wide(value);
    for _ in 0..4 {
        let mut kind: u32 = 0;
        let mut len: u32 = 0;
        // SAFETY: a null data pointer asks only for the type and size.
        let rc = unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                std::ptr::null_mut(),
                &mut len,
            )
        };
        match rc {
            ERROR_SUCCESS => {}
            ERROR_FILE_NOT_FOUND => return Ok(None),
            other => return Err(os_error(other)),
        }
        let mut buf = vec![0u8; len as usize];
        // SAFETY: `buf` holds `len` bytes, the size the first call reported.
        let rc = unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                buf.as_mut_ptr(),
                &mut len,
            )
        };
        match rc {
            ERROR_SUCCESS => {
                buf.truncate(len as usize);
                return Ok(Some((kind, buf)));
            }
            ERROR_FILE_NOT_FOUND => return Ok(None),
            ERROR_MORE_DATA => continue,
            other => return Err(os_error(other)),
        }
    }
    Err(os_error(ERROR_MORE_DATA))
}

impl Registration<'_> {
    /// On when the Run value exists as a string and Task Manager has not
    /// disabled it — `auto-launch` 0.5's rule, so the toggle reads an earlier
    /// Tandem's registration the same way.
    pub(crate) fn is_enabled(&self) -> io::Result<bool> {
        let Some(run) = open_hkcu(self.run_subkey, KEY_QUERY_VALUE)? else {
            return Ok(false);
        };
        match query_value(&run, self.value_name)? {
            Some((kind, _)) if kind == REG_SZ || kind == REG_EXPAND_SZ => {}
            _ => return Ok(false),
        }
        Ok(self
            .startup_approved_bytes()
            .is_none_or(|bytes| win_startup_approved_allows(&bytes)))
    }

    /// The StartupApproved bytes, or `None` when there are none to read. Any
    /// failure here reads as "not disabled", as it did in 0.5: the Run value is
    /// the registration, and this is only Task Manager's override of it.
    fn startup_approved_bytes(&self) -> Option<Vec<u8>> {
        let key = open_hkcu(self.approved_subkey, KEY_QUERY_VALUE).ok()??;
        query_value(&key, self.value_name)
            .ok()?
            .map(|(_, bytes)| bytes)
    }

    /// Write the Run value (`REG_SZ`), then mark it enabled in StartupApproved
    /// when that key exists.
    pub(crate) fn enable(&self, command: &str) -> io::Result<()> {
        let run = open_hkcu(self.run_subkey, KEY_SET_VALUE)?
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
        let name = wide(self.value_name);
        let data = wide(command);
        let byte_len = u32::try_from(data.len() * 2)
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        // SAFETY: `data` is `byte_len` bytes of NUL-terminated UTF-16, the
        // layout `REG_SZ` requires.
        check(unsafe {
            RegSetValueExW(
                run.0,
                name.as_ptr(),
                0,
                REG_SZ,
                data.as_ptr().cast(),
                byte_len,
            )
        })?;

        // Clears a Task Manager "disabled" left from before, so turning the
        // toggle on means on. Skipped when Explorer has not created the key.
        if let Ok(Some(approved)) = open_hkcu(self.approved_subkey, KEY_SET_VALUE) {
            // SAFETY: a 12-byte array, passed with its own length.
            check(unsafe {
                RegSetValueExW(
                    approved.0,
                    name.as_ptr(),
                    0,
                    REG_BINARY,
                    WIN_STARTUP_APPROVED_ENABLED.as_ptr(),
                    WIN_STARTUP_APPROVED_ENABLED.len() as u32,
                )
            })?;
        }
        Ok(())
    }

    /// Delete the Run value. Absent already is success. The StartupApproved
    /// value is left, as 0.5 left it; with no Run value it starts nothing, and
    /// the uninstall scrub removes both.
    pub(crate) fn disable(&self) -> io::Result<()> {
        let Some(run) = open_hkcu(self.run_subkey, KEY_SET_VALUE)? else {
            return Ok(());
        };
        let name = wide(self.value_name);
        // SAFETY: `name` is NUL-terminated and outlives the call.
        match unsafe { RegDeleteValueW(run.0, name.as_ptr()) } {
            ERROR_SUCCESS | ERROR_FILE_NOT_FOUND => Ok(()),
            other => Err(os_error(other)),
        }
    }
}

/// The Run value's command line for this launch: `current_exe()`, quoted, then
/// `--tandem-autostart`.
///
/// Refuses (as an `io::Error` with no path in its message — it is logged, and
/// only `ERR_IO` crosses IPC) when the executable sits in another user's
/// profile, when the profile folder cannot be found to check that, and when
/// the path is not Unicode or would need escaping.
pub(crate) fn command_for_this_launch() -> io::Result<String> {
    let exe = std::env::current_exe()?;
    let home = dirs::home_dir().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "profile folder not found; refusing to register start-at-login",
        )
    })?;
    // Judged on both spellings: canonicalizing yields `\\?\C:\...`, and if it
    // fails for one side only (it falls back to the raw path) the canonical
    // pair no longer shares a prefix and would read as "not another profile".
    let canonical_exe = crate::autostart::canonical_for_refresh_check(&exe);
    let canonical_home = crate::autostart::canonical_for_refresh_check(&home);
    if exe_in_another_users_profile(&canonical_exe, &canonical_home)
        || exe_in_another_users_profile(&exe, &home)
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "executable is in another user's profile; refusing to register start-at-login",
        ));
    }
    let exe = exe.to_str().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "executable path is not Unicode")
    })?;
    win_run_command(exe, &[AUTOSTART_FLAG]).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "executable path cannot be quoted for the Run value",
        )
    })
}

#[cfg(test)]
mod tests {
    //! Round trips against a scratch key under `HKCU\SOFTWARE`, never the real
    //! Run key. These run on the Windows CI leg only.

    use super::*;
    use windows_sys::Win32::System::Registry::{RegCreateKeyExW, RegDeleteKeyW, KEY_ALL_ACCESS};

    /// A scratch parent key with `Run` and (optionally) `Approved` children,
    /// deleted on drop.
    struct Scratch {
        parent: String,
        run: String,
        approved: String,
    }

    fn create(subkey: &str) {
        let name = wide(subkey);
        let mut handle: HKEY = std::ptr::null_mut();
        // SAFETY: test-only; valid NUL-terminated name and out-pointer.
        let rc = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                name.as_ptr(),
                0,
                std::ptr::null(),
                0,
                KEY_ALL_ACCESS,
                std::ptr::null(),
                &mut handle,
                std::ptr::null_mut(),
            )
        };
        check(rc).expect("create scratch key");
        drop(Key(handle));
    }

    fn delete(subkey: &str) {
        let name = wide(subkey);
        // SAFETY: test-only; valid NUL-terminated name.
        unsafe {
            RegDeleteKeyW(HKEY_CURRENT_USER, name.as_ptr());
        }
    }

    impl Scratch {
        fn new(tag: &str, with_approved: bool) -> Self {
            let parent = format!(
                r"SOFTWARE\Tandem-autostart-test-{}-{tag}",
                std::process::id()
            );
            let scratch = Scratch {
                run: format!(r"{parent}\Run"),
                approved: format!(r"{parent}\Approved"),
                parent,
            };
            create(&scratch.run);
            if with_approved {
                create(&scratch.approved);
            }
            scratch
        }

        fn registration(&self) -> Registration<'_> {
            Registration {
                run_subkey: &self.run,
                approved_subkey: &self.approved,
                value_name: "TandemTest",
            }
        }

        fn run_value(&self) -> Option<(u32, Vec<u8>)> {
            let key = open_hkcu(&self.run, KEY_QUERY_VALUE).unwrap().unwrap();
            query_value(&key, "TandemTest").unwrap()
        }

        fn set_approved(&self, bytes: &[u8]) {
            let key = open_hkcu(&self.approved, KEY_SET_VALUE).unwrap().unwrap();
            let name = wide("TandemTest");
            // SAFETY: test-only; `bytes` passed with its own length.
            check(unsafe {
                RegSetValueExW(
                    key.0,
                    name.as_ptr(),
                    0,
                    REG_BINARY,
                    bytes.as_ptr(),
                    bytes.len() as u32,
                )
            })
            .unwrap();
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            delete(&self.run);
            delete(&self.approved);
            delete(&self.parent);
        }
    }

    fn utf16_bytes(s: &str) -> Vec<u8> {
        wide(s).iter().flat_map(|u| u.to_le_bytes()).collect()
    }

    #[test]
    fn enable_then_disable_round_trips_in_hkcu() {
        let scratch = Scratch::new("roundtrip", true);
        let reg = scratch.registration();
        let command = r#""C:\Users\Jane Doe\AppData\Local\Tandem\tandem.exe" --tandem-autostart"#;

        assert!(!reg.is_enabled().unwrap());
        reg.enable(command).unwrap();
        assert!(reg.is_enabled().unwrap());

        let (kind, bytes) = scratch.run_value().expect("run value written");
        assert_eq!(kind, REG_SZ);
        assert_eq!(bytes, utf16_bytes(command));

        reg.disable().unwrap();
        assert!(!reg.is_enabled().unwrap());
        assert!(scratch.run_value().is_none());
        reg.disable()
            .expect("disabling what is already off is success");
    }

    #[test]
    fn task_manager_disable_reads_as_off_and_enable_clears_it() {
        let scratch = Scratch::new("approved", true);
        let reg = scratch.registration();
        reg.enable(r#""C:\T\tandem.exe" --tandem-autostart"#)
            .unwrap();

        scratch.set_approved(&[
            0x03, 0, 0, 0, 0x10, 0x52, 0x3a, 0x8b, 0xc4, 0x41, 0xda, 0x01,
        ]);
        assert!(!reg.is_enabled().unwrap(), "Task Manager's disable wins");

        reg.enable(r#""C:\T\tandem.exe" --tandem-autostart"#)
            .unwrap();
        assert!(reg.is_enabled().unwrap(), "turning the toggle on means on");
    }

    #[test]
    fn a_missing_startup_approved_key_neither_blocks_nor_disables() {
        let scratch = Scratch::new("noapproved", false);
        let reg = scratch.registration();
        reg.enable(r#""C:\T\tandem.exe""#).unwrap();
        assert!(reg.is_enabled().unwrap());
        assert!(
            open_hkcu(&scratch.approved, KEY_QUERY_VALUE)
                .unwrap()
                .is_none(),
            "enable must not create Explorer's key"
        );
    }

    #[test]
    fn a_missing_run_key_reads_as_off() {
        let reg = Registration {
            run_subkey: r"SOFTWARE\Tandem-autostart-test-absent\Run",
            approved_subkey: r"SOFTWARE\Tandem-autostart-test-absent\Approved",
            value_name: "TandemTest",
        };
        assert!(!reg.is_enabled().unwrap());
        reg.disable().unwrap();
        assert!(reg.enable("\"C:\\T\\tandem.exe\"").is_err());
    }

    #[test]
    fn this_launch_builds_a_quoted_command() {
        // The test binary lives in the cargo target dir, inside this user's
        // profile or outside every profile, so this must not be refused.
        let command = command_for_this_launch().expect("command for the test binary");
        assert!(command.starts_with('"'), "got {command}");
        assert!(
            command.ends_with(&format!("\" {AUTOSTART_FLAG}")),
            "got {command}"
        );
    }
}
