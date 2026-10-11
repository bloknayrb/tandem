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

/// Bidi controls and zero-width characters: invisible, and able to reorder or
/// disguise the visible text (a file name carrying U+202E reads backwards).
/// `char::is_control` covers only category Cc, so these need naming.
fn is_invisible_format(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}'
    )
}

/// Trim, drop control characters (newlines become spaces) and invisible format
/// characters, and cap at `max` characters with an ellipsis. Character-based,
/// so a cap never splits a code point.
fn clean(text: &str, max: usize) -> String {
    let flattened: String = text
        .chars()
        .filter(|c| !is_invisible_format(*c))
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

/// Escape the three characters a freedesktop notification server reads as
/// markup. The spec lets a server parse `<b>`, `<a href>` and `<img>` in the
/// body (and dunst parses the summary too), so without this a reply previewed
/// into a notification could render as a clickable link attributed to Tandem.
/// Linux/BSD only: Windows sets the toast text as inner text and macOS takes
/// plain text, so escaping there would show literal entities.
fn escape_markup(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

/// What reaches the notification server on this platform.
fn for_platform(text: String) -> String {
    if cfg!(all(unix, not(target_os = "macos"))) {
        escape_markup(&text)
    } else {
        text
    }
}

/// Post a chat-reply notification. Posted without a sound: the client plays
/// its own chime, so an OS sound would double it.
#[tauri::command]
pub async fn notify_chat_reply(
    app: AppHandle,
    title: String,
    body: String,
) -> Result<(), &'static str> {
    // Cap first, then escape: the caps count visible characters.
    let title = for_platform(clean(&title, MAX_TITLE_CHARS));
    let body = for_platform(clean(&body, MAX_BODY_CHARS));
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
    fn clean_drops_bidi_and_zero_width_characters() {
        assert_eq!(
            clean("report\u{202E}dm.exe\u{200B}\u{2066}x\u{FEFF}", 120),
            "reportdm.exex"
        );
    }

    #[test]
    fn escape_markup_neutralises_tags_and_entities() {
        assert_eq!(
            escape_markup(r#"<a href="https://x">sign in</a> & <img src=y>"#),
            r#"&lt;a href="https://x"&gt;sign in&lt;/a&gt; &amp; &lt;img src=y&gt;"#
        );
    }

    #[test]
    fn for_platform_escapes_only_on_freedesktop_servers() {
        let out = for_platform("<b>x</b>".to_owned());
        if cfg!(all(unix, not(target_os = "macos"))) {
            assert_eq!(out, "&lt;b&gt;x&lt;/b&gt;");
        } else {
            assert_eq!(out, "<b>x</b>");
        }
    }

    #[test]
    fn clean_does_not_leave_a_space_before_the_ellipsis() {
        assert_eq!(clean("abcd efgh", 6), "abcd…");
    }
}
