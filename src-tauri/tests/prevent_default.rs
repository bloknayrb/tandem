//! Regression test for #541 — verifies the prevent-default plugin is configured
//! with the correct flag set: blocks only reload shortcuts (F5, Ctrl+F5, Shift+F5,
//! Ctrl+R, Ctrl+Shift+R); DevTools, Find, Print, and right-click are preserved.
//!
//! Calls `prevent_default_flags()` from lib.rs — the same function that
//! `with_flags()` receives — so flag-expression changes in lib.rs are caught.
//!
//! Limitation: validates the flag configuration, not actual webview interception
//! (which requires a live Tauri WebView). Removing `with_flags()` from the
//! builder call would not be caught by this test.

use app_lib::prevent_default_flags;
use tauri_plugin_prevent_default::Flags;

#[test]
fn prevent_default_plugin_registered_with_correct_flags() {
    let blocked = prevent_default_flags();
    assert_eq!(
        blocked,
        Flags::RELOAD,
        "Only RELOAD must be blocked — Find, Print, context menu, and DevTools must remain accessible"
    );
}
