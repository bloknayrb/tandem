import { isTauriRuntime } from "../cowork/cowork-helpers";
import { loadInvoke, notifyTest } from "../tauri/notifications-invoke";
import type { NotifierBackend } from "./chat-attention";
import { TEST_NOTIFICATION_TEXT } from "./notification-text";
import { createTauriNotifier } from "./tauri-notifier";
import { createWebNotifier, postWebNotification } from "./web-notifier";

/**
 * Picks the platform half of chat-reply attention (#2168).
 *
 * The Tauri check MUST come first. `tauri-plugin-notification` replaces
 * `window.Notification` inside the WebView, so feature-detecting
 * `Notification` would route desktop calls into a plugin command this app has
 * no ACL grant for, and every notification would silently fail. See
 * docs/gotchas.md.
 */
export function createNotifierBackend(): NotifierBackend {
  return isTauriRuntime() ? createTauriNotifier(loadInvoke) : createWebNotifier();
}

/** Separate from the reply tag, so a test never replaces a real reply's notification. */
const TEST_TAG = "tandem-chat-test";

/**
 * Settings → Notifications "Send a test notification". A click on it only
 * focuses Tandem: it never opens chat. That focus still counts as the user
 * coming back, so it clears a real reply's taskbar flash or title count like
 * any other return. On desktop the Rust side posts its own copy of the same
 * text (`TEST_TITLE` / `TEST_BODY`, pinned to `TEST_NOTIFICATION_TEXT` by
 * `tests/docs/chat-notification-parity-claims.test.ts`) under its own id, and
 * routes the click by that id.
 */
export function sendTestNotification(): void {
  if (isTauriRuntime()) {
    void loadInvoke()
      .then((invoke) => notifyTest(invoke))
      .catch((err: unknown) => {
        console.warn("[notifications] notify_test failed:", err);
      });
    return;
  }
  postWebNotification(TEST_NOTIFICATION_TEXT, { tag: TEST_TAG, onClick: () => {} });
}
