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

#![cfg(target_os = "windows")]

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use fs2::FileExt;
use serde_json::Value;

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
/// 1. Opens (or creates) `path` and acquires a non-blocking exclusive lock
///    with exponential backoff (200 ms → 500 ms → 1.5 s → 5 s cap, 30 s total).
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
///   before supplying `path`.
pub fn with_locked_json<T, F>(path: &Path, mutate: F) -> Result<T, CoworkError>
where
    F: FnOnce(&mut Value) -> Result<T, CoworkError>,
{
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;

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
    let lock_path = dir.join(format!(".{file_name}.tandem-lock"));

    // Open/create the sibling lock file.
    let lock_file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)?;

    // Acquire exclusive lock with exponential backoff.
    let start = Instant::now();
    let mut delay_idx = 0usize;
    loop {
        match lock_file.try_lock_exclusive() {
            Ok(()) => break,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                let elapsed = start.elapsed();
                if elapsed >= LOCK_BUDGET {
                    return Err(CoworkError::LockTimeout {
                        path: path.to_path_buf(),
                        elapsed,
                    });
                }
                let delay_ms = BACKOFF_DELAYS_MS
                    .get(delay_idx)
                    .copied()
                    .unwrap_or(5_000);
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

    // --- Critical section: read → mutate → atomic write ---
    let result = (|| -> Result<T, CoworkError> {
        // Read existing content; absent file = empty object. `read_to_string`
        // opens and closes its own handle, so no data-file handle is held
        // across the rename below.
        let mut json_value: Value = match std::fs::read_to_string(path) {
            Ok(s) if s.is_empty() => Value::Object(serde_json::Map::new()),
            Ok(s) => serde_json::from_str(&s)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                Value::Object(serde_json::Map::new())
            }
            Err(e) => return Err(e.into()),
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
        let tmp_name = format!(".tandem-tmp-{}", rand_hex(8));
        let tmp_path = dir.join(&tmp_name);

        let serialised = serde_json::to_string_pretty(&json_value)?;

        {
            use std::io::Write;
            let mut tmp_file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp_path)?;
            tmp_file.write_all(serialised.as_bytes())?;
            tmp_file.flush()?;
            tmp_file.sync_all()?;
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
    let _ = FileExt::unlock(&lock_file);
    // Best-effort cleanup of the sidecar lock file. If another process picked
    // up the lock between our unlock and this remove, the remove silently
    // fails — that's fine; they own it now.
    drop(lock_file);
    let _ = std::fs::remove_file(&lock_path);

    result
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/// Generate a short random hex string for temp-file suffixes.
fn rand_hex(len: usize) -> String {
    use rand::RngCore;
    let mut bytes = vec![0u8; (len + 1) / 2];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
        .chars()
        .take(len)
        .collect()
}
