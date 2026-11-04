import {
  clearAttention,
  type InvokeFn,
  notifyChatReply,
  notifyCommentAnswer,
  requestAttention,
} from "../tauri/notifications-invoke";
import type { NotificationKind, NotificationText, NotifierBackend } from "./chat-attention";

/**
 * Desktop backend (#2168): the OS notification and the taskbar flash, both via
 * app-defined commands in `src-tauri/src/notifications.rs`.
 *
 * A click is not reported through `notify`'s callback: the Rust click handler
 * focuses the window (as a user-presence signal) and emits the
 * `notification-activated` event, whose only payload is the kind
 * (`"chat"` / `"comment"`); `App.svelte` routes it to the matching
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
    notify(text: NotificationText, _onClick: () => void, kind: NotificationKind = "chat") {
      if (kind === "comment") {
        void getInvoke()
          .then((invoke) => notifyCommentAnswer(invoke, text.title, text.body))
          .catch(warn("notify_comment_answer"));
        return;
      }
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
