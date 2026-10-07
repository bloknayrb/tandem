//! Cowork workspace path discovery.
//!
//! Walks `<sessions-root>\<workspace-id>\<vm-id>\` under every Claude Desktop
//! sessions root (the MSIX `%LOCALAPPDATA%\Packages\<claude-package>\LocalCache\
//! Roaming\Claude\local-agent-mode-sessions` and the direct-install
//! `%APPDATA%\Claude\local-agent-mode-sessions`, see [`roots_under`]) and
//! returns the list of VM-level directories that are safe to write Cowork
//! plugin-registry files into.
//!
//! **Security invariant §3 — defense-in-depth path guard:**
//! Every candidate path goes through the five steps of [`check_path_safe`]
//! (in order):
//!   a0. Reject a UNC path by string, before any syscall touches it.
//!   a. Reject any path where any ancestor has the reparse-point attribute set
//!      (checked BEFORE canonicalize, which would resolve and hide them).
//!   b. `std::fs::canonicalize` on the candidate (safe: reparse points already rejected).
//!   c. Reject any path whose canonical form is a UNC path.
//!   d. Component-wise comparison (NOT string-prefix) against the canonical root.
//!
//! **Getting TO a candidate must not follow anything either (#2144).** The
//! guard runs on the vm dir, but the walk that finds the vm dir reads the
//! `Packages` tree, the sessions root, each workspace dir and each
//! `cowork_plugins` marker first, and `read_dir` / `is_dir` / `canonicalize`
//! all follow a junction planted at any of them. So every one of those levels
//! is inspected with [`probe`] (`symlink_metadata`, which does not follow the
//! FINAL component) before it is read, and multi-level paths are inspected one
//! component at a time by [`walk_below`], because `symlink_metadata` on an
//! assembled path traverses, and so follows, every middle component.
//!
//! **What is trusted:** the ancestors of the Known Folders
//! (`dirs::data_local_dir()`, `dirs::config_dir()`), as the CLI scrub trusts
//! the ancestors of its env dirs. The Known Folder itself is screened (a
//! same-user registry write can point it at a junction), and so is everything
//! below it. A relocated profile, where an ancestor is a junction, still has
//! every workspace refused at step (a) above.
//!
//! Paths that fail any check are skipped with a `WARN` log (the first per scan)
//! and counted in [`ScanStats::rejected_by_guard`]; the walker never surfaces
//! their failure to the caller as an error.

#![cfg(target_os = "windows")]

use std::collections::HashMap;
use std::fmt::Write as _;
use std::os::windows::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use rand::Rng;
use serde::Serialize;

/// Maximum number of workspaces processed in a single walk.
/// Logs a warning and stops if exceeded.
const MAX_WORKSPACES: usize = 100;

/// `FILE_ATTRIBUTE_REPARSE_POINT` — from the Windows API.
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

/// Does this metadata describe a reparse point (junction, symlink, or any
/// other tag)? The one spelling of the test every Cowork guard uses.
pub(crate) fn is_reparse(meta: &std::fs::Metadata) -> bool {
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

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
// the exact canonical `PathBuf` that passed the five-step guard during the
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
    // rand 0.9+: `thread_rng` is `rng`; `fill_bytes` lives on the `Rng` trait.
    rand::rng().fill_bytes(&mut bytes);
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

/// Re-run the five-step guard against a path resolved from a snapshot handle,
/// catching a directory swapped *after* the scan that produced the handle.
///
/// Recomputes the canonical scan root for `candidate` (so the containment check
/// has a fresh, validated root) and runs [`check_path_safe`]. Returns the
/// re-canonicalized path on success, or `Err` if no current root contains the
/// candidate or any guard layer rejects it. This is the final defense-in-depth
/// gate the IPC commands run immediately before any file I/O.
pub fn revalidate_resolved_path(candidate: &Path) -> Result<PathBuf, String> {
    revalidate_against(candidate, &cowork_roots())
}

/// [`revalidate_resolved_path`] against an explicit root set, split out so a
/// test can hand it a root the walk refused (the test override root in
/// [`cowork_roots`] is never walked).
fn revalidate_against(candidate: &Path, session_roots: &SessionRoots) -> Result<PathBuf, String> {
    // Capture the most specific `check_path_safe` rejection (reparse point in
    // chain / UNC / canonicalize-failed-on-deleted-dir / outside-root) so the
    // final error names *why* the post-scan re-check failed — load-bearing for
    // incident triage of a junction-swap or deleted-workspace attack, which is
    // exactly what this gate exists to catch. Without it every distinct
    // rejection collapses into one generic line.
    //
    // A sessions root swapped for a junction since the scan no longer reaches
    // this loop at all (#2144: `roots_under` refuses it), so its refusal is
    // carried in `refused` and reported here too. Without that the swap this
    // gate exists to catch would read as "no current root resolved".
    let mut reasons: Vec<String> = Vec::new();
    for root in &session_roots.roots {
        let canonical_root = match std::fs::canonicalize(root) {
            Ok(p) => p,
            Err(_) => continue,
        };
        match check_path_safe(candidate, &canonical_root) {
            Ok(safe) => return Ok(safe),
            Err(reason) => reasons.push(reason),
        }
    }
    reasons.extend(session_roots.refused.iter().cloned());
    Err(if reasons.is_empty() {
        format!(
            "resolved workspace path {} is no longer within a canonical Cowork root (no current root resolved)",
            candidate.display()
        )
    } else {
        format!(
            "resolved workspace path {} failed re-validation: {}",
            candidate.display(),
            reasons.join("; ")
        )
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
/// `rejected_by_guard` counts everything the scan refused to enter or use: a
/// sessions root, workspace dir, vm dir or `cowork_plugins` marker that is a
/// reparse point or cannot be inspected (#2144), and candidates that passed
/// the shape filter but failed the five-step guard (reparse point / UNC /
/// canonicalize / containment). A Known Folder on a UNC path is NOT counted:
/// the scan never looks at it, so it cannot say anything was found there.
/// Surfaced to the UI as `workspacesBlocked` so redirected or cloud-synced
/// AppData setups get honest messaging ("found but can't safely configure")
/// instead of a perpetual "no workspace yet".
///
/// `rejected_by_shape` counts expected non-workspace siblings and is log-only.
/// `skills-plugin\<uuid>` counts here only while it has no `cowork_plugins` dir
/// (see [`workspace_shape_ok`]).
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
    scan_session_roots(cowork_roots())
}

/// Count one refusal; the first per scan logs at WARN, the rest at debug
/// (avoids WARN-per-candidate-per-poll on redirected-AppData machines).
fn note_guard_rejection(stats: &mut ScanStats, detail: &str) {
    stats.rejected_by_guard += 1;
    if stats.rejected_by_guard == 1 {
        log::warn!("[cowork-scan] skipping {detail}");
    } else {
        log::debug!("[cowork-scan] skipping {detail}");
    }
}

/// [`probe`] `path`; a refusal (a reparse point, or an uninspectable path)
/// is counted as a guard rejection and returns `None`, so the caller skips it.
fn probe_or_note(path: &Path, stats: &mut ScanStats) -> Option<Probe> {
    let p = probe(path);
    match p.refusal(path) {
        Some(reason) => {
            note_guard_rejection(stats, &reason);
            None
        }
        None => Some(p),
    }
}

/// The walk behind [`find_cowork_workspaces_with_stats`], against an explicit
/// root set so tests can reach the refused-root accounting (the test override
/// root in [`cowork_roots`] is never walked).
fn scan_session_roots(session_roots: SessionRoots) -> (Vec<PathBuf>, ScanStats) {
    let SessionRoots { roots, refused } = session_roots;
    let mut stats = ScanStats::default();
    // Before the empty-roots return: a machine whose every root was refused is
    // exactly the case `rejected_by_guard` exists to report.
    for reason in &refused {
        note_guard_rejection(&mut stats, reason);
    }
    if roots.is_empty() {
        if refused.is_empty() {
            log::debug!("[cowork-scan] no Claude session roots found — Cowork not installed");
        }
        return (vec![], stats);
    }

    let mut results = Vec::new();

    for root in &roots {
        // Canonicalize the root for security comparisons. Safe to resolve now:
        // `roots_under` walked every component below the Known Folder without
        // following it.
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

            // (#2144) Inspect before reading: `read_dir` follows a junction
            // planted as the workspace dir, and the guard below only ever sees
            // the vm dirs it would list.
            let Some(ws_probe) = probe_or_note(&ws_path, &mut stats) else {
                continue;
            };
            if !matches!(ws_probe, Probe::Dir) {
                log::debug!("[cowork-scan] skipping {} — not a directory", ws_path.display());
                continue;
            }

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

                // (#2144) The vm dir and its marker are inspected without
                // following. The shape check used to call `is_dir()` on the
                // marker, which follows a junction planted as either one.
                let Some(vm_probe) = probe_or_note(&vm_path, &mut stats) else {
                    continue;
                };
                match vm_probe {
                    Probe::Dir => {}
                    Probe::Other => {
                        stats.rejected_by_shape += 1;
                        log::debug!("[cowork-scan] skipping {} — not a directory", vm_path.display());
                        continue;
                    }
                    _ => continue, // vanished since the listing
                }
                let marker = vm_path.join("cowork_plugins");
                let Some(marker_probe) = probe_or_note(&marker, &mut stats) else {
                    continue;
                };
                let has_marker = matches!(marker_probe, Probe::Dir);

                // Shape filter BEFORE the security guard: only dirs that look
                // like Cowork sessions are candidates. Rejections here are
                // expected (non-workspace siblings), not suspicious.
                if !workspace_shape_ok(&vm_path, has_marker) {
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
                        note_guard_rejection(
                            &mut stats,
                            &format!("{} — {reason}", vm_path.display()),
                        );
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
pub(crate) fn is_uuid_like(name: &str) -> bool {
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
/// A non-workspace sibling such as `skills-plugin\<uuid>` (at the
/// `<ws>\<vm>` level) fails the UUID branch, so it is skipped **only while it
/// has no `cowork_plugins` dir**. Measured 2026-10-05 on a past enabler's
/// machine: `skills-plugin\<uuid>\cowork_plugins` existed and held Tandem
/// entries, so the marker branch admits it. The CLI scrub
/// (`src/cli/uninstall-scrub.ts`) relies on reaching it for that reason (#2136).
///
/// `has_marker` is the caller's no-follow [`probe`] of `<vm>\cowork_plugins`,
/// never an `is_dir()` here: that followed a junction planted as the marker
/// (#2144). A marker that IS a reparse point never gets this far; the caller
/// refuses the vm outright.
fn workspace_shape_ok(vm_path: &Path, has_marker: bool) -> bool {
    let vm_name = vm_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ws_name = vm_path
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    (is_uuid_like(&ws_name) && is_uuid_like(&vm_name)) || has_marker
}

// ---------------------------------------------------------------------------
// No-follow inspection (#2144)
// ---------------------------------------------------------------------------

/// What sits at a path, read with `symlink_metadata`, which does not follow
/// the FINAL component. Anything with the reparse-point attribute is
/// `Reparse`, whatever its tag, the same test [`has_reparse_point_in_chain`]
/// applies.
#[derive(Debug)]
pub(crate) enum Probe {
    Absent,
    Dir,
    /// Exists, is not a directory, is not a reparse point.
    Other,
    Reparse,
    Unreadable(std::io::Error),
}

impl Probe {
    /// The refusal reason when this probe means "do not go further" (a
    /// reparse point, or something that cannot be inspected, which fails
    /// closed). `None` for the three benign answers.
    pub(crate) fn refusal(&self, path: &Path) -> Option<String> {
        match self {
            Probe::Reparse => Some(format!("{} — reparse point", path.display())),
            Probe::Unreadable(e) => Some(format!("{} — cannot inspect: {e}", path.display())),
            Probe::Absent | Probe::Dir | Probe::Other => None,
        }
    }
}

pub(crate) fn probe(path: &Path) -> Probe {
    match std::fs::symlink_metadata(path) {
        Ok(m) if is_reparse(&m) => Probe::Reparse,
        Ok(m) if m.is_dir() => Probe::Dir,
        Ok(_) => Probe::Other,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Probe::Absent,
        Err(e) => Probe::Unreadable(e),
    }
}

/// Outcome of [`walk_below`].
#[derive(Debug)]
pub(crate) enum Walk {
    /// Every component from `base` down is a plain directory.
    Safe,
    /// Some component is missing (or is a file): nothing is there.
    Absent,
    /// A component is a reparse point or cannot be inspected.
    Refused(String),
    /// `base` or `path` is a UNC path: refused by string, never touched, so
    /// nothing can be said about what is there.
    Unc,
}

/// Inspect `base` and every component of `path` below it, shallowest first,
/// without following any of them.
///
/// `symlink_metadata` declines to follow only the final component, so an
/// inspection of the assembled `path` would traverse (and follow) every middle
/// one. Probing one component at a time means each call traverses only
/// components already shown to be plain directories. `base` itself is probed
/// too: it is a Known Folder, which a same-user registry write can point at a
/// junction; only its ancestors are trusted.
///
/// Callers pass `path` built by `join`ing names onto `base`, so `strip_prefix`
/// holds; a path that is not under `base` is refused rather than half-walked.
pub(crate) fn walk_below(base: &Path, path: &Path) -> Walk {
    // Before any syscall, as `check_path_safe`'s step (a0) — see there for why.
    if is_unc_path(base) || is_unc_path(path) {
        return Walk::Unc;
    }
    let Ok(rest) = path.strip_prefix(base) else {
        return Walk::Refused(format!(
            "{} is not under {}",
            path.display(),
            base.display()
        ));
    };
    let mut current = base.to_path_buf();
    let mut components = rest.components();
    loop {
        let p = probe(&current);
        if let Some(reason) = p.refusal(&current) {
            return Walk::Refused(reason);
        }
        if !matches!(p, Probe::Dir) {
            return Walk::Absent;
        }
        match components.next() {
            None => return Walk::Safe,
            Some(Component::Normal(name)) => current.push(name),
            Some(other) => {
                return Walk::Refused(format!(
                    "unexpected component {other:?} in {}",
                    path.display()
                ))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Root directory discovery
// ---------------------------------------------------------------------------

/// Returns all `local-agent-mode-sessions\` directories on this machine.
///
/// Two production layouts (see [`roots_under`]) plus the
/// `TANDEM_COWORK_ROOT_OVERRIDE` environment variable for test fixtures: if
/// set, returns that path as the sole root (skipping discovery).
pub(crate) fn cowork_roots() -> SessionRoots {
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
                return SessionRoots {
                    roots: vec![p],
                    refused: vec![],
                };
            } else {
                log::debug!(
                    "[cowork-scan] TANDEM_COWORK_ROOT_OVERRIDE={override_root} is not a dir — returning empty"
                );
                return SessionRoots::default();
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
///
/// **No level is entered before it is inspected (#2144).** `Packages` is
/// walked before it is listed and each assembled sessions path is walked
/// component by component ([`walk_below`]), where this used `is_dir()`, which
/// follows a junction at any of them. A refused level is reported in
/// [`SessionRoots::refused`] rather than dropped silently.
///
/// `tests/build/cowork-scan-alignment.test.ts` parses this body: it counts
/// exactly two `roots` pushes and reads every literal `join` argument in
/// order. Keep both shapes (and name no other vec here `…roots`).
fn roots_under(packages_dir: Option<&Path>, roaming_config_dir: Option<&Path>) -> SessionRoots {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut refused: Vec<String> = Vec::new();

    if let Some(packages) = packages_dir {
        let local_app_data = packages.parent().unwrap_or(packages);
        if admit(walk_below(local_app_data, packages), &mut refused) {
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

                        if admit(walk_below(packages, &sessions_path), &mut refused) {
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
        if admit(walk_below(config, &sessions_path), &mut refused) {
            log::debug!(
                "[cowork-scan] found Roaming sessions root: {}",
                sessions_path.display()
            );
            roots.push(sessions_path);
        }
    }

    // Dedup by canonical path — exact aliases only (see doc comment). Safe to
    // resolve now: every root here was walked without following anything.
    let mut seen: Vec<PathBuf> = Vec::new();
    roots.retain(|r| {
        let canon = std::fs::canonicalize(r).unwrap_or_else(|_| {
            // Degraded dedup: fall back to the raw path as the dedup key. Logged
            // so a "duplicate workspace rows" investigation has a breadcrumb.
            log::debug!(
                "[cowork-scan] dedup: canonicalize failed for {} — using raw path as key",
                r.display()
            );
            r.clone()
        });
        if seen.contains(&canon) {
            false
        } else {
            seen.push(canon);
            true
        }
    });

    SessionRoots { roots, refused }
}

/// The sessions roots found, plus why any candidate root was refused.
#[derive(Debug, Default)]
pub(crate) struct SessionRoots {
    pub(crate) roots: Vec<PathBuf>,
    /// One reason per root the walk refused (a reparse point or an
    /// uninspectable level below a Known Folder). A UNC Known Folder is not
    /// here: it was never looked at.
    pub(crate) refused: Vec<String>,
}

/// `true` when `walk` reached a plain directory; records a refusal. Debug
/// level only: this runs several times per status poll, and the scan reports
/// each refusal once at WARN through [`note_guard_rejection`].
fn admit(walk: Walk, refused: &mut Vec<String>) -> bool {
    match walk {
        Walk::Safe => true,
        Walk::Absent => false,
        Walk::Unc => {
            log::debug!("[cowork-scan] not entering a UNC Known Folder");
            false
        }
        Walk::Refused(reason) => {
            log::debug!("[cowork-scan] refusing sessions root: {reason}");
            refused.push(reason);
            false
        }
    }
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
/// Verified 2026-06: the real Store package family name is
/// `Claude_pzs8sxrjxfjjc` (the app is registered as bare "Claude"), so
/// `Claude_*` matches today's Store installs. The `AnthropicPBC.Claude`
/// prefix is future-proofing in case the package is ever re-published under
/// a publisher-qualified name.
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

    let packages_dir = dirs::data_local_dir().map(|d| d.join("Packages"));
    let roaming_config_dir = dirs::config_dir();
    claude_desktop_detected_under(packages_dir.as_deref(), roaming_config_dir.as_deref())
}

/// Three-signal OR for a detectable Claude Desktop install, against injectable
/// base directories (mirrors [`roots_under`] so tests exercise each signal
/// against temp dirs without env vars). `packages_dir` must already include the
/// `Packages` suffix — the caller passes `data_local_dir().join("Packages")`.
///
/// Inspected without following, like the scan (#2144). A level the walk
/// REFUSES counts as detected: something Claude-shaped is there that Tandem
/// will not enter, which is what the UI's "blocked" copy describes (it needs
/// this to be true to show). A UNC Known Folder counts as nothing, because it
/// is never looked at.
fn claude_desktop_detected_under(
    packages_dir: Option<&Path>,
    roaming_config_dir: Option<&Path>,
) -> bool {
    // Signal 1: direct-installer roaming config.
    if let Some(config) = roaming_config_dir {
        if config_signal(config, &config.join("Claude")) != Signal::Absent {
            return true;
        }
    }

    // Signal 2: MSIX-virtualized config under a publisher-anchored package.
    if let Some(packages) = packages_dir {
        match walk_below(packages.parent().unwrap_or(packages), packages) {
            Walk::Safe => {
                if let Ok(entries) = std::fs::read_dir(packages) {
                    for entry in entries.flatten() {
                        let name = entry.file_name();
                        if !is_claude_package_name(&name.to_string_lossy()) {
                            continue;
                        }
                        let claude_dir = entry.path().join("LocalCache").join("Roaming").join("Claude");
                        if config_signal(packages, &claude_dir) != Signal::Absent {
                            return true;
                        }
                    }
                }
            }
            Walk::Refused(_) => return true,
            Walk::Absent | Walk::Unc => {}
        }
    }

    // Signal 3: any session root, or one refused.
    let session_roots = roots_under(packages_dir, roaming_config_dir);
    !session_roots.roots.is_empty() || !session_roots.refused.is_empty()
}

/// One config-file detection signal.
#[derive(Debug, PartialEq, Eq)]
enum Signal {
    Present,
    Absent,
    Refused,
}

/// Is there a `claude_desktop_config.json` in `claude_dir`? Walks to
/// `claude_dir` from `base` without following, then inspects the file without
/// opening it. A symlinked config counts as present: detection needs to know
/// it exists, not what it points at.
fn config_signal(base: &Path, claude_dir: &Path) -> Signal {
    match walk_below(base, claude_dir) {
        Walk::Safe => {}
        Walk::Refused(_) => return Signal::Refused,
        Walk::Absent | Walk::Unc => return Signal::Absent,
    }
    match probe(&claude_dir.join("claude_desktop_config.json")) {
        Probe::Other | Probe::Reparse => Signal::Present,
        Probe::Unreadable(_) => Signal::Refused,
        Probe::Dir | Probe::Absent => Signal::Absent,
    }
}

// ---------------------------------------------------------------------------
// Security guard
// ---------------------------------------------------------------------------

/// Apply the five-step path security guard (invariant §3).
///
/// Returns the canonicalized path on success, or a human-readable rejection
/// reason string on failure.
///
/// **(a0) is the #1417 fix.** The UNC check used to live only at (c), testing
/// `canonical` — the *output* of `canonicalize` — so `symlink_metadata` and
/// `canonicalize` both touched the raw candidate first. Why that is dangerous
/// is stated once in `src/shared/windows-path-safety.ts`. What is specific here
/// is that the comment on (a) ordered the *junction* threat correctly and the
/// *UNC* threat backwards: for a junction the danger is what the path resolves
/// to, so the lstat walk must precede `canonicalize`; for UNC the danger is the
/// syscall itself. Both are satisfiable — a string test goes first, and (c)
/// stays because a junction can still resolve *to* a UNC path.
///
/// Exact twin of `src/cli/win-path-guard.ts`; keep the two in step.
pub(crate) fn check_path_safe(candidate: &Path, canonical_root: &Path) -> Result<PathBuf, String> {
    // (a0) Reject UNC on the RAW candidate, before any syscall touches it.
    if is_unc_path(candidate) {
        return Err(format!(
            "UNC path rejected before any filesystem call: {}",
            candidate.display()
        ));
    }

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

/// Returns true if `path` is UNC or otherwise unsafe to hand to a syscall.
///
/// **Allowlist, not blacklist** — the twin of `isUncPath` in
/// `src/cli/win-path-guard.ts`, and for the same reason. Every `\\`-rooted
/// path is unsafe except one shape: the extended-length LOCAL drive path
/// `\\?\C:\…` that Tauri's path APIs return on Windows, which this guard
/// permits on purpose and then confines by canonicalized containment.
///
/// The previous version enumerated the bad forms, and let three through:
/// `//server/share` and every other forward-slash form, which
/// `starts_with(r"\\")` never sees at all; `\\?\unc\server\share`, because
/// Windows prefixes are case-insensitive and the literal `UNC` was not; and
/// `\\?\GLOBALROOT\Device\Mup\server\share`, which reaches SMB by another
/// route. All three are covered here for free, because the allowlist has to
/// *match* `\\?\<drive>:\` rather than fail to match a bypass — a distinction
/// with no tail of undiscovered forms.
fn is_unc_path(path: &Path) -> bool {
    // Normalising separators first means the mixed spellings (`\/server\share`)
    // fall out uniformly instead of depending on which prefix arm matched, and
    // it removes the byte indices a reader would otherwise have to count.
    let s = path.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
    if !s.starts_with(r"\\") {
        return false;
    }
    !s.strip_prefix(r"\\?\").is_some_and(|rest| {
        let mut c = rest.chars();
        matches!(
            (c.next(), c.next(), c.next()),
            (Some(drive), Some(':'), Some('\\')) if drive.is_ascii_lowercase()
        )
    })
}

/// Returns true if any component in the path chain (from root to candidate)
/// has the `FILE_ATTRIBUTE_REPARSE_POINT` bit set.
///
/// Fails closed: if `symlink_metadata` returns an error, returns `true` (reject)
/// rather than `false` (allow). This prevents a metadata failure from silently
/// bypassing the reparse-point guard.
///
/// **Walks shallowest-first — root down to the candidate.** Ascending inspected
/// the deepest component first, so a symlinked *parent* was only noticed after
/// its children had already been touched; descending rejects it before that.
///
/// **This ordering does nothing for UNC, and `check_path_safe` step (a0) is the
/// only thing that does.** `ancestors()` bottoms out at the path *prefix*, so
/// for `\\server\share\a\b` the shallowest entry it yields is `\\server\share`
/// itself — and `symlink_metadata` on that performs the very SMB handshake the
/// guard exists to prevent. (a0) is load-bearing, not defence in depth; do not
/// delete it on the strength of this walk.
fn has_reparse_point_in_chain(path: &Path) -> bool {
    // `ancestors()` yields the path itself, then each parent up to the root.
    // `Ancestors` is not a DoubleEndedIterator, so collecting is what buys the
    // root-first order.
    for entry in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        match std::fs::symlink_metadata(entry) {
            Ok(metadata) => {
                if is_reparse(&metadata) {
                    return true;
                }
            }
            Err(_) => return true, // Can't inspect — reject for safety.
        }
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

/// Real reparse-point fixtures for the Cowork modules' #2144 tests.
#[cfg(test)]
pub(crate) mod test_fs {
    use std::fs;
    use std::path::{Path, PathBuf};

    /// A fresh scratch dir whose links are removed as links (`remove_dir` /
    /// `remove_file`) before the tree is deleted, so cleanup never depends on
    /// how `remove_dir_all` treats a reparse point.
    pub(crate) struct Scratch {
        pub(crate) dir: PathBuf,
        links: Vec<PathBuf>,
    }

    impl Scratch {
        pub(crate) fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "tandem_2144_{name}_{}",
                crate::cowork_atomic_json::unique_suffix()
            ));
            fs::create_dir_all(&dir).unwrap();
            Scratch {
                dir,
                links: Vec::new(),
            }
        }

        pub(crate) fn junction(&mut self, link: &Path, target: &Path) {
            junction(link, target);
            self.links.push(link.to_path_buf());
        }

        pub(crate) fn file_symlink(&mut self, link: &Path, target: &Path) {
            file_symlink(link, target);
            self.links.push(link.to_path_buf());
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            for link in &self.links {
                let _ = fs::remove_dir(link).or_else(|_| fs::remove_file(link));
            }
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    /// `link` becomes a directory junction to `target`, which need not exist.
    /// `mklink /J` needs no privilege, so this runs on any Windows machine and
    /// on the windows `rust-test` leg.
    pub(crate) fn junction(link: &Path, target: &Path) {
        let out = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("spawn cmd for mklink /J");
        assert!(
            out.status.success(),
            "mklink /J {link:?} {target:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(
            matches!(super::probe(link), super::Probe::Reparse),
            "fixture {link:?} is not a reparse point"
        );
    }

    /// `link` becomes a FILE symlink to `target`, which need not exist. This
    /// needs `SeCreateSymbolicLinkPrivilege` (an elevated shell, which the
    /// windows CI runner is, or Developer Mode). It panics rather than
    /// skipping without it, so a machine that cannot run the row fails it
    /// instead of reporting a pass (`docs/gotchas.md`, `cargo test` setup).
    pub(crate) fn file_symlink(link: &Path, target: &Path) {
        std::os::windows::fs::symlink_file(target, link).unwrap_or_else(|e| {
            panic!(
                "cannot create a file symlink ({e}); these #2144 rows need Developer Mode or an \
                 elevated shell — enable Developer Mode rather than skipping them"
            )
        });
    }
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

    /// #1417 §1C. The UNC check used to run only at step (c), on the OUTPUT of
    /// `canonicalize` — so `symlink_metadata` and `canonicalize` both touched
    /// the raw candidate first, and on Windows each performs the SMB handshake
    /// that leaks an NTLM hash. Step (a0) is a pure string test that runs before
    /// any syscall, and the error text is what distinguishes the two paths: a
    /// candidate rejected at (a0) never reached the filesystem, whereas
    /// "canonicalize failed" means it did.
    #[test]
    fn check_path_safe_rejects_unc_before_touching_the_filesystem() {
        let root = std::env::temp_dir();
        for candidate in [
            r"\\attacker\share\ws\vm",
            r"\\?\UNC\attacker\share\ws",
            // The three the enumerate-the-bad-forms check let through.
            "//attacker/share/ws/vm",
            r"\\?\unc\attacker\share\ws",
            r"\\?\GLOBALROOT\Device\Mup\attacker\share",
        ] {
            let err = check_path_safe(Path::new(candidate), &root)
                .expect_err("UNC candidate must be refused");
            assert!(
                err.contains("before any filesystem call"),
                "expected the pre-syscall rejection for {candidate}, got: {err}"
            );
        }
    }

    /// The extended-length LOCAL prefix stays permitted — containment under the
    /// canonical root is what confines it, and Tauri's path APIs hand it back.
    /// It must fall through (a0) to the filesystem steps rather than be refused
    /// outright, so the rejection it eventually earns is a different one.
    #[test]
    fn check_path_safe_still_admits_extended_length_local_paths_to_the_fs_steps() {
        let root = std::env::temp_dir();
        let err = check_path_safe(Path::new(r"\\?\C:\definitely\not\here"), &root)
            .expect_err("nonexistent path must still be refused");
        assert!(
            !err.contains("before any filesystem call"),
            "extended-length local prefix must not be rejected by (a0), got: {err}"
        );
    }

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

        let found = roots_under(Some(&packages), Some(&roaming));
        let _ = fs::remove_dir_all(&base);

        // Positive control for the #2144 walk: a clean tree refuses nothing.
        assert!(found.refused.is_empty(), "{found:?}");
        let roots = found.roots;
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
        let found = roots_under(Some(&base.join("NoPackages")), Some(&roaming));
        let _ = fs::remove_dir_all(&base);

        assert!(found.refused.is_empty(), "absent is not refused: {found:?}");
        assert_eq!(found.roots, vec![sessions]);
    }

    #[test]
    fn test_roots_under_none_found() {
        let base = std::env::temp_dir().join("tandem_cowork_roots_none_test");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("Roaming")).unwrap();
        let found = roots_under(Some(&base.join("Packages")), Some(&base.join("Roaming")));
        let _ = fs::remove_dir_all(&base);
        assert!(found.roots.is_empty(), "{found:?}");
        assert!(found.refused.is_empty(), "{found:?}");
    }

    #[test]
    fn test_claude_desktop_detected_under_signals() {
        // Pure fn — no env vars, no lock; unique temp dir for parallel safety.
        let base = std::env::temp_dir().join("tandem_cdd_under_test");
        let _ = fs::remove_dir_all(&base);
        let packages = base.join("Packages");
        let roaming = base.join("Roaming");
        fs::create_dir_all(&packages).unwrap();
        fs::create_dir_all(&roaming).unwrap();

        // Nothing present → false.
        assert!(!claude_desktop_detected_under(Some(&packages), Some(&roaming)));

        // Signal 1: direct-installer roaming config.
        let roaming_claude = roaming.join("Claude");
        fs::create_dir_all(&roaming_claude).unwrap();
        let cfg = roaming_claude.join("claude_desktop_config.json");
        fs::write(&cfg, "{}").unwrap();
        assert!(claude_desktop_detected_under(Some(&packages), Some(&roaming)));
        fs::remove_file(&cfg).unwrap();
        assert!(!claude_desktop_detected_under(Some(&packages), Some(&roaming)));

        // Signal 2: MSIX-virtualized config under a publisher-anchored package.
        let msix_claude = packages
            .join("AnthropicPBC.Claude_8wekyb3d8bbwe")
            .join("LocalCache")
            .join("Roaming")
            .join("Claude");
        fs::create_dir_all(&msix_claude).unwrap();
        fs::write(msix_claude.join("claude_desktop_config.json"), "{}").unwrap();
        assert!(claude_desktop_detected_under(Some(&packages), Some(&roaming)));

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn test_claude_desktop_detected_under_ignores_foreign_package() {
        let base = std::env::temp_dir().join("tandem_cdd_foreign_test");
        let _ = fs::remove_dir_all(&base);
        let packages = base.join("Packages");
        // A foreign package staging the inner config layout must NOT signal
        // detection (publisher anchor, not contains("Claude")).
        let foreign = packages
            .join("EvilCorp.TotallyClaude_x")
            .join("LocalCache")
            .join("Roaming")
            .join("Claude");
        fs::create_dir_all(&foreign).unwrap();
        fs::write(foreign.join("claude_desktop_config.json"), "{}").unwrap();
        let roaming = base.join("Roaming");
        fs::create_dir_all(&roaming).unwrap();

        let detected = claude_desktop_detected_under(Some(&packages), Some(&roaming));
        let _ = fs::remove_dir_all(&base);
        assert!(!detected, "foreign package must not signal Claude detected");
    }

    #[test]
    fn test_is_unc_path() {
        for unsafe_path in [
            r"\\?\UNC\server\share",
            r"\\server\share",
            // Forward-slash forms: `starts_with(r"\\")` alone never saw these.
            "//server/share",
            "//?/UNC/server/share",
            // Windows prefixes are case-insensitive; a literal `UNC` was not.
            r"\\?\unc\server\share",
            r"\\?\Unc\server\share",
            // Other routes to SMB under the same `\\?\` namespace.
            r"\\?\GLOBALROOT\Device\Mup\server\share",
            r"\\.\UNC\server\share",
            "//./unc/server/share",
            // Mixed separators. Windows treats `/` and `\` as interchangeable,
            // so these are UNC too — the normalization above handles them, and
            // these rows are what pin the claim its docblock makes. Both TS
            // predicates were missing this and it was a two-character bypass.
            r"/\server\share",
            r"\/server/share",
        ] {
            assert!(
                is_unc_path(Path::new(unsafe_path)),
                "must reject {unsafe_path}"
            );
        }

        // The one permitted `\\`-rooted shape, plus ordinary local paths. The
        // allowlist must not be narrower than what Windows and Tauri produce.
        for safe_path in [
            r"\\?\C:\Users\foo",
            r"\\?\c:\Users\foo",
            // A non-C drive, so narrowing the drive test to a literal `c`
            // would not pass this table.
            r"\\?\D:\Data\x",
            "//?/C:/Users/foo",
            r"C:\Users\foo",
            "/home/foo",
        ] {
            assert!(
                !is_unc_path(Path::new(safe_path)),
                "must permit {safe_path}"
            );
        }
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

    // -----------------------------------------------------------------------
    // #2144: nothing on the way to a candidate is followed
    // -----------------------------------------------------------------------
    //
    // Real junctions, made with `mklink /J`, which needs no privilege. Each
    // test names what the pre-#2144 code did with the same fixture, so the
    // assertion is one the old code fails. What these cannot show is that no
    // syscall reached a junction's target; that rests on source order.

    use super::test_fs::Scratch;

    fn only_root(root: PathBuf) -> SessionRoots {
        SessionRoots {
            roots: vec![root],
            refused: vec![],
        }
    }

    #[test]
    fn a_junction_planted_as_a_workspace_dir_is_refused_not_listed() {
        let mut s = Scratch::new("ws_junction");
        let root = s.dir.join("sessions");
        fs::create_dir_all(&root).unwrap();
        let (link, target) = (root.join(WS_UUID), s.dir.join("nowhere"));
        s.junction(&link, &target);

        let (results, stats) = scan_session_roots(only_root(root));

        assert!(results.is_empty(), "{results:?}");
        // Old: `read_dir` followed the dangling junction, failed, and counted nothing.
        assert_eq!(stats.rejected_by_guard, 1, "{stats:?}");
    }

    #[test]
    fn a_junction_planted_as_a_vm_dir_is_a_guard_rejection_not_a_shape_one() {
        let mut s = Scratch::new("vm_junction");
        let root = s.dir.join("sessions");
        let ws = root.join(WS_UUID);
        fs::create_dir_all(&ws).unwrap();
        let target = s.dir.join("target");
        fs::create_dir_all(&target).unwrap();
        s.junction(&ws.join("renamed-vm"), &target);

        let (results, stats) = scan_session_roots(only_root(root));

        assert!(results.is_empty(), "{results:?}");
        // Old: the marker `is_dir()` followed the junction, found no
        // `cowork_plugins` in its target, and counted a SHAPE rejection.
        assert_eq!(stats.rejected_by_guard, 1, "{stats:?}");
        assert_eq!(stats.rejected_by_shape, 0, "{stats:?}");
    }

    #[test]
    fn a_junction_planted_as_cowork_plugins_refuses_the_workspace() {
        let mut s = Scratch::new("marker_junction");
        let root = s.dir.join("sessions");
        let vm = root.join(WS_UUID).join(VM_UUID);
        fs::create_dir_all(&vm).unwrap();
        let target = s.dir.join("elsewhere");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("installed_plugins.json"), "{}").unwrap();
        s.junction(&vm.join("cowork_plugins"), &target);

        let (results, stats) = scan_session_roots(only_root(root));

        // Old: the UUID pair passed the shape check without looking at the
        // marker, `check_path_safe` never inspects it, and the vm was returned
        // for every writer to follow into the junction.
        assert!(results.is_empty(), "{results:?}");
        assert_eq!(stats.rejected_by_guard, 1, "{stats:?}");
    }

    #[test]
    fn a_junction_at_a_middle_component_of_the_msix_root_is_refused() {
        let mut s = Scratch::new("localcache_junction");
        let packages = s.dir.join("Packages");
        let pkg = packages.join("Claude_pzs8sxrjxfjjc");
        fs::create_dir_all(&pkg).unwrap();
        let real = s.dir.join("real-localcache");
        fs::create_dir_all(real.join("Roaming").join("Claude").join("local-agent-mode-sessions")).unwrap();
        let link = pkg.join("LocalCache");
        s.junction(&link, &real);

        // The measurement this walk exists for: inspecting the ASSEMBLED path
        // traverses the middle junction and reports a plain directory, so a
        // final-component check alone (what `is_dir()` callers would reach
        // for) sees nothing wrong.
        let assembled = link.join("Roaming").join("Claude").join("local-agent-mode-sessions");
        let m = fs::symlink_metadata(&assembled).expect("lstat traverses the middle junction");
        assert!(m.is_dir() && !is_reparse(&m));

        let found = roots_under(Some(&packages), None);

        // Old: `is_dir()` followed it and the root was returned.
        assert!(found.roots.is_empty(), "{found:?}");
        assert_eq!(found.refused.len(), 1, "{found:?}");
        assert!(found.refused[0].contains("LocalCache"), "{found:?}");
    }

    #[test]
    fn a_junction_planted_as_the_sessions_root_is_refused() {
        let mut s = Scratch::new("sessions_junction");
        let roaming = s.dir.join("Roaming");
        fs::create_dir_all(roaming.join("Claude")).unwrap();
        let real = s.dir.join("real-sessions");
        fs::create_dir_all(real.join(WS_UUID).join(VM_UUID)).unwrap();
        s.junction(&roaming.join("Claude").join("local-agent-mode-sessions"), &real);

        let found = roots_under(None, Some(&roaming));

        assert!(found.roots.is_empty(), "old code returned it: {found:?}");
        assert_eq!(found.refused.len(), 1, "{found:?}");
    }

    #[test]
    fn a_known_folder_that_is_itself_a_junction_is_refused() {
        // A same-user registry write can point a Known Folder at a junction;
        // only its ancestors are trusted.
        let mut s = Scratch::new("base_junction");
        let real = s.dir.join("real-roaming");
        fs::create_dir_all(real.join("Claude").join("local-agent-mode-sessions")).unwrap();
        let roaming = s.dir.join("Roaming");
        s.junction(&roaming, &real);

        let found = roots_under(None, Some(&roaming));

        assert!(found.roots.is_empty(), "{found:?}");
        assert_eq!(found.refused.len(), 1, "{found:?}");
    }

    #[test]
    fn a_junction_planted_as_the_claude_dir_refuses_the_config_signal() {
        let mut s = Scratch::new("claude_dir_junction");
        let roaming = s.dir.join("Roaming");
        fs::create_dir_all(&roaming).unwrap();
        let real = s.dir.join("real-claude");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("claude_desktop_config.json"), "{}").unwrap();
        s.junction(&roaming.join("Claude"), &real);

        // Old: `is_file()` on the joined path followed it, i.e. `Present`.
        assert_eq!(config_signal(&roaming, &roaming.join("Claude")), Signal::Refused);
    }

    #[test]
    fn a_junction_planted_as_packages_is_not_listed_and_reads_as_detected() {
        let mut s = Scratch::new("packages_junction");
        let local = s.dir.join("Local");
        fs::create_dir_all(&local).unwrap();
        let real = s.dir.join("real-packages");
        // A Claude package with no config and no sessions: read through, it
        // says nothing is installed.
        fs::create_dir_all(real.join("Claude_pzs8sxrjxfjjc").join("LocalCache")).unwrap();
        let packages = local.join("Packages");
        s.junction(&packages, &real);

        assert!(matches!(walk_below(&local, &packages), Walk::Refused(_)));
        // Old: `read_dir` followed it, found neither config nor sessions, and
        // said "not detected". A refusal is reported, so the UI can say why.
        assert!(claude_desktop_detected_under(Some(&packages), None));
    }

    #[test]
    fn a_unc_known_folder_is_never_entered_and_claims_nothing() {
        for candidate in [
            r"\\attacker\share\Roaming",
            r"\\?\UNC\attacker\share\Roaming",
            "//attacker/share/Roaming",
            r"\\?\unc\attacker\share\Roaming",
            r"\\?\GLOBALROOT\Device\Mup\attacker\share",
        ] {
            let base = Path::new(candidate);
            assert!(
                matches!(walk_below(base, &base.join("Claude")), Walk::Unc),
                "{candidate} must be refused by string"
            );
            assert_eq!(config_signal(base, &base.join("Claude")), Signal::Absent, "{candidate}");
            let found = roots_under(None, Some(base));
            assert!(found.roots.is_empty() && found.refused.is_empty(), "{candidate}: {found:?}");
        }
        // The extended-length LOCAL form reaches the filesystem steps.
        let local = Path::new(r"\\?\C:\definitely\not\here");
        assert!(matches!(walk_below(local, &local.join("x")), Walk::Absent));
    }

    #[test]
    fn refused_roots_count_as_guard_rejections_even_when_no_root_survives() {
        let (results, stats) = scan_session_roots(SessionRoots {
            roots: vec![],
            refused: vec![r"C:\x\local-agent-mode-sessions — reparse point".to_string()],
        });
        assert!(results.is_empty());
        // Counted before the empty-roots return, or `workspacesBlocked` reads 0.
        assert_eq!(stats.rejected_by_guard, 1, "{stats:?}");
    }

    #[test]
    fn revalidation_names_a_refused_root_instead_of_no_root() {
        let reason = r"C:\x\local-agent-mode-sessions — reparse point";
        let err = revalidate_against(
            Path::new(r"C:\x\local-agent-mode-sessions\ws\vm"),
            &SessionRoots {
                roots: vec![],
                refused: vec![reason.to_string()],
            },
        )
        .expect_err("no root, so no candidate can pass");
        assert!(err.contains(reason), "got: {err}");
    }
}
