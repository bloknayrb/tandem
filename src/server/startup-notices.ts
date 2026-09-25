/**
 * Notices raised during startup, before any client can be connected.
 *
 * `pushNotification` only reaches subscribers present at the moment it fires,
 * and session restore runs before the server binds, so a notice pushed from
 * there reaches nobody. What lands here is instead written by
 * `handleNotifyStream` to EVERY stream that connects for the rest of this
 * process: a stale tab's EventSource can reconnect before the fresh one, and
 * tabs don't share tray state, so "first subscriber only" would hand the
 * notice to a background tab. Each notice carries a fixed `dedupKey`, so a tab
 * that reconnects shows one tray entry, not two.
 *
 * In-memory and per-process by design. A notice is only put here for a
 * condition that is already gone by the next boot (ADR-053's `.docx` session
 * drop deletes the records it names), so it cannot repeat across restarts.
 */

import type { TandemNotification } from "../shared/types.js";

const notices: TandemNotification[] = [];

export function addStartupNotice(notice: TandemNotification): void {
  notices.push(notice);
}

/** A copy, so a caller iterating it can't be disturbed by a later add. */
export function getStartupNotices(): readonly TandemNotification[] {
  return [...notices];
}

/** Test seam: the module is process-global state. */
export function clearStartupNotices(): void {
  notices.length = 0;
}
