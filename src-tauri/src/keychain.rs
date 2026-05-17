// Native OS keychain access for integration auth tokens (#477 PR 3c-tauri-keychain).
//
// PR 3c-i shipped the wizard with an HTTP-based keychain backend
// (`@napi-rs/keyring` running in the Node sidecar). On the Tauri desktop
// build that backend fails because `@napi-rs/keyring` ships platform-specific
// `.node` binaries that aren't bundled into the sidecar's self-contained
// JavaScript bundle. The wizard falls back to "set TANDEM_INTEGRATION_*_TOKEN
// as an env var" guidance — usable but clunky.
//
// This module exposes the Rust `keyring` crate (already a dep, used by
// `token_store.rs` for the auth token) as three Tauri commands the WebView
// can invoke directly. The client routes around the sidecar entirely when
// `isTauriRuntime()` is true, so secrets never traverse the
// `localhost:3479` HTTP boundary at all on the desktop app.
//
// Service namespace: `tandem-integrations` (matches `KEYCHAIN_SERVICE`
// from `src/server/integrations/keychain.ts` so the npm CLI path and the
// Tauri path can share keychain entries when a user runs both).
//
// Errors are wrapped as `String` per Tauri command convention. Distinct
// error prefixes (`keychain-init`, `keychain-get`, `keychain-set`,
// `keychain-delete`) let the client surface different UX without parsing
// the underlying OS error.

use keyring::Entry;

const SERVICE: &str = "tandem-integrations";

fn make_entry(account: &str) -> Result<Entry, String> {
    if account.is_empty() {
        return Err("keychain-init: account is required".to_string());
    }
    Entry::new(SERVICE, account).map_err(|e| format!("keychain-init: {e}"))
}

/// Read the secret stored under `account`. Returns `None` if no entry exists.
/// `null` distinguishes "no secret" from "keychain unavailable" — only the
/// latter throws an error.
#[tauri::command]
pub fn keychain_get(account: String) -> Result<Option<String>, String> {
    let entry = make_entry(&account)?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain-get: {e}")),
    }
}

/// Store or overwrite a secret under `account`. The `secret` must be
/// non-empty — the OS keychain accepts empty strings on some platforms but
/// it always indicates a bug in the caller, so reject early.
#[tauri::command]
pub fn keychain_set(account: String, secret: String) -> Result<(), String> {
    if secret.is_empty() {
        return Err("keychain-set: secret must be non-empty".to_string());
    }
    let entry = make_entry(&account)?;
    entry
        .set_password(&secret)
        .map_err(|e| format!("keychain-set: {e}"))
}

/// Remove the secret stored under `account`. Returns `true` if one existed
/// and was removed, `false` if there was nothing to delete.
#[tauri::command]
pub fn keychain_delete(account: String) -> Result<bool, String> {
    let entry = make_entry(&account)?;
    match entry.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("keychain-delete: {e}")),
    }
}
