//! Spike-only prototype for #477 PR 4: sidecar launcher validation.
//!
//! NOT shipped in release builds. Compiled under `#[cfg(test)]` only via
//! `mod integrations_probe;` in `lib.rs`. The real implementation will live
//! in a separate launcher binary (or `tandem-launcher` crate) once the spike
//! verdict is acted on.
//!
//! Three pieces are exercised here:
//!
//! 1. **Sidecar path resolution** without `env!("TARGET_TRIPLE")` — a non-Tauri
//!    launcher cannot rely on the Tauri build-time triple. We test reading a
//!    pointer file written by `tandem setup` instead.
//! 2. **Launch command shape** — build a `std::process::Command` with the
//!    correct env vars (`TANDEM_AUTH_TOKEN`, `TANDEM_OPEN_BROWSER=0`,
//!    `TANDEM_BIND_HOST` defaulted/omitted so the server binds 127.0.0.1).
//! 3. **Config rewrite** — merge a tandem entry into an existing
//!    `mcpServers` map without clobbering siblings, preserving the
//!    `http://127.0.0.1:<port>` invariant.
//!
//! Security invariants enforced by this module's helpers (verified by tests):
//!   - URL is constructed from `127.0.0.1`, never `0.0.0.0` or a LAN IP.
//!   - Auth token, if written, is exactly the value passed in (caller is
//!     expected to have generated a fresh per-install token).
//!   - Pre-existing unrelated MCP entries are preserved byte-for-byte.

#![cfg(test)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// Loopback host used for every URL this module emits. Tests assert this is
/// not `0.0.0.0` or a routable IP.
pub const LOOPBACK_HOST: &str = "127.0.0.1";

/// Default MCP HTTP port. Keep in sync with `DEFAULT_MCP_PORT` in
/// `src/shared/constants.ts`.
pub const DEFAULT_MCP_PORT: u16 = 3479;

/// Resolved sidecar location. The real launcher will read this from a
/// pointer file written by `tandem setup` (option (c) in the spike doc).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarLocation {
    pub exe: PathBuf,
    /// Argument(s) to pass after the exe — for the bundled
    /// `node-sidecar-<triple>` self-contained binary this is empty; for a
    /// raw `node dist/server/index.js` invocation it's the script path.
    pub args: Vec<String>,
}

/// Read a `sidecar.json` pointer file written by `tandem setup`. Schema:
///
/// ```json
/// { "exe": "C:/Program Files/Tandem/node-sidecar-x86_64-pc-windows-msvc.exe",
///   "args": [] }
/// ```
///
/// Errors are returned as `String` for spike simplicity; the real impl will
/// use `thiserror`.
pub fn read_sidecar_pointer(path: &Path) -> Result<SidecarLocation, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("read pointer file: {e}"))?;
    let parsed: Value =
        serde_json::from_str(&contents).map_err(|e| format!("parse pointer JSON: {e}"))?;
    let exe = parsed
        .get("exe")
        .and_then(Value::as_str)
        .ok_or_else(|| "pointer JSON missing 'exe'".to_string())?;
    let args = parsed
        .get("args")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Ok(SidecarLocation {
        exe: PathBuf::from(exe),
        args,
    })
}

/// Build the launch command's environment block. The launcher passes this
/// to `std::process::Command::envs()`. We don't actually spawn here — the
/// `#[ignore]`-gated live test below does that.
pub fn build_launch_env(auth_token: &str, app_data_dir: &Path) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    env.insert("TANDEM_AUTH_TOKEN".into(), auth_token.into());
    env.insert("TANDEM_OPEN_BROWSER".into(), "0".into());
    env.insert(
        "TANDEM_DATA_DIR".into(),
        app_data_dir.to_string_lossy().into_owned(),
    );
    // Explicit absence of TANDEM_BIND_HOST → server defaults to 127.0.0.1.
    // The launcher MUST NEVER set TANDEM_BIND_HOST=0.0.0.0 unless the user
    // has opted into LAN mode with an auth token (#477 PR 4 out of scope).
    env
}

/// Construct the MCP URL the rewritten config should reference.
pub fn build_mcp_url(port: u16) -> String {
    format!("http://{LOOPBACK_HOST}:{port}/mcp")
}

/// Merge a tandem entry into the `mcpServers` map of an existing config,
/// preserving every other key. Returns the new JSON value; caller is
/// responsible for atomic write + chmod 600.
pub fn rewrite_mcp_config(existing: &Value, port: u16, auth_token: &str) -> Result<Value, String> {
    let obj = existing
        .as_object()
        .ok_or_else(|| "config root is not an object".to_string())?;
    let mut out: Map<String, Value> = obj.clone();

    let mut servers: Map<String, Value> = out
        .get("mcpServers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let url = build_mcp_url(port);
    // Invariant check at construction time. If a future change accidentally
    // formats a wildcard host, this assert will fire in tests.
    debug_assert!(url.starts_with("http://127.0.0.1:"));

    let tandem_entry = json!({
        "type": "http",
        "url": url,
        "headers": {
            "Authorization": format!("Bearer {auth_token}")
        }
    });
    servers.insert("tandem".into(), tandem_entry);

    out.insert("mcpServers".into(), Value::Object(servers));
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture_path() -> PathBuf {
        // CARGO_MANIFEST_DIR == src-tauri
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.pop();
        p.push("tests/fixtures/mcp-config-sample.json");
        p
    }

    #[test]
    fn loopback_host_is_127_0_0_1() {
        assert_eq!(LOOPBACK_HOST, "127.0.0.1");
        let url = build_mcp_url(DEFAULT_MCP_PORT);
        assert!(url.starts_with("http://127.0.0.1:"));
        assert!(!url.contains("0.0.0.0"));
    }

    #[test]
    fn build_launch_env_never_sets_bind_host() {
        let env = build_launch_env("synthetic-token", Path::new("/tmp/tandem"));
        assert!(!env.contains_key("TANDEM_BIND_HOST"));
        assert_eq!(env.get("TANDEM_OPEN_BROWSER").map(String::as_str), Some("0"));
        assert_eq!(
            env.get("TANDEM_AUTH_TOKEN").map(String::as_str),
            Some("synthetic-token")
        );
    }

    #[test]
    fn rewrite_preserves_unrelated_servers() {
        let raw = std::fs::read_to_string(fixture_path()).expect("read fixture");
        let existing: Value = serde_json::from_str(&raw).expect("parse fixture");
        let rewritten = rewrite_mcp_config(&existing, 3479, "fresh-install-token").unwrap();

        let servers = rewritten
            .get("mcpServers")
            .and_then(Value::as_object)
            .unwrap();

        // Sibling preserved untouched.
        let other = servers.get("some-other-server").unwrap();
        let other_orig = existing
            .get("mcpServers")
            .and_then(|v| v.get("some-other-server"))
            .unwrap();
        assert_eq!(other, other_orig, "sibling MCP entry was clobbered");

        // Tandem entry uses 127.0.0.1 and the fresh token.
        let tandem = servers.get("tandem").unwrap();
        let url = tandem.get("url").and_then(Value::as_str).unwrap();
        assert!(url.starts_with("http://127.0.0.1:3479"), "url was: {url}");
        let auth = tandem
            .get("headers")
            .and_then(|h| h.get("Authorization"))
            .and_then(Value::as_str)
            .unwrap();
        assert_eq!(auth, "Bearer fresh-install-token");
    }

    #[test]
    fn read_sidecar_pointer_round_trip() {
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            tmp,
            r#"{{ "exe": "/opt/tandem/node-sidecar", "args": [] }}"#
        )
        .unwrap();
        let loc = read_sidecar_pointer(tmp.path()).unwrap();
        assert_eq!(loc.exe, PathBuf::from("/opt/tandem/node-sidecar"));
        assert!(loc.args.is_empty());
    }

    /// Live spawn against a real bundled sidecar. Gated `#[ignore]` because
    /// it requires `src-tauri/binaries/node-sidecar-*` to exist and a free
    /// :3479 port. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml \
    ///       --lib integrations_probe -- --ignored
    #[test]
    #[ignore]
    fn live_spawn_and_health_check() {
        // Documented but not implemented in the spike — the goal is to prove
        // the launch-command-building logic compiles and is correct. The
        // Node probe script (`scripts/spikes/probe-launcher.mjs`) covers the
        // end-to-end spawn + health-check path.
    }
}
