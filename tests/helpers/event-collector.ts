import { subscribe, unsubscribe } from "../../src/server/events/queue.js";
import type { TandemEvent } from "../../src/server/events/types.js";

/**
 * Subscribe to the channel event queue and accumulate emitted events into an
 * array. Returns the live `events` array plus a `cleanup` to unsubscribe.
 *
 * Several server tests (`event-queue.test.ts`, `event-queue-dwell.test.ts`,
 * `event-queue-observer-split.test.ts`) hand-roll an identical helper; new
 * tests should import this one. Existing copies can migrate onto it over time.
 */
export function collectEvents(): { events: TandemEvent[]; cleanup: () => void } {
  const events: TandemEvent[] = [];
  const cb = (e: TandemEvent): void => {
    events.push(e);
  };
  subscribe(cb);
  return { events, cleanup: () => unsubscribe(cb) };
}
