//! Cowork workspace path discovery.
//!
//! Walks `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\
//! local-agent-mode-sessions\<workspace-id>\<vm-id>\` and returns the list of
//! VM-level directories that are safe to write Cowork plugin-registry files into.
//!
//! **Security invariant §3 — defense-in-depth path guard:**
//! Every candidate path goes through four checks (in order):
//!   a. Reject any path where any ancestor has the reparse-point attribute set
//!      (checked BEFORE canonicalize, which would resolve and hide them).
//!   b. `std::fs::canonicalize` on the candidate (safe: reparse points already rejected).
//!   c. Reject any path whose canonical form is a UNC path.
//!   d. Component-wise comparison (NOT string-prefix) against the canonical root.
//!
//! Paths that fail any check are skipped with a `WARN` log; the walker never
//! surfaces their failure to the caller.

#![cfg(target_os = "windows")]

use std::collections::HashMap;
use std::fmt::Write as _;
use std::os::windows::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use rand::RngCore;
use serde::Serialize;

/// Maximum number of workspaces processed in a single walk.
/// Logs a warning and stops if exceeded.
const MAX_WORKSPACES: usize = 100;

/// `FILE_ATTRIBUTE_REPARSE_POINT` — from the Windows API.
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

// ---------------------------------------------------------------------------
// Snapshot registry (TOCTOU hardening — issue #433)
// ---------------------------------------------------------------------------
//
// The UI scan and the per-workspace install/uninstall IPC calls are two
// separate trips across the Tauri boundary. Re-scanning the filesystem at IPC
// time leaves a time-of-check-to-time-of-use window: between the scan the UI
// rendered and the install click, a workspace directory could be moved,
// replaced with a junction/symlink, or a brand-new path injected into the
// caller-supplied string.
//
// To close that window we hand the UI an *opaque handle* for each validated
// workspace instead of a bare path. The handle maps — inside this process — to
// the exact canonical `PathBuf` that passed the four-layer guard during the
// scan. Install/uninstall resolve the handle back to that stored path rather
// than trusting (and re-scanning around) a caller-supplied string. A handle
// therefore can only ever name a path that the scan already validated; an
// injected or swapped path has no handle and cannot be acted on.
//
// The token is a 256-bit random value rendered as lowercase hex. It is opaque,
// unguessable, and process-local (a fresh registry per launch), so it cannot be
// forged or replayed across runs.

/// An opaque, validated reference to a single Cowork workspace directory,
/// returned by [`scan_workspaces_with_handles`].
///
/// `token` is the only field the UI must round-trip back to install/uninstall.
/// `path` is included for display purposes only — it is NOT trusted on the way
/// back in; the token is the authority.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceHandle {
    /// Opaque process-local token. Round-tripped to install/uninstall.
    pub token: String,
    /// Canonical path, for display in the UI only.
    pub path: String,
}

/// Process-global registry mapping handle token → validated canonical path.
///
/// Rebuilt from scratch on every [`scan_workspaces_with_handles`] call so a
/// stale token from a previous scan cannot be reused after the workspace set
/// changes. Cleared, not merged.
static SNAPSHOT: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

/// Generate a 256-bit random, hex-encoded handle token.
fn new_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut s = String::with_capacity(64);
    for b in bytes {
        // Infallible: writing to a String never errors.
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Scan for Cowork workspaces and return an opaque handle for each.
///
/// Replaces the in-process snapshot registry with the freshly validated set, so
/// only handles from the most recent scan resolve. Callers (the UI) must pass a
/// handle's `token` back to [`resolve_handle`] via the install/uninstall IPC
/// commands — the bare path is never trusted on the return trip.
pub fn scan_workspaces_with_handles() -> Vec<WorkspaceHandle> {
    let paths = find_cowork_workspaces();

    let mut map = HashMap::with_capacity(paths.len());
    let mut handles = Vec::with_capacity(paths.len());
    for path in paths {
        let token = new_token();
        handles.push(WorkspaceHandle {
            token: token.clone(),
            path: path.to_string_lossy().into_owned(),
        });
        map.insert(token, path);
    }

    // Replace (never merge) the registry so prior-scan tokens stop resolving.
    let mut guard = SNAPSHOT.lock().unwrap_or_else(|p| p.into_inner());
    *guard = Some(map);

    handles
}

/// Resolve a snapshot handle token back to the canonical path validated during
/// the scan that produced it.
///
/// Returns `None` if the token is unknown — e.g. it was forged, it came from a
/// scan that has since been superseded, or no scan has run this session. The
/// returned path was guard-validated at scan time; callers SHOULD still re-run
/// [`check_path_safe`] against it immediately before any file I/O to catch a
/// directory that was swapped *after* the scan (defense-in-depth).
pub fn resolve_handle(token: &str) -> Option<PathBuf> {
    let guard = SNAPSHOT.lock().unwrap_or_else(|p| p.into_inner());
    guard.as_ref().and_then(|m| m.get(token).cloned())
}

/// Re-run the four-layer guard against a path resolved from a snapshot handle,
/// catching a directory swapped *after* the scan that produced the handle.
///
/// Recomputes the canonical scan root for `candidate` (so the containment check
/// has a fresh, validated root) and runs [`check_path_safe`]. Returns the
/// re-canonicalized path on success, or `Err` if no current root contains the
/// candidate or any guard layer rejects it. This is the final defense-in-depth
/// gate the IPC commands run immediately before any file I/O.
pub fn revalidate_resolved_path(candidate: &Path) -> Result<PathBuf, String> {
    for root in cowork_roots() {
        let canonical_root = match std::fs::canonicalize(&root) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if let Ok(safe) = check_path_safe(candidate, &canonical_root) {
            return Ok(safe);
        }
    }
    Err(format!(
        "resolved workspace path {} is no longer within a canonical Cowork root",
        candidate.display()
    ))
}

/// Clear the snapshot registry. Test-only helper so suites do not leak handles
/// across cases.
#[cfg(test)]
pub(crate) fn clear_snapshot_for_test() {
    let mut guard = SNAPSHOT.lock().unwrap_or_else(|p| p.into_inner());
    *guard = None;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Discover all Cowork workspace directories on this machine.
///
/// # Returns
/// A `Vec<PathBuf>` of VM-level directories (two levels below
/// `local-agent-mode-sessions\`).  Returns an empty vec — not an error — when:
///   - Claude Desktop is not installed.
///   - `local-agent-mode-sessions\` does not exist yet.
///   - No workspaces are found.
///
/// Paths that fail the security guard (reparse point, UNC, outside-root) are
/// silently skipped after a `WARN` log.
pub fn find_cowork_workspaces() -> Vec<PathBuf> {
    let roots = cowork_roots();
    if roots.is_empty() {
        log::debug!("[cowork-scan] no Claude_* package directories found — Cowork not installed");
        return vec![];
    }

    let mut results = Vec::new();

    'root: for root in &roots {
        // Canonicalize the root for security comparisons.
        let canonical_root = match std::fs::canonicalize(root) {
            Ok(p) => p,
            Err(e) => {
                log::debug!("[cowork-scan] cannot canonicalize root {}: {e}", root.display());
                continue;
            }
        };

        // Walk workspace-id level.
        let ws_entries = match std::fs::read_dir(root) {
            Ok(e) => e,
            Err(e) => {
                log::debug!("[cowork-scan] cannot read sessions dir {}: {e}", root.display());
                continue;
            }
        };

        for ws_entry in ws_entries {
            let ws_entry = match ws_entry {
                Ok(e) => e,
                Err(e) => {
                    log::warn!("[cowork-scan] error reading workspace entry: {e}");
                    continue;
                }
            };
            let ws_path = ws_entry.path();

            // Walk vm-id level.
            let vm_entries = match std::fs::read_dir(&ws_path) {
                Ok(e) => e,
                Err(e) => {
                    log::warn!("[cowork-scan] cannot read vm-level dir {}: {e}", ws_path.display());
                    continue;
                }
            };

            for vm_entry in vm_entries {
                let vm_entry = match vm_entry {
                    Ok(e) => e,
                    Err(e) => {
                        log::warn!("[cowork-scan] error reading vm entry: {e}");
                        continue;
                    }
                };
                let vm_path = vm_entry.path();

                // Security guard.
                match check_path_safe(&vm_path, &canonical_root) {
                    Ok(safe_path) => {
                        results.push(safe_path);
                        if results.len() >= MAX_WORKSPACES {
                            log::warn!(
                                "[cowork-scan] reached {MAX_WORKSPACES} workspace limit — stopping scan"
                            );
                            break 'root;
                        }
                    }
                    Err(reason) => {
                        log::warn!(
                            "[cowork-scan] skipping {} — {reason}",
                            vm_path.display()
                        );
                    }
                }
            }
        }
    }

    log::info!("[cowork-scan] found {} workspace(s)", results.len());
    results
}

// ---------------------------------------------------------------------------
// Root directory discovery
// ---------------------------------------------------------------------------

/// Returns all `local-agent-mode-sessions\` directories found under
/// `%LOCALAPPDATA%\Packages\Claude_*\...`.
///
/// Supports the `TANDEM_COWORK_ROOT_OVERRIDE` environment variable for test
/// fixtures: if set, returns that path as the sole root (skipping the glob).
fn cowork_roots() -> Vec<PathBuf> {
    // Test hook: allow overriding the scan root for unit tests.
    //
    // Gated behind cfg(test) / the cowork-test-hooks feature so the env var
    // cannot be used to redirect production builds. Production binaries compiled
    // with `cargo build --release` (no features) skip this block entirely.
    #[cfg(any(test, feature = "cowork-test-hooks"))]
    {
        if let Ok(override_root) = std::env::var("TANDEM_COWORK_ROOT_OVERRIDE") {
            let p = PathBuf::from(&override_root);
            if p.is_dir() {
                log::debug!("[cowork-scan] using TANDEM_COWORK_ROOT_OVERRIDE: {override_root}");
                return vec![p];
            } else {
                log::debug!(
                    "[cowork-scan] TANDEM_COWORK_ROOT_OVERRIDE={override_root} is not a dir — returning empty"
                );
                return vec![];
            }
        }
    }

    let local_app_data = match dirs::data_local_dir() {
        Some(d) => d,
        None => {
            log::warn!("[cowork-scan] cannot resolve %LOCALAPPDATA%");
            return vec![];
        }
    };

    let packages_dir = local_app_data.join("Packages");
    if !packages_dir.is_dir() {
        return vec![];
    }

    let entries = match std::fs::read_dir(&packages_dir) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("[cowork-scan] cannot read Packages dir: {e}");
            return vec![];
        }
    };

    let mut roots = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        // Match Claude_* MSIX package directories.
        if !name_str.starts_with("Claude_") {
            continue;
        }

        let sessions_path = entry
            .path()
            .join("LocalCache")
            .join("Roaming")
            .join("Claude")
            .join("local-agent-mode-sessions");

        if sessions_path.is_dir() {
            log::debug!("[cowork-scan] found sessions root: {}", sessions_path.display());
            roots.push(sessions_path);
        }
    }

    roots
}

// ---------------------------------------------------------------------------
// Security guard
// ---------------------------------------------------------------------------

/// Apply the four-step path security guard (invariant §3).
///
/// Returns the canonicalized path on success, or a human-readable rejection
/// reason string on failure.
pub(crate) fn check_path_safe(candidate: &Path, canonical_root: &Path) -> Result<PathBuf, String> {
    // (a) Fail-closed reparse check on candidate + ancestors via lstat.
    //     MUST run before canonicalize — canonicalize resolves reparse points
    //     on Windows and would hide junction/symlink components.
    if has_reparse_point_in_chain(candidate) {
        return Err("reparse point detected in candidate path chain".to_string());
    }

    // (b) Canonicalize (safe now — reparse points already rejected).
    let canonical = std::fs::canonicalize(candidate)
        .map_err(|e| format!("canonicalize failed: {e}"))?;

    // (c) Reject UNC paths.
    if is_unc_path(&canonical) {
        return Err(format!(
            "UNC path rejected: {}",
            canonical.display()
        ));
    }

    // (d) Component-wise containment check (NOT string prefix).
    if !is_component_wise_child(&canonical, canonical_root) {
        return Err(format!(
            "path {} is outside canonical root {}",
            canonical.display(),
            canonical_root.display()
        ));
    }

    Ok(canonical)
}

/// Returns true if the path looks like a UNC path.
fn is_unc_path(path: &Path) -> bool {
    let s = path.to_string_lossy();
    // Extended UNC: \\?\UNC\  or classic UNC: \\server\share
    s.starts_with(r"\\?\UNC\") || (s.starts_with(r"\\") && !s.starts_with(r"\\?\"))
}

/// Returns true if any component in the path chain (from root to candidate)
/// has the `FILE_ATTRIBUTE_REPARSE_POINT` bit set.
///
/// Fails closed: if `symlink_metadata` returns an error, returns `true` (reject)
/// rather than `false` (allow). This prevents a metadata failure from silently
/// bypassing the reparse-point guard.
fn has_reparse_point_in_chain(path: &Path) -> bool {
    // Check the candidate itself. Fail closed on metadata errors.
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return true;
            }
        }
        Err(_) => return true, // Can't inspect — reject for safety.
    }
    // Check each ancestor. Fail closed on metadata errors.
    let mut ancestor = path.parent();
    while let Some(p) = ancestor {
        match std::fs::symlink_metadata(p) {
            Ok(metadata) => {
                if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    return true;
                }
            }
            Err(_) => return true, // Can't inspect ancestor — reject for safety.
        }
        ancestor = p.parent();
    }
    false
}

/// Returns true if `child` is strictly within `root` based on a component-wise
/// comparison.  String-prefix checks are banned (they break on names like
/// `/foo/bar` being "inside" `/foo/ba`).
fn is_component_wise_child(child: &Path, root: &Path) -> bool {
    let root_components: Vec<Component<'_>> = root.components().collect();
    let child_components: Vec<Component<'_>> = child.components().collect();

    if child_components.len() <= root_components.len() {
        return false;
    }

    for (r, c) in root_components.iter().zip(child_components.iter()) {
        if r != c {
            return false;
        }
    }
    true
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_is_unc_path() {
        assert!(is_unc_path(Path::new(r"\\?\UNC\server\share")));
        assert!(is_unc_path(Path::new(r"\\server\share")));
        assert!(!is_unc_path(Path::new(r"\\?\C:\Users\foo")));
        assert!(!is_unc_path(Path::new(r"C:\Users\foo")));
    }

    #[test]
    fn test_component_wise_child() {
        let root = Path::new(r"C:\Users\test\root");
        assert!(is_component_wise_child(
            Path::new(r"C:\Users\test\root\ws\vm"),
            root
        ));
        assert!(!is_component_wise_child(
            Path::new(r"C:\Users\test\root"),
            root
        ));
        assert!(!is_component_wise_child(
            Path::new(r"C:\Users\test\other\ws\vm"),
            root
        ));
        // Path traversal via .. trick.
        assert!(!is_component_wise_child(
            Path::new(r"C:\Windows\System32"),
            root
        ));
    }

    #[test]
    fn test_scan_with_override_absent() {
        let _guard = crate::COWORK_ENV_LOCK.lock().unwrap();
        // Override pointing at a non-existent dir → returns empty vec.
        std::env::set_var("TANDEM_COWORK_ROOT_OVERRIDE", r"C:\NonExistent\CoworkTest");
        let results = find_cowork_workspaces();
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");
        assert!(results.is_empty());
    }

    #[test]
    fn test_scan_with_fixture_dir() {
        let _guard = crate::COWORK_ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join("tandem_cowork_scan_test");
        let _ = fs::remove_dir_all(&dir); // Clean up previous runs.
        let ws_dir = dir.join("ws-abc").join("vm-123");
        fs::create_dir_all(&ws_dir).unwrap();

        std::env::set_var("TANDEM_COWORK_ROOT_OVERRIDE", dir.to_str().unwrap());
        let results = find_cowork_workspaces();
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");

        // Clean up.
        let _ = fs::remove_dir_all(&dir);

        // Should find the vm-level directory.
        assert_eq!(results.len(), 1, "expected 1 workspace, got {:?}", results);
    }

    #[test]
    fn test_reparse_check_fail_closed_on_nonexistent_path() {
        // Fail-closed: lstat on a non-existent path returns Err → reject.
        let bogus = Path::new(r"C:\Definitely\Does\Not\Exist\xyz_reparse_test");
        assert!(
            has_reparse_point_in_chain(bogus),
            "has_reparse_point_in_chain must fail closed on lstat errors"
        );
    }

    #[test]
    fn test_token_is_64_hex_chars_and_unique() {
        let a = new_token();
        let b = new_token();
        assert_eq!(a.len(), 64, "token must be 32 bytes hex-encoded");
        assert!(
            a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "token must be lowercase hex: {a}"
        );
        assert_ne!(a, b, "two tokens must not collide");
    }

    #[test]
    fn test_scan_with_handles_round_trips_via_resolve() {
        let _guard = crate::COWORK_ENV_LOCK.lock().unwrap();
        clear_snapshot_for_test();

        let dir = std::env::temp_dir().join("tandem_cowork_handles_test");
        let _ = fs::remove_dir_all(&dir);
        let vm = dir.join("ws-abc").join("vm-123");
        fs::create_dir_all(&vm).unwrap();

        std::env::set_var("TANDEM_COWORK_ROOT_OVERRIDE", dir.to_str().unwrap());
        let handles = scan_workspaces_with_handles();
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");

        assert_eq!(handles.len(), 1, "expected 1 handle, got {handles:?}");
        let token = &handles[0].token;

        // A valid token resolves to the canonical validated path.
        let resolved = resolve_handle(token).expect("valid token must resolve");
        assert!(resolved.ends_with("vm-123"), "resolved {resolved:?}");

        // An unknown token does not resolve.
        assert!(
            resolve_handle("deadbeef").is_none(),
            "forged token must not resolve"
        );

        clear_snapshot_for_test();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_rescan_invalidates_prior_tokens() {
        let _guard = crate::COWORK_ENV_LOCK.lock().unwrap();
        clear_snapshot_for_test();

        let dir = std::env::temp_dir().join("tandem_cowork_rescan_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("ws").join("vm")).unwrap();

        std::env::set_var("TANDEM_COWORK_ROOT_OVERRIDE", dir.to_str().unwrap());
        let first = scan_workspaces_with_handles();
        let old_token = first[0].token.clone();
        assert!(resolve_handle(&old_token).is_some());

        // A fresh scan replaces (not merges) the registry — old tokens die.
        let second = scan_workspaces_with_handles();
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");

        let new_token = &second[0].token;
        assert_ne!(&old_token, new_token, "rescan must mint a fresh token");
        assert!(
            resolve_handle(&old_token).is_none(),
            "prior-scan token must stop resolving after a rescan"
        );
        assert!(resolve_handle(new_token).is_some());

        clear_snapshot_for_test();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_revalidate_resolved_path_accepts_in_root() {
        let _guard = crate::COWORK_ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join("tandem_cowork_reval_ok_test");
        let _ = fs::remove_dir_all(&dir);
        let vm = dir.join("ws").join("vm");
        fs::create_dir_all(&vm).unwrap();

        std::env::set_var("TANDEM_COWORK_ROOT_OVERRIDE", dir.to_str().unwrap());
        let canon_vm = std::fs::canonicalize(&vm).unwrap();
        let result = revalidate_resolved_path(&canon_vm);
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");
        let _ = fs::remove_dir_all(&dir);

        assert!(result.is_ok(), "path inside the root must revalidate: {result:?}");
    }

    #[test]
    fn test_revalidate_resolved_path_rejects_outside_root() {
        let _guard = crate::COWORK_ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join("tandem_cowork_reval_bad_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("ws").join("vm")).unwrap();

        std::env::set_var("TANDEM_COWORK_ROOT_OVERRIDE", dir.to_str().unwrap());
        // A path that exists but is NOT under the override root.
        let outside = std::env::temp_dir();
        let result = revalidate_resolved_path(&outside);
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");
        let _ = fs::remove_dir_all(&dir);

        assert!(result.is_err(), "path outside the root must be rejected");
    }
}
