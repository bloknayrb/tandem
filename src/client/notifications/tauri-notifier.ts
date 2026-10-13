import {
  clearAttention,
  type InvokeFn,
  notifyChatReply,
  requestAttention,
} from "../tauri/notifications-invoke";
import type { NotificationText, NotifierBackend } from "./chat-attention";

/**
 * Desktop backend (#2168): the OS notification and the taskbar flash, both via
 * app-defined commands in `src-tauri/src/notifications.rs`.
 *
 * A click is not reported through `notify`'s callback: the Rust click handler
 * focuses the window (as a user-presence signal) and emits the payload-free
 * `notification-activated` event, which `App.svelte` routes to
 * `ChatAttention.notificationActivated()`.
 *
 * `clearAttention` withdraws the request explicitly (`clear_attention`) once
 * the user is back. Focusing stops the Windows flash and the macOS bounce on
 * its own; the Linux urgency hint is the case that needs it, since tao clears
 * that only when asked.
 */
export function createTauriNotifier(getInvoke: () => Promise<InvokeFn>): NotifierBackend {
  const warn = (what: string) => (err: unknown) => {
    console.warn(`[notifications] ${what} failed:`, err);
  };
  return {
    notify(text: NotificationText) {
      void getInvoke()
        .then((invoke) => notifyChatReply(invoke, text.title, text.body))
        .catch(warn("notify_chat_reply"));
    },
    attention() {
      void getInvoke()
        .then((invoke) => requestAttention(invoke))
        .catch(warn("request_attention"));
    },
    clearAttention() {
      void getInvoke()
        .then((invoke) => clearAttention(invoke))
        .catch(warn("clear_attention"));
    },
  };
}
