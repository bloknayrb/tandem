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

/// Summary of orphan reconciliation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    /// Names of orphan firewall rules that were removed.
    pub removed_firewall_rules: Vec<String>,
    /// Paths of workspace entries that had stale tokens and were rewritten.
    pub rewritten_stale_entries: Vec<String>,
}

// ---------------------------------------------------------------------------
// ACL guard (heuristic — full DACL inspection deferred to v0.8.1)
// ---------------------------------------------------------------------------

/// Heuristic ACL check for a workspace path.
///
/// Returns `CoworkError::InsecureAcl` when the path's canonical form is
/// outside `%LOCALAPPDATA%` (indicating a redirected or OneDrive-synced path
/// that could be world-readable).
///
/// TODO(v0.8.1): Replace with full DACL inspection via
/// `GetFileSecurityW` / `GetEffectiveRightsFromAcl` from `windows-sys`.
fn check_acl(path: &Path) -> Result<(), CoworkError> {
    // Honour the test override root: if the path is within the override, skip
    // the %LOCALAPPDATA% check (tests use std::env::temp_dir()).
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

    let local_app_data = match dirs::data_local_dir() {
        Some(d) => d,
        None => return Ok(()), // Can't determine — allow optimistically
    };

    // Canonicalize both for comparison.
    let canonical_path = match std::fs::canonicalize(path) {
        Ok(p) => p,
        Err(_) => return Ok(()), // Can't canonicalize — allow optimistically
    };
    let canonical_lad = match std::fs::canonicalize(&local_app_data) {
        Ok(p) => p,
        Err(_) => return Ok(()),
    };

    // Check that the path starts with %LOCALAPPDATA%.
    let path_components: Vec<_> = canonical_path.components().collect();
    let lad_components: Vec<_> = canonical_lad.components().collect();

    let is_under_lad = lad_components.iter().zip(path_components.iter()).all(|(l, p)| l == p)
        && path_components.len() > lad_components.len();

    if !is_under_lad {
        log::warn!(
            "[cowork-install] InsecureAcl: {} is outside %LOCALAPPDATA%",
            path.display()
        );
        return Err(CoworkError::InsecureAcl {
            path: path.to_path_buf(),
        });
    }

    Ok(())
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

    warn_if_onedrive(ws_path);

    // ACL check before any write.
    let acl_result = check_acl(ws_path);

    // Create the cowork_plugins subdirectory if it doesn't exist.
    let plugins_dir = ws_path.join("cowork_plugins");
    std::fs::create_dir_all(&plugins_dir).map_err(|e| {
        log::warn!("[cowork-install] mkdir cowork_plugins failed: {e}");
        CoworkError::from(e)
    })?;

    let installed_status = if let Err(ref e) = acl_result {
        log::warn!("[cowork-install] InsecureAcl for installed_plugins.json: {e}");
        WriteStatus::InsecureAcl
    } else {
        let path = plugins_dir.join("installed_plugins.json");
        // Token must not appear in any log — pass it via closure capture only.
        let token_owned = token.to_string();
        let tandem_url_owned = tandem_url.to_string();
        write_status_from(with_locked_json(&path, move |json| {
            merge_installed_plugins(json, &token_owned, &tandem_url_owned)
        }))
    };

    let known_status = if acl_result.is_err() {
        WriteStatus::InsecureAcl
    } else {
        let path = plugins_dir.join("known_marketplaces.json");
        write_status_from(with_locked_json(&path, merge_known_marketplaces))
    };

    let settings_status = if acl_result.is_err() {
        WriteStatus::InsecureAcl
    } else {
        let path = plugins_dir.join("cowork_settings.json");
        write_status_from(with_locked_json(&path, merge_cowork_settings))
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

/// Scan for and reconcile orphan firewall rules and stale env blocks.
///
/// Removes firewall rules left by a previous failed uninstall and rewrites
/// workspace entries whose `env.TANDEM_AUTH_TOKEN` does not match the current
/// token (security invariant §12).
pub fn reconcile_orphans(workspaces: &[PathBuf], current_token: &str) -> ReconcileReport {
    use crate::firewall;

    let orphan_rules = firewall::scan_orphan_rules();
    let mut removed_rules = Vec::new();

    if !orphan_rules.is_empty() {
        log::warn!(
            "[cowork-install] reconcile: found {} orphan firewall rule(s): {:?}",
            orphan_rules.len(),
            orphan_rules
        );
        if let Err(e) = firewall::remove_cowork_rules() {
            log::warn!("[cowork-install] reconcile: failed to remove orphan rules: {e}");
        } else {
            removed_rules = orphan_rules;
        }
    }

    let mut rewritten = Vec::new();
    for ws_path in workspaces {
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
                Err(_) => false,
            },
            Err(_) => false,
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

    ReconcileReport {
        removed_firewall_rules: removed_rules,
        rewritten_stale_entries: rewritten,
    }
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
    let desired = json!({
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "tandem-editor", "mcp-stdio"],
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
        // Token must be present but we avoid logging it — just check it's non-empty.
        assert!(json["mcpServers"]["tandem"]["env"]["TANDEM_AUTH_TOKEN"].as_str().unwrap().len() > 0);
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
}
