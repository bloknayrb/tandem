//! Cowork per-workspace plugin installer.
//!
//! Reads and modifies three Cowork registry JSON files inside each workspace's
//! VM directory using the atomic lock-read-modify-write primitive from
//! `cowork_atomic_json`.
//!
//! **ADR-023 override:** writes stdio entries (`npx -y tandem-editor mcp-stdio`),
//! NOT HTTP entries.  The authority cowork spec's HTTP shape surfaces zero tools.
//!
//! **Token handling:** the auth token is NEVER logged.  It is passed as a function
//! argument, written to JSON, and never surfaced in any log call.

#![cfg(target_os = "windows")]

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::cowork_atomic_json::{with_locked_json, CoworkError};
use crate::cowork_meta::CoworkMeta;
use crate::cowork_workspace_scan::find_cowork_workspaces;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Primary hostname for reaching the host from inside the Cowork Hyper-V VM.
/// The LAN-IP fallback is stored in cowork_meta.json and used when
/// `use_lan_ip_override` is true.
const DEFAULT_TANDEM_URL: &str = "http://host.docker.internal:3479";

/// Plugin ID used throughout — must be unique within Cowork's marketplace.
const TANDEM_PLUGIN_ID: &str = "tandem";

/// Marketplace entry identifier: `<plugin-id>@<marketplace-id>`.
const TANDEM_ENABLED_KEY: &str = "tandem@tandem";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/// Status of a single JSON file write during a workspace install/uninstall pass.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum WriteStatus {
    /// Write succeeded.
    Ok,
    /// Tandem entry already present with identical content — no write needed.
    AlreadyPresent,
    /// File was locked and the lock timeout expired.
    Locked,
    /// The file's JSON structure did not match the expected schema.
    SchemaDrift,
    /// The parent directory ACL indicates an insecure write target.
    InsecureAcl,
    /// Write failed for a reason captured in the message.
    Failed(String),
}

/// Per-workspace result of an install or uninstall pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWriteReport {
    /// The workspace ID component of the path (parent directory of `vm_id`).
    pub workspace_id: String,
    /// The VM ID component of the path (leaf directory scanned).
    pub vm_id: String,
    /// Result for `installed_plugins.json`.
    pub installed_plugins: WriteStatus,
    /// Result for `known_marketplaces.json`.
    pub known_marketplaces: WriteStatus,
    /// Result for `cowork_settings.json`.
    pub cowork_settings: WriteStatus,
}

// ---------------------------------------------------------------------------
// ACL guard (heuristic — full DACL inspection deferred to v0.8.1)
// ---------------------------------------------------------------------------

/// Heuristic ACL check for a workspace path.
///
/// Returns `CoworkError::InsecureAcl` when the path's canonical form is
/// outside every allowed root (indicating a redirected or OneDrive-synced
/// path that could be world-readable). Allowed roots:
///
/// 1. `%LOCALAPPDATA%` — covers the MSIX `Packages\…\LocalCache\Roaming`
///    layout (historical behavior).
/// 2. `<config_dir>\Claude\local-agent-mode-sessions` — the direct-installer
///    Cowork sessions dir, and ONLY that subtree, NOT all of Roaming.
///    Token-confidentiality note: Tandem already writes the same bearer token
///    into Roaming via `claude_desktop_config.json` (integration wizard), so
///    this allowance adds no new exposure class; roaming-profile sync of the
///    token is pre-existing, documented behavior. See `warn_if_roaming`.
///
/// TODO(v0.8.1): Replace with full DACL inspection via
/// `GetFileSecurityW` / `GetEffectiveRightsFromAcl` from `windows-sys`.
fn check_acl(path: &Path) -> Result<(), CoworkError> {
    // Honour the test override root: if the path is within the override, skip
    // the %LOCALAPPDATA% check (tests use std::env::temp_dir()).
    // Gated so production binaries cannot be redirected by env var.
    #[cfg(any(test, feature = "cowork-test-hooks"))]
    {
        if let Ok(override_root) = std::env::var("TANDEM_COWORK_ROOT_OVERRIDE") {
            let override_path = PathBuf::from(&override_root);
            if let (Ok(canon_override), Ok(canon_path)) =
                (std::fs::canonicalize(&override_path), std::fs::canonicalize(path))
            {
                if canon_path.starts_with(&canon_override) {
                    return Ok(());
                }
            }
        }
    }

    // Allowed root candidates (see doc comment).
    let allowed_roots: Vec<PathBuf> = [
        dirs::data_local_dir(),
        dirs::config_dir().map(|c| c.join("Claude").join("local-agent-mode-sessions")),
    ]
    .into_iter()
    .flatten()
    .collect();

    check_acl_against(path, &allowed_roots)
}

/// Core ACL containment check against an explicit allowed-root set.
///
/// Split out of [`check_acl`] so tests inject `TempDir` roots instead of
/// mutating the developer's real `%APPDATA%\Claude` tree.
///
/// Fails closed: a candidate that is not a strict child of any *resolvable*
/// allowed root is rejected with `InsecureAcl`. The single fail-open is a
/// candidate that does not exist on disk yet (`NotFound` — a brand-new
/// workspace dir is legitimately fine to allow); all other candidate-side I/O
/// errors propagate as `IoError` so callers can distinguish a security
/// rejection from a transient failure.
///
/// Safety of the fail-closed change: every production caller runs
/// `cowork_workspace_scan::revalidate_resolved_path` *before* this, which
/// already canonicalizes the candidate's ancestor chain (including
/// `%LOCALAPPDATA%`). The only way *every* allowed root fails to canonicalize
/// is if `%LOCALAPPDATA%` itself is unresolvable — in which case a token write
/// there is impossible anyway. So the dropped optimistic allow cannot reject a
/// legitimate workspace.
fn check_acl_against(path: &Path, allowed_roots: &[PathBuf]) -> Result<(), CoworkError> {
    let canonical_path = match std::fs::canonicalize(path) {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };

    for root in allowed_roots {
        if let Ok(canonical_root) = std::fs::canonicalize(root) {
            if is_strict_component_child(&canonical_path, &canonical_root) {
                return Ok(());
            }
        }
    }

    log::warn!(
        "[cowork-install] InsecureAcl: {} is outside all allowed roots (%LOCALAPPDATA% + Roaming Claude sessions dir)",
        path.display()
    );
    Err(CoworkError::InsecureAcl {
        path: path.to_path_buf(),
    })
}

/// Component-wise "child is strictly under root" check (string-prefix checks
/// are banned — they break on sibling names sharing a prefix).
fn is_strict_component_child(child: &Path, root: &Path) -> bool {
    let root_components: Vec<_> = root.components().collect();
    let child_components: Vec<_> = child.components().collect();
    child_components.len() > root_components.len()
        && root_components.iter().zip(child_components.iter()).all(|(r, c)| r == c)
}

/// Check whether the canonical path contains "OneDrive" and log a one-time warning.
fn warn_if_onedrive(path: &Path) {
    let s = path.to_string_lossy();
    if s.contains("OneDrive") {
        log::warn!(
            "[cowork-install] WARNING: workspace path {} is inside a OneDrive-synced folder. \
             Auth tokens will be uploaded to Microsoft cloud storage.",
            path.display()
        );
    }
}

/// Warn when the workspace sits under Roaming AppData: roaming user profiles
/// sync `%APPDATA%` to the domain file server at logoff, so the auth token in
/// `installed_plugins.json` may leave the machine. Mirrors `warn_if_onedrive`;
/// same exposure class as the wizard's `claude_desktop_config.json` write.
fn warn_if_roaming(path: &Path) {
    if let Some(config) = dirs::config_dir() {
        if let (Ok(canonical_path), Ok(canonical_config)) =
            (std::fs::canonicalize(path), std::fs::canonicalize(&config))
        {
            if is_strict_component_child(&canonical_path, &canonical_config) {
                log::warn!(
                    "[cowork-install] note: workspace path {} is under Roaming AppData; \
                     roaming user profiles will sync the auth token to the profile server.",
                    path.display()
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Registry inspection / heal-pass support
// ---------------------------------------------------------------------------

/// Read-only check: does this workspace's `installed_plugins.json` already
/// contain the Tandem entry? Shared by `cowork_get_status` and the heal pass.
///
/// Three on-disk states are distinguished by logging (the file holds the bearer
/// token, so only the PATH and the error are ever logged — never the contents):
/// - absent (`NotFound`) → `false`, silent (the expected "not configured yet").
/// - present-but-unreadable / malformed → `false`, logged at WARN so a
///   debugging session sees the breadcrumb instead of a silent "no entry".
/// - present with the entry → `true`.
///
/// Token-safety: `serde_json::Error`'s Display is `"... at line L column C"` and
/// does NOT embed the source snippet (unlike V8's `JSON.parse`), so logging the
/// error is wire-safe.
pub(crate) fn workspace_has_tandem_entry(ws_path: &Path) -> bool {
    let path = ws_path.join("cowork_plugins").join("installed_plugins.json");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return false,
        Err(e) => {
            log::warn!(
                "[cowork] could not read {} ({e}) — treating as not configured",
                path.display()
            );
            return false;
        }
    };
    match serde_json::from_str::<Value>(&content) {
        Ok(json) => json
            .get("mcpServers")
            .and_then(|s| s.get(TANDEM_PLUGIN_ID))
            .is_some(),
        Err(e) => {
            log::warn!(
                "[cowork] malformed JSON in {} ({e}) — treating as not configured",
                path.display()
            );
            false
        }
    }
}

/// Whether a heal-pass install outcome is *terminal* — i.e. the background heal
/// pass should NOT retry this workspace on the next tick.
///
/// Terminal: `Ok` / `AlreadyPresent` (success) and `InsecureAcl` (a structurally
/// redirected/synced path that will never become a safe write target). Retryable
/// (NOT terminal): `Locked` / `SchemaDrift` / `Failed` and any error — these are
/// usually transient (lock contention, momentary I/O), so leaving them out of the
/// attempted set lets a later tick self-heal. A genuinely persistent non-ACL
/// failure re-attempts every interval and logs each time; this is low-harm
/// (idempotent write, 5-min cadence) and keeps a real problem visible.
pub(crate) fn heal_outcome_is_terminal(status: &WriteStatus) -> bool {
    matches!(
        status,
        WriteStatus::Ok | WriteStatus::AlreadyPresent | WriteStatus::InsecureAcl
    )
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/// Install the Tandem plugin entry into all three Cowork registry files for a
/// single workspace VM directory.
///
/// # Preconditions
/// - `ws_path` has already been validated by the path-traversal guard in
///   `cowork_workspace_scan::check_path_safe()`.
/// - `token` is NEVER logged; call sites must not log it either.
pub fn install_tandem_plugin_into_workspace(
    ws_path: &Path,
    token: &str,
    tandem_url: &str,
) -> Result<WorkspaceWriteReport, CoworkError> {
    let workspace_id = parent_component(ws_path);
    let vm_id = leaf_component(ws_path);

    // Write-time revalidation (#433 defense, applied to ALL write paths — not
    // just the handle-based install): re-run the four-layer path guard
    // immediately before any file I/O so a directory swapped for a junction
    // after the scan cannot receive the token.
    let ws_path = match crate::cowork_workspace_scan::revalidate_resolved_path(ws_path) {
        Ok(p) => p,
        Err(reason) => {
            log::warn!("[cowork-install] write-time revalidation failed: {reason}");
            let failed = WriteStatus::Failed(format!("revalidation failed: {reason}"));
            return Ok(WorkspaceWriteReport {
                workspace_id,
                vm_id,
                installed_plugins: failed.clone(),
                known_marketplaces: failed.clone(),
                cowork_settings: failed,
            });
        }
    };
    let ws_path = ws_path.as_path();

    warn_if_onedrive(ws_path);
    warn_if_roaming(ws_path);

    // ACL check before any write.
    let acl_result = check_acl(ws_path);

    // Create the cowork_plugins subdirectory only after ACL check passes.
    // Creating the dir before we know the ACL is safe leaves a directory behind
    // even when the write is rejected.
    let plugins_dir = ws_path.join("cowork_plugins");
    if acl_result.is_ok() {
        std::fs::create_dir_all(&plugins_dir).map_err(|e| {
            log::warn!("[cowork-install] mkdir cowork_plugins failed: {e}");
            CoworkError::from(e)
        })?;
    }

    let installed_status = match &acl_result {
        Ok(()) => {
            let path = plugins_dir.join("installed_plugins.json");
            // Token must not appear in any log — pass it via closure capture only.
            let token_owned = token.to_string();
            let tandem_url_owned = tandem_url.to_string();
            write_status_from(with_locked_json(&path, move |json| {
                merge_installed_plugins(json, &token_owned, &tandem_url_owned)
            }))
        }
        Err(CoworkError::InsecureAcl { .. }) => {
            log::warn!("[cowork-install] InsecureAcl for installed_plugins.json");
            WriteStatus::InsecureAcl
        }
        Err(e) => {
            log::warn!("[cowork-install] I/O error checking ACL for installed_plugins.json: {e}");
            WriteStatus::Failed(e.to_string())
        }
    };

    let known_status = match &acl_result {
        Ok(()) => {
            let path = plugins_dir.join("known_marketplaces.json");
            write_status_from(with_locked_json(&path, merge_known_marketplaces))
        }
        Err(CoworkError::InsecureAcl { .. }) => WriteStatus::InsecureAcl,
        Err(e) => WriteStatus::Failed(e.to_string()),
    };

    let settings_status = match &acl_result {
        Ok(()) => {
            let path = plugins_dir.join("cowork_settings.json");
            write_status_from(with_locked_json(&path, merge_cowork_settings))
        }
        Err(CoworkError::InsecureAcl { .. }) => WriteStatus::InsecureAcl,
        Err(e) => WriteStatus::Failed(e.to_string()),
    };

    Ok(WorkspaceWriteReport {
        workspace_id,
        vm_id,
        installed_plugins: installed_status,
        known_marketplaces: known_status,
        cowork_settings: settings_status,
    })
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

/// Remove the Tandem plugin entry from all three Cowork registry files for a
/// single workspace VM directory.
///
/// Leaves all other plugin entries (context7, Anthropic's own) intact.
pub fn uninstall_tandem_plugin_from_workspace(
    ws_path: &Path,
) -> Result<WorkspaceWriteReport, CoworkError> {
    let workspace_id = parent_component(ws_path);
    let vm_id = leaf_component(ws_path);

    // Write-time revalidation — same #433 defense as install (uninstall also
    // rewrites the three registry JSON files).
    let ws_path = match crate::cowork_workspace_scan::revalidate_resolved_path(ws_path) {
        Ok(p) => p,
        Err(reason) => {
            log::warn!("[cowork-install] write-time revalidation failed: {reason}");
            let failed = WriteStatus::Failed(format!("revalidation failed: {reason}"));
            return Ok(WorkspaceWriteReport {
                workspace_id,
                vm_id,
                installed_plugins: failed.clone(),
                known_marketplaces: failed.clone(),
                cowork_settings: failed,
            });
        }
    };
    let ws_path = ws_path.as_path();

    let plugins_dir = ws_path.join("cowork_plugins");

    let installed_status = {
        let path = plugins_dir.join("installed_plugins.json");
        if !path.exists() {
            WriteStatus::AlreadyPresent // nothing to remove
        } else {
            write_status_from(with_locked_json(&path, remove_installed_plugins))
        }
    };

    let known_status = {
        let path = plugins_dir.join("known_marketplaces.json");
        if !path.exists() {
            WriteStatus::AlreadyPresent
        } else {
            write_status_from(with_locked_json(&path, remove_known_marketplaces))
        }
    };

    let settings_status = {
        let path = plugins_dir.join("cowork_settings.json");
        if !path.exists() {
            WriteStatus::AlreadyPresent
        } else {
            write_status_from(with_locked_json(&path, remove_cowork_settings))
        }
    };

    Ok(WorkspaceWriteReport {
        workspace_id,
        vm_id,
        installed_plugins: installed_status,
        known_marketplaces: known_status,
        cowork_settings: settings_status,
    })
}

// ---------------------------------------------------------------------------
// Token rotation
// ---------------------------------------------------------------------------

/// Re-walk all workspaces and update `env.TANDEM_AUTH_TOKEN` in each
/// `installed_plugins.json` entry.
///
/// Used by `tandem rotate-token` after a successful rotation so that
/// post-rotation Cowork sessions use the new token (security invariant §6).
///
/// Token is NEVER logged.
pub fn apply_token_to_all_workspaces(token: &str) -> Vec<WorkspaceWriteReport> {
    let workspaces = find_cowork_workspaces();
    log::info!(
        "[cowork-install] apply_token_to_all_workspaces: {} workspace(s)",
        workspaces.len()
    );

    workspaces
        .iter()
        .map(|ws_path| {
            let workspace_id = parent_component(ws_path);
            let vm_id = leaf_component(ws_path);

            // Write-time revalidation (#433): re-run the four-layer path guard
            // immediately before the token rewrite so a dir swapped for a
            // junction after the scan cannot receive the rotated token.
            let ws_path = match crate::cowork_workspace_scan::revalidate_resolved_path(ws_path) {
                Ok(p) => p,
                Err(reason) => {
                    log::warn!("[cowork-install] apply_token: revalidation failed: {reason}");
                    return WorkspaceWriteReport {
                        workspace_id,
                        vm_id,
                        installed_plugins: WriteStatus::Failed(format!(
                            "revalidation failed: {reason}"
                        )),
                        known_marketplaces: WriteStatus::AlreadyPresent,
                        cowork_settings: WriteStatus::AlreadyPresent,
                    };
                }
            };
            let plugins_dir = ws_path.join("cowork_plugins");
            let path = plugins_dir.join("installed_plugins.json");

            let installed_status = if !path.exists() {
                WriteStatus::AlreadyPresent // no entry to update
            } else {
                let token_owned = token.to_string();
                write_status_from(with_locked_json(&path, move |json| {
                    update_token_in_installed_plugins(json, &token_owned)
                }))
            };

            WorkspaceWriteReport {
                workspace_id,
                vm_id,
                installed_plugins: installed_status,
                known_marketplaces: WriteStatus::AlreadyPresent,
                cowork_settings: WriteStatus::AlreadyPresent,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Orphan reconciliation
// ---------------------------------------------------------------------------

/// Remove orphan `"Tandem Cowork*"` firewall rules left by a previous failed
/// uninstall (security invariant §12). Returns the names of rules removed, or an
/// empty vec on scan/remove failure.
///
/// **Ordering contract (issue #1163):** on the enable path this MUST run *before*
/// `firewall::add_cowork_allow_rule`. `scan_orphan_rules` matches by the name
/// prefix `"Tandem Cowork"`, which is identical to the allow rule's own name, so
/// it cannot distinguish a freshly-added rule from a true orphan — reconciling
/// *after* the add would scan the just-added rule as an orphan and delete it,
/// leaving every enable with no allow rule. The stale-token half of the old
/// combined reconcile is split into [`reconcile_stale_workspace_tokens`], which
/// runs *after* a successful add so a fail-closed firewall add never reaches a
/// workspace write (invariant §4).
pub fn reconcile_orphan_firewall_rules() -> Vec<String> {
    use crate::firewall;

    let orphan_rules = match firewall::scan_orphan_rules() {
        Ok(rules) => rules,
        Err(e) => {
            // Warn (not silent) so callers know the scan was inconclusive rather
            // than treating a failed scan as "no orphans".
            log::warn!(
                "[cowork-install] reconcile: orphan rule scan failed ({e}) — skipping rule removal"
            );
            return vec![];
        }
    };

    if orphan_rules.is_empty() {
        return vec![];
    }

    log::warn!(
        "[cowork-install] reconcile: found {} orphan firewall rule(s): {:?}",
        orphan_rules.len(),
        orphan_rules
    );
    if let Err(e) = firewall::remove_cowork_rules() {
        log::warn!("[cowork-install] reconcile: failed to remove orphan rules: {e}");
        return vec![];
    }
    orphan_rules
}

/// Rewrite workspace plugin entries whose `env.TANDEM_AUTH_TOKEN` does not match
/// the current token (security invariant §12). Returns the paths rewritten.
///
/// **Ordering contract (§4):** on the enable path this MUST run *after* a
/// successful `firewall::add_cowork_allow_rule`. A fail-closed firewall add must
/// not be followed by any workspace write, so this is intentionally split from
/// [`reconcile_orphan_firewall_rules`] (which runs before the add).
pub fn reconcile_stale_workspace_tokens(workspaces: &[PathBuf], current_token: &str) -> Vec<String> {
    let mut rewritten = Vec::new();
    for ws_path in workspaces {
        // Write-time revalidation (#433): re-run the four-layer path guard
        // before the per-workspace token rewrite. Per this function's ordering
        // contract (§4), the caller has already run orphan firewall-rule cleanup
        // and a successful firewall add before reaching here.
        let ws_path = match crate::cowork_workspace_scan::revalidate_resolved_path(ws_path) {
            Ok(p) => p,
            Err(reason) => {
                log::warn!(
                    "[cowork-install] reconcile: revalidation failed for {} ({reason}) — skipping",
                    ws_path.display()
                );
                continue;
            }
        };
        let plugins_dir = ws_path.join("cowork_plugins");
        let path = plugins_dir.join("installed_plugins.json");
        if !path.exists() {
            continue;
        }

        // Check if the token is stale without modifying the file.
        let needs_update = match std::fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str::<Value>(&content) {
                Ok(json) => {
                    let stored = json
                        .get("mcpServers")
                        .and_then(|s| s.get(TANDEM_PLUGIN_ID))
                        .and_then(|e| e.get("env"))
                        .and_then(|e| e.get("TANDEM_AUTH_TOKEN"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("");
                    stored != current_token
                }
                Err(e) => {
                    log::warn!(
                        "[cowork-install] reconcile: corrupt JSON in {} ({e}) — forcing rewrite",
                        path.display()
                    );
                    true // locked writer's schema guard will surface drift safely
                }
            },
            Err(e) => {
                log::warn!(
                    "[cowork-install] reconcile: cannot read {} ({e}) — skipping",
                    path.display()
                );
                false // can't read means can't write safely
            }
        };

        if needs_update {
            let token_owned = current_token.to_string();
            match with_locked_json(&path, move |json| {
                update_token_in_installed_plugins(json, &token_owned)
            }) {
                Ok(WriteStatus::Ok) => {
                    rewritten.push(path.to_string_lossy().into_owned());
                }
                other => {
                    log::warn!(
                        "[cowork-install] reconcile: failed to rewrite token in {}: {:?}",
                        path.display(),
                        other
                    );
                }
            }
        }
    }

    rewritten
}

// ---------------------------------------------------------------------------
// JSON mutation helpers — installed_plugins.json
// ---------------------------------------------------------------------------

/// Merge the Tandem stdio entry into `installed_plugins.json`.
///
/// Expects top-level structure: `{ "mcpServers": { ... } }`.
/// Raises `SchemaDriftSuspected` if the structure differs.
/// Returns `AlreadyPresent` if the entry exists and is byte-identical.
fn merge_installed_plugins(
    json: &mut Value,
    token: &str,
    tandem_url: &str,
) -> Result<WriteStatus, CoworkError> {
    let obj = json.as_object_mut().ok_or_else(|| CoworkError::SchemaDriftSuspected {
        file: PathBuf::from("installed_plugins.json"),
        detail: "expected top-level object".into(),
    })?;

    // Discover the server-map key: prefer "mcpServers", fall back to "servers".
    // Any other shape triggers SchemaDriftSuspected.
    let server_key = if obj.contains_key("mcpServers") {
        "mcpServers"
    } else if obj.contains_key("servers") {
        "servers"
    } else if obj.is_empty() {
        // Fresh empty file — create with "mcpServers".
        "mcpServers"
    } else {
        return Err(CoworkError::SchemaDriftSuspected {
            file: PathBuf::from("installed_plugins.json"),
            detail: format!(
                "expected 'mcpServers' or 'servers' key, found keys: {:?}",
                obj.keys().collect::<Vec<_>>()
            ),
        });
    };

    let servers = obj
        .entry(server_key)
        .or_insert_with(|| json!({}));

    let servers_map = servers.as_object_mut().ok_or_else(|| CoworkError::SchemaDriftSuspected {
        file: PathBuf::from("installed_plugins.json"),
        detail: format!("'{server_key}' is not an object"),
    })?;

    // Build the desired entry — token is captured in the value, never in a log.
    // Pin the npx spec to this build's exact version so `npm exec` fetches the
    // correct `tandem-editor` inside the Cowork guest instead of reusing a
    // stale global copy that predates the `mcp-stdio` subcommand. CARGO_PKG_VERSION
    // tracks package.json today (release bumps both); the drift guard in
    // tests/plugin/plugin-version-pin.test.ts fails CI if they diverge.
    let editor_spec = format!("tandem-editor@{}", env!("CARGO_PKG_VERSION"));
    let desired = json!({
        "type": "stdio",
        "command": "npx",
        "args": ["-y", editor_spec, "mcp-stdio"],
        "env": {
            "TANDEM_AUTH_TOKEN": token,
            "TANDEM_URL": tandem_url
        }
    });

    if let Some(existing) = servers_map.get(TANDEM_PLUGIN_ID) {
        if existing == &desired {
            return Ok(WriteStatus::AlreadyPresent);
        }
    }

    servers_map.insert(TANDEM_PLUGIN_ID.to_string(), desired);
    Ok(WriteStatus::Ok)
}

/// Remove the Tandem entry from `installed_plugins.json`.
fn remove_installed_plugins(json: &mut Value) -> Result<WriteStatus, CoworkError> {
    let obj = json.as_object_mut().ok_or_else(|| CoworkError::SchemaDriftSuspected {
        file: PathBuf::from("installed_plugins.json"),
        detail: "expected top-level object".into(),
    })?;

    let mut removed = false;
    for key in ["mcpServers", "servers"] {
        if let Some(servers) = obj.get_mut(key).and_then(|v| v.as_object_mut()) {
            if servers.remove(TANDEM_PLUGIN_ID).is_some() {
                removed = true;
            }
        }
    }

    Ok(if removed {
        WriteStatus::Ok
    } else {
        WriteStatus::AlreadyPresent
    })
}

/// Update `env.TANDEM_AUTH_TOKEN` in the existing Tandem entry.
/// Token is never logged — it's written directly to JSON.
fn update_token_in_installed_plugins(
    json: &mut Value,
    token: &str,
) -> Result<WriteStatus, CoworkError> {
    for key in ["mcpServers", "servers"] {
        if let Some(entry) = json
            .get_mut(key)
            .and_then(|s| s.get_mut(TANDEM_PLUGIN_ID))
            .and_then(|e| e.get_mut("env"))
            .and_then(|e| e.as_object_mut())
        {
            entry.insert(
                "TANDEM_AUTH_TOKEN".to_string(),
                Value::String(token.to_string()),
            );
            return Ok(WriteStatus::Ok);
        }
    }
    // Entry not found — nothing to update.
    Ok(WriteStatus::AlreadyPresent)
}

// ---------------------------------------------------------------------------
// JSON mutation helpers — known_marketplaces.json
// ---------------------------------------------------------------------------

/// Merge the Tandem marketplace entry into `known_marketplaces.json`.
fn merge_known_marketplaces(json: &mut Value) -> Result<WriteStatus, CoworkError> {
    let obj = json.as_object_mut().ok_or_else(|| CoworkError::SchemaDriftSuspected {
        file: PathBuf::from("known_marketplaces.json"),
        detail: "expected top-level object".into(),
    })?;

    let marketplaces = obj
        .entry("marketplaces")
        .or_insert_with(|| json!({}));

    let mp_map = marketplaces.as_object_mut().ok_or_else(|| CoworkError::SchemaDriftSuspected {
        file: PathBuf::from("known_marketplaces.json"),
        detail: "'marketplaces' is not an object".into(),
    })?;

    let desired = json!({
        "id": TANDEM_PLUGIN_ID,
        "name": "Tandem",
        "description": "Collaborative AI-human document editor",
        "url": "https://github.com/bloknayrb/tandem"
    });

    if let Some(existing) = mp_map.get(TANDEM_PLUGIN_ID) {
        if existing == &desired {
            return Ok(WriteStatus::AlreadyPresent);
        }
    }

    mp_map.insert(TANDEM_PLUGIN_ID.to_string(), desired);
    Ok(WriteStatus::Ok)
}

/// Remove the Tandem marketplace entry from `known_marketplaces.json`.
fn remove_known_marketplaces(json: &mut Value) -> Result<WriteStatus, CoworkError> {
    let removed = json
        .get_mut("marketplaces")
        .and_then(|m| m.as_object_mut())
        .and_then(|m| m.remove(TANDEM_PLUGIN_ID))
        .is_some();
    Ok(if removed { WriteStatus::Ok } else { WriteStatus::AlreadyPresent })
}

// ---------------------------------------------------------------------------
// JSON mutation helpers — cowork_settings.json
// ---------------------------------------------------------------------------

/// Add `tandem@tandem` to `enabledPlugins` in `cowork_settings.json`.
fn merge_cowork_settings(json: &mut Value) -> Result<WriteStatus, CoworkError> {
    let obj = json.as_object_mut().ok_or_else(|| CoworkError::SchemaDriftSuspected {
        file: PathBuf::from("cowork_settings.json"),
        detail: "expected top-level object".into(),
    })?;

    let enabled = obj
        .entry("enabledPlugins")
        .or_insert_with(|| json!([]));

    // enabledPlugins may be an array or an object (map).
    if let Some(arr) = enabled.as_array_mut() {
        let already = arr.iter().any(|v| v.as_str() == Some(TANDEM_ENABLED_KEY));
        if already {
            return Ok(WriteStatus::AlreadyPresent);
        }
        arr.push(Value::String(TANDEM_ENABLED_KEY.to_string()));
        return Ok(WriteStatus::Ok);
    }

    if let Some(map) = enabled.as_object_mut() {
        if map.contains_key(TANDEM_ENABLED_KEY) {
            return Ok(WriteStatus::AlreadyPresent);
        }
        map.insert(TANDEM_ENABLED_KEY.to_string(), Value::Bool(true));
        return Ok(WriteStatus::Ok);
    }

    Err(CoworkError::SchemaDriftSuspected {
        file: PathBuf::from("cowork_settings.json"),
        detail: "'enabledPlugins' is neither an array nor an object".into(),
    })
}

/// Remove `tandem@tandem` from `enabledPlugins`.
fn remove_cowork_settings(json: &mut Value) -> Result<WriteStatus, CoworkError> {
    if let Some(arr) = json
        .get_mut("enabledPlugins")
        .and_then(|v| v.as_array_mut())
    {
        let before = arr.len();
        arr.retain(|v| v.as_str() != Some(TANDEM_ENABLED_KEY));
        return Ok(if arr.len() < before {
            WriteStatus::Ok
        } else {
            WriteStatus::AlreadyPresent
        });
    }

    if let Some(map) = json
        .get_mut("enabledPlugins")
        .and_then(|v| v.as_object_mut())
    {
        let removed = map.remove(TANDEM_ENABLED_KEY).is_some();
        return Ok(if removed { WriteStatus::Ok } else { WriteStatus::AlreadyPresent });
    }

    Ok(WriteStatus::AlreadyPresent)
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/// Convert a `CoworkError` to a `WriteStatus`.
fn write_status_from(result: Result<WriteStatus, CoworkError>) -> WriteStatus {
    match result {
        Ok(s) => s,
        Err(CoworkError::LockTimeout { .. }) => WriteStatus::Locked,
        Err(CoworkError::SchemaDriftSuspected { .. }) => WriteStatus::SchemaDrift,
        Err(CoworkError::InsecureAcl { .. }) => WriteStatus::InsecureAcl,
        Err(e) => WriteStatus::Failed(e.to_string()),
    }
}

/// Extract the leaf directory name as a string.
fn leaf_component(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Extract the parent directory's leaf name (one level above `path`).
fn parent_component(path: &Path) -> String {
    leaf_component(path.parent().unwrap_or(path))
}

/// Resolve the TANDEM_URL to write into `env.TANDEM_URL` for a workspace.
///
/// Returns `http://<lan_ip_fallback>:3479` when `use_lan_ip_override` is true
/// AND a LAN-IP fallback is populated; otherwise returns `DEFAULT_TANDEM_URL`
/// (`http://host.docker.internal:3479`).
pub fn resolve_tandem_url(meta: &CoworkMeta) -> String {
    if meta.use_lan_ip_override {
        if let Some(ip) = meta.lan_ip_fallback.as_deref() {
            return format!("http://{ip}:3479");
        }
    }
    DEFAULT_TANDEM_URL.to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Acquire the process-wide env lock, create a temp workspace dir, and set
    /// the override.  Returns the guard, the TempDir (must stay alive), and the
    /// ws path.  The guard serializes all tests in this module AND
    /// `cowork_workspace_scan` tests against the shared `TANDEM_COWORK_ROOT_OVERRIDE`
    /// env var.
    fn temp_ws() -> (std::sync::MutexGuard<'static, ()>, TempDir, PathBuf) {
        let guard = crate::COWORK_ENV_LOCK.lock().unwrap();
        let dir = TempDir::new().unwrap();
        // Set the override so the ACL guard passes in tests.
        std::env::set_var("TANDEM_COWORK_ROOT_OVERRIDE", dir.path().to_str().unwrap());
        let ws_path = dir.path().join("ws-abc").join("vm-123");
        fs::create_dir_all(&ws_path).unwrap();
        (guard, dir, ws_path)
    }

    #[test]
    fn test_install_creates_entries() {
        let (_guard, _dir, ws_path) = temp_ws();
        let report = install_tandem_plugin_into_workspace(&ws_path, "secret-token", DEFAULT_TANDEM_URL).unwrap();
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");
        assert_eq!(report.installed_plugins, WriteStatus::Ok);
        assert_eq!(report.known_marketplaces, WriteStatus::Ok);
        assert_eq!(report.cowork_settings, WriteStatus::Ok);

        // Verify file content.
        let content = fs::read_to_string(ws_path.join("cowork_plugins/installed_plugins.json")).unwrap();
        let json: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(json["mcpServers"]["tandem"]["type"], "stdio");
        assert_eq!(json["mcpServers"]["tandem"]["command"], "npx");
        // The npx spec must be pinned to this build's exact version — a bare
        // "tandem-editor" would let `npm exec` reuse a stale global copy that
        // predates the `mcp-stdio` subcommand (the root cause this pin fixes).
        let expected_spec = format!("tandem-editor@{}", env!("CARGO_PKG_VERSION"));
        assert_eq!(
            json["mcpServers"]["tandem"]["args"],
            json!(["-y", expected_spec, "mcp-stdio"])
        );
        // Token must be present but we avoid logging it — just check it's non-empty.
        assert!(json["mcpServers"]["tandem"]["env"]["TANDEM_AUTH_TOKEN"].as_str().unwrap().len() > 0);
    }

    #[test]
    fn test_install_rewrites_a_stale_pinned_version() {
        let (_guard, _dir, ws_path) = temp_ws();
        let plugins_dir = ws_path.join("cowork_plugins");
        fs::create_dir_all(&plugins_dir).unwrap();

        // Pre-populate with a "tandem" entry pinned to an old/foreign version —
        // simulates a workspace installed by a previous build.
        let existing = json!({
            "mcpServers": {
                "tandem": {
                    "type": "stdio",
                    "command": "npx",
                    "args": ["-y", "tandem-editor@0.0.1", "mcp-stdio"],
                    "env": { "TANDEM_AUTH_TOKEN": "old-token", "TANDEM_URL": DEFAULT_TANDEM_URL }
                }
            }
        });
        fs::write(
            plugins_dir.join("installed_plugins.json"),
            serde_json::to_string_pretty(&existing).unwrap(),
        ).unwrap();

        let report = install_tandem_plugin_into_workspace(&ws_path, "secret-token", DEFAULT_TANDEM_URL).unwrap();
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");

        // The stale pin must be treated as drift, not as already-present.
        assert_eq!(report.installed_plugins, WriteStatus::Ok);

        let content = fs::read_to_string(plugins_dir.join("installed_plugins.json")).unwrap();
        let json: Value = serde_json::from_str(&content).unwrap();
        let expected_spec = format!("tandem-editor@{}", env!("CARGO_PKG_VERSION"));
        assert_eq!(
            json["mcpServers"]["tandem"]["args"],
            json!(["-y", expected_spec, "mcp-stdio"])
        );
    }

    #[test]
    fn test_install_is_idempotent() {
        let (_guard, _dir, ws_path) = temp_ws();
        install_tandem_plugin_into_workspace(&ws_path, "token", DEFAULT_TANDEM_URL).unwrap();
        let report2 = install_tandem_plugin_into_workspace(&ws_path, "token", DEFAULT_TANDEM_URL).unwrap();
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");
        // Second run should report AlreadyPresent for all three files.
        assert_eq!(report2.installed_plugins, WriteStatus::AlreadyPresent);
        assert_eq!(report2.known_marketplaces, WriteStatus::AlreadyPresent);
        assert_eq!(report2.cowork_settings, WriteStatus::AlreadyPresent);
    }

    #[test]
    fn test_install_preserves_context7_entry() {
        let (_guard, _dir, ws_path) = temp_ws();
        let plugins_dir = ws_path.join("cowork_plugins");
        fs::create_dir_all(&plugins_dir).unwrap();

        // Pre-populate with a context7 entry.
        let existing = json!({
            "mcpServers": {
                "context7": {
                    "type": "stdio",
                    "command": "npx",
                    "args": ["-y", "@upstash/context7-mcp"]
                }
            }
        });
        fs::write(
            plugins_dir.join("installed_plugins.json"),
            serde_json::to_string_pretty(&existing).unwrap(),
        ).unwrap();

        install_tandem_plugin_into_workspace(&ws_path, "token", DEFAULT_TANDEM_URL).unwrap();
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");

        let content = fs::read_to_string(plugins_dir.join("installed_plugins.json")).unwrap();
        let json: Value = serde_json::from_str(&content).unwrap();

        // Both entries must be present.
        assert!(json["mcpServers"]["context7"].is_object(), "context7 entry missing after install");
        assert!(json["mcpServers"]["tandem"].is_object(), "tandem entry not written");
    }

    #[test]
    fn test_uninstall_removes_only_tandem() {
        let (_guard, _dir, ws_path) = temp_ws();
        let plugins_dir = ws_path.join("cowork_plugins");
        fs::create_dir_all(&plugins_dir).unwrap();

        // Install context7 + tandem.
        let existing = json!({
            "mcpServers": {
                "context7": { "type": "stdio", "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },
                "tandem": { "type": "stdio", "command": "npx", "args": ["-y", "tandem-editor", "mcp-stdio"], "env": {} }
            }
        });
        fs::write(
            plugins_dir.join("installed_plugins.json"),
            serde_json::to_string_pretty(&existing).unwrap(),
        ).unwrap();
        fs::write(plugins_dir.join("known_marketplaces.json"), "{}").unwrap();
        fs::write(plugins_dir.join("cowork_settings.json"), "{}").unwrap();

        let report = uninstall_tandem_plugin_from_workspace(&ws_path).unwrap();
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");
        assert_eq!(report.installed_plugins, WriteStatus::Ok);

        let content = fs::read_to_string(plugins_dir.join("installed_plugins.json")).unwrap();
        let json: Value = serde_json::from_str(&content).unwrap();
        assert!(json["mcpServers"]["context7"].is_object(), "context7 was removed by uninstall");
        assert!(json["mcpServers"]["tandem"].is_null() || !json["mcpServers"]["tandem"].is_object(), "tandem not removed");
    }

    #[test]
    fn test_schema_drift_fires_on_array() {
        let (_guard, _dir, ws_path) = temp_ws();
        let plugins_dir = ws_path.join("cowork_plugins");
        fs::create_dir_all(&plugins_dir).unwrap();

        // Top-level is an array — schema drift.
        fs::write(plugins_dir.join("installed_plugins.json"), "[1,2,3]").unwrap();

        let result = install_tandem_plugin_into_workspace(&ws_path, "token", DEFAULT_TANDEM_URL).unwrap();
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");
        assert_eq!(result.installed_plugins, WriteStatus::SchemaDrift);
    }

    #[test]
    fn test_check_acl_against_accepts_child_rejects_outside() {
        // Hermetic: inject TempDir roots instead of mutating the dev's real
        // %APPDATA%\Claude tree (the old tests touched a live Claude install).
        let root_dir = TempDir::new().unwrap();
        let other_dir = TempDir::new().unwrap();
        let allowed = vec![root_dir.path().to_path_buf()];

        // A path strictly under the allowed root passes.
        let inside = root_dir.path().join("ws").join("vm");
        fs::create_dir_all(&inside).unwrap();
        assert!(
            check_acl_against(&inside, &allowed).is_ok(),
            "child of allowed root must pass"
        );

        // A path outside every allowed root is rejected (fail-closed).
        let outside = other_dir.path().join("ws").join("vm");
        fs::create_dir_all(&outside).unwrap();
        assert!(
            matches!(
                check_acl_against(&outside, &allowed),
                Err(CoworkError::InsecureAcl { .. })
            ),
            "path outside all roots must be InsecureAcl"
        );
    }

    #[test]
    fn test_check_acl_against_rejects_prefix_sibling() {
        // The reason `is_strict_component_child` exists: a sibling whose name
        // shares a string prefix with the allowed root must NOT count as a child.
        let base = TempDir::new().unwrap();
        let root = base.path().join("sessions");
        let sibling = base.path().join("sessions-evil").join("vm");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        let allowed = vec![root];
        assert!(
            matches!(
                check_acl_against(&sibling, &allowed),
                Err(CoworkError::InsecureAcl { .. })
            ),
            "prefix-sibling must be rejected, not treated as a child"
        );
    }

    #[test]
    fn test_check_acl_against_nonexistent_candidate_fails_open() {
        // A candidate that doesn't exist yet (new workspace dir) is allowed —
        // the only fail-open in the fail-closed core.
        let base = TempDir::new().unwrap();
        let allowed = vec![base.path().to_path_buf()];
        let ghost = base.path().join("does-not-exist-yet").join("vm");
        assert!(check_acl_against(&ghost, &allowed).is_ok());
    }

    #[test]
    fn test_is_strict_component_child() {
        let root = Path::new("/a/b/sessions");
        assert!(is_strict_component_child(
            Path::new("/a/b/sessions/x/y"),
            root
        ));
        // Equal path is NOT a strict child.
        assert!(!is_strict_component_child(root, root));
        // Prefix-sibling is NOT a child (component-wise, not string-prefix).
        assert!(!is_strict_component_child(
            Path::new("/a/b/sessions-evil/x"),
            root
        ));
        // Disjoint path.
        assert!(!is_strict_component_child(Path::new("/a/c/x"), root));
    }

    #[test]
    fn test_install_rejects_unscanned_path() {
        // Write-time revalidation: a path outside every Cowork root must be
        // rejected before any file I/O (the #433 defense on the non-handle
        // write path).
        let _guard = crate::COWORK_ENV_LOCK.lock().unwrap();
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");

        let dir = TempDir::new().unwrap();
        let ws = dir.path().join("ws").join("vm");
        fs::create_dir_all(&ws).unwrap();

        let report =
            install_tandem_plugin_into_workspace(&ws, "tok", DEFAULT_TANDEM_URL).unwrap();
        assert!(
            matches!(report.installed_plugins, WriteStatus::Failed(_)),
            "expected revalidation failure, got {report:?}"
        );
        // Nothing may be written on rejection.
        assert!(
            !ws.join("cowork_plugins").exists(),
            "rejected install must not create cowork_plugins"
        );
    }

    #[test]
    fn test_uninstall_rejects_unscanned_path() {
        // Symmetric to install: uninstall's write-time revalidation must reject
        // a path outside every Cowork root, leaving existing files untouched.
        let _guard = crate::COWORK_ENV_LOCK.lock().unwrap();
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");

        let dir = TempDir::new().unwrap();
        let ws = dir.path().join("ws").join("vm");
        let plugins_dir = ws.join("cowork_plugins");
        fs::create_dir_all(&plugins_dir).unwrap();
        // Pre-existing registry file the rejected uninstall must NOT mutate.
        fs::write(
            plugins_dir.join("installed_plugins.json"),
            r#"{"mcpServers":{"tandem":{}}}"#,
        )
        .unwrap();

        let report = uninstall_tandem_plugin_from_workspace(&ws).unwrap();
        assert!(
            matches!(report.installed_plugins, WriteStatus::Failed(_)),
            "expected revalidation failure, got {report:?}"
        );
        // The tandem entry is still present — nothing was removed.
        let content = fs::read_to_string(plugins_dir.join("installed_plugins.json")).unwrap();
        assert!(
            content.contains("tandem"),
            "rejected uninstall must not rewrite the file"
        );
    }

    #[test]
    fn test_heal_outcome_is_terminal_classification() {
        // Terminal: success + InsecureAcl (a path that won't become safe).
        assert!(heal_outcome_is_terminal(&WriteStatus::Ok));
        assert!(heal_outcome_is_terminal(&WriteStatus::AlreadyPresent));
        assert!(heal_outcome_is_terminal(&WriteStatus::InsecureAcl));
        // Retryable (transient) — must NOT be terminal, so the next tick retries.
        assert!(!heal_outcome_is_terminal(&WriteStatus::Locked));
        assert!(!heal_outcome_is_terminal(&WriteStatus::SchemaDrift));
        assert!(!heal_outcome_is_terminal(&WriteStatus::Failed("io".into())));
    }

    #[test]
    fn test_workspace_has_tandem_entry_states() {
        let dir = TempDir::new().unwrap();
        let ws = dir.path();
        let plugins = ws.join("cowork_plugins");
        fs::create_dir_all(&plugins).unwrap();
        let file = plugins.join("installed_plugins.json");

        // Absent file → false (the expected "not configured yet").
        assert!(!workspace_has_tandem_entry(ws));

        // Present with the entry → true.
        fs::write(&file, r#"{"mcpServers":{"tandem":{"type":"stdio"}}}"#).unwrap();
        assert!(workspace_has_tandem_entry(ws));

        // Valid JSON without the tandem key → false.
        fs::write(&file, r#"{"mcpServers":{"context7":{}}}"#).unwrap();
        assert!(!workspace_has_tandem_entry(ws));

        // Malformed JSON → false (logged, never panics, never logs contents).
        fs::write(&file, "{ not json").unwrap();
        assert!(!workspace_has_tandem_entry(ws));
    }

    #[test]
    fn test_check_acl_io_error_is_not_insecure_acl() {
        // Trigger a non-NotFound canonicalize error: path whose parent is a regular
        // file (not a directory). Canonicalize returns NotADirectory/Other, not NotFound.
        let _guard = crate::COWORK_ENV_LOCK.lock().unwrap();
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");

        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("regular_file");
        fs::write(&file_path, b"not a dir").unwrap();
        let bogus = file_path.join("child"); // parent is a file, not a dir

        let result = check_acl(&bogus);
        // Either IoError (preferred — Step 3's fix) or NotFound fail-open (Ok).
        // MUST NOT be InsecureAcl (that would mean we're still conflating I/O with security).
        match result {
            Err(CoworkError::InsecureAcl { .. }) => {
                panic!("I/O error should not map to InsecureAcl after Step 3 fix");
            }
            Err(CoworkError::IoError(_)) | Ok(()) => {} // either is acceptable
            other => panic!("unexpected result: {:?}", other),
        }
    }

    #[test]
    fn test_apply_token_updates_existing_entry() {
        let _guard = crate::COWORK_ENV_LOCK.lock().unwrap();
        let dir = TempDir::new().unwrap();
        let ws_path = dir.path().join("ws-abc").join("vm-123");
        fs::create_dir_all(&ws_path).unwrap();

        // Override root for both install + walker, plus ACL bypass.
        std::env::set_var("TANDEM_COWORK_ROOT_OVERRIDE", dir.path().to_str().unwrap());

        install_tandem_plugin_into_workspace(&ws_path, "old-token", DEFAULT_TANDEM_URL).unwrap();

        let reports = apply_token_to_all_workspaces("new-token");
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");

        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].installed_plugins, WriteStatus::Ok);

        let content = fs::read_to_string(ws_path.join("cowork_plugins/installed_plugins.json")).unwrap();
        let json: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(json["mcpServers"]["tandem"]["env"]["TANDEM_AUTH_TOKEN"], "new-token");
    }

    #[test]
    fn test_reconcile_stale_workspace_tokens_rewrites_mismatch() {
        // Net-new coverage enabled by the #1163 split: the token-rewrite half is
        // now testable in isolation (the old combined reconcile_orphans was
        // entangled with netsh). temp_ws() sets TANDEM_COWORK_ROOT_OVERRIDE and
        // nests the ws under it so revalidate_resolved_path (#433) passes instead
        // of skipping the rewrite — without it this test would fail red.
        let (_guard, _dir, ws_path) = temp_ws();
        install_tandem_plugin_into_workspace(&ws_path, "old-token", DEFAULT_TANDEM_URL).unwrap();

        let rewritten = reconcile_stale_workspace_tokens(&[ws_path.clone()], "current-token");
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");

        // The reported path is the #433-revalidated (canonicalized) form, which on
        // Windows carries the \\?\ extended-length prefix — assert on the suffix,
        // not exact string equality, then verify the actual on-disk rewrite.
        assert_eq!(rewritten.len(), 1, "stale entry should be reported as rewritten");
        assert!(
            rewritten[0].ends_with("installed_plugins.json"),
            "unexpected rewritten path: {}",
            rewritten[0]
        );

        let entry_path = ws_path.join("cowork_plugins/installed_plugins.json");
        let content = fs::read_to_string(&entry_path).unwrap();
        let json: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(json["mcpServers"]["tandem"]["env"]["TANDEM_AUTH_TOKEN"], "current-token");
    }

    #[test]
    fn test_reconcile_stale_workspace_tokens_skips_when_current() {
        // Pins the needs_update == false branch: a workspace already carrying the
        // current token must not be reported or rewritten (avoids needless writes
        // + lock contention on every enable).
        let (_guard, _dir, ws_path) = temp_ws();
        install_tandem_plugin_into_workspace(&ws_path, "current-token", DEFAULT_TANDEM_URL).unwrap();

        let rewritten = reconcile_stale_workspace_tokens(&[ws_path], "current-token");
        std::env::remove_var("TANDEM_COWORK_ROOT_OVERRIDE");

        assert!(rewritten.is_empty(), "no rewrite expected when token already current");
    }
}
