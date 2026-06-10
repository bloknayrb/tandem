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
    // Capture the most specific `check_path_safe` rejection (reparse point in
    // chain / UNC / canonicalize-failed-on-deleted-dir / outside-root) so the
    // final error names *why* the post-scan re-check failed — load-bearing for
    // incident triage of a junction-swap or deleted-workspace attack, which is
    // exactly what this gate exists to catch. Without it every distinct
    // rejection collapses into one generic line.
    let mut last_reason: Option<String> = None;
    for root in cowork_roots() {
        let canonical_root = match std::fs::canonicalize(&root) {
            Ok(p) => p,
            Err(_) => continue,
        };
        match check_path_safe(candidate, &canonical_root) {
            Ok(safe) => return Ok(safe),
            Err(reason) => last_reason = Some(reason),
        }
    }
    Err(match last_reason {
        Some(reason) => format!(
            "resolved workspace path {} failed re-validation: {reason}",
            candidate.display()
        ),
        None => format!(
            "resolved workspace path {} is no longer within a canonical Cowork root (no current root resolved)",
            candidate.display()
        ),
    })
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

/// Aggregate counters from a single workspace scan.
///
/// `rejected_by_guard` counts candidates that passed the shape filter but
/// failed the four-layer security guard (reparse point / UNC / canonicalize /
/// containment). Surfaced to the UI as `workspacesBlocked` so redirected or
/// cloud-synced AppData setups get honest messaging ("found but can't safely
/// configure") instead of a perpetual "no workspace yet".
///
/// `rejected_by_shape` counts expected non-workspace siblings (e.g.
/// `skills-plugin\…` under the Roaming root) and is log-only.
#[derive(Debug, Default, Clone, Copy)]
pub struct ScanStats {
    pub rejected_by_guard: usize,
    pub rejected_by_shape: usize,
}

/// Discover all Cowork workspace directories on this machine.
///
/// Convenience wrapper over [`find_cowork_workspaces_with_stats`] for callers
/// that don't need rejection counters.
pub fn find_cowork_workspaces() -> Vec<PathBuf> {
    find_cowork_workspaces_with_stats().0
}

/// Discover all Cowork workspace directories on this machine, plus scan stats.
///
/// # Returns
/// A `Vec<PathBuf>` of VM-level directories (two levels below
/// `local-agent-mode-sessions\`) and a [`ScanStats`].  Returns an empty vec —
/// not an error — when:
///   - Claude Desktop is not installed.
///   - `local-agent-mode-sessions\` does not exist yet.
///   - No workspaces are found.
///
/// Candidates that fail the shape filter (see [`workspace_shape_ok`]) are
/// debug-logged. Paths that fail the security guard (reparse point, UNC,
/// outside-root) are skipped: the first per scan logs at WARN, the rest at
/// debug (avoids WARN-per-candidate-per-poll on redirected-AppData machines).
pub fn find_cowork_workspaces_with_stats() -> (Vec<PathBuf>, ScanStats) {
    let roots = cowork_roots();
    let mut stats = ScanStats::default();
    if roots.is_empty() {
        log::debug!("[cowork-scan] no Claude session roots found — Cowork not installed");
        return (vec![], stats);
    }

    let mut results = Vec::new();

    for root in &roots {
        // Canonicalize the root for security comparisons.
        let canonical_root = match std::fs::canonicalize(root) {
            Ok(p) => p,
            Err(e) => {
                log::debug!("[cowork-scan] cannot canonicalize root {}: {e}", root.display());
                continue;
            }
        };

        // Per-root workspace cap: a first root with many accumulated session
        // dirs must not starve later roots (dual MSIX + direct installs).
        let mut root_count = 0usize;

        // Walk workspace-id level.
        let ws_entries = match std::fs::read_dir(root) {
            Ok(e) => e,
            Err(e) => {
                log::debug!("[cowork-scan] cannot read sessions dir {}: {e}", root.display());
                continue;
            }
        };

        'ws_level: for ws_entry in ws_entries {
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
                    log::debug!("[cowork-scan] cannot read vm-level dir {}: {e}", ws_path.display());
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

                // Shape filter BEFORE the security guard: only dirs that look
                // like Cowork sessions are candidates. Rejections here are
                // expected (non-workspace siblings), not suspicious.
                if !workspace_shape_ok(&vm_path) {
                    stats.rejected_by_shape += 1;
                    log::debug!(
                        "[cowork-scan] skipping {} — not workspace-shaped",
                        vm_path.display()
                    );
                    continue;
                }

                // Security guard.
                match check_path_safe(&vm_path, &canonical_root) {
                    Ok(safe_path) => {
                        results.push(safe_path);
                        root_count += 1;
                        if root_count >= MAX_WORKSPACES {
                            log::warn!(
                                "[cowork-scan] reached {MAX_WORKSPACES} workspace limit for root {} — moving to next root",
                                root.display()
                            );
                            break 'ws_level;
                        }
                    }
                    Err(reason) => {
                        stats.rejected_by_guard += 1;
                        if stats.rejected_by_guard == 1 {
                            log::warn!(
                                "[cowork-scan] skipping {} — {reason}",
                                vm_path.display()
                            );
                        } else {
                            log::debug!(
                                "[cowork-scan] skipping {} — {reason}",
                                vm_path.display()
                            );
                        }
                    }
                }
            }
        }
    }

    if stats.rejected_by_shape > 0 {
        // One aggregate line per scan so a Claude session-dir layout change is
        // diagnosable from a single log line.
        log::info!(
            "[cowork-scan] {} candidate dir(s) rejected by shape guard",
            stats.rejected_by_shape
        );
    }
    log::info!(
        "[cowork-scan] found {} workspace(s) ({} blocked by path guard)",
        results.len(),
        stats.rejected_by_guard
    );
    (results, stats)
}

// ---------------------------------------------------------------------------
// Workspace shape filter
// ---------------------------------------------------------------------------

/// Structural UUID check: exactly 36 chars, hyphens at 8/13/18/23, ASCII hex
/// elsewhere, case-insensitive. Deliberately not the `uuid` crate — this is a
/// shape filter, not a parser.
fn is_uuid_like(name: &str) -> bool {
    let b = name.as_bytes();
    if b.len() != 36 {
        return false;
    }
    b.iter().enumerate().all(|(i, &c)| match i {
        8 | 13 | 18 | 23 => c == b'-',
        _ => c.is_ascii_hexdigit(),
    })
}

/// A vm-level dir qualifies as a Cowork workspace when both path components
/// are UUID-shaped (`<workspace-uuid>\<vm-uuid>` — the observed layout for
/// both MSIX and direct installs) OR it carries a `cowork_plugins` directory
/// (forward-compat escape hatch if a future Claude Desktop renames session
/// dirs; the marker branch can only widen the UUID branch, never narrow it).
///
/// Non-workspace siblings under the Roaming root — e.g.
/// `skills-plugin\<uuid>\<uuid>` — fail both branches and are skipped, which
/// prevents plugin-registry files from being written into them.
fn workspace_shape_ok(vm_path: &Path) -> bool {
    let vm_name = vm_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ws_name = vm_path
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    (is_uuid_like(&ws_name) && is_uuid_like(&vm_name))
        || vm_path.join("cowork_plugins").is_dir()
}

// ---------------------------------------------------------------------------
// Root directory discovery
// ---------------------------------------------------------------------------

/// Returns all `local-agent-mode-sessions\` directories on this machine.
///
/// Two production layouts (see [`roots_under`]) plus the
/// `TANDEM_COWORK_ROOT_OVERRIDE` environment variable for test fixtures: if
/// set, returns that path as the sole root (skipping discovery).
pub(crate) fn cowork_roots() -> Vec<PathBuf> {
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

    let packages_dir = dirs::data_local_dir().map(|d| d.join("Packages"));
    let roaming_config_dir = dirs::config_dir();
    if packages_dir.is_none() && roaming_config_dir.is_none() {
        log::warn!("[cowork-scan] cannot resolve %LOCALAPPDATA% or %APPDATA%");
    }
    roots_under(packages_dir.as_deref(), roaming_config_dir.as_deref())
}

/// Enumerate Claude session roots under the given base directories. Split from
/// [`cowork_roots`] so unit tests can exercise layout discovery against temp
/// dirs without env vars.
///
/// Two layouts:
/// - **MSIX (Microsoft Store):**
///   `<packages_dir>\<claude-package>\LocalCache\Roaming\Claude\local-agent-mode-sessions`
///   where `<claude-package>` is publisher-anchored (see
///   [`is_claude_package_name`]).
/// - **Direct installer:** `<roaming_config_dir>\Claude\local-agent-mode-sessions`.
///   `dirs::config_dir()` resolves `FOLDERID_RoamingAppData` via the Known
///   Folder API — note this ignores a modified `%APPDATA%` env var that an
///   Electron app would honor (rare divergence, documented in ADR).
///
/// Dedup is exact-alias-only (canonical path equality). The MSIX-virtualized
/// and real Roaming directories are *distinct* real directories by design
/// (MSIX virtualization is a filter-driver overlay, not a junction), so a
/// dual install legitimately yields two roots.
fn roots_under(packages_dir: Option<&Path>, roaming_config_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();

    if let Some(packages) = packages_dir {
        if packages.is_dir() {
            match std::fs::read_dir(packages) {
                Ok(entries) => {
                    for entry in entries.flatten() {
                        let name = entry.file_name();
                        let name_str = name.to_string_lossy();
                        if !is_claude_package_name(&name_str) {
                            continue;
                        }

                        let sessions_path = entry
                            .path()
                            .join("LocalCache")
                            .join("Roaming")
                            .join("Claude")
                            .join("local-agent-mode-sessions");

                        if sessions_path.is_dir() {
                            log::debug!(
                                "[cowork-scan] found MSIX sessions root: {}",
                                sessions_path.display()
                            );
                            roots.push(sessions_path);
                        }
                    }
                }
                Err(e) => {
                    log::warn!("[cowork-scan] cannot read Packages dir: {e}");
                }
            }
        }
    }

    if let Some(config) = roaming_config_dir {
        let sessions_path = config.join("Claude").join("local-agent-mode-sessions");
        if sessions_path.is_dir() {
            log::debug!(
                "[cowork-scan] found Roaming sessions root: {}",
                sessions_path.display()
            );
            roots.push(sessions_path);
        }
    }

    // Dedup by canonical path — exact aliases only (see doc comment).
    let mut seen: Vec<PathBuf> = Vec::new();
    roots.retain(|r| {
        let canon = std::fs::canonicalize(r).unwrap_or_else(|_| r.clone());
        if seen.contains(&canon) {
            false
        } else {
            seen.push(canon);
            true
        }
    });

    roots
}

/// Publisher-anchored MSIX package-name match.
///
/// `Claude_*` is the historical pattern; `AnthropicPBC.Claude*` covers the
/// `<Publisher>.<App>_<hash>` package-family naming. Deliberately NOT a bare
/// `contains("Claude")`: each `Packages\` subdir is an MSIX container owned by
/// (and readable to) that package's identity, so a foreign package named e.g.
/// `EvilCorp.TotallyClaude_x` could otherwise stage the inner sessions layout
/// inside its own container and receive Tandem's plugin-registry writes —
/// including the auth token — across the app-sandbox boundary.
///
/// [Unverified] the exact Store family name for Claude Desktop; if it differs,
/// Store installs stay undetected (no regression vs the old `Claude_*` glob)
/// and the fix is a one-line prefix addition here.
fn is_claude_package_name(name: &str) -> bool {
    name.starts_with("Claude_") || name.starts_with("AnthropicPBC.Claude")
}

/// Returns true when a Claude Desktop installation is detectable on this
/// machine even if no Cowork workspace exists yet. Existence checks only —
/// the config file is never read or parsed.
///
/// Signals (any suffices):
/// - `<roaming>\Claude\claude_desktop_config.json` (direct installer)
/// - `<packages>\<claude-package>\LocalCache\Roaming\Claude\claude_desktop_config.json`
///   (MSIX: `%APPDATA%` writes are virtualized into `LocalCache\Roaming`, so a
///   Store install that never ran Cowork has *only* this copy)
/// - any session root from [`roots_under`]
pub fn claude_desktop_detected() -> bool {
    // Test hook parity with cowork_roots(): under an override root, treat the
    // override's existence as the Claude-install signal.
    #[cfg(any(test, feature = "cowork-test-hooks"))]
    {
        if let Ok(override_root) = std::env::var("TANDEM_COWORK_ROOT_OVERRIDE") {
            return PathBuf::from(&override_root).is_dir();
        }
    }

    let roaming_config_dir = dirs::config_dir();
    if let Some(config) = &roaming_config_dir {
        if config
            .join("Claude")
            .join("claude_desktop_config.json")
            .is_file()
        {
            return true;
        }
    }

    let packages_dir = dirs::data_local_dir().map(|d| d.join("Packages"));
    if let Some(packages) = &packages_dir {
        if let Ok(entries) = std::fs::read_dir(packages) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if !is_claude_package_name(&name.to_string_lossy()) {
                    continue;
                }
                if entry
                    .path()
                    .join("LocalCache")
                    .join("Roaming")
                    .join("Claude")
                    .join("claude_desktop_config.json")
                    .is_file()
                {
                    return true;
                }
            }
        }
    }

    !roots_under(packages_dir.as_deref(), roaming_config_dir.as_deref()).is_empty()
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

    /// UUID-shaped fixture names matching the real Cowork session layout
    /// (`<workspace-uuid>\<vm-uuid>`), required by the shape guard.
    const WS_UUID: &str = "ff68c797-99aa-416c-9b7d-f21bceeddb8d";
    const VM_UUID: &str = "ca28ad17-dcdb-4ea1-8178-8a8861613939";
    const VM_UUID_2: &str = "0b30dd94-eb52-48e2-851c-025e7b9a45ad";

    #[test]
    fn test_is_uuid_like() {
        assert!(is_uuid_like(WS_UUID));
        assert!(is_uuid_like(&WS_UUID.to_uppercase()));
        // Wrong length.
        assert!(!is_uuid_like("ff68c797"));
        assert!(!is_uuid_like(""));
        // `local_<uuid>` prefix used at the *third* level must be rejected.
        assert!(!is_uuid_like("local_bac09b38-080d-4b88-be7f-48e15db575d8"));
        // Hyphens in the wrong spots.
        assert!(!is_uuid_like("ff68c797-99aa-416c-9b7d_f21bceeddb8d"));
        // Non-hex content.
        assert!(!is_uuid_like("zz68c797-99aa-416c-9b7d-f21bceeddb8d"));
        // Non-UUID dir names from the real Roaming root.
        assert!(!is_uuid_like("skills-plugin"));
    }

    #[test]
    fn test_is_claude_package_name() {
        assert!(is_claude_package_name("Claude_pzs8sxrjxfjjc"));
        assert!(is_claude_package_name("AnthropicPBC.Claude_8wekyb3d8bbwe"));
        // Foreign package containing "Claude" must NOT match (token would be
        // written into a foreign MSIX container).
        assert!(!is_claude_package_name("EvilCorp.TotallyClaude_x"));
        assert!(!is_claude_package_name("MyClaude_y"));
        assert!(!is_claude_package_name("Claude")); // no underscore suffix
    }

    #[test]
    fn test_shape_guard_rejects_non_workspace_siblings() {
        let _guard = crate::COWORK_ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join("tandem_cowork_shape_test");
        let _ = fs::remove_dir_all(&dir);
        // Real workspace: <uuid>\<uuid>.
        fs::create_dir_all(dir.join(WS_UUID).join(VM_UUID)).unwrap();
        // Non-workspace sibling mirroring the real Roaming layout.
        fs::create_dir_all(dir.join("skills-plugin").join(VM_UUID).join(WS_UUID)).unwrap();
        // UUID workspace with non-UUID vm level and no marker → rejected.
        fs::create_dir_all(dir.join(WS_UUID).join("not-a-uuid")).unwrap();

        std::env::set_var("TANDEM_COWORK_ROOT_OVERRIDE", dir.to_str().unwrap());
        let (results, stats) = find_cowork_workspaces_with_stats();
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(results.len(), 1, "expected only the <uuid>\\<uuid> dir: {results:?}");
        assert!(results[0].ends_with(VM_UUID), "got {results:?}");
        assert!(stats.rejected_by_shape >= 2, "shape rejections counted: {stats:?}");
        assert_eq!(stats.rejected_by_guard, 0, "no guard rejections expected: {stats:?}");
    }

    #[test]
    fn test_shape_guard_marker_accepts_non_uuid_dir() {
        // Forward-compat: a non-UUID-named dir carrying cowork_plugins is
        // accepted via the marker branch.
        let _guard = crate::COWORK_ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join("tandem_cowork_marker_test");
        let _ = fs::remove_dir_all(&dir);
        let vm = dir.join("renamed-ws").join("renamed-vm");
        fs::create_dir_all(vm.join("cowork_plugins")).unwrap();

        std::env::set_var("TANDEM_COWORK_ROOT_OVERRIDE", dir.to_str().unwrap());
        let results = find_cowork_workspaces();
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(results.len(), 1, "marker branch must accept: {results:?}");
    }

    #[test]
    fn test_roots_under_discovers_both_layouts() {
        // Pure fn — no env vars, no lock; unique temp dir for parallel safety.
        let base = std::env::temp_dir().join("tandem_cowork_roots_both_test");
        let _ = fs::remove_dir_all(&base);

        // MSIX layout.
        let packages = base.join("Packages");
        let msix_sessions = packages
            .join("AnthropicPBC.Claude_8wekyb3d8bbwe")
            .join("LocalCache")
            .join("Roaming")
            .join("Claude")
            .join("local-agent-mode-sessions");
        fs::create_dir_all(&msix_sessions).unwrap();
        // Foreign package with the same inner layout must be ignored.
        fs::create_dir_all(
            packages
                .join("EvilCorp.TotallyClaude_x")
                .join("LocalCache")
                .join("Roaming")
                .join("Claude")
                .join("local-agent-mode-sessions"),
        )
        .unwrap();

        // Direct-installer (Roaming) layout.
        let roaming = base.join("Roaming");
        let roaming_sessions = roaming.join("Claude").join("local-agent-mode-sessions");
        fs::create_dir_all(&roaming_sessions).unwrap();

        let roots = roots_under(Some(&packages), Some(&roaming));
        let _ = fs::remove_dir_all(&base);

        assert_eq!(roots.len(), 2, "expected MSIX + Roaming roots: {roots:?}");
        assert!(roots.iter().any(|r| r.starts_with(&packages)), "{roots:?}");
        assert!(roots.iter().any(|r| *r == roaming_sessions), "{roots:?}");
        assert!(
            !roots.iter().any(|r| r.to_string_lossy().contains("EvilCorp")),
            "foreign package must not contribute a root: {roots:?}"
        );
    }

    #[test]
    fn test_roots_under_roaming_only() {
        let base = std::env::temp_dir().join("tandem_cowork_roots_roaming_test");
        let _ = fs::remove_dir_all(&base);
        let roaming = base.join("Roaming");
        let sessions = roaming.join("Claude").join("local-agent-mode-sessions");
        fs::create_dir_all(&sessions).unwrap();

        // Packages dir absent entirely.
        let roots = roots_under(Some(&base.join("NoPackages")), Some(&roaming));
        let _ = fs::remove_dir_all(&base);

        assert_eq!(roots, vec![sessions]);
    }

    #[test]
    fn test_roots_under_none_found() {
        let base = std::env::temp_dir().join("tandem_cowork_roots_none_test");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("Roaming")).unwrap();
        let roots = roots_under(Some(&base.join("Packages")), Some(&base.join("Roaming")));
        let _ = fs::remove_dir_all(&base);
        assert!(roots.is_empty(), "{roots:?}");
    }

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
        let ws_dir = dir.join(WS_UUID).join(VM_UUID);
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
        let vm = dir.join(WS_UUID).join(VM_UUID);
        fs::create_dir_all(&vm).unwrap();

        std::env::set_var("TANDEM_COWORK_ROOT_OVERRIDE", dir.to_str().unwrap());
        let handles = scan_workspaces_with_handles();
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");

        assert_eq!(handles.len(), 1, "expected 1 handle, got {handles:?}");
        let token = &handles[0].token;

        // A valid token resolves to the canonical validated path.
        let resolved = resolve_handle(token).expect("valid token must resolve");
        assert!(resolved.ends_with(VM_UUID), "resolved {resolved:?}");

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
        fs::create_dir_all(dir.join(WS_UUID).join(VM_UUID)).unwrap();

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

    #[test]
    fn test_revalidate_rejects_deleted_workspace() {
        // Reject-on-missing: a workspace directory that existed at scan time but
        // was removed before the re-check must fail revalidation. This is the
        // branch the old "outside-root" test never exercised — a *missing* path
        // goes through the reparse-fail-closed / canonicalize-failure path, not
        // the containment check. The root stays intact so we test the workspace
        // swap specifically, not a vanished root.
        let _guard = crate::COWORK_ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join("tandem_cowork_reval_deleted_test");
        let _ = fs::remove_dir_all(&dir);
        let ws = dir.join("ws-del");
        let vm = ws.join("vm-del");
        fs::create_dir_all(&vm).unwrap();

        std::env::set_var("TANDEM_COWORK_ROOT_OVERRIDE", dir.to_str().unwrap());
        let canon_vm = std::fs::canonicalize(&vm).unwrap();
        // Delete the workspace AFTER capturing its canonical path (root intact).
        let _ = fs::remove_dir_all(&ws);
        let result = revalidate_resolved_path(&canon_vm);
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");
        let _ = fs::remove_dir_all(&dir);

        assert!(
            result.is_err(),
            "a workspace deleted after the scan must fail re-validation: {result:?}"
        );
    }

    #[test]
    fn test_resolve_then_revalidate_rejects_after_workspace_deleted() {
        // The literal #433 attack, end-to-end: mint a handle from a real scan,
        // then remove/swap the workspace before the install click. The in-memory
        // handle still resolves (the registry is unaffected by the fs change),
        // but the defense-in-depth re-check must reject the now-missing path so
        // no file I/O happens against a swapped/deleted directory.
        let _guard = crate::COWORK_ENV_LOCK.lock().unwrap();
        clear_snapshot_for_test();

        let dir = std::env::temp_dir().join("tandem_cowork_resolve_reval_test");
        let _ = fs::remove_dir_all(&dir);
        let ws = dir.join(WS_UUID);
        let vm = ws.join(VM_UUID_2);
        fs::create_dir_all(&vm).unwrap();

        std::env::set_var("TANDEM_COWORK_ROOT_OVERRIDE", dir.to_str().unwrap());
        let handles = scan_workspaces_with_handles();
        assert_eq!(handles.len(), 1, "expected 1 handle, got {handles:?}");
        let token = handles[0].token.clone();

        // Handle resolves (registry is in-memory, independent of the filesystem).
        let resolved = resolve_handle(&token).expect("token from this scan must resolve");

        // Swap: remove the workspace after the scan, before the re-check.
        let _ = fs::remove_dir_all(&ws);
        let result = revalidate_resolved_path(&resolved);

        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");
        clear_snapshot_for_test();
        let _ = fs::remove_dir_all(&dir);

        assert!(
            result.is_err(),
            "resolve → revalidate must reject a workspace deleted after the scan (the #433 TOCTOU defense): {result:?}"
        );
    }
}
