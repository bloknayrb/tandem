import { type InvokeFn, notifyChatReply, requestAttention } from "../tauri/notifications-invoke";
import type { NotificationText, NotifierBackend } from "./chat-attention";

/**
 * Desktop backend (#2168): the OS notification and the taskbar flash, both via
 * app-defined commands in `src-tauri/src/notifications.rs`.
 *
 * A click is not reported through `notify`'s callback: the Rust click handler
 * focuses the window (as a user-presence signal) and emits the payload-free
 * `notification-activated` event, which `App.svelte` routes to
 * `ChatAttention.notificationActivated()`. The flash clears itself when the
 * window is focused, so `clearAttention` has nothing to do.
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
    clearAttention() {},
  };
}
