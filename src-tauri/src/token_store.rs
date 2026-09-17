use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use keyring::Entry;
use std::path::PathBuf;

const SERVICE: &str = "tandem";
const ENTRY_NAME: &str = "auth-token";
const TOKEN_FILE_NAME: &str = "auth-token";

/// Resolve the env-paths-equivalent data directory for the token file.
/// Mirrors the Node.js `envPaths("tandem", { suffix: "" }).data` path:
///   Windows: %LOCALAPPDATA%\tandem\Data
///   macOS:   ~/Library/Application Support/tandem
///   Linux:   ~/.local/share/tandem
fn data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir().map(|d| d.join("tandem").join("Data"))
    }
    #[cfg(target_os = "macos")]
    {
        dirs::data_dir().map(|d| d.join("tandem"))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        dirs::data_local_dir().map(|d| d.join("tandem"))
    }
}

fn token_file_path() -> Option<PathBuf> {
    data_dir().map(|d| d.join(TOKEN_FILE_NAME))
}

fn read_from_file() -> Option<String> {
    let path = token_file_path()?;
    let content = std::fs::read_to_string(&path).ok()?;
    let trimmed = content.trim().to_string();
    if trimmed.is_empty() { None } else { Some(trimmed) }
}

fn write_to_file(token: &str) -> Result<(), String> {
    let path = token_file_path().ok_or("Cannot resolve data dir")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    std::fs::write(&path, token).map_err(|e| format!("write failed: {e}"))?;

    // Restrict to owner on POSIX; on Windows, directory ACL inheritance applies.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod failed: {e}"))?;
    }

    Ok(())
}

fn generate_token() -> String {
    // 32 bytes of OS randomness encoded as base64url without padding = 43 chars.
    // rand 0.9+: `thread_rng` is `rng`, and the `Rng` trait carries `fill_bytes`.
    use rand::Rng;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Return the auth token, creating one if none exists.
///
/// Priority:
///   1. Keyring (native secure storage — Windows Credential Manager / macOS Keychain)
///   2. Env-paths file (fallback for Linux CI or locked-down environments)
///   3. Generate, persist to keyring or file, return.
pub fn get_or_create_token() -> Result<String, String> {
    // `Entry::new` fails when the platform credential store could not be
    // initialised at all (keyring 4's one-time `set_credential_store()`).
    // Propagating that used to skip steps 2 and 3 entirely, so the desktop
    // started token-less and no token file was ever written — the docblock's
    // stated priority order was a fiction. Fall through instead (#1761).
    match Entry::new(SERVICE, ENTRY_NAME) {
        Ok(entry) => token_with_keyring(&entry),
        Err(e) => {
            let status = match Entry::store_status() {
                Ok(()) => "credential store reports available".to_string(),
                Err(s) => s.to_string(),
            };
            eprintln!(
                "[tandem] keyring unavailable ({e}; credential store: {status}) — using the token file"
            );
            token_from_file_or_generate()
        }
    }
}

/// Steps 1–3 with a usable keyring entry.
fn token_with_keyring(entry: &Entry) -> Result<String, String> {
    // 1. Try keyring.
    match entry.get_password() {
        Ok(token) if !token.trim().is_empty() => return Ok(token),
        Ok(_) => {} // empty keyring entry — treat as missing
        Err(keyring::Error::NoEntry) => {
            // token not yet stored — fall through to file or generate
        }
        Err(e) => {
            eprintln!("[tandem] keyring read failed (falling through to file): {e}");
        }
    }

    // 2. Try env-paths file.
    if let Some(token) = read_from_file() {
        return Ok(token);
    }

    // 3. Generate a fresh token and persist it.
    let token = generate_token();

    // Try keyring first; fall back to file if unavailable.
    if entry.set_password(&token).is_err() {
        write_to_file(&token)?;
    }

    Ok(token)
}

/// Steps 2–3 when there is no credential store to talk to at all.
fn token_from_file_or_generate() -> Result<String, String> {
    if let Some(token) = read_from_file() {
        return Ok(token);
    }

    let token = generate_token();
    write_to_file(&token)?;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A secret written by one `Entry` must be readable by a *second* `Entry`
    /// constructed from the same service+account pair. A single-`Entry`
    /// set-then-get passes against any per-instance in-memory backend, which
    /// is exactly the failure #1761 was originally filed against.
    #[test]
    fn keyring_round_trips_across_entry_instances() {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        assert!(
            Entry::store_status().is_ok(),
            "the platform credential store must initialise on windows/macos: {:?}",
            Entry::store_status()
        );

        // Capability gate, not a quarantine: ubuntu CI runners have no Secret
        // Service. The windows/macos legs are covered by the assertion above.
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        if Entry::store_status().is_err() {
            eprintln!(
                "[tandem] skipping keyring round-trip: no credential store on this target ({:?})",
                Entry::store_status()
            );
            return;
        }

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let service = "tandem-roundtrip-test";
        let account = format!("{}-{}", std::process::id(), nanos);
        let secret = "round-trip-value";

        let writer = Entry::new(service, &account)
            .expect("Entry::new must succeed once the credential store is available");

        if let Err(e) = writer.set_password(secret) {
            let message = e.to_string();
            // `NoStorageAccess` only — a locked or headless login keychain is a
            // runner fact `store_status()` cannot detect. `PlatformFailure` is
            // the variant a genuinely broken store also takes, so it must fail.
            if message.contains("Couldn't access platform storage:") {
                eprintln!(
                    "[tandem] skipping keyring round-trip: platform storage is not accessible ({message})"
                );
                return;
            }
            panic!("set_password failed: {message}");
        }
        drop(writer);

        let reader = Entry::new(service, &account)
            .expect("a second Entry::new for the same pair must succeed");
        let read_back = reader.get_password();
        // Cleanup runs before the assertion so a red run leaves nothing behind
        // in the operator's Credential Manager / login keychain.
        let _ = reader.delete_credential();

        assert_eq!(
            read_back.expect("the second Entry must read the secret the first one wrote"),
            secret
        );
    }
}
