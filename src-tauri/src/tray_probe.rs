//! Linux tray backend pre-check (#2359).
//!
//! On Linux, `tauri`'s tray goes through `tray-icon` → `libappindicator` →
//! `libappindicator-sys`, which does not link the appindicator library: it
//! `dlopen`s it from a `once_cell::sync::Lazy` (`LIB`) the first time any
//! wrapper function runs, i.e. inside `TrayIconBuilder::build`. When none of
//! its candidate sonames loads, that `Lazy` **panics** (libappindicator-sys
//! 0.9.0, `src/lib.rs:41`), so a missing library used to abort startup before
//! the "continue without a tray" arm in `setup()` could ever run.
//!
//! The fix is to ask the same question first, without panicking: try the same
//! sonames with the same loader, and skip the tray build when none loads.
//!
//! Why the probe agrees with `LIB`:
//! - Same loader and flags: both call `libloading` 0.7 `Library::new`
//!   (`RTLD_LAZY | RTLD_LOCAL`).
//! - Same search path: both calls are statically linked into `tandem-desktop`,
//!   so glibc searches on behalf of the same calling object, in its order:
//!   `LD_LIBRARY_PATH`, then the main executable's DT_RUNPATH (which is how
//!   the AppImage's bundled `usr/lib/libappindicator3.so.1` is found; its
//!   `AppRun` sets no `LD_LIBRARY_PATH`), the ld.so cache and the default
//!   directories. **Do not move this probe into a separate shared object**:
//!   it would search that object's RUNPATH instead.
//! - The probe keeps the library it loaded (`mem::forget`), so `LIB`'s later
//!   `dlopen` of the same name is answered from the already-loaded object.
//! - The invariant that actually prevents the panic is that every name the
//!   probe accepts is also one `LIB` tries. Matching `LIB`'s *order* as well
//!   keeps the two from loading two different appindicator libraries.
//!
//! What it does not cover: a library that loads but lacks a symbol
//! `tray-icon` needs. `libappindicator-sys` `expect`s every symbol lookup, so
//! that still panics — a wrong library, not a missing one, and unchanged by
//! this probe.
//!
//! Drift guard: the soname list is a copy of `LIB`'s, so the tests below pin
//! the locked crate versions and, where the crate source is on disk (it is
//! after any `cargo build`/`cargo test`), compare the list against it.
//! `Cargo.toml` pins `libappindicator-sys` with `backcompat` so feature
//! unification cannot drop the two unversioned names from `LIB`'s list while
//! the probe still accepts them.

/// The sonames `libappindicator-sys` 0.9.0 tries, in its order, with its
/// `backcompat` feature on (forced on by `Cargo.toml`).
pub(crate) const APPINDICATOR_SONAMES: [&str; 4] = [
    "libayatana-appindicator3.so.1",
    "libappindicator3.so.1",
    "libayatana-appindicator3.so",
    "libappindicator3.so",
];

/// Try each name in order with `load`; return the first that loads, or every
/// failure joined into one message.
pub(crate) fn probe_with<F>(names: &[&'static str], mut load: F) -> Result<&'static str, String>
where
    F: FnMut(&str) -> Result<(), String>,
{
    let mut failures = Vec::with_capacity(names.len());
    for &name in names {
        match load(name) {
            Ok(()) => return Ok(name),
            Err(e) => failures.push(e),
        }
    }
    Err(failures.join("; "))
}

/// Whether an appindicator library can be loaded, the way
/// `libappindicator-sys` will load it. `Ok` carries the soname that loaded,
/// `Err` the `dlopen` error for each candidate.
pub(crate) fn probe_appindicator() -> Result<&'static str, String> {
    probe_with(&APPINDICATOR_SONAMES, |name| {
        // SAFETY: loading runs the library's ELF initializers. This is the
        // same library, by the same name and loader, that `libappindicator-sys`
        // loads unconditionally as soon as the tray is built, so the probe adds
        // no initializer that would not have run anyway.
        match unsafe { libloading::Library::new(name) } {
            Ok(lib) => {
                // Keep it loaded: `LIB` keeps it for the life of the process
                // anyway, and `dlclose` on a GObject-type library is unsafe
                // once any of its types are registered.
                std::mem::forget(lib);
                Ok(())
            }
            Err(e) => Err(e.to_string()),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_loadable_name_wins_and_later_names_are_not_tried() {
        let mut tried = Vec::new();
        let got = probe_with(&APPINDICATOR_SONAMES, |name| {
            tried.push(name.to_string());
            if name == "libappindicator3.so.1" {
                Ok(())
            } else {
                Err(format!("{name}: nope"))
            }
        });
        assert_eq!(got, Ok("libappindicator3.so.1"));
        assert_eq!(
            tried,
            ["libayatana-appindicator3.so.1", "libappindicator3.so.1"]
        );
    }

    #[test]
    fn all_failures_are_reported_in_order() {
        let got = probe_with(&APPINDICATOR_SONAMES, |name| {
            Err(format!("{name}: missing"))
        });
        assert_eq!(
            got,
            Err(
                "libayatana-appindicator3.so.1: missing; libappindicator3.so.1: missing; \
                 libayatana-appindicator3.so: missing; libappindicator3.so: missing"
                    .to_string()
            )
        );
    }

    #[test]
    fn a_real_missing_library_is_an_error_not_a_panic() {
        let got = probe_with(&["libtandem-no-such-library-2359.so.1"], |name| {
            match unsafe { libloading::Library::new(name) } {
                Ok(lib) => {
                    std::mem::forget(lib);
                    Ok(())
                }
                Err(e) => Err(e.to_string()),
            }
        });
        let err = got.expect_err("a nonexistent soname must not load");
        assert!(err.contains("libtandem-no-such-library-2359.so.1"), "{err}");
    }

    /// Every `[[package]]` version recorded for `name` in Cargo.lock.
    fn locked_versions(name: &str) -> Vec<String> {
        let lock = include_str!("../Cargo.lock");
        let needle = format!("name = \"{name}\"");
        let mut versions = Vec::new();
        let mut lines = lock.lines();
        while let Some(line) = lines.next() {
            if line.trim() == needle {
                let v = lines.next().unwrap_or_default().trim();
                let v = v
                    .strip_prefix("version = \"")
                    .and_then(|v| v.strip_suffix('"'))
                    .unwrap_or_else(|| panic!("no version line after {needle}"));
                versions.push(v.to_string());
            }
        }
        versions
    }

    /// The soname list above is a copy of `libappindicator-sys`'s `LIB`, read
    /// from that crate's source at these versions. A bump of any crate on the
    /// tray path — including `tray-icon` switching its Linux backend (e.g. to
    /// `ksni`, which needs no library, so the probe would skip a working tray)
    /// — must fail here until someone re-reads the new source and updates
    /// `APPINDICATOR_SONAMES` and this test. Exactly one copy of each: a second
    /// `libappindicator-sys` would have its own `LIB` with its own list.
    #[test]
    fn tray_path_crate_versions_are_the_ones_the_soname_list_was_read_from() {
        assert_eq!(locked_versions("libappindicator-sys"), ["0.9.0"]);
        assert_eq!(locked_versions("libappindicator"), ["0.9.0"]);
        assert_eq!(locked_versions("tray-icon"), ["0.25.1"]);
    }

    /// Where the crate source is on disk (any machine that just compiled this
    /// crate from the registry), compare against `LIB`'s actual names.
    #[test]
    fn soname_list_matches_libappindicator_sys_source_when_available() {
        let cargo_home = std::env::var_os("CARGO_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".cargo")));
        let Some(registry) = cargo_home.map(|h| h.join("registry").join("src")) else {
            eprintln!("skipping: no CARGO_HOME or home dir");
            return;
        };
        let source = std::fs::read_dir(&registry)
            .into_iter()
            .flatten()
            .flatten()
            .map(|index| index.path().join("libappindicator-sys-0.9.0/src/lib.rs"))
            .find(|p| p.is_file());
        let Some(source) = source else {
            eprintln!("skipping: libappindicator-sys-0.9.0 source not under {registry:?}");
            return;
        };
        let text = std::fs::read_to_string(&source).expect("read libappindicator-sys source");
        let names: Vec<&str> = text
            .split("Library::new(\"")
            .skip(1)
            .map(|rest| rest.split('"').next().unwrap_or_default())
            .collect();
        assert_eq!(names, APPINDICATOR_SONAMES, "LIB's names in {source:?}");
    }
}
