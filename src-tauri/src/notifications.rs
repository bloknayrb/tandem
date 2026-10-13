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

/// Fixed notification ids, so a click can tell which kind of notification it
/// came from. The plugin serialises the builder's data — id included — into the
/// payload a click reports, on all three desktops. Without an explicit id the
/// plugin picks a random one, which could collide with the test id.
pub const CHAT_REPLY_ID: i32 = 2168;
/// The Settings "send a test notification" toast. Its click focuses the window
/// but never reaches the chat dispatcher: there is no reply to open.
pub const TEST_NOTIFICATION_ID: i32 = 2169;

/// The fixed text of the test notification. Written to read like a real one,
/// so what the user sees is what a reply will look like.
const TEST_TITLE: &str = "Claude replied";
const TEST_BODY: &str = "This is a test notification from Tandem.";

/// Caps, in characters. OS notification surfaces truncate long text anyway;
/// these keep an oversized payload from reaching the notification server.
const MAX_TITLE_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 300;

/// Bidi controls and zero-width characters: invisible, and able to reorder or
/// disguise the visible text (a file name carrying U+202E reads backwards).
/// `char::is_control` covers only category Cc, so these need naming. U+061C
/// (ARABIC LETTER MARK) is a bidi control outside the U+200x blocks.
fn is_invisible_format(c: char) -> bool {
    matches!(
        c,
        '\u{061C}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

/// Characters that break a line: the Cc controls plus LINE SEPARATOR and
/// PARAGRAPH SEPARATOR (category Zl/Zp, so `is_control` misses them).
fn is_line_breaking(c: char) -> bool {
    c.is_control() || c == '\u{2028}' || c == '\u{2029}'
}

/// Trim, drop control and line-separator characters (newlines become spaces)
/// and invisible format characters, and cap at `max` characters with an
/// ellipsis. Character-based, so a cap never splits a code point.
fn clean(text: &str, max: usize) -> String {
    let flattened: String = text
        .chars()
        .filter(|c| !is_invisible_format(*c))
        .map(|c| if is_line_breaking(c) { ' ' } else { c })
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
/// body, so without this a reply previewed into a notification could render as
/// a clickable link attributed to Tandem.
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

/// The body as it reaches the notification server on this platform. Linux/BSD
/// only: Windows sets the toast text as inner text and macOS takes plain text,
/// so escaping there would show literal entities.
///
/// The title is never escaped, on any platform. The freedesktop spec defines
/// the summary as plain text, and GNOME Shell and KDE Plasma escape it
/// themselves, so pre-escaping it showed a literal `&amp;` in the title.
fn body_for_platform(text: String) -> String {
    if cfg!(all(unix, not(target_os = "macos"))) {
        escape_markup(&text)
    } else {
        text
    }
}

/// The title and body as they are handed to the plugin: both cleaned and
/// capped, the body alone escaped. Cap first, then escape: the caps count
/// visible characters.
fn prepare(title: &str, body: &str) -> (String, String) {
    (
        clean(title, MAX_TITLE_CHARS),
        body_for_platform(clean(body, MAX_BODY_CHARS)),
    )
}

/// Post `title`/`body` with the fixed `id`. Posted without a sound: the client
/// plays its own chime, so an OS sound would double it. `what` names the
/// notification kind in the log line, which never carries the text itself.
fn post(app: &AppHandle, id: i32, title: &str, body: &str, what: &str) -> Result<(), &'static str> {
    let (title, body) = prepare(title, body);
    let mut builder = app.notification().builder().id(id).title(title);
    if !body.is_empty() {
        builder = builder.body(body);
    }
    builder.show().map_err(|e| {
        log::warn!("{what} notification failed: {e}");
        ERR_UNAVAILABLE
    })
}

/// Post a chat-reply notification.
#[tauri::command]
pub async fn notify_chat_reply(
    app: AppHandle,
    title: String,
    body: String,
) -> Result<(), &'static str> {
    post(&app, CHAT_REPLY_ID, &title, &body, "chat-reply")
}

/// Post the Settings test notification: fixed text, through the same cleaning
/// and escaping path as a real reply, with the test id so its click only
/// focuses the window (see `routes_click`).
#[tauri::command]
pub async fn notify_test(app: AppHandle) -> Result<(), &'static str> {
    post(&app, TEST_NOTIFICATION_ID, TEST_TITLE, TEST_BODY, "test")
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

/// Withdraw an attention request once the reply has been seen. tao clears the
/// urgency hint on Linux; on Windows it sends `FLASHW_STOP`, but returns early
/// (doing nothing) when the window is already the active one, where focusing
/// has stopped the flash anyway; on macOS it has no effect — the dock bounce
/// ends when the app is activated.
#[tauri::command]
pub async fn clear_attention(app: AppHandle) -> Result<(), &'static str> {
    let Some(window) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) else {
        return Err(ERR_UNAVAILABLE);
    };
    window.request_user_attention(None).map_err(|e| {
        log::warn!("clearing user attention failed: {e}");
        ERR_UNAVAILABLE
    })
}

/// Whether a click on the notification with `id` goes to the chat dispatcher.
/// Everything but the test notification does — including a click whose
/// notification the platform could not describe, which can only be a reply's.
fn routes_click(id: Option<i32>) -> bool {
    id != Some(TEST_NOTIFICATION_ID)
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
        // A human clicked: this is a presence signal, not a mechanical show —
        // for the test notification too.
        crate::show_main_window_for_user(&handle);
        if !routes_click(action.notification().map(|n| n.id())) {
            return;
        }
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
    fn body_for_platform_escapes_only_on_freedesktop_servers() {
        let out = body_for_platform("<b>x</b> & y".to_owned());
        if cfg!(all(unix, not(target_os = "macos"))) {
            assert_eq!(out, "&lt;b&gt;x&lt;/b&gt; &amp; y");
        } else {
            assert_eq!(out, "<b>x</b> & y");
        }
    }

    #[test]
    fn the_title_is_never_escaped_and_the_body_is_escaped_where_needed() {
        let (title, body) = prepare("Q&A <draft>.md", "a & b");
        assert_eq!(title, "Q&A <draft>.md");
        if cfg!(all(unix, not(target_os = "macos"))) {
            assert_eq!(body, "a &amp; b");
        } else {
            assert_eq!(body, "a & b");
        }
    }

    #[test]
    fn clean_flattens_line_separators_and_drops_the_arabic_letter_mark() {
        assert_eq!(clean("a\u{2028}b\u{2029}c\u{061C}d", 120), "a b cd");
    }

    #[test]
    fn only_the_test_notification_skips_the_chat_dispatcher() {
        assert_ne!(CHAT_REPLY_ID, TEST_NOTIFICATION_ID);
        assert!(!routes_click(Some(TEST_NOTIFICATION_ID)));
        assert!(routes_click(Some(CHAT_REPLY_ID)));
        assert!(routes_click(None));
    }

    #[test]
    fn clean_does_not_leave_a_space_before_the_ellipsis() {
        assert_eq!(clean("abcd efgh", 6), "abcd…");
    }
}
