/**
 * Ephemeral notification system for pushing server-side events to the browser.
 *
 * Uses an in-memory ring buffer + subscriber pattern (mirrors events/queue.ts).
 * NOT persisted via CRDT — notifications are transient and should not bleed
 * across sessions or survive server restarts.
 */

import { NOTIFICATION_BUFFER_SIZE } from "../shared/constants.js";
import type { TandemNotification } from "../shared/types.js";

type NotificationCallback = (notification: TandemNotification) => void;

const buffer: TandemNotification[] = [];
const subscribers = new Set<NotificationCallback>();

/** Push a notification to the buffer and notify all subscribers. */
export function pushNotification(notification: TandemNotification): void {
  buffer.push(notification);

  // Evict oldest when buffer exceeds max size
  while (buffer.length > NOTIFICATION_BUFFER_SIZE) {
    buffer.shift();
  }

  for (const cb of subscribers) {
    try {
      cb(notification);
    } catch (err) {
      console.error("[Notifications] Subscriber threw during dispatch:", err);
    }
  }
}

/** Subscribe to new notifications. Returns an unsubscribe function. */
export function subscribe(cb: NotificationCallback): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Get current buffer contents (for testing or replay). */
export function getBuffer(): readonly TandemNotification[] {
  return buffer;
}

/** Reset all state. For tests only. */
export function resetForTesting(): void {
  buffer.length = 0;
  subscribers.clear();
}
