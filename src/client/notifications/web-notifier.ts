import type { NotificationText, NotifierBackend } from "./chat-attention";

/**
 * Browser / npm-install backend (#2168): the Web Notifications API plus an
 * `(N)` unread count in the tab title, since a browser tab cannot flash a
 * taskbar button.
 *
 * Never used inside Tauri — the notification plugin replaces
 * `window.Notification` there, and its calls need ACL grants this backend does
 * not have. Pick the backend with `isTauriRuntime()` first.
 *
 * Permission is never requested here. It is requested only from an explicit
 * click in Settings → Notifications (`requestWebNotificationPermission`); a
 * page-load prompt is both hostile and, in current browsers, auto-denied.
 */

/** Same tag for every reply, so a newer notification replaces an older one. */
const TAG = "tandem-chat";
const TITLE_COUNT = /^\(\d+\+?\) /;

export type WebNotificationPermission = NotificationPermission | "unsupported";

export function webNotificationPermission(): WebNotificationPermission {
  try {
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  } catch {
    return "unsupported";
  }
}

export async function requestWebNotificationPermission(): Promise<WebNotificationPermission> {
  if (webNotificationPermission() === "unsupported") return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return webNotificationPermission();
  }
}

/**
 * Rewrite only our own `(N) ` prefix, so this composes with any other prefix
 * something else puts on the title instead of saving and restoring a snapshot.
 */
export function withTitleCount(title: string, count: number): string {
  const base = title.replace(TITLE_COUNT, "");
  if (count <= 0) return base;
  return `(${count > 9 ? "9+" : count}) ${base}`;
}

export function createWebNotifier(): NotifierBackend {
  return {
    notify(text: NotificationText, onClick: () => void) {
      if (webNotificationPermission() !== "granted") return;
      try {
        const notification = new Notification(text.title, {
          body: text.body,
          tag: TAG,
          // The page plays its own chime.
          silent: true,
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
          onClick();
        };
      } catch (err) {
        // Some platforms (Android Chrome) only allow notifications from a
        // service worker and throw on the constructor.
        console.warn("[notifications] browser notification failed:", err);
      }
    },
    attention(count: number) {
      document.title = withTitleCount(document.title, count);
    },
    clearAttention() {
      document.title = withTitleCount(document.title, 0);
    },
  };
}
