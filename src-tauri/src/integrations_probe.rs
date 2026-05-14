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
//! ## Typed pointer-file contract
//!
//! `read_sidecar_pointer` returns [`UnvalidatedSidecarLocation`]. The only
//! path to a spawnable [`SidecarLocation`] is
//! [`UnvalidatedSidecarLocation::validate`]. The spike implementation of
//! `validate` rejects symlinks and (when an allowlist is supplied) requires
//! the resolved exe to live inside one of the allowed install roots. The
//! install-root allowlist itself — and the rest of the hardening enumerated
//! below — is PR 4 work, tracked separately. The typed-wrapper shape exists
//! so PR 4 cannot accidentally pass an unvalidated pointer to
//! `Command::new`.
//!
//! ## Security invariants enforced by this module's helpers (verified by tests):
//!   - URL is constructed from `127.0.0.1`, never `0.0.0.0` or a LAN IP.
//!   - Auth token, if written, is exactly the value passed in (caller is
//!     expected to have generated a fresh per-install token).
//!   - Pre-existing unrelated MCP entries are preserved byte-for-byte.
//!   - A pre-existing `tandem` entry with a stale token is **replaced**, not
//!     deep-merged — the stale token must not survive in the rewritten
//!     config.
//!   - `rewrite_mcp_config` bails (does not overwrite) on malformed
//!     `mcpServers` shapes (non-object root, non-object `mcpServers`).
//!   - Symlinked sidecar exes are rejected at validation time.

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

/// A pointer-file payload as read off disk. Untrusted — must be promoted to
/// [`SidecarLocation`] via [`UnvalidatedSidecarLocation::validate`] before it
/// can be spawned.
///
/// `args`: argument(s) to pass after the exe. For the bundled
/// `node-sidecar-<triple>` packaged Node runtime this is
/// `["dist/server/index.js"]` (the script path — see `start_sidecar` in
/// `src-tauri/src/lib.rs`); empty only for true self-contained binaries that
/// hard-code the entry point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnvalidatedSidecarLocation {
    pub exe: PathBuf,
    pub args: Vec<String>,
}

impl UnvalidatedSidecarLocation {
    /// Validate the pointer payload. Spike-level checks:
    ///
    /// 1. Reject symlinks at `self.exe` (TOCTOU surface — a symlink-following
    ///    spawn could be redirected by a non-privileged attacker who can
    ///    write next to the install root).
    /// 2. If `install_roots` is non-empty, require `self.exe` to live inside
    ///    one of them.
    ///
    /// PR 4 must extend this with: parent-dir ownership check, group/world-
    /// writable rejection, canonicalisation against the allowlist (current
    /// `starts_with` is prefix-only). See GH issue tracking PR-4 acceptance
    /// criterion #1.
    pub fn validate(self, install_roots: &[&Path]) -> Result<SidecarLocation, String> {
        if let Ok(meta) = std::fs::symlink_metadata(&self.exe) {
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "sidecar exe is a symlink, rejecting: {}",
                    self.exe.display()
                ));
            }
        }
        if !install_roots.is_empty() {
            let in_root = install_roots.iter().any(|root| self.exe.starts_with(root));
            if !in_root {
                return Err(format!(
                    "sidecar exe not in any allowed install root: {}",
                    self.exe.display()
                ));
            }
        }
        Ok(SidecarLocation {
            exe: self.exe,
            args: self.args,
        })
    }
}

/// A validated sidecar location ready to spawn. Constructed only via
/// [`UnvalidatedSidecarLocation::validate`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarLocation {
    pub exe: PathBuf,
    pub args: Vec<String>,
}

/// Read a `sidecar.json` pointer file written by `tandem setup`. Schema:
///
/// ```json
/// { "exe": "C:/Program Files/Tandem/node-sidecar-x86_64-pc-windows-msvc.exe",
///   "args": ["dist/server/index.js"] }
/// ```
///
/// Returns an [`UnvalidatedSidecarLocation`]; the caller must call
/// [`UnvalidatedSidecarLocation::validate`] before spawning.
///
/// Errors are returned as `String` for spike simplicity; the real impl will
/// use `thiserror`.
pub fn read_sidecar_pointer(path: &Path) -> Result<UnvalidatedSidecarLocation, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("read pointer file: {e}"))?;
    let parsed: Value =
        serde_json::from_str(&contents).map_err(|e| format!("parse pointer JSON: {e}"))?;
    let exe = parsed
        .get("exe")
        .and_then(Value::as_str)
        .ok_or_else(|| "pointer JSON missing 'exe'".to_string())?;
    // Strict: if `args` is present, it MUST be an array of strings.
    // Silent coercion to vec![] would launch the sidecar with no script
    // argument (which for the bundled packaged-node runtime drops to REPL).
    let args = match parsed.get("args") {
        None => Vec::new(),
        Some(Value::Array(arr)) => {
            let mut out = Vec::with_capacity(arr.len());
            for (i, v) in arr.iter().enumerate() {
                match v.as_str() {
                    Some(s) => out.push(s.to_string()),
                    None => {
                        return Err(format!(
                            "pointer 'args[{i}]' must be a string, got: {v}"
                        ))
                    }
                }
            }
            out
        }
        Some(other) => {
            return Err(format!(
                "pointer 'args' must be an array of strings, got: {other}"
            ))
        }
    };
    Ok(UnvalidatedSidecarLocation {
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
/// responsible for atomic write + chmod 600 / Windows ACL.
///
/// Rejects (returns `Err`, never overwrites):
/// - root is not a JSON object
/// - `mcpServers` is present but is not a JSON object
///
/// Replace semantics: any pre-existing `mcpServers.tandem` is overwritten,
/// not deep-merged. PR 4 must add a backup-before-overwrite step (see GH
/// issue tracking PR-4 acceptance criterion #3).
pub fn rewrite_mcp_config(existing: &Value, port: u16, auth_token: &str) -> Result<Value, String> {
    let obj = existing
        .as_object()
        .ok_or_else(|| "config root is not an object".to_string())?;
    let mut out: Map<String, Value> = obj.clone();

    let mut servers: Map<String, Value> = match out.get("mcpServers") {
        None => Map::new(),
        Some(Value::Object(o)) => o.clone(),
        Some(_) => {
            return Err("mcpServers exists but is not an object".to_string());
        }
    };

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
    fn rewrite_preserves_unrelated_servers_and_replaces_stale_tandem() {
        let raw = std::fs::read_to_string(fixture_path()).expect("read fixture");
        let existing: Value = serde_json::from_str(&raw).expect("parse fixture");

        // Sanity: fixture pre-seeds a stale `tandem` entry whose token we
        // expect to be wiped after rewrite.
        let stale_token_marker = "test-token-do-not-use-tandem";
        assert!(
            raw.contains(stale_token_marker),
            "fixture should pre-seed a stale tandem token"
        );

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
        // Positive: header is exactly the fresh token.
        assert_eq!(auth, "Bearer fresh-install-token");

        // Negative: the stale token marker must not survive ANYWHERE in the
        // rewritten document. Pins replace-not-deep-merge semantics; a
        // future regression to deep-merge would leave the old Authorization
        // header in place.
        let serialised = serde_json::to_string(&rewritten).unwrap();
        assert!(
            !serialised.contains(stale_token_marker),
            "stale token marker survived rewrite: {serialised}"
        );
    }

    /// Table-driven coverage of every malformed-input path through
    /// `rewrite_mcp_config`. One assertion per case — adding a new failure
    /// mode is one new row, not one new test.
    #[test]
    fn rewrite_rejects_invalid_inputs() {
        let cases: &[(&str, &str, &str)] = &[
            ("root_is_array", "[]", "root is not an object"),
            ("root_is_string", "\"hello\"", "root is not an object"),
            ("root_is_null", "null", "root is not an object"),
            (
                "mcp_servers_is_string",
                r#"{"mcpServers": "bogus"}"#,
                "mcpServers exists but is not an object",
            ),
            (
                "mcp_servers_is_array",
                r#"{"mcpServers": []}"#,
                "mcpServers exists but is not an object",
            ),
            (
                "mcp_servers_is_number",
                r#"{"mcpServers": 42}"#,
                "mcpServers exists but is not an object",
            ),
        ];
        for (name, input, expected_err) in cases {
            let val: Value = serde_json::from_str(input).expect("test JSON parses");
            let result = rewrite_mcp_config(&val, 3479, "tok");
            let err = result
                .as_ref()
                .err()
                .unwrap_or_else(|| panic!("case {name}: expected Err, got Ok({:?})", result));
            assert!(
                err.contains(expected_err),
                "case {name}: err was {err:?}, expected substring {expected_err:?}"
            );
        }
    }

    #[test]
    fn rewrite_accepts_missing_mcp_servers() {
        // Missing key is the most common real case (fresh `.claude.json`).
        // Must succeed and produce an `mcpServers` map containing only
        // `tandem`.
        let val: Value = serde_json::json!({});
        let rewritten = rewrite_mcp_config(&val, 3479, "tok").unwrap();
        let servers = rewritten
            .get("mcpServers")
            .and_then(Value::as_object)
            .unwrap();
        assert_eq!(servers.len(), 1);
        assert!(servers.contains_key("tandem"));
    }

    #[test]
    fn read_sidecar_pointer_round_trip() {
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            tmp,
            r#"{{ "exe": "/opt/tandem/node-sidecar", "args": ["dist/server/index.js"] }}"#
        )
        .unwrap();
        let loc = read_sidecar_pointer(tmp.path()).unwrap();
        assert_eq!(loc.exe, PathBuf::from("/opt/tandem/node-sidecar"));
        assert_eq!(loc.args, vec!["dist/server/index.js".to_string()]);
    }

    #[test]
    fn read_sidecar_pointer_handles_empty_file() {
        // Empty file is the mid-write window PR 4's atomic writer must
        // close. Until then, reader-side must surface a clear error rather
        // than silently spawning a zero-arg sidecar.
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let err = read_sidecar_pointer(tmp.path()).unwrap_err();
        assert!(
            err.contains("parse pointer JSON"),
            "err was: {err}"
        );
    }

    #[test]
    fn read_sidecar_pointer_rejects_non_array_args() {
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            tmp,
            r#"{{ "exe": "/opt/tandem/node-sidecar", "args": "dist/server/index.js" }}"#
        )
        .unwrap();
        let err = read_sidecar_pointer(tmp.path()).unwrap_err();
        assert!(
            err.contains("args"),
            "err was: {err}"
        );
    }

    #[test]
    fn read_sidecar_pointer_rejects_non_string_args_element() {
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            tmp,
            r#"{{ "exe": "/opt/tandem/node-sidecar", "args": ["script.js", 42] }}"#
        )
        .unwrap();
        let err = read_sidecar_pointer(tmp.path()).unwrap_err();
        assert!(
            err.contains("args[1]"),
            "err was: {err}"
        );
    }

    /// POSIX-only: validate() must reject a symlinked exe. On Windows
    /// symlink creation requires Developer Mode or admin, so this test is
    /// gated to Unix; the symlink-rejection logic itself runs on every
    /// platform via `symlink_metadata`.
    #[cfg(unix)]
    #[test]
    fn validate_rejects_symlink_exe() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real-sidecar");
        std::fs::write(&real, b"#!/bin/sh\nexit 0\n").unwrap();
        let link = dir.path().join("link-to-sidecar");
        symlink(&real, &link).unwrap();
        let loc = UnvalidatedSidecarLocation {
            exe: link,
            args: vec![],
        };
        let err = loc.validate(&[]).unwrap_err();
        assert!(err.contains("symlink"), "err was: {err}");
    }

    #[test]
    fn validate_with_install_root_allowlist_accepts_match() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("node-sidecar");
        std::fs::write(&exe, b"binary").unwrap();
        let loc = UnvalidatedSidecarLocation {
            exe: exe.clone(),
            args: vec![],
        };
        let validated = loc.validate(&[dir.path()]).unwrap();
        assert_eq!(validated.exe, exe);
    }

    #[test]
    fn validate_with_install_root_allowlist_rejects_outside() {
        let outside_dir = tempfile::tempdir().unwrap();
        let allowed_dir = tempfile::tempdir().unwrap();
        let exe = outside_dir.path().join("node-sidecar");
        std::fs::write(&exe, b"binary").unwrap();
        let loc = UnvalidatedSidecarLocation {
            exe,
            args: vec![],
        };
        let err = loc.validate(&[allowed_dir.path()]).unwrap_err();
        assert!(err.contains("install root"), "err was: {err}");
    }

    /// Live spawn against a real bundled sidecar. Gated `#[ignore]` because
    /// it requires `src-tauri/binaries/node-sidecar-*` to exist and a free
    /// :3479 port. The Node probe script (`scripts/spikes/probe-launcher.mjs`)
    /// covers the end-to-end spawn + health-check path; this stub exists
    /// only to document the gating path.
    ///
    /// Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml \
    ///       --lib integrations_probe -- --ignored
    #[test]
    #[ignore]
    fn live_spawn_and_health_check() {
        panic!(
            "Live spawn is covered by scripts/spikes/probe-launcher.mjs — run \
             that instead. This stub exists only to document the gating path."
        );
    }
}
