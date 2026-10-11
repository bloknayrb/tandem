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

/** The payload-free event `notifications.rs` emits when a notification is clicked. */
export const NOTIFICATION_ACTIVATED_EVENT = "notification-activated";

export function notifyChatReply(invoke: InvokeFn, title: string, body: string): Promise<void> {
  return invoke<void>("notify_chat_reply", { title, body });
}

export function requestAttention(invoke: InvokeFn): Promise<void> {
  return invoke<void>("request_attention");
}
