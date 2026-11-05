/**
 * Typed wrappers around the chat-reply notification commands (#2168).
 *
 * App-defined commands (`src-tauri/src/notifications.rs`), not the
 * `tauri-plugin-notification` JS API: no npm dependency, and the Rust side owns
 * the click handler so a click can release a deferred launcher. Each wrapper
 * takes an `InvokeFn` so vitest can stub the call.
 *
 * Note the plugin still injects its own `window.Notification` into the
 * WebView, so desktop code must pick this backend by `isTauriRuntime()`, never
 * by feature-detecting `Notification`.
 */

import { type InvokeFn, loadInvoke } from "../cowork/cowork-invoke";

export type { InvokeFn };
export { loadInvoke };

/**
 * The event `notifications.rs` emits when a notification is clicked. Its only
 * payload is the kind (`NotificationKind::as_str`) — never a document id,
 * annotation id or any text.
 */
export const NOTIFICATION_ACTIVATED_EVENT = "notification-activated";

/**
 * The payload of a click on a comment-answer notification (#2360). Any other
 * payload routes to chat. Pinned against the Rust `as_str` arm by
 * `tests/docs/startup-open-failure-wiring-claims.test.ts`.
 */
export const NOTIFICATION_KIND_COMMENT = "comment";

export function notifyChatReply(invoke: InvokeFn, title: string, body: string): Promise<void> {
  return invoke<void>("notify_chat_reply", { title, body });
}

/** #2360: "Claude replied to your comment" — posted under its own id. */
export function notifyCommentAnswer(invoke: InvokeFn, title: string, body: string): Promise<void> {
  return invoke<void>("notify_comment_answer", { title, body });
}

export function requestAttention(invoke: InvokeFn): Promise<void> {
  return invoke<void>("request_attention");
}

/** Withdraw a `requestAttention` flash once the reply has been seen. */
export function clearAttention(invoke: InvokeFn): Promise<void> {
  return invoke<void>("clear_attention");
}

/**
 * Post the fixed-text Settings test notification. Its click focuses the window
 * but emits no `notification-activated` event: there is no reply to open.
 */
export function notifyTest(invoke: InvokeFn): Promise<void> {
  return invoke<void>("notify_test");
}
