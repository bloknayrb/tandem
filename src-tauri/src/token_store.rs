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
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Return the auth token, creating one if none exists.
///
/// Priority:
///   1. Keyring (native secure storage — Windows Credential Manager / macOS Keychain)
///   2. Env-paths file (fallback for Linux CI or locked-down environments)
///   3. Generate, persist to keyring or file, return.
pub fn get_or_create_token() -> Result<String, String> {
    let entry = Entry::new(SERVICE, ENTRY_NAME).map_err(|e| format!("keyring init: {e}"))?;

    // 1. Try keyring.
    match entry.get_password() {
        Ok(token) if !token.trim().is_empty() => return Ok(token),
        Ok(_) => {} // empty keyring entry — treat as missing
        Err(_) => {} // keyring unavailable (headless Linux CI, etc.) — fall through
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
