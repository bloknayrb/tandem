//! OS open-candidate screening: the one place a path arriving from the
//! operating system is checked, and the one place a [`ScreenedOpenPath`] can be
//! built.
//!
//! Everything here was lifted verbatim out of `lib.rs` (#1415). The move is the
//! mechanism, not tidying: `lib.rs` is ~6,900 lines in a single module, so a
//! newtype declared there would have a "private" field visible to every one of
//! those lines and to all eight of its `#[cfg(test)]` submodules. The standing
//! proof that this is not theoretical is `PendingOpens`, whose nominally
//! private field `lib.rs`'s own tests wrote straight through
//! (`state.0.lock().unwrap().push(PathBuf::from("a"))`).
//!
//! **This file deliberately contains no `#[cfg(test)] mod`.** A test module
//! declared here would be a *descendant* of `open_candidate` and could write
//! `ScreenedOpenPath(PathBuf::from("anything"))` — exactly the power the
//! newtype exists to withhold. The unit tests for these functions live in
//! `lib.rs` (`mod classify_opened_url_tests`), which is a *sibling* module and
//! therefore has the same reach as production code: it can call
//! [`validate_open_candidate`] to obtain a screened path, and cannot fabricate
//! one.
//!
//! `tests/build/screened-open-path.test.ts` pins the CONSEQUENCE rather than the
//! spelling: this file must contain exactly one `ScreenedOpenPath(...)`
//! construction and it must sit inside [`validate_open_candidate`]. An earlier
//! version of that pin grepped for `#[cfg(test)]` and `mod …tests {`, and
//! `#[cfg(any(test, feature = "x"))] mod fixtures { … }` walked straight past
//! both while still handing out fabricated values.

use std::path::{Path, PathBuf};

use tauri::Url;

use crate::is_unc_or_network_path;

/// A filesystem path that has passed EVERY check in [`validate_open_candidate`]
/// — the NTFS alternate-data-stream scan, UNC rejection, the extension
/// allowlist and the regular-file check — at the moment it was screened.
///
/// "Screened", not "Validated": the name must not fuse two predicates of very
/// different strength. `ext ∈ SUPPORTED_FILE_ASSOC_EXTS` is a total function of
/// the path and holds forever; `is_file()` is a filesystem SNAPSHOT that
/// expires, and a queued path sits in `PendingOpens` across the whole
/// `wait_for_health()` window with no re-screening on drain. This type asserts
/// "the OS handed this in and it was screened", not "this file exists right
/// now". The server's `resolveAndValidatePath` remains the authority.
///
/// The invariant is about CONSTRUCTION, not deconstruction: [`into_inner`] is
/// public and `Clone` is derived, because handing the inner path out (or
/// copying it) cannot un-screen it.
///
/// # The sanctioned route compiles
///
/// ```
/// use std::path::Path;
///
/// let dir = tempfile::TempDir::new().unwrap();
/// let file = dir.path().join("doc.md");
/// std::fs::write(&file, b"# hi").unwrap();
///
/// let args = vec!["tandem".to_string(), file.to_string_lossy().to_string()];
/// let screened: app_lib::ScreenedOpenPath =
///     app_lib::extract_file_arg(&args, dir.path()).unwrap().unwrap();
///
/// // `Deref<Target = Path>` is what lets the downstream consumers keep taking
/// // `&Path` with no textual change — including the macOS-gated ones this
/// // box cannot type-check.
/// let borrowed: &Path = &screened;
/// assert_eq!(borrowed, file.as_path());
/// ```
///
/// # Fabricating one does not compile
///
/// The tuple constructor is private to this module, so no consumer of the
/// crate can conjure a `ScreenedOpenPath` around an unscreened path.
///
/// ```compile_fail,E0603
/// let _ = app_lib::ScreenedOpenPath(std::path::PathBuf::from("/etc/passwd"));
/// ```
///
/// # Nor does reaching through the field
///
/// ```compile_fail,E0616
/// fn steal(screened: app_lib::ScreenedOpenPath) -> std::path::PathBuf {
///     screened.0
/// }
/// ```
///
/// # What `compile_fail` proves, and what it does not
///
/// **The error code after `compile_fail` is not enforced on stable rustc.**
/// rustdoc parses it and only checks it under a nightly toolchain, so retagging
/// the first block `compile_fail,E0308` still reports `3 passed; 0 failed`
/// (verified by mutation). Each block therefore proves "this does not compile"
/// and never "this fails with exactly this error". The codes are kept as
/// documentation of what a reader should expect to see, not as an assertion.
///
/// That makes *how many ways a block can fail* the thing that matters, so both
/// are written down to one: between them they resolve only
/// `app_lib::ScreenedOpenPath` and `std::path::PathBuf`, and a rename of the
/// type reddens the passing doctest above, which names it too. Neither block
/// calls `extract_file_arg` any more — an earlier version did, and a rename of
/// that function would have made the block fail on the unresolved call (E0425)
/// while still reporting `compile fail … ok`, with nothing downstream noticing
/// that the privacy it claimed to pin had stopped being tested.
///
/// Both doctests compile as EXTERNAL crates, so what they pin is the boundary
/// facing `app_lib`'s consumers (`src-tauri/tests/file_association.rs` among
/// them). The in-crate half of the guarantee — that `lib.rs` itself cannot
/// build one — is enforced by rustc on every build of this crate and pinned
/// against regression by `tests/build/screened-open-path.test.ts`. No negative
/// -compilation harness can cover it, `trybuild` included: trybuild also
/// compiles its cases as separate crates linking `app_lib`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenedOpenPath(PathBuf);

impl ScreenedOpenPath {
    /// Borrow the screened path.
    pub fn as_path(&self) -> &Path {
        &self.0
    }

    /// Consume the wrapper and yield the owned path.
    pub fn into_inner(self) -> PathBuf {
        self.0
    }
}

/// Deliberate, and the load-bearing design choice of #1415.
///
/// Rust's API guidelines reserve `Deref` on a newtype for smart pointers. It is
/// taken here anyway because the alternative — `.as_path()` at every use — puts
/// hand edits inside `#[cfg(target_os = "macos")]` code that no non-macOS
/// machine type-checks. With `Deref`, `request_open_file(&client, token, &path)`
/// coerces, `path.display()` resolves by auto-deref, and
/// `Option<ScreenedOpenPath>::as_deref()` yields `Option<&Path>` — so the macOS
/// arm changes by zero lines.
impl std::ops::Deref for ScreenedOpenPath {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for ScreenedOpenPath {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

/// File extensions Tandem can open via OS file association. Keep aligned with
/// `SUPPORTED_EXTENSIONS` in `src/shared/constants.ts` — server-side is the
/// authority; this list is
/// defense-in-depth, rejecting an obviously-wrong open candidate before an HTTP
/// request is issued. Since #1344 that means BOTH surfaces: argv on
/// Windows/Linux, and macOS `RunEvent::Opened` URLs.
///
/// "Keep aligned" was the whole instruction and it still drifted (#1306):
/// `markdown` sat in this list and in `tauri.conf.json` while the server
/// rejected it, and the failure is silent — `maybeOpenStartupFile` swallows the
/// open error and falls through to `welcome.md`. The alignment is now pinned by
/// `tests/build/file-association-alignment.test.ts`, which parses this literal
/// out of the source, so renaming or reshaping the constant fails that test
/// rather than silently stopping the check.
///
/// It must EQUAL the server's list, not merely be a subset of it. `htm` used to
/// be omitted, on the reasoning that `.htm` is not OS-registered (`.html` alone
/// is the association) so a double-click could never put one on argv. That was
/// true of argv and false everywhere else: #1344 routed the macOS Apple Event
/// through this same filter, and "Open With" and a Dock-icon drop deliver ANY
/// file regardless of registration. Omitting `htm` therefore stopped being a
/// no-op the moment the filter was shared, and refused a file the server
/// accepts — while the same file dropped on the window still opened, because
/// `useTauriFileDrop.svelte.ts` checks the server's list. Equality costs no
/// defense (the server rejects everything else regardless) and deletes the
/// drift axis instead of testing it.
///
/// `pub` rather than `pub(crate)` so `tests/file_association.rs` can iterate it
/// instead of keeping a hand-copied duplicate.
pub const SUPPORTED_FILE_ASSOC_EXTS: &[&str] =
    &["md", "markdown", "txt", "html", "htm", "docx"];

/// Why `extract_file_arg` rejected a candidate path. Carried in the `Err`
/// variant of its return so callers can log a typed reason (and, in the
/// future, surface a typed event to the WebView). See issue #630 — this is
/// sub-task #1 of the broader rejection-surfacing work; downstream sub-tasks
/// (Tauri event emission, buffered drain summaries, etc.) are tracked in a
/// follow-up issue.
///
/// `Ok(None)` is used for the "no candidate arg" case (the user did not pass
/// a file at all — e.g. cold-start with only flags). Only paths that were
/// supplied but failed validation produce an `Err`.
#[derive(Debug, Clone, PartialEq)]
pub enum RejectionReason {
    /// On Windows, the resolved absolute path contains a `:` outside the
    /// drive-letter slot (index 1). Catches NTFS Alternate Data Stream
    /// syntax like `file.md:Zone.Identifier`. Carries the resolved absolute
    /// `path` and the byte `index` of the offending colon — both are
    /// security-relevant (ADS detection) and were logged inline before the
    /// typed-reason refactor.
    SuspiciousColon { path: std::path::PathBuf, index: usize },
    /// The candidate's extension (lowercased) is not in
    /// `SUPPORTED_FILE_ASSOC_EXTS`. `ext` is the offending extension (empty
    /// when the path had no extension at all); `path` is the resolved
    /// absolute path.
    UnsupportedExtension { ext: String, path: std::path::PathBuf },
    /// The resolved `path` does not exist as a regular file (missing, a
    /// directory, or some other non-file inode).
    NotAFile { path: std::path::PathBuf },
}

impl std::fmt::Display for RejectionReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RejectionReason::SuspiciousColon { path, index } => write!(
                f,
                "suspicious colon at byte index {index} in resolved path {}",
                path.display()
            ),
            RejectionReason::UnsupportedExtension { ext, path } => {
                if ext.is_empty() {
                    write!(f, "missing/empty extension on path {}", path.display())
                } else {
                    write!(
                        f,
                        "unsupported extension '.{ext}' on path {}",
                        path.display()
                    )
                }
            }
            RejectionReason::NotAFile { path } => {
                write!(f, "not a regular file: {}", path.display())
            }
        }
    }
}

/// Map a typed [`RejectionReason`] to a stable, path-free reason code for the
/// WebView toast bus. The code travels to the client through
/// `get_startup_rejection`, never through the event payload; `App.svelte`'s
/// reason-code→message map turns it into user-facing text.
pub(crate) fn rejection_reason_code(reason: &RejectionReason) -> &'static str {
    match reason {
        RejectionReason::SuspiciousColon { .. } => "suspicious-path",
        RejectionReason::UnsupportedExtension { .. } => "unsupported-extension",
        RejectionReason::NotAFile { .. } => "not-a-file",
    }
}

/// Why `classify_opened_url` rejected a `file://`-style URL delivered via the
/// macOS `RunEvent::Opened` Apple Event (`kAEOpenDocuments`). Distinct from
/// `RejectionReason` (which classifies argv candidates): this enum classifies
/// already-parsed `tauri::Url` values from the Opened-event surface. See issue
/// #630, sub-task #3 (`classify_opened_url` extraction).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum OpenedUrlRejection {
    /// The URL's scheme is not `file` (e.g. `https://…`). Tandem only opens
    /// local files from Opened events.
    NonFileScheme,
    /// The URL carries a non-empty host (e.g. `file://localhost/x` or the
    /// SMB-style `file://smb-host/share`). RFC-8089 permits `localhost`, but
    /// Tandem flags any host conservatively — an SMB host is a real security
    /// concern and a `localhost` host is surprising for a desktop open.
    NonEmptyHost,
    /// `url.to_file_path()` failed to produce a filesystem path (e.g. a
    /// `cannot-be-a-base` `file:` URL with no path component).
    ConversionFailed,
    /// The URL converted to a filesystem path, but that path failed the shared
    /// [`validate_open_candidate`] checks (extension / regular-file). Wraps the
    /// argv path's [`RejectionReason`] rather than mirroring its variants so the
    /// reason-code strings have exactly one definition —
    /// `opened_url_reason_code` delegates to `rejection_reason_code`, and a
    /// third copy of `"unsupported-extension"` / `"not-a-file"` is precisely the
    /// drift #1344 was.
    ///
    /// Every `RejectionReason` variant is reachable through here on the platform
    /// that produces it — `SuspiciousColon` only where the ADS scan compiles
    /// (Windows), which is why the wrapping is exact rather than aspirational.
    /// Its production caller is macOS-only today, so that arm is currently
    /// unreached; it is deliberately not *unreachable*, because a future
    /// Windows Opened / deep-link handler must inherit the scan rather than
    /// silently skip it. See [`validate_open_candidate`].
    PathRejected(RejectionReason),
}

impl std::fmt::Display for OpenedUrlRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenedUrlRejection::NonFileScheme => {
                write!(f, "non-file URL from Opened event")
            }
            OpenedUrlRejection::NonEmptyHost => {
                write!(f, "file URL with host from Opened event")
            }
            OpenedUrlRejection::ConversionFailed => {
                write!(f, "failed to convert URL to file path")
            }
            // Delegate so the log line keeps the resolved path + detail the
            // inner reason carries. Wire payloads stay path-free because they go
            // through `opened_url_reason_code`, never through `Display`.
            OpenedUrlRejection::PathRejected(reason) => {
                write!(f, "rejected path from Opened event: {reason}")
            }
        }
    }
}

/// Map an [`OpenedUrlRejection`] to a stable, path-free reason code for the
/// WebView toast bus. Mirrors `rejection_reason_code` for the argv path; both
/// codes are handled by the `startup-file-rejected` listener in `App.svelte`.
///
/// The `dead_code` allowance is because its only production caller is the
/// macOS-gated `handle_opened_urls`; it stays compiled everywhere so the
/// code-stability test runs on every CI leg.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) fn opened_url_reason_code(reason: &OpenedUrlRejection) -> &'static str {
    match reason {
        OpenedUrlRejection::NonFileScheme => "non-file-url",
        OpenedUrlRejection::NonEmptyHost => "suspicious-path",
        OpenedUrlRejection::ConversionFailed => "not-a-file",
        // Pure delegation — no new code strings on this surface.
        OpenedUrlRejection::PathRejected(reason) => rejection_reason_code(reason),
    }
}

/// Classify a `file://`-style URL from the macOS Opened event into either an
/// openable filesystem path or a typed rejection.
///
/// Rules (in order):
/// - Reject any non-`file` scheme (`NonFileScheme`).
/// - Reject any non-empty host (`NonEmptyHost`). `file://host/share/...`
///   SMB-style URLs would surprise the user; require an empty/missing host.
/// - Convert via `Url::to_file_path()`; a failure is `ConversionFailed`.
/// - Validate the resulting path with the shared [`validate_open_candidate`]
///   (extension + regular file); a failure is `PathRejected(..)`. This step was
///   APPENDED, not interleaved — the first three gates are unchanged.
///
/// Unconditionally compiled and free of Tauri / Apple-Event plumbing (it reads
/// only the filesystem), so it can be unit-tested cross-platform with tempfiles
/// (the macOS Apple-Event delivery plumbing in `handle_opened_urls` is not
/// unit-testable from Windows). Its only production caller is the macOS-gated
/// `handle_opened_urls`. See issues #630 (sub-task #3) and #1344.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) fn classify_opened_url(
    url: &Url,
) -> Result<ScreenedOpenPath, OpenedUrlRejection> {
    if url.scheme() != "file" {
        return Err(OpenedUrlRejection::NonFileScheme);
    }
    if url.host_str().map(|h| !h.is_empty()).unwrap_or(false) {
        return Err(OpenedUrlRejection::NonEmptyHost);
    }
    let path =
        url.to_file_path().map_err(|_| OpenedUrlRejection::ConversionFailed)?;
    validate_open_candidate(path).map_err(OpenedUrlRejection::PathRejected)
}

/// ALL of the path-shaped open-candidate validation the desktop shell performs,
/// in one place: the NTFS alternate-data-stream scan (Windows), UNC rejection,
/// the extension allowlist, and the regular-file check. Shared by the argv path
/// (`extract_file_arg`, used by Windows / Linux cold start and the
/// `single-instance` warm-start callback) and the macOS `RunEvent::Opened` path
/// (`classify_opened_url`).
///
/// One definition so the OS entry points cannot drift again: before #1344 these
/// checks existed only inline inside `extract_file_arg`, so a macOS Finder
/// double-click of a `.pdf` or a deleted path sailed through to `/api/open` and
/// was refused server-side with nothing but a `log::warn!`.
///
/// The ADS scan lives HERE rather than in `extract_file_arg`, and that placement
/// is the point. Guarding it with a `#[cfg]` on the *caller* was the same shape
/// of bug as #1344 itself: this function is unconditionally compiled and
/// `classify_opened_url` is too, so a future Windows or Linux Opened / deep-link
/// handler would have inherited the extension and `is_file()` checks with no ADS
/// scan — and `C:\x\notes:stream.md` has `extension() == "md"` and reports
/// `is_file() == true` (Windows returns the base file's attributes for a stream
/// path). A check whose safety depends on who happens to call it is not a check.
///
/// ORDER IS LOAD-BEARING. The ADS and UNC scans run before `is_file()`, because
/// `is_file()` on a UNC path performs the SMB handshake — leaking an NTLM hash
/// from the shell process on a path Tandem was never going to open (the server's
/// `resolveAndValidatePath` refuses `\\` and `//` prefixes). A gate that runs
/// after the syscall it is protecting against is decoration.
///
/// Takes the `PathBuf` by value so neither caller has to clone it, and returns
/// it wrapped in a [`ScreenedOpenPath`] — the only constructor of that type, and
/// the reason this module exists (#1415).
///
/// `SUPPORTED_FILE_ASSOC_EXTS` must MATCH the server's `SUPPORTED_EXTENSIONS`
/// exactly — asserted as set equality by
/// `tests/build/file-association-alignment.test.ts`. Making this the shared
/// validator is what turned that list into a contract: an extension the server
/// opens but this list omits becomes unopenable via "Open With" or a Dock drop
/// while still opening when dropped on the *window* (`useTauriFileDrop.svelte.ts`
/// validates against the server list). `.htm` was exactly that, briefly, and a
/// per-surface difference in what counts as an openable file is not a policy
/// anyone chose.
///
/// # Precondition — the argument must already be resolved
///
/// `absolute` must be a resolved, non-relative path. The ADS scan exempts a
/// colon at byte index 1 because that is the Windows drive-letter slot, and that
/// exemption is only sound on a path that actually starts with one: handed the
/// *relative* `f:ADS.md`, the scan skips the very colon it exists to catch. Both
/// production callers satisfy this — `extract_file_arg` joins against `cwd`
/// first, `classify_opened_url` goes through `Url::to_file_path()` — but the
/// function is `pub(crate)`, so the precondition is stated and checked rather
/// than assumed. **Panics in debug builds** (`debug_assert!`) if it is violated;
/// release builds are unaffected.
///
/// The check reads "absolute *or* UNC/network" because `\\host\share\x` is a
/// resolved path that `Path::is_absolute()` reports as `false` on Unix, and the
/// cross-platform UNC test hands exactly that in — the refusal a few lines below
/// is what such a path is there to exercise.
pub(crate) fn validate_open_candidate(
    absolute: std::path::PathBuf,
) -> Result<ScreenedOpenPath, RejectionReason> {
    debug_assert!(
        absolute.is_absolute() || is_unc_or_network_path(&absolute.to_string_lossy()),
        "validate_open_candidate requires a resolved absolute path — the ADS scan's \
         drive-letter exemption at byte index 1 is unsound otherwise (a relative \
         `f:ADS.md` would sail through it)"
    );

    #[cfg(target_os = "windows")]
    {
        // Reject any colon outside the drive-letter position (index 1) on the
        // resolved absolute path. Catches NTFS Alternate Data Stream syntax
        // (`file.md:Zone.Identifier`) both when the colon lands at an absolute
        // index >1 (e.g. `C:\tmp\file.md:ADS`) and when a relative candidate
        // joined against `cwd` produces an absolute path with the suspicious
        // colon. An earlier version scanned the un-joined candidate string,
        // which let a relative `f:ADS.md` through (colon at index 1 of the
        // *candidate*). Scanning the resolved absolute closes that gap, which
        // is also why this must run on the already-joined path.
        let absolute_str = absolute.to_string_lossy();
        for (i, b) in absolute_str.as_bytes().iter().enumerate() {
            if *b == b':' && i != 1 {
                let index = i;
                return Err(RejectionReason::SuspiciousColon { path: absolute, index });
            }
        }
    }

    // UNC / network paths, refused before any filesystem call touches them.
    // Matches the server's `resolveAndValidatePath`, which rejects both
    // prefixes — but the server refusing it is one HTTP hop too late to stop
    // `is_file()` from having already performed the SMB handshake here.
    if is_unc_or_network_path(&absolute.to_string_lossy()) {
        return Err(RejectionReason::NotAFile { path: absolute });
    }

    let ext = absolute
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !SUPPORTED_FILE_ASSOC_EXTS.contains(&ext.as_str()) {
        return Err(RejectionReason::UnsupportedExtension { ext, path: absolute });
    }

    // is_file() follows symlinks intentionally — the final read goes through
    // server-side openFileByPath which is the authority for path validation
    // (extension, size, UNC rejection, etc.). Resolving symlinks here would
    // duplicate that check without adding defense in depth, since a symlink
    // pointing at a disallowed target would be rejected on the server hop.
    if !absolute.is_file() {
        return Err(RejectionReason::NotAFile { path: absolute });
    }

    Ok(ScreenedOpenPath(absolute))
}

/// Extract a file path to open from a process's command-line args.
///
/// Rules:
/// - Skip the executable (args\[0\]).
/// - Skip any arg whose first byte is `-` (covers both `-x` and `--long`).
///   We do **not** parse `--key=value` style flags — the value is treated as
///   part of the flag.
/// - Skip a literal `--` separator.
/// - Take the FIRST remaining arg.
/// - Resolve relative to `cwd`.
/// - Hand the resolved absolute path to the shared [`validate_open_candidate`],
///   which owns EVERY path-shaped check: the Windows NTFS alternate-data-stream
///   colon scan, UNC rejection, the `SUPPORTED_FILE_ASSOC_EXTS` allowlist
///   (case-insensitive), and the regular-file check. The macOS
///   `RunEvent::Opened` path runs the same helper (#1344). This function's own
///   job is argv shape only — it deliberately performs no path validation of
///   its own, because a check that lives at one entry point is a check the
///   other entry point does not have.
///
/// Returns:
/// - `Ok(Some(path))` — a screened, openable file path, typed as
///   [`ScreenedOpenPath`] so a downstream consumer cannot be handed an
///   unscreened one by mistake.
/// - `Ok(None)` — no candidate file arg was supplied (cold-start without a
///   file, all args were flags, etc.). Not a rejection.
/// - `Err(RejectionReason::...)` — a candidate was supplied but failed
///   validation. Each variant carries the resolved absolute path (and, for
///   `SuspiciousColon`, the offending byte index) so callers can log a
///   human-readable, diagnostic reason via the `Display` impl (`{reason}`,
///   not `{reason:?}`) — matching the path + index detail logged inline
///   before the typed-reason refactor.
///
/// This is `pub` so the integration test in `tests/file_association.rs` can
/// exercise it.
pub fn extract_file_arg(
    args: &[String],
    cwd: &std::path::Path,
) -> Result<Option<ScreenedOpenPath>, RejectionReason> {
    let Some(candidate) =
        args.iter().skip(1).find(|a| !a.starts_with('-') && a.as_str() != "--")
    else {
        return Ok(None);
    };

    let p = std::path::Path::new(candidate);
    let absolute: std::path::PathBuf =
        if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };

    validate_open_candidate(absolute).map(Some)
}
