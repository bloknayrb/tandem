//! Tandem-owned Cowork sidecar metadata.
//!
//! Stores integration state that Tandem controls:
//! - Detected vEthernet CIDR from the last Hyper-V scan.
//! - LAN-IP fallback value (populated but not used unless `use_lan_ip_override`).
//! - Timestamp of the last workspace scan.
//! - Whether the user has requested LAN-IP override instead of `host.docker.internal`.
//! - Whether UAC elevation was declined on the last attempt.
//!
//! Persisted to `%LOCALAPPDATA%\tandem\Data\cowork-meta.json` via atomic write.

#![cfg(target_os = "windows")]

use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Persistent metadata for the Cowork integration.
///
/// All fields are nullable/optional so that partial state is valid (e.g.
/// `vethernet_cidr_detected` is null until the first scan completes).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoworkMeta {
    /// Detected LAN-IP of the host machine; populated during `cowork_toggle_integration`.
    /// Used as a fallback TANDEM_URL when `use_lan_ip_override` is true.
    #[serde(default)]
    pub lan_ip_fallback: Option<String>,

    /// The vEthernet CIDR detected from Hyper-V adapter enumeration.
    /// `null` until a successful `detect_vethernet_subnet()` call.
    #[serde(default)]
    pub vethernet_cidr_detected: Option<String>,

    /// ISO-8601 timestamp of the last `find_cowork_workspaces()` scan.
    #[serde(default)]
    pub workspaces_last_scanned_at: Option<String>,

    /// When true, `cowork_installer` writes `http://<lan_ip_fallback>:3479`
    /// as `TANDEM_URL` instead of `http://host.docker.internal:3479`.
    #[serde(default)]
    pub use_lan_ip_override: bool,

    /// Set to true when UAC elevation was declined during `cowork_toggle_integration`.
    /// Drives the persistent non-dismissable modal in the PR-f Settings UI.
    #[serde(default)]
    pub uac_declined_last_attempt: bool,

    /// ISO-8601 timestamp of the last UAC decline.
    #[serde(default)]
    pub uac_declined_at: Option<String>,

    /// Whether the Cowork integration is currently enabled.
    #[serde(default)]
    pub enabled: bool,
}

impl Default for CoworkMeta {
    fn default() -> Self {
        CoworkMeta {
            lan_ip_fallback: None,
            vethernet_cidr_detected: None,
            workspaces_last_scanned_at: None,
            use_lan_ip_override: false,
            uac_declined_last_attempt: false,
            uac_declined_at: None,
            enabled: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Storage path
// ---------------------------------------------------------------------------

/// Resolve the cowork-meta.json path.
///
/// Path: `%LOCALAPPDATA%\tandem\Data\cowork-meta.json`
fn meta_path() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|d| d.join("tandem").join("Data").join("cowork-meta.json"))
        .ok_or_else(|| "Cannot resolve %LOCALAPPDATA%".to_string())
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Load `CoworkMeta` from disk.
///
/// Returns `Ok(CoworkMeta::default())` if the file does not exist yet.
/// Returns `Err` only on I/O or JSON parse failures for an existing file.
pub fn load() -> Result<CoworkMeta, String> {
    let path = meta_path()?;
    if !path.exists() {
        return Ok(CoworkMeta::default());
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("read cowork-meta.json: {e}"))?;
    serde_json::from_str::<CoworkMeta>(&content)
        .map_err(|e| format!("parse cowork-meta.json: {e}"))
}

/// Persist `CoworkMeta` to disk using an atomic temp-file rename.
///
/// Creates parent directories if they don't exist.
pub fn save(meta: &CoworkMeta) -> Result<(), String> {
    let path = meta_path()?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir for cowork-meta.json: {e}"))?;
    }

    let serialised =
        serde_json::to_string_pretty(meta).map_err(|e| format!("serialise cowork-meta: {e}"))?;

    // Atomic write: temp file in same dir → rename.
    let dir = path
        .parent()
        .ok_or("cowork-meta.json has no parent directory")?;

    let tmp_path = dir.join(format!(
        ".tandem-meta-tmp-{}",
        crate::cowork_atomic_json::unique_suffix()
    ));

    (|| -> Result<(), io::Error> {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)?;
        f.write_all(serialised.as_bytes())?;
        f.flush()?;
        f.sync_all()?;
        std::fs::rename(&tmp_path, &path)
    })()
    .map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("write cowork-meta.json: {e}")
    })
}

/// Update a single field via a closure, loading and saving atomically.
pub fn update<F: FnOnce(&mut CoworkMeta)>(f: F) -> Result<(), String> {
    let mut meta = load()?;
    f(&mut meta);
    save(&meta)
}
