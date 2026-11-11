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
/** The subset of `subscribers` that are Tandem's own window (see `subscribe`). */
const ownWindowSubscribers = new Set<NotificationCallback>();

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
export function subscribe(
  cb: NotificationCallback,
  opts: { ownWindow?: boolean } = {},
): () => void {
  subscribers.add(cb);
  // `ownWindow` marks a stream opened by Tandem's own window, as far as a
  // browser can vouch for it (`isTandemOwnWindow` in the notify-stream route).
  // Only such a stream counts as "the user was shown this" (#2404).
  if (opts.ownWindow === true) ownWindowSubscribers.add(cb);
  return () => {
    subscribers.delete(cb);
    ownWindowSubscribers.delete(cb);
  };
}

/** How many of Tandem's own windows are listening right now. A notice pushed
 *  while this is zero has not been shown to the user, whoever else is
 *  connected (there is no replay here). */
export function ownWindowSubscriberCount(): number {
  return ownWindowSubscribers.size;
}

/** Get current buffer contents (for testing or replay). */
export function getBuffer(): readonly TandemNotification[] {
  return buffer;
}

/** Reset all state. For tests only. */
export function resetForTesting(): void {
  buffer.length = 0;
  subscribers.clear();
  ownWindowSubscribers.clear();
}
