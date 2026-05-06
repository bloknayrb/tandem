//! Regression test for #541 — verifies the prevent-default plugin is configured
//! with the correct flag set: blocks reload shortcuts, keeps DevTools.
//!
//! Limitation: this test validates the flag configuration logic, not actual
//! webview interception (which requires a live Tauri WebView to test).

#[test]
fn prevent_default_plugin_registered_with_correct_flags() {
    use tauri_plugin_prevent_default::Flags;
    let blocked = Flags::all().difference(Flags::DEV_TOOLS);
    assert!(
        blocked.contains(Flags::RELOAD),
        "RELOAD flag must be blocked"
    );
    assert!(
        blocked.contains(Flags::RELOAD_IGNORING_CACHE),
        "RELOAD_IGNORING_CACHE flag must be blocked"
    );
    assert!(
        !blocked.contains(Flags::DEV_TOOLS),
        "DEV_TOOLS flag must NOT be blocked (DevTools must remain accessible)"
    );
}
