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
    let start = Instant::now();
    let mut delay_idx = 0usize;
    let lock_file = loop {
        let attempt = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .and_then(|file| file.try_lock_exclusive().map(|()| file));
        match attempt {
            Ok(file) => break file,
            Err(e) if is_lock_contention(&e) => {
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
    };

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
        let tmp_path = dir.join(format!(".tandem-tmp-{}", unique_suffix()));

        let serialised = serde_json::to_string_pretty(&json_value)?;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Is `e` another writer holding the lock, rather than a real failure?
///
/// - `WouldBlock`: fs2's `try_lock_exclusive` contention on Unix.
/// - Raw 33 (`ERROR_LOCK_VIOLATION`), Windows only: fs2's contention on
///   Windows. **Measured, not assumed** (`a_real_fs2_contention_error_is_contention`):
///   `LockFileEx` returns it with `ErrorKind::Uncategorized`, NOT `WouldBlock`,
///   so before #1600 a second Rust writer on Windows failed at once with an I/O
///   error instead of waiting.
/// - Raw 32 (`ERROR_SHARING_VIOLATION`), Windows only: the npm scrub holding the
///   lockfile open with share mode 0 (#1600).
///
/// Both raw codes are Windows-only (32 is `EPIPE` and 33 is `EDOM` on Linux),
/// hence the `cfg!`.
fn is_lock_contention(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::WouldBlock
        || (cfg!(windows) && matches!(e.raw_os_error(), Some(32) | Some(33)))
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
    /// undocumented libuv flag spelled as the literal on purpose: these tests
    /// are the only check that the flag still means share mode 0.
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

    fn open_lockfile(lock: &Path) -> io::Result<std::fs::File> {
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock)
    }

    #[test]
    fn lock_contention_classifies_would_block_and_windows_sharing_violation() {
        assert!(is_lock_contention(&io::Error::from(io::ErrorKind::WouldBlock)));
        assert_eq!(
            is_lock_contention(&io::Error::from_raw_os_error(32)),
            cfg!(windows)
        );
        assert_eq!(
            is_lock_contention(&io::Error::from_raw_os_error(33)),
            cfg!(windows)
        );
        assert!(!is_lock_contention(&io::Error::from(io::ErrorKind::NotFound)));
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
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&data).unwrap()).unwrap();
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
