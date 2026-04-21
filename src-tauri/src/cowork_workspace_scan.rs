//! Cowork workspace path discovery.
//!
//! Walks `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\
//! local-agent-mode-sessions\<workspace-id>\<vm-id>\` and returns the list of
//! VM-level directories that are safe to write Cowork plugin-registry files into.
//!
//! **Security invariant §3 — defense-in-depth path guard:**
//! Every candidate path goes through four checks (in order):
//!   a. `std::fs::canonicalize` on both the root and each candidate.
//!   b. Reject any path whose canonical form is a UNC path.
//!   c. Reject any path where any component has the reparse-point attribute set.
//!   d. Component-wise comparison (NOT string-prefix) against the canonical root.
//!
//! Paths that fail any check are skipped with a `WARN` log; the walker never
//! surfaces their failure to the caller.

#![cfg(target_os = "windows")]

use std::os::windows::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

/// Maximum number of workspaces processed in a single walk.
/// Logs a warning and stops if exceeded.
const MAX_WORKSPACES: usize = 100;

/// `FILE_ATTRIBUTE_REPARSE_POINT` — from the Windows API.
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

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
                Err(_) => continue,
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
    // The override is authoritative when set — if it points at an absent
    // directory we return an empty vec rather than falling back to the real
    // %LOCALAPPDATA% scan. This prevents tests that expect "no workspaces"
    // from accidentally picking up the developer's real Claude Desktop install.
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
    // (a) Canonicalize the candidate.
    let canonical = std::fs::canonicalize(candidate)
        .map_err(|e| format!("canonicalize failed: {e}"))?;

    // (b) Reject UNC paths.
    if is_unc_path(&canonical) {
        return Err(format!(
            "UNC path rejected: {}",
            canonical.display()
        ));
    }

    // (c) Reject reparse points anywhere in the chain.
    // Pass the canonical path so the check operates on the resolved form.
    if has_reparse_point_in_chain(&canonical) {
        return Err("reparse point detected in path chain".to_string());
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
}
