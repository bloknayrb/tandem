//! Atomic read-modify-write helper for Cowork registry JSON files.
//!
//! All Cowork plugin-registry files (`installed_plugins.json`,
//! `known_marketplaces.json`, `cowork_settings.json`) go through
//! `with_locked_json` so they share the same lock/read/merge/write/unlock path.
//!
//! **Security invariants:**
//! - Writes the temp file into the SAME directory as the destination so that
//!   `std::fs::rename` stays on the same volume (NTFS atomic rename contract).
//! - Acquires an exclusive file lock with exponential backoff before reading.
//! - Schema-drift guard: raises `CoworkError::SchemaDriftSuspected` if the
//!   top-level JSON shape does not match an expected `Object`.
//! - Follows no reparse point (#2144): the `cowork_plugins` folder, the
//!   lockfile and the data file are each inspected before use, and the two
//!   files are opened with `FILE_FLAG_OPEN_REPARSE_POINT`, so a link swapped
//!   in after the inspection is opened as itself and refused rather than
//!   followed. Opening a reparse point that way is the only no-follow open
//!   Windows has: an exclusive create (`CREATE_NEW`, Node's `O_CREAT|O_EXCL`)
//!   creates the target of a dangling symlink.

#![cfg(target_os = "windows")]

use std::fmt;
use std::io::{self, Read};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use fs2::FileExt;
use serde_json::Value;

use crate::cowork_workspace_scan::{is_reparse, is_uuid_like, probe, Probe};

/// `FILE_FLAG_OPEN_REPARSE_POINT`: open a reparse point itself rather than
/// what it points at. On a regular file it changes nothing.
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

/// The three Cowork registry files, in the order every multi-file lock holder
/// takes their locks (the sweeps below and the CLI's
/// `PLUGIN_FILES` in `src/cli/uninstall-scrub.ts`; the two lists are pinned
/// equal by `tests/build/cowork-scan-alignment.test.ts`). One shared order is
/// what lets two concurrent sweeps wait for each other instead of each holding
/// one lock and timing out on the other.
pub(crate) const PLUGIN_FILES: [&str; 3] = [
    "installed_plugins.json",
    "known_marketplaces.json",
    "cowork_settings.json",
];

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// Errors that can occur during Cowork workspace file operations.
///
/// All variants are `Display`-formatted so they can be returned as `String`
/// from Tauri invoke commands via `.map_err(|e| e.to_string())`.
#[derive(Debug)]
pub enum CoworkError {
    /// The top-level JSON shape of a Cowork file does not match the expected
    /// schema. Raised instead of silently coercing so that schema drift from a
    /// Cowork update surfaces immediately in the UI.
    SchemaDriftSuspected { file: PathBuf, detail: String },
    /// Could not acquire an exclusive file lock within the total wall-clock
    /// budget (30 seconds with exponential backoff).
    LockTimeout { path: PathBuf, elapsed: Duration },
    /// An I/O error occurred while reading, writing, or renaming files.
    IoError(io::Error),
    /// JSON serialisation or deserialisation failed.
    JsonError(serde_json::Error),
    /// The parent directory's ACL indicates it may grant write access to
    /// identities beyond the current user — write refused for security.
    InsecureAcl { path: PathBuf },
    /// A junction, symlink or other reparse point sits where a plain folder or
    /// file was expected (#2144). Refused rather than followed; maps to
    /// `WriteStatus::Failed`, which the heal pass retries, so a planted link
    /// stays visible in the log instead of going quiet.
    ReparsePoint { path: PathBuf },
}

impl fmt::Display for CoworkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CoworkError::SchemaDriftSuspected { file, detail } => write!(
                f,
                "Schema drift detected in {}: {}",
                file.display(),
                detail
            ),
            CoworkError::LockTimeout { path, elapsed } => write!(
                f,
                "Could not acquire lock on {} after {:.1}s",
                path.display(),
                elapsed.as_secs_f64()
            ),
            CoworkError::IoError(e) => write!(f, "I/O error: {e}"),
            CoworkError::JsonError(e) => write!(f, "JSON error: {e}"),
            CoworkError::InsecureAcl { path } => write!(
                f,
                "Insecure ACL on {} — write refused (path may be outside %LOCALAPPDATA% or OneDrive-synced)",
                path.display()
            ),
            CoworkError::ReparsePoint { path } => write!(
                f,
                "Refusing to follow a reparse point (junction or symlink) at {}",
                path.display()
            ),
        }
    }
}

impl std::error::Error for CoworkError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            CoworkError::IoError(e) => Some(e),
            CoworkError::JsonError(e) => Some(e),
            _ => None,
        }
    }
}

impl CoworkError {
    fn reparse(path: &Path) -> Self {
        CoworkError::ReparsePoint {
            path: path.to_path_buf(),
        }
    }
}

impl From<io::Error> for CoworkError {
    fn from(e: io::Error) -> Self {
        CoworkError::IoError(e)
    }
}

impl From<serde_json::Error> for CoworkError {
    fn from(e: serde_json::Error) -> Self {
        CoworkError::JsonError(e)
    }
}

// ---------------------------------------------------------------------------
// Lock backoff schedule
// ---------------------------------------------------------------------------

/// Exponential backoff delay sequence (ms): 200, 500, 1500, 5000, then 5000
/// repeated until the 30-second wall-clock budget is exhausted.
const BACKOFF_DELAYS_MS: &[u64] = &[200, 500, 1_500, 5_000];
const LOCK_BUDGET: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------
// Core helper
// ---------------------------------------------------------------------------

/// Atomically read-modify-write a JSON file under an exclusive file lock.
///
/// # Contract
/// 1. Refuses a link at `path`'s folder, then opens (or creates) the sibling
///    `.<file>.tandem-lock` and takes a non-blocking exclusive lock on it with
///    exponential backoff (200 ms → 500 ms → 1.5 s → 5 s cap, 30 s total).
/// 2. Reads and deserialises the file.  An absent file is treated as an empty
///    JSON object `{}`.
/// 3. Asserts the top-level value is a JSON object; returns
///    `CoworkError::SchemaDriftSuspected` otherwise.
/// 4. Calls `mutate(&mut Value)` — the caller performs the merge.
/// 5. Serialises the (possibly mutated) value into a temp file **in the same
///    directory** as `path`, `fsync`s, then renames into place (NTFS-atomic).
/// 6. Releases the lock.
///
/// # Preconditions
/// - `path`'s parent directory must already exist; this function will not
///   create it (callers should create it if needed).
/// - The caller is responsible for path-traversal validation (invariant §3)
///   before supplying `path`. That validation covers the vm dir; this function
///   refuses a reparse point at `path`'s folder, its lockfile or `path`
///   itself (#2144), none of which the vm-dir guard can see.
/// - `path` is one of [`PLUGIN_FILES`]. The orphan sweep's safety rests on
///   that: it holds those three locks, so a temp written under any other
///   file's lock would be protected only by the sweep's age gate.
pub fn with_locked_json<T, F>(path: &Path, mutate: F) -> Result<T, CoworkError>
where
    F: FnOnce(&mut Value) -> Result<T, CoworkError>,
{
    let dir = parent_of(path)?;

    // A junction planted as `cowork_plugins` would take every file below,
    // token included, wherever it points.
    require_plain_dir(dir)?;

    let lock_file = acquire_plugin_lock(path)?;

    // --- Critical section: read → mutate → atomic write ---
    let result = (|| -> Result<T, CoworkError> {
        // Read existing content; absent file = empty object. The handle is
        // closed before returning, so no data-file handle is held across the
        // rename below.
        let mut json_value: Value = match read_plugin_file(path)? {
            None => Value::Object(serde_json::Map::new()),
            Some(s) if s.is_empty() => Value::Object(serde_json::Map::new()),
            Some(s) => serde_json::from_str(&s)?,
        };

        // Schema guard: top-level must be an object.
        if !json_value.is_object() {
            return Err(CoworkError::SchemaDriftSuspected {
                file: path.to_path_buf(),
                detail: format!(
                    "expected top-level JSON object, got {}",
                    json_value_type_name(&json_value)
                ),
            });
        }

        // Run the caller's mutation.
        let mutation_result = mutate(&mut json_value)?;

        // Write to temp file in the same directory (same volume — atomic rename).
        let tmp_path = dir.join(temp_name());

        let serialised = serde_json::to_string_pretty(&json_value)?;

        // `create_new` does not follow a link at the temp name: std adds
        // `FILE_FLAG_OPEN_REPARSE_POINT` whenever it is set (std
        // `sys/fs/windows.rs`, `get_flags_and_attributes`), so a name planted
        // ahead of time fails this write rather than redirecting it.
        let write_result: std::io::Result<()> = (|| {
            use std::io::Write;
            let mut tmp_file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp_path)?;
            tmp_file.write_all(serialised.as_bytes())?;
            tmp_file.flush()?;
            tmp_file.sync_all()?;
            Ok(())
        })();

        if let Err(e) = write_result {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e.into());
        }

        // Atomic rename into place. Safe on Windows now because we only hold
        // a handle to the sibling lock file, not to `path`.
        std::fs::rename(&tmp_path, path).map_err(|e| {
            // Best-effort cleanup on rename failure.
            let _ = std::fs::remove_file(&tmp_path);
            CoworkError::from(e)
        })?;

        Ok(mutation_result)
    })();

    // Release the lock regardless of outcome.
    // The lock file is persistent — never deleted. Mutual exclusion lives in
    // the lock state, not the file's existence.  Deleting it between unlock()
    // and the next writer's open() would let two writers hold the critical
    // section simultaneously (classic TOCTOU race on lock files).
    let _ = FileExt::unlock(&lock_file);
    drop(lock_file);

    result
}

/// Take the cross-language lock on `path`'s sibling `.<file>.tandem-lock`,
/// with the backoff schedule above. The returned handle holds the lock until
/// it is unlocked or dropped.
fn acquire_plugin_lock(path: &Path) -> Result<std::fs::File, CoworkError> {
    let dir = parent_of(path)?;

    // Use a SIBLING lock file, NOT the data file itself.
    //
    // On Windows, holding an exclusive fs2 lock on the data file blocks
    // `std::fs::rename` from replacing it (os error 33 — "The process cannot
    // access the file because another process has locked a portion of the
    // file"). Locking a separate sidecar file decouples mutual exclusion from
    // the rename-over-path operation, letting the atomic swap succeed while
    // still serializing concurrent writers against the same data file.
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    //
    // **This name is a cross-language contract (#1600).** The npm CLI's
    // `rewriteJson` (`src/cli/uninstall-scrub.ts`) builds the same sibling name
    // and excludes this function by opening it with share mode 0. Renaming the
    // lockfile on either side silently removes the exclusion.
    let lock_path = dir.join(format!(".{file_name}.tandem-lock"));

    // Open/create the sibling lock file AND acquire the exclusive lock, both
    // inside the backoff loop. The open is inside deliberately: while the npm
    // scrub holds its share-mode-0 handle, `open` itself fails with sharing
    // violation 32. Outside the loop that was an immediate hard failure, and
    // the Cowork install writes its three files in separate calls with no
    // rollback, so one such failure left a partial registration.
    //
    // Only builds that contain this change get that protection. A desktop app
    // released before #1600 still hard-fails here while a newer npm scrub holds
    // the lockfile, and the two ship separately. That version-skew residual is
    // recorded in `docs/security.md`.
    let start = Instant::now();
    let mut delay_idx = 0usize;
    loop {
        // (#2144) Inspected before each open. A junction at the lock name
        // fails the open with error 5, which would read as an I/O fault rather
        // than the refusal it is; a symlink would be followed (and, dangling,
        // created through) by an open without the reparse flag.
        refuse_link(&lock_path)?;
        let attempt =
            open_lockfile(&lock_path).and_then(|file| file.try_lock_exclusive().map(|()| file));
        match attempt {
            Ok(file) => {
                // A link swapped in after the inspection was opened as itself
                // (the reparse flag), so this sees it.
                refuse_reparse_handle(&file, &lock_path)?;
                return Ok(file);
            }
            Err(e) if is_lock_contention(&e) => {
                let elapsed = start.elapsed();
                if elapsed >= LOCK_BUDGET {
                    return Err(CoworkError::LockTimeout {
                        path: path.to_path_buf(),
                        elapsed,
                    });
                }
                let delay_ms = BACKOFF_DELAYS_MS.get(delay_idx).copied().unwrap_or(5_000);
                log::debug!(
                    "[cowork] waiting for lock on {} (elapsed={:.1}s, backoff={}ms)",
                    lock_path.display(),
                    elapsed.as_secs_f64(),
                    delay_ms
                );
                std::thread::sleep(Duration::from_millis(delay_ms));
                if delay_idx + 1 < BACKOFF_DELAYS_MS.len() {
                    delay_idx += 1;
                }
            }
            Err(e) => return Err(e.into()),
        }
    }
}

// ---------------------------------------------------------------------------
// No-follow file access (#2144)
// ---------------------------------------------------------------------------
//
// Every Rust read or existence check of the three registry files goes through
// these, never `exists()` / `is_dir()` / `read_to_string`, all of which follow
// a junction or symlink at the path.

fn parent_of(path: &Path) -> Result<&Path, CoworkError> {
    path.parent().ok_or_else(|| {
        CoworkError::IoError(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path has no parent",
        ))
    })
}

/// `Err` when a reparse point sits at `path`, or when it cannot be inspected
/// (fails closed); `Ok` when it is absent or not a link.
fn refuse_link(path: &Path) -> Result<(), CoworkError> {
    match probe(path) {
        Probe::Reparse => Err(CoworkError::reparse(path)),
        Probe::Unreadable(e) => Err(e.into()),
        Probe::Absent | Probe::Dir | Probe::Other => Ok(()),
    }
}

/// Refuse a handle that was opened on a reparse point (only possible with
/// `FILE_FLAG_OPEN_REPARSE_POINT`, which is why every open here sets it).
fn refuse_reparse_handle(file: &std::fs::File, path: &Path) -> Result<(), CoworkError> {
    if is_reparse(&file.metadata()?) {
        return Err(CoworkError::reparse(path));
    }
    Ok(())
}

/// `dir` must be a plain directory: not a reparse point, not a file, present.
pub(crate) fn require_plain_dir(dir: &Path) -> Result<(), CoworkError> {
    match probe(dir) {
        Probe::Dir => Ok(()),
        Probe::Reparse => Err(CoworkError::reparse(dir)),
        Probe::Absent => Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("{} does not exist", dir.display()),
        )
        .into()),
        Probe::Other => Err(io::Error::new(
            io::ErrorKind::Other,
            format!("{} is not a directory", dir.display()),
        )
        .into()),
        Probe::Unreadable(e) => Err(e.into()),
    }
}

/// Create `cowork_plugins` if it is absent, then require it to be a plain
/// directory. Replaces `create_dir_all`, whose already-exists branch calls
/// `is_dir()` and so followed a junction planted there.
pub(crate) fn ensure_plugins_dir(dir: &Path) -> Result<(), CoworkError> {
    if matches!(probe(dir), Probe::Absent) {
        match std::fs::create_dir(dir) {
            Ok(()) => {}
            // Another writer (Claude Desktop, say) made it in between.
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
    }
    require_plain_dir(dir)
}

/// Is there a registry file at `path`, looked at without following anything?
///
/// `Ok(false)` when it or its folder is absent (or the folder is not a
/// directory); `Err(ReparsePoint)` when either is a link. A folder that is a
/// link is refused even though the file "exists" through it: the answer would
/// describe wherever the link points.
pub(crate) fn plugin_file_exists(path: &Path) -> Result<bool, CoworkError> {
    let dir = parent_of(path)?;
    match probe(dir) {
        Probe::Dir => {}
        Probe::Absent | Probe::Other => return Ok(false),
        Probe::Reparse => return Err(CoworkError::reparse(dir)),
        Probe::Unreadable(e) => return Err(e.into()),
    }
    match probe(path) {
        Probe::Absent => Ok(false),
        Probe::Reparse => Err(CoworkError::reparse(path)),
        Probe::Unreadable(e) => Err(e.into()),
        Probe::Dir | Probe::Other => Ok(true),
    }
}

/// Read a registry file without following a link at it or at its folder.
/// `Ok(None)` when absent.
///
/// The open sets `FILE_FLAG_OPEN_REPARSE_POINT`, so a symlink swapped in after
/// [`plugin_file_exists`] looked is opened as itself and refused below, and a
/// junction swapped in fails the open with error 5. Neither is followed.
pub(crate) fn read_plugin_file(path: &Path) -> Result<Option<String>, CoworkError> {
    if !plugin_file_exists(path)? {
        return Ok(None);
    }
    let mut file = match open_for_read_no_follow(path) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    refuse_reparse_handle(&file, path)?;
    let mut content = String::new();
    file.read_to_string(&mut content)?;
    Ok(Some(content))
}

/// Open for reading; a reparse point at `path` is opened as itself.
fn open_for_read_no_follow(path: &Path) -> io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

// ---------------------------------------------------------------------------
// Orphaned temp files (#2144)
// ---------------------------------------------------------------------------

/// The temp-file name [`with_locked_json`] writes beside its target.
/// `tests/build/cowork-scan-alignment.test.ts` reads this literal and the
/// `unique_suffix` format below, because the CLI's sweep matches the same shape.
fn temp_name() -> String {
    format!(".tandem-tmp-{}", unique_suffix())
}

/// The npm CLI scrub's temp prefix (`SCRUB_TEMP_PREFIX` in
/// `src/cli/uninstall-scrub.ts`, followed by a `randomUUID()`), pinned equal by
/// the same alignment test.
const CLI_SCRUB_TEMP_PREFIX: &str = ".tandem-scrub-tmp-";

/// Is `name` a temp file one of the two Cowork writers leaves when it dies
/// between writing and renaming? Exact shapes only, because the match is what
/// keeps the sweep off every other file in Claude's folder:
/// - `.tandem-tmp-<hex>-<hex>-<hex>` ([`temp_name`]; the only shape any
///   released desktop build wrote);
/// - `.tandem-scrub-tmp-<uuid>` (the npm CLI since v0.14.0), and
///   `.tandem-scrub-tmp-<1–8 base-36 chars>` (v0.8.0–v0.13.x, which used
///   `Math.random().toString(36).slice(2, 10)`). A removal pass must match every
///   shape any version wrote.
///
/// `.tandem-meta-tmp-*` (`cowork_meta.rs`) is deliberately not matched: it
/// lives in Tandem's app data, not here, and holds no token.
pub(crate) fn is_orphaned_temp_name(name: &str) -> bool {
    if let Some(rest) = name.strip_prefix(CLI_SCRUB_TEMP_PREFIX) {
        let legacy = (1..=8).contains(&rest.len())
            && rest.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'z'));
        return is_uuid_like(rest) || legacy;
    }
    if let Some(rest) = name.strip_prefix(".tandem-tmp-") {
        let groups: Vec<&str> = rest.split('-').collect();
        return groups.len() == 3
            && groups.iter().all(|g| {
                !g.is_empty() && g.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            });
    }
    false
}

/// A temp younger than this is left alone. Every current writer creates and
/// renames its temp while holding that file's lock, and the sweep holds all
/// three, so for them no age is needed. npm CLIs v0.8.0–v0.25.x wrote theirs
/// with no lock; a live temp lives milliseconds, so a minute outlasts it.
pub(crate) const ORPHAN_MIN_AGE: Duration = Duration::from_secs(60);

/// What a sweep did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SweepOutcome {
    /// Orphaned temp files deleted.
    pub removed: usize,
    /// Orphan-named entries left on purpose: not a regular file, or too new.
    pub left: usize,
    /// "path — error" for each orphan that could not be inspected or deleted
    /// (an antivirus holding it, access denied). Path and error only; such a
    /// file may hold the token, so the caller must say which one.
    pub failed: Vec<String>,
}

/// Delete orphaned temp files from `plugins_dir`, holding all three registry
/// locks while it does.
///
/// **The locks are the safety argument.** A temp exists only while its own
/// file's lock is held, so with all three held nothing can be mid-write, and
/// neither race a lock-free sweep has can happen: deleting a live temp (its
/// rename then fails, and a Tandem entry its writer was removing stays), or a
/// delete landing on the name the temp was just renamed to. The listing is
/// done once unlocked first, so a folder with nothing to sweep gets no new
/// lockfiles.
///
/// Precondition: the caller has validated the vm dir above `plugins_dir`.
pub(crate) fn sweep_orphaned_temps_in(
    plugins_dir: &Path,
    min_age: Duration,
) -> Result<SweepOutcome, CoworkError> {
    // An unreadable entry is an error, not an absence: dropping it would read
    // as "nothing to sweep" while an orphan stayed.
    let list = || -> Result<Vec<PathBuf>, CoworkError> {
        require_plain_dir(plugins_dir)?;
        let mut found = Vec::new();
        for entry in std::fs::read_dir(plugins_dir)? {
            let entry = entry?;
            if is_orphaned_temp_name(&entry.file_name().to_string_lossy()) {
                found.push(entry.path());
            }
        }
        Ok(found)
    };
    if list()?.is_empty() {
        return Ok(SweepOutcome::default());
    }

    // All three, in the shared order. A failure part-way drops the handles
    // already taken, which releases them.
    let _locks = PLUGIN_FILES
        .iter()
        .map(|name| acquire_plugin_lock(&plugins_dir.join(name)))
        .collect::<Result<Vec<_>, _>>()?;

    // A failure on one entry counts it as left and moves on, so one file an
    // antivirus holds open does not leave every other orphan behind.
    let mut outcome = SweepOutcome::default();
    for path in list()? {
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => {
                outcome.failed.push(format!("{} — {e}", path.display()));
                continue;
            }
        };
        let plain_file = meta.is_file() && !is_reparse(&meta);
        // A future mtime reads as fresh.
        let old_enough = meta
            .modified()
            .ok()
            .and_then(|m| SystemTime::now().duration_since(m).ok())
            .is_some_and(|age| age >= min_age);
        if !plain_file || !old_enough {
            outcome.left += 1;
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => outcome.removed += 1,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => outcome.failed.push(format!("{} — {e}", path.display())),
        }
    }
    Ok(outcome)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Is `e` another writer holding the lock, rather than a real failure?
///
/// - `WouldBlock`: fs2's `try_lock_exclusive` contention on Unix.
/// - Raw 33 (`ERROR_LOCK_VIOLATION`): fs2's contention on Windows. **Measured, not assumed** (`a_real_fs2_contention_error_is_contention`):
///   `LockFileEx` returns it with `ErrorKind::Uncategorized`, NOT `WouldBlock`,
///   so before #1600 a second Rust writer on Windows failed at once with an I/O
///   error instead of waiting.
/// - Raw 32 (`ERROR_SHARING_VIOLATION`): the npm scrub holding the
///   lockfile open with share mode 0 (#1600).
///
/// Both raw codes are Windows error numbers (32 is `EPIPE` and 33 is `EDOM` on
/// Linux); this whole module is `#![cfg(target_os = "windows")]`, so no
/// platform check is needed here.
fn is_lock_contention(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::WouldBlock || matches!(e.raw_os_error(), Some(32) | Some(33))
}

/// Open (creating if absent) the sibling lockfile, without truncating it.
///
/// `FILE_FLAG_OPEN_REPARSE_POINT` (#2144): without it, this open-or-create
/// creates the target of a dangling symlink at the lock name (measured). With
/// it, the link itself is opened, which the caller refuses. A share-mode-0
/// holder still fails it with 32, so the #1600 contention handling is
/// unchanged.
fn open_lockfile(lock: &Path) -> io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(lock)
}

/// Return a human-readable JSON type name for diagnostic messages.
fn json_value_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Generate a per-process-unique hex suffix for temp files.
///
/// Combines PID, monotonic nanosecond timestamp, and a process-local counter —
/// sufficient to avoid collisions with concurrent writers and leftover files
/// from a crashed previous run. Cryptographic randomness is not required here.
pub(crate) fn unique_suffix() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}-{:x}-{:x}", std::process::id(), nanos, count)
}

#[cfg(test)]
mod lock_interop_tests {
    //! The cross-language Cowork lock (#1600). This whole module is
    //! `#![cfg(target_os = "windows")]`, so every case here runs on the
    //! `windows-latest` `rust-test` leg only.

    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use std::sync::mpsc;

    /// Mirrors `rewriteJson`'s open in `src/cli/uninstall-scrub.ts`, with the
    /// libuv's `UV_FS_O_EXLOCK` spelled as the literal on purpose (Node does not
    /// export it in `fs.constants`): these tests are the only check that Node's
    /// libuv still honours it as share mode 0.
    const NODE_HOLD: &str = r#"const fs=require('fs');const h=fs.openSync(process.env.TANDEM_LOCK_PROBE,fs.constants.O_RDWR|fs.constants.O_CREAT|0x10000000);process.stdout.write('HELD\n');process.stdin.resume();process.stdin.on('end',()=>{fs.closeSync(h);process.exit(0);});"#;
    const NODE_CONTEND: &str = r#"const fs=require('fs');try{const h=fs.openSync(process.env.TANDEM_LOCK_PROBE,fs.constants.O_RDWR|fs.constants.O_CREAT|0x10000000);fs.closeSync(h);console.log('opened');}catch(e){console.log(e.code);}"#;

    fn node(script: &str, lock: &Path) -> Command {
        let mut cmd = Command::new("node");
        cmd.arg("-e").arg(script).env("TANDEM_LOCK_PROBE", lock);
        cmd
    }

    /// Never a skip: a missing `node` must fail this leg, not quietly pass it.
    fn spawn_failed(e: io::Error) -> ! {
        panic!(
            "could not spawn `node` ({e}); the #1600 interop check needs node on PATH — \
             add a setup-node step to the windows rust-test leg rather than skipping"
        )
    }

    fn scratch_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tandem-lock-interop-{}", unique_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lock_contention_classifies_would_block_and_windows_sharing_violation() {
        assert!(is_lock_contention(&io::Error::from(
            io::ErrorKind::WouldBlock
        )));
        assert!(is_lock_contention(&io::Error::from_raw_os_error(32)));
        assert!(is_lock_contention(&io::Error::from_raw_os_error(33)));
        assert!(!is_lock_contention(&io::Error::from(
            io::ErrorKind::NotFound
        )));
    }

    /// Measured, not assumed: whatever error fs2 really returns when a second
    /// handle contends must be classified as contention, or Rust-vs-Rust
    /// writers would stop waiting for each other.
    #[test]
    fn a_real_fs2_contention_error_is_contention() {
        let dir = scratch_dir();
        let lock = dir.join(".x.json.tandem-lock");
        let holder = open_lockfile(&lock).unwrap();
        holder.try_lock_exclusive().unwrap();
        let contender = open_lockfile(&lock).unwrap();
        let err = contender
            .try_lock_exclusive()
            .expect_err("a second exclusive lock succeeded");
        assert!(
            is_lock_contention(&err),
            "fs2 contention not classified: {err:?} (raw {:?})",
            err.raw_os_error()
        );
        FileExt::unlock(&holder).unwrap();
        drop((holder, contender));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Node holds the lockfile → Rust's open fails with 32, and
    /// `with_locked_json` WAITS (rather than failing) until Node releases.
    #[test]
    fn with_locked_json_waits_while_node_holds_the_lockfile() {
        let dir = scratch_dir();
        let data = dir.join("installed_plugins.json");
        std::fs::write(&data, "{}").unwrap();
        let lock = dir.join(".installed_plugins.json.tandem-lock");

        let mut child = node(NODE_HOLD, &lock)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap_or_else(|e| spawn_failed(e));
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line.trim(), "HELD", "node did not take the lockfile");

        let err = open_lockfile(&lock).expect_err("Rust opened a lockfile Node holds");
        assert_eq!(err.raw_os_error(), Some(32), "got {err:?}");

        let (done_tx, done_rx) = mpsc::channel();
        let writer_data = data.clone();
        let writer = std::thread::spawn(move || {
            let result = with_locked_json(&writer_data, |v| {
                v["written"] = Value::from(true);
                Ok(())
            });
            let _ = done_tx.send(());
            result
        });

        // The first two backoff sleeps sum to 700 ms: a writer that treated 32
        // as a hard failure would have returned by now.
        if done_rx.recv_timeout(Duration::from_millis(700)).is_ok() {
            let node_status = child.try_wait();
            let result = writer.join().unwrap();
            panic!(
                "with_locked_json returned while Node held the lockfile: {result:?} \
                 (node child status: {node_status:?})"
            );
        }

        drop(child.stdin.take());
        child.wait().unwrap();
        writer
            .join()
            .unwrap()
            .expect("with_locked_json must succeed once Node releases");
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&data).unwrap()).unwrap();
        assert_eq!(written["written"], Value::from(true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Rust holds (inside `with_locked_json`'s critical section) → Node's
    /// share-mode-0 open fails with `EBUSY`. The after-release control proves the
    /// probe is not failing for some other reason.
    #[test]
    fn node_exlock_open_is_refused_while_with_locked_json_holds() {
        let dir = scratch_dir();
        let data = dir.join("known_marketplaces.json");
        std::fs::write(&data, "{}").unwrap();
        let lock = dir.join(".known_marketplaces.json.tandem-lock");

        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let writer_data = data.clone();
        let writer = std::thread::spawn(move || {
            with_locked_json(&writer_data, move |_v| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
        });
        entered_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the writer never entered its critical section");

        let held = node(NODE_CONTEND, &lock)
            .output()
            .unwrap_or_else(|e| spawn_failed(e));
        release_tx.send(()).unwrap();
        writer.join().unwrap().unwrap();

        let after = node(NODE_CONTEND, &lock)
            .output()
            .unwrap_or_else(|e| spawn_failed(e));
        assert_eq!(String::from_utf8_lossy(&held.stdout).trim(), "EBUSY");
        assert_eq!(String::from_utf8_lossy(&after.stdout).trim(), "opened");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod reparse_tests {
    //! #2144: the folder, the lockfile and the data file are never followed.
    //! Several of these fixtures also failed on the old code, but with an
    //! `IoError` after following, so each row asserts the `ReparsePoint`
    //! variant, which is what changed.

    use super::*;
    use crate::cowork_workspace_scan::test_fs::Scratch;

    /// A fresh scratch dir with an empty `cowork_plugins` in it.
    fn plugins(s: &Scratch) -> PathBuf {
        let p = s.dir.join("cowork_plugins");
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_tandem(v: &mut Value) -> Result<(), CoworkError> {
        v["mcpServers"] = serde_json::json!({ "tandem": { "env": { "TANDEM_AUTH_TOKEN": "t" } } });
        Ok(())
    }

    fn assert_refused<T: std::fmt::Debug>(result: Result<T, CoworkError>, at: &Path) {
        match result {
            Err(CoworkError::ReparsePoint { path }) => assert_eq!(path, at),
            other => panic!("expected ReparsePoint at {at:?}, got {other:?}"),
        }
    }

    #[test]
    fn a_junction_planted_as_cowork_plugins_receives_nothing() {
        let mut s = Scratch::new("atomic");
        let target = s.dir.join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        let plugins = s.dir.join("cowork_plugins");
        s.junction(&plugins, &target);

        let result = with_locked_json(&plugins.join("installed_plugins.json"), write_tandem);

        assert_refused(result, &plugins);
        // Old: the token was written through the junction into its target.
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
    }

    #[test]
    fn a_junction_at_the_data_file_name_is_refused_by_name() {
        let mut s = Scratch::new("atomic");
        let plugins = plugins(&s);
        let target = s.dir.join("live");
        std::fs::create_dir_all(&target).unwrap();
        let data = plugins.join("installed_plugins.json");
        s.junction(&data, &target);

        // Old: `IoError` ("Access is denied") from the read that followed it.
        assert_refused(with_locked_json(&data, write_tandem), &data);
    }

    #[test]
    fn a_junction_at_the_lockfile_name_is_refused_by_name() {
        let mut s = Scratch::new("atomic");
        let plugins = plugins(&s);
        let target = s.dir.join("live");
        std::fs::create_dir_all(&target).unwrap();
        let lock = plugins.join(".installed_plugins.json.tandem-lock");
        s.junction(&lock, &target);

        // Old: `IoError` 5 from the open, which followed it to get there.
        assert_refused(
            with_locked_json(&plugins.join("installed_plugins.json"), write_tandem),
            &lock,
        );
    }

    #[test]
    fn a_dangling_symlink_at_the_lockfile_name_is_not_created_through() {
        let mut s = Scratch::new("atomic");
        let plugins = plugins(&s);
        let target = s.dir.join("created-through-the-link");
        let lock = plugins.join(".installed_plugins.json.tandem-lock");
        s.file_symlink(&lock, &target);

        let result = with_locked_json(&plugins.join("installed_plugins.json"), write_tandem);

        assert_refused(result, &lock);
        // Old: the open-or-create made the link's target (the issue's O_CREAT sentence).
        assert!(
            !target.exists(),
            "the lock open created the symlink's target"
        );
    }

    #[test]
    fn a_dangling_symlink_at_the_data_file_name_is_refused() {
        let mut s = Scratch::new("atomic");
        let plugins = plugins(&s);
        let target = s.dir.join("nowhere.json");
        let data = plugins.join("installed_plugins.json");
        s.file_symlink(&data, &target);

        // Old: read as absent (`{}`) and silently replaced by the rename.
        assert_refused(with_locked_json(&data, write_tandem), &data);
        assert!(!target.exists());
    }

    // The next two pin the opens themselves. A link that appears after the
    // lstat cannot be staged deterministically, so these call the open helpers
    // directly on a link: without the reparse flag each would open (or create)
    // the target, and the handle would carry no reparse attribute.

    #[test]
    fn the_data_file_open_sees_a_symlink_as_itself() {
        let mut s = Scratch::new("atomic");
        let plugins = plugins(&s);
        let real = s.dir.join("real.json");
        std::fs::write(&real, "{}").unwrap();
        let data = plugins.join("installed_plugins.json");
        s.file_symlink(&data, &real);
        let file = open_for_read_no_follow(&data).unwrap();
        assert_refused(refuse_reparse_handle(&file, &data), &data);
    }

    #[test]
    fn the_lockfile_open_sees_a_dangling_symlink_as_itself() {
        let mut s = Scratch::new("atomic");
        let plugins = plugins(&s);
        let target = s.dir.join("created-through-the-link");
        let lock = plugins.join(".installed_plugins.json.tandem-lock");
        s.file_symlink(&lock, &target);
        let file = open_lockfile(&lock).unwrap();
        assert_refused(refuse_reparse_handle(&file, &lock), &lock);
        assert!(!target.exists(), "open-or-create made the link's target");
    }

    #[test]
    fn absent_files_and_folders_read_as_absent() {
        let s = Scratch::new("atomic");
        let in_missing_dir = s.dir.join("cowork_plugins").join("installed_plugins.json");
        assert!(!plugin_file_exists(&in_missing_dir).unwrap());
        assert!(read_plugin_file(&in_missing_dir).unwrap().is_none());
        let plugins = plugins(&s);
        let data = plugins.join("installed_plugins.json");
        assert!(!plugin_file_exists(&data).unwrap());
        std::fs::write(&data, r#"{"a":1}"#).unwrap();
        assert_eq!(
            read_plugin_file(&data).unwrap().as_deref(),
            Some(r#"{"a":1}"#)
        );
    }

    #[test]
    fn ensure_plugins_dir_creates_once_and_refuses_a_junction_or_a_file() {
        let mut s = Scratch::new("atomic");
        let fresh = s.dir.join("cowork_plugins");
        ensure_plugins_dir(&fresh).unwrap();
        ensure_plugins_dir(&fresh).unwrap();
        assert!(fresh.is_dir());

        let target = s.dir.join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        let link = s.dir.join("linked_plugins");
        s.junction(&link, &target);
        assert_refused(ensure_plugins_dir(&link), &link);

        // A FILE there still fails, as `create_dir_all` made it fail.
        let file = s.dir.join("file_plugins");
        std::fs::write(&file, "").unwrap();
        assert!(matches!(
            ensure_plugins_dir(&file),
            Err(CoworkError::IoError(_))
        ));
    }

    #[test]
    fn orphaned_temp_names_match_exactly_the_two_writers_shapes() {
        // The generator's own output, not a copy of its format string.
        assert!(is_orphaned_temp_name(&temp_name()));
        assert!(is_orphaned_temp_name(
            ".tandem-scrub-tmp-0b30dd94-eb52-48e2-851c-025e7b9a45ad"
        ));
        // npm CLIs v0.8.0–v0.13.x: `Math.random().toString(36).slice(2, 10)`.
        assert!(is_orphaned_temp_name(".tandem-scrub-tmp-k3j9x2ab"));
        assert!(is_orphaned_temp_name(".tandem-scrub-tmp-4f"));
        for name in [
            ".tandem-tmp-",
            ".tandem-tmp-xyz",
            ".tandem-tmp-1-2",
            ".tandem-tmp-1-2-3-4",
            ".tandem-tmp-1--3",
            ".tandem-tmp-1A-2-3",
            ".tandem-scrub-tmp-",
            ".tandem-scrub-tmp-not-a-uuid",
            ".tandem-scrub-tmp-k3j9x2ab9",
            ".tandem-scrub-tmp-K3J9X2AB",
            ".tandem-meta-tmp-0b30dd94-eb52-48e2-851c-025e7b9a45ad",
            ".installed_plugins.json.tandem-lock",
            "installed_plugins.json",
            "x.tandem-tmp-1-2-3",
        ] {
            assert!(!is_orphaned_temp_name(name), "{name} must not match");
        }
    }

    fn seed_registry(plugins: &Path) {
        for name in PLUGIN_FILES {
            std::fs::write(plugins.join(name), "{}").unwrap();
            std::fs::write(plugins.join(format!(".{name}.tandem-lock")), "").unwrap();
        }
    }

    #[test]
    fn the_sweep_removes_orphans_and_leaves_a_directory_named_like_one() {
        let s = Scratch::new("atomic");
        let plugins = plugins(&s);
        seed_registry(&plugins);
        std::fs::write(plugins.join(".tandem-tmp-a-b-c"), "{}").unwrap();
        std::fs::write(plugins.join(".tandem-tmp-1-2-3"), "{}").unwrap();
        std::fs::create_dir(plugins.join(".tandem-tmp-d-e-f")).unwrap();

        let outcome = sweep_orphaned_temps_in(&plugins, Duration::ZERO).unwrap();

        assert_eq!(
            outcome,
            SweepOutcome {
                removed: 2,
                left: 1,
                ..Default::default()
            }
        );
        assert!(plugins.join(".tandem-tmp-d-e-f").is_dir());
        for name in PLUGIN_FILES {
            assert!(plugins.join(name).exists());
        }
    }

    #[test]
    fn the_sweep_creates_no_lockfile_when_there_is_nothing_to_sweep() {
        let s = Scratch::new("atomic");
        let plugins = plugins(&s);
        std::fs::write(plugins.join("installed_plugins.json"), "{}").unwrap();

        assert_eq!(
            sweep_orphaned_temps_in(&plugins, Duration::ZERO).unwrap(),
            SweepOutcome::default()
        );
        let names: Vec<_> = std::fs::read_dir(&plugins)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["installed_plugins.json".to_string()]);
    }

    #[test]
    fn the_sweep_keeps_a_temp_younger_than_the_gate() {
        let s = Scratch::new("atomic");
        let plugins = plugins(&s);
        seed_registry(&plugins);
        let fresh = plugins.join(".tandem-tmp-1-2-3");
        std::fs::write(&fresh, "{}").unwrap();

        let outcome = sweep_orphaned_temps_in(&plugins, ORPHAN_MIN_AGE).unwrap();

        assert_eq!(
            outcome,
            SweepOutcome {
                removed: 0,
                left: 1,
                ..Default::default()
            }
        );
        assert!(fresh.exists());
    }

    #[test]
    fn the_sweep_waits_while_a_writer_holds_one_of_the_three_locks() {
        // Holding all three is the safety argument, so a held lock must stall it.
        let s = Scratch::new("atomic");
        let plugins = plugins(&s);
        seed_registry(&plugins);
        std::fs::write(plugins.join(".tandem-tmp-1-2-3"), "{}").unwrap();
        let holder = open_lockfile(&plugins.join(".known_marketplaces.json.tandem-lock")).unwrap();
        holder.try_lock_exclusive().unwrap();

        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let sweep_dir = plugins.clone();
        let sweeper = std::thread::spawn(move || {
            let r = sweep_orphaned_temps_in(&sweep_dir, Duration::ZERO);
            let _ = done_tx.send(());
            r
        });
        // The first two backoff sleeps sum to 700 ms.
        assert!(
            done_rx.recv_timeout(Duration::from_millis(700)).is_err(),
            "the sweep ran while a writer held a lock"
        );
        assert!(plugins.join(".tandem-tmp-1-2-3").exists());

        FileExt::unlock(&holder).unwrap();
        drop(holder);
        assert_eq!(sweeper.join().unwrap().unwrap().removed, 1);
    }
}
