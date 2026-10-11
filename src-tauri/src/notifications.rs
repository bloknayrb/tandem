//! Chat-reply notifications (#2168): the OS notification and the taskbar flash
//! the client asks for when a Claude reply arrives while Tandem is unfocused.
//!
//! App-defined commands over `tauri-plugin-notification` rather than its JS
//! API, for the same reasons as `autostart.rs`, plus one of its own: the
//! notification click has to call `show_main_window_for_user`, which is what
//! releases a launcher deferred by an autostart launch. A JS `onAction` could
//! only reach the mechanical `show_main_window` path, if any.
//!
//! **Nothing here logs a title or body.** They can carry a document name or a
//! preview of the reply, and the log directory is attached to bug reports.
//!
//! Decisions about *whether* to notify — focus, settings, coalescing, history
//! replay — are the client's (`src/client/notifications/`). This module only
//! posts what it is handed.

use tauri::{AppHandle, Emitter, Manager, UserAttentionType};
use tauri_plugin_notification::NotificationExt;

/// Payload-free nudge to the WebView: "a notification was clicked". The
/// document to open is held client-side — no document id crosses IPC.
pub const ACTIVATED_EVENT: &str = "notification-activated";

/// Path-free error code. The cross-process contract with
/// `src/client/tauri/notifications-invoke.ts`.
pub const ERR_UNAVAILABLE: &str = "notification-unavailable";

/// Caps, in characters. OS notification surfaces truncate long text anyway;
/// these keep an oversized payload from reaching the notification server.
const MAX_TITLE_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 300;

/// Trim, drop control characters (newlines become spaces), and cap at `max`
/// characters with an ellipsis. Character-based, so a cap never splits a code
/// point.
fn clean(text: &str, max: usize) -> String {
    let flattened: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let trimmed = flattened.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_owned();
    }
    let mut out: String = trimmed.chars().take(max.saturating_sub(1)).collect();
    out.truncate(out.trim_end().len());
    out.push('…');
    out
}

/// Post a chat-reply notification. Posted without a sound: the client plays
/// its own chime, so an OS sound would double it.
#[tauri::command]
pub async fn notify_chat_reply(
    app: AppHandle,
    title: String,
    body: String,
) -> Result<(), &'static str> {
    let title = clean(&title, MAX_TITLE_CHARS);
    let body = clean(&body, MAX_BODY_CHARS);
    let mut builder = app.notification().builder().title(title);
    if !body.is_empty() {
        builder = builder.body(body);
    }
    builder.show().map_err(|e| {
        log::warn!("chat-reply notification failed: {e}");
        ERR_UNAVAILABLE
    })
}

/// Flash the taskbar button (Windows) / bounce the dock icon (macOS) until the
/// window is focused. Linux sets the urgency hint; what that looks like is up
/// to the window manager. No-op once the window is focused.
#[tauri::command]
pub async fn request_attention(app: AppHandle) -> Result<(), &'static str> {
    let Some(window) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) else {
        return Err(ERR_UNAVAILABLE);
    };
    window
        .request_user_attention(Some(UserAttentionType::Critical))
        .map_err(|e| {
            log::warn!("request_user_attention failed: {e}");
            ERR_UNAVAILABLE
        })
}

/// Register the click handler. Called once from `setup()`: notifications shown
/// before the first handler exists report nothing, and a second registration
/// would run the handler twice.
///
/// Windows reports a click only while the toast is on screen, not from the
/// Action Center.
pub fn register_click_handler(app: &AppHandle) {
    let handle = app.clone();
    let registered = app.notification().on_action(move |action| {
        if action.action_id() != "tap" {
            return;
        }
        // A human clicked: this is a presence signal, not a mechanical show.
        crate::show_main_window_for_user(&handle);
        if let Err(e) = handle.emit(ACTIVATED_EVENT, ()) {
            log::warn!("Failed to emit {ACTIVATED_EVENT}: {e}");
        }
    });
    if let Err(e) = registered {
        log::warn!("notification click handler not registered: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_trims_and_keeps_short_text() {
        assert_eq!(clean("  Claude replied  ", 120), "Claude replied");
        assert_eq!(clean("", 120), "");
    }

    #[test]
    fn clean_flattens_control_characters() {
        assert_eq!(clean("one\ntwo\tthree\r", 120), "one two three");
    }

    #[test]
    fn clean_caps_with_an_ellipsis_at_exactly_max_chars() {
        let out = clean(&"a".repeat(500), 10);
        assert_eq!(out.chars().count(), 10);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn clean_never_splits_a_code_point() {
        let out = clean(&"é🙂".repeat(100), 7);
        assert_eq!(out.chars().count(), 7);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn clean_does_not_leave_a_space_before_the_ellipsis() {
        assert_eq!(clean("abcd efgh", 6), "abcd…");
    }
}
