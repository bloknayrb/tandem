//! Integration tests for the `keychain` Tauri commands.
//!
//! The real `keyring` crate calls require platform-specific services
//! (`libsecret` on Linux, Keychain Services on macOS, Credential Manager on
//! Windows) that CI runners don't always provide and that would pollute the
//! developer's real keyring during local test runs. These tests focus on
//! the **input-validation** path that runs entirely before the keyring
//! crate is touched — empty account, empty secret. The rest of the surface
//! is covered by:
//!   - Client-side mocks in `tests/client/keychain-backend.test.ts`
//!   - Manual verification on Tauri dev builds (set/get/delete a real secret)

use app_lib::keychain::{keychain_delete, keychain_get, keychain_set};

#[test]
fn keychain_get_rejects_empty_account() {
    let err = keychain_get(String::new()).unwrap_err();
    assert!(err.contains("account is required"), "got: {err}");
}

#[test]
fn keychain_set_rejects_empty_account() {
    let err = keychain_set(String::new(), "secret".to_string()).unwrap_err();
    assert!(err.contains("account is required"), "got: {err}");
}

#[test]
fn keychain_set_rejects_empty_secret() {
    // Non-empty account, empty secret — the secret check runs after the
    // account check passes, so this exercises the secret-validation branch.
    let err = keychain_set("test-account".to_string(), String::new()).unwrap_err();
    assert!(err.contains("secret must be non-empty"), "got: {err}");
}

#[test]
fn keychain_delete_rejects_empty_account() {
    let err = keychain_delete(String::new()).unwrap_err();
    assert!(err.contains("account is required"), "got: {err}");
}
