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

/**
 * `lib.dom` does not declare `renotify` yet. Chromium re-alerts (sound,
 * banner) for a notification that replaces one with the same non-empty tag
 * only when it is set; other browsers ignore the field.
 */
type WebNotificationOptions = NotificationOptions & { renotify?: boolean };

/**
 * Post one browser notification. Returns it, or null when permission is not
 * granted or the platform refuses. A click focuses the window, closes the
 * notification, then runs `onClick`.
 */
export function postWebNotification(
  text: NotificationText,
  options: { tag: string; onClick: () => void },
): Notification | null {
  if (webNotificationPermission() !== "granted") return null;
  try {
    const init: WebNotificationOptions = {
      body: text.body,
      tag: options.tag,
      renotify: true,
      // The page plays its own chime.
      silent: true,
    };
    const notification = new Notification(text.title, init);
    notification.onclick = () => {
      window.focus();
      notification.close();
      options.onClick();
    };
    return notification;
  } catch (err) {
    // Some platforms (Android Chrome) only allow notifications from a
    // service worker and throw on the constructor.
    console.warn("[notifications] browser notification failed:", err);
    return null;
  }
}

export function createWebNotifier(): NotifierBackend {
  // The last notification this backend posted, closed once the user is back
  // so a stale "Claude replied" does not linger in the notification centre.
  let last: Notification | null = null;
  return {
    notify(text: NotificationText, onClick: () => void) {
      const posted = postWebNotification(text, { tag: TAG, onClick });
      if (posted) last = posted;
    },
    attention(count: number) {
      document.title = withTitleCount(document.title, count);
    },
    clearAttention() {
      document.title = withTitleCount(document.title, 0);
      if (last) {
        try {
          last.close();
        } catch {
          // Already gone, or the platform refuses — nothing to undo.
        }
        last = null;
      }
    },
  };
}
