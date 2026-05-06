//! Regression test for #541 — verifies the prevent-default plugin is configured
//! with the correct flag set: blocks reload shortcuts, keeps DevTools.
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
    assert!(
        blocked.contains(Flags::RELOAD),
        "RELOAD flag must be blocked"
    );
    assert!(
        !blocked.contains(Flags::DEV_TOOLS),
        "DEV_TOOLS flag must NOT be blocked (DevTools must remain accessible)"
    );
}
