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

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, UserAttentionType};
use tauri_plugin_notification::{Action, ActionType, NotificationExt};

/// Payload-free nudge to the WebView: "a notification was clicked". The
/// document to open is held client-side — no document id crosses IPC.
pub const ACTIVATED_EVENT: &str = "notification-activated";

/// The one error string these commands return. There is no client contract on
/// it: no client code branches on the value, and the callers in
/// `src/client/notifications/` only log a rejection. It exists so the OS error
/// text, which can carry a path, is logged here and never crosses IPC.
pub const ERR_UNAVAILABLE: &str = "notification-unavailable";

/// Fixed notification ids, so a click can tell which kind of notification it
/// came from. The plugin serialises the builder's data — id included — into the
/// payload a click reports, on all three desktops. Without an explicit id the
/// plugin picks a random one, which could collide with the test id.
pub const CHAT_REPLY_ID: i32 = 2168;
/// The Settings "send a test notification" toast. Its click focuses the window
/// but never reaches the chat dispatcher: there is no reply to open.
pub const TEST_NOTIFICATION_ID: i32 = 2169;

/// The action type a chat-reply notification references on macOS, and its one
/// action: an "Open chat" button.
///
/// macOS reports a click only for a notification that has an action button.
/// notify-rust 4.18 never asks mac-notification-sys to wait for a click on an
/// action-less notification, so the plugin sees it expire after at most 2 s and
/// reports nothing — not even a click on the body. With exactly one action,
/// notify-rust sets it as the main button, mac-notification-sys waits for the
/// user, and both a body click (`"tap"`) and the button (`OPEN_CHAT_ACTION_ID`)
/// are reported.
///
/// Registered on every platform (a registered type is inert until a
/// notification references it) but referenced only on macOS: on Windows and
/// Linux a click is already reported, and the type would add a visible button.
/// The id must not be `default` or `tap`, which the plugin uses for a click on
/// the notification itself.
pub const CHAT_REPLY_ACTION_TYPE: &str = "tandem-chat-reply";
pub const OPEN_CHAT_ACTION_ID: &str = "open-chat";
/// macOS tells actions apart by their title, so it must be unique in the type.
const OPEN_CHAT_ACTION_TITLE: &str = "Open chat";

/// Whether a chat-reply notification with the action button is outstanding.
///
/// That notification is not free on macOS: mac-notification-sys parks a thread
/// on it, plus a 0.5 s poll on the main run loop, until it is clicked or leaves
/// Notification Centre. Tandem cannot see a dismissal, and the plugin's
/// `remove_active` does nothing on macOS. So only the first chat notification
/// of an absence carries the button — later ones in the same absence post
/// action-less and cost at most a 2 s delivery wait — and the main window
/// gaining focus removes Tandem's delivered notifications, which releases the
/// waiter (`on_main_window_focused`). At most one waits at a time.
///
/// Never claimed off macOS (`should_attach_action`), so there it stays false.
static MAC_ACTION_OUTSTANDING: AtomicBool = AtomicBool::new(false);

/// Whether this chat-reply notification carries the action button. On macOS it
/// claims `outstanding` when it does, so of any number of concurrent posts in
/// one absence exactly one wins. Off macOS it never touches the flag.
///
/// `is_macos` is a parameter (`cfg!`, never `#[cfg]`) so the decision compiles
/// and is tested on every platform.
fn should_attach_action(is_macos: bool, outstanding: &AtomicBool) -> bool {
    is_macos
        && outstanding
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
}

/// Let the next chat notification carry the action button again. Returns
/// whether one was outstanding.
fn release_action(outstanding: &AtomicBool) -> bool {
    outstanding.swap(false, Ordering::SeqCst)
}

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
/// The title is never escaped (see `title_for_platform`).
fn body_for_platform(text: String) -> String {
    if cfg!(all(unix, not(target_os = "macos"))) {
        escape_markup(&text)
    } else {
        text
    }
}

/// The title as it reaches the notification server on this platform.
///
/// Never escaped: the freedesktop spec defines the summary as plain text, and
/// GNOME Shell and KDE Plasma escape it themselves, so pre-escaping it showed a
/// literal `&amp;` in the title. But a server that parses summary markup
/// against the spec would render a `<…>` in a file name as a tag, so on
/// Linux/BSD `<` and `>` become the look-alike `‹` (U+2039) and `›` (U+203A),
/// with which no tag can form. `&` is kept, for the servers that escape it;
/// without `<` an entity can only ever decode to text. Windows and macOS take
/// plain text, so the title passes through unchanged there.
fn title_for_platform(text: String) -> String {
    if cfg!(all(unix, not(target_os = "macos"))) {
        text.chars()
            .map(|c| match c {
                '<' => '\u{2039}',
                '>' => '\u{203A}',
                _ => c,
            })
            .collect()
    } else {
        text
    }
}

/// The title and body as they are handed to the plugin: both cleaned and
/// capped, then adapted to this platform's notification server. Cap first,
/// then escape: the caps count visible characters.
fn prepare(title: &str, body: &str) -> (String, String) {
    (
        title_for_platform(clean(title, MAX_TITLE_CHARS)),
        body_for_platform(clean(body, MAX_BODY_CHARS)),
    )
}

/// Post `title`/`body` with the fixed `id`, referencing `action_type` when
/// given. Posted without a sound: the client plays its own chime, so an OS
/// sound would double it. `what` names the notification kind in the log line,
/// which never carries the text itself.
fn post(
    app: &AppHandle,
    id: i32,
    title: &str,
    body: &str,
    action_type: Option<&str>,
    what: &str,
) -> Result<(), &'static str> {
    let (title, body) = prepare(title, body);
    let mut builder = app.notification().builder().id(id).title(title);
    if !body.is_empty() {
        builder = builder.body(body);
    }
    if let Some(action_type) = action_type {
        builder = builder.action_type_id(action_type);
    }
    builder.show().map_err(|e| {
        log::warn!("{what} notification failed: {e}");
        ERR_UNAVAILABLE
    })
}

/// Post a chat-reply notification. On macOS the first one of an absence
/// carries the "Open chat" action, so its click is reported (see
/// `CHAT_REPLY_ACTION_TYPE` and `MAC_ACTION_OUTSTANDING`).
#[tauri::command]
pub async fn notify_chat_reply(
    app: AppHandle,
    title: String,
    body: String,
) -> Result<(), &'static str> {
    let with_action = should_attach_action(cfg!(target_os = "macos"), &MAC_ACTION_OUTSTANDING);
    let action_type = with_action.then_some(CHAT_REPLY_ACTION_TYPE);
    let result = post(
        &app,
        CHAT_REPLY_ID,
        &title,
        &body,
        action_type,
        "chat-reply",
    );
    // Nothing was shown, so nothing waits: let the next post carry the button.
    // A failure later, on the plugin's own thread, is not seen here; the flag
    // then stays claimed until the window is focused, which only costs this
    // absence its click reporting.
    if with_action && result.is_err() {
        let _ = release_action(&MAC_ACTION_OUTSTANDING);
    }
    result
}

/// Post the Settings test notification: fixed text, through the same cleaning
/// and escaping path as a real reply, with the test id so a reported click
/// only focuses the window (see `routes_click`). It carries no action, so on
/// macOS no click on it is reported at all (see `CHAT_REPLY_ACTION_TYPE`).
#[tauri::command]
pub async fn notify_test(app: AppHandle) -> Result<(), &'static str> {
    post(
        &app,
        TEST_NOTIFICATION_ID,
        TEST_TITLE,
        TEST_BODY,
        None,
        "test",
    )
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

/// The main window gained focus: the user is back. Release the macOS action
/// claim and, if a notification carrying it was outstanding, end the wait
/// parked on it (see `MAC_ACTION_OUTSTANDING`). Called from the native window
/// event, so it holds however the client's own attention state stands.
pub fn on_main_window_focused(app: &AppHandle) {
    if release_action(&MAC_ACTION_OUTSTANDING) {
        remove_delivered_notifications(app);
    }
}

/// Remove every notification Tandem has delivered from Notification Centre.
///
/// mac-notification-sys's wait on an actionable notification ends when a
/// 0.5 s poll finds it gone from `deliveredNotifications`, so this releases the
/// parked thread, and clears replies the user has now seen. It goes through
/// `NSUserNotificationCenter` directly because the plugin's `remove_active` is
/// a no-op on macOS. The API is deprecated in favour of UserNotifications, but
/// it is the one mac-notification-sys (and so notify-rust 4.18) posts through,
/// so it is the centre holding these notifications.
///
/// Dispatched to the main thread: the poll that reads `deliveredNotifications`
/// runs on the main run loop, and this keeps the removal serialised with it.
/// Fire-and-forget, so a reply posted between the flag release and this
/// running can be removed as it lands; that costs its click reporting, never
/// an unbounded wait. A click racing the removal still wins: mac-notification-sys
/// drains queued delegate callbacks before reading a disappearance as a
/// dismissal. In a dev build mac-notification-sys posts as Terminal
/// (`com.apple.Terminal`), so this may clear Terminal's delivered notifications
/// too.
#[cfg(target_os = "macos")]
fn remove_delivered_notifications(app: &AppHandle) {
    let dispatched = app.run_on_main_thread(|| {
        #[allow(deprecated)]
        objc2_foundation::NSUserNotificationCenter::defaultUserNotificationCenter()
            .removeAllDeliveredNotifications();
    });
    if let Err(e) = dispatched {
        log::warn!("removing delivered notifications failed: {e}");
    }
}

/// Elsewhere nothing waits on a delivered notification, and the OS keeps its
/// own notification history (Windows Action Center, the Linux server).
#[cfg(not(target_os = "macos"))]
fn remove_delivered_notifications(_app: &AppHandle) {}

/// Whether `action_id` asks to open Tandem: a click on the notification itself
/// (`"tap"`, which the plugin also reports for a freedesktop `default` action)
/// or the macOS "Open chat" button.
fn is_open_action(action_id: &str) -> bool {
    action_id == "tap" || action_id == OPEN_CHAT_ACTION_ID
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
/// Also registers the chat-reply action type, before any notification can
/// reference it.
///
/// Windows reports a click only while the toast is on screen, not from the
/// Action Center. macOS reports one only for a notification with an action
/// button (see `CHAT_REPLY_ACTION_TYPE`).
pub fn register_click_handler(app: &AppHandle) {
    let action_types = vec![ActionType::builder(CHAT_REPLY_ACTION_TYPE)
        .actions(vec![Action::builder(
            OPEN_CHAT_ACTION_ID,
            OPEN_CHAT_ACTION_TITLE,
        )
        .build()])
        .build()];
    if let Err(e) = app.notification().register_action_types(action_types) {
        log::warn!("notification action types not registered: {e}");
    }

    let handle = app.clone();
    let registered = app.notification().on_action(move |action| {
        if !is_open_action(action.action_id()) {
            return;
        }
        // A human clicked: this is a presence signal, not a mechanical show —
        // for the test notification too.
        crate::show_main_window_for_user(&handle);
        if !routes_click(action.notification().map(|n| n.id())) {
            return;
        }
        // A reported chat-reply click on macOS is the actionable one, and its
        // wait has just ended.
        let _ = release_action(&MAC_ACTION_OUTSTANDING);
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
    fn the_title_is_never_escaped_and_loses_its_angle_brackets_on_freedesktop() {
        let (title, body) = prepare("Q&A <draft>.md", "a & b");
        if cfg!(all(unix, not(target_os = "macos"))) {
            assert_eq!(title, "Q&A \u{2039}draft\u{203A}.md");
            assert_eq!(body, "a &amp; b");
        } else {
            assert_eq!(title, "Q&A <draft>.md");
            assert_eq!(body, "a & b");
        }
    }

    #[test]
    fn title_for_platform_keeps_ampersands_and_only_swaps_angle_brackets() {
        let out = title_for_platform(r#"<a href="x">&amp;</a>"#.to_owned());
        if cfg!(all(unix, not(target_os = "macos"))) {
            assert_eq!(out, "\u{2039}a href=\"x\"\u{203A}&amp;\u{2039}/a\u{203A}");
            assert!(!out.contains('<') && !out.contains('>'));
        } else {
            assert_eq!(out, r#"<a href="x">&amp;</a>"#);
        }
    }

    #[test]
    fn only_macos_attaches_the_action_and_only_once_per_claim() {
        let flag = AtomicBool::new(false);
        // Off macOS: never attached, and the flag is never claimed.
        assert!(!should_attach_action(false, &flag));
        assert!(!flag.load(Ordering::SeqCst));
        // macOS: the first post wins, the rest of the absence post action-less.
        assert!(should_attach_action(true, &flag));
        assert!(flag.load(Ordering::SeqCst));
        assert!(!should_attach_action(true, &flag));
        assert!(!should_attach_action(false, &flag));
        // Released (focus, accepted click or failed post): the next one wins
        // again, and the release reports whether one was outstanding.
        assert!(release_action(&flag));
        assert!(!release_action(&flag));
        assert!(should_attach_action(true, &flag));
        assert!(!should_attach_action(true, &flag));
    }

    #[test]
    fn only_a_body_click_or_the_open_chat_button_opens_tandem() {
        assert!(is_open_action("tap"));
        assert!(is_open_action(OPEN_CHAT_ACTION_ID));
        assert!(!is_open_action("default"));
        assert!(!is_open_action(""));
        assert!(!is_open_action(OPEN_CHAT_ACTION_TITLE));
        assert!(!is_open_action("__closed"));
        // The type id is not an action id the plugin reports as a click.
        assert!(!is_open_action(CHAT_REPLY_ACTION_TYPE));
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
