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
 * that reconnects shows one tray entry, not two — and adding a second notice
 * under the same `dedupKey` REPLACES the first rather than stacking.
 *
 * In-memory and per-process by design. A notice is only put here for a
 * condition that cannot outlive this process: ADR-053's `.docx` session drop
 * deletes the records it names, and a boot-time "not watching" warning
 * (#1662, `file-watcher.ts`) describes a handle that only this process holds.
 * The second kind can also stop being true while the process runs — a later
 * successful watch of that path, or the document being closed — so a notice
 * can be withdrawn (`removeStartupNotice`); a tab that already showed it keeps
 * its tray entry, but no tab that connects afterwards is told something false.
 */

import type { TandemNotification } from "../shared/types.js";

const notices: TandemNotification[] = [];
let restoreInProgress = false;

/** Register a notice; one with an existing `dedupKey` replaces that entry. */
export function addStartupNotice(notice: TandemNotification): void {
  if (notice.dedupKey !== undefined) {
    const at = notices.findIndex((n) => n.dedupKey === notice.dedupKey);
    if (at !== -1) {
      notices[at] = notice;
      return;
    }
  }
  notices.push(notice);
}

/** Withdraw the notice registered under `dedupKey`, if any. */
export function removeStartupNotice(dedupKey: string): void {
  const at = notices.findIndex((n) => n.dedupKey === dedupKey);
  if (at !== -1) notices.splice(at, 1);
}

/** A copy, so a caller iterating it can't be disturbed by a later add. */
export function getStartupNotices(): readonly TandemNotification[] {
  return [...notices];
}

/**
 * Bracket boot-time session restore (`restoreOpenDocuments`). While it runs no
 * notify stream can exist yet, so a site whose live push would reach nobody
 * (the file watcher's "not watching" warning) registers here as well.
 */
export function beginStartupRestore(): void {
  restoreInProgress = true;
}

export function endStartupRestore(): void {
  restoreInProgress = false;
}

export function isStartupRestoreInProgress(): boolean {
  return restoreInProgress;
}

/** Test seam: the module is process-global state. Also closes the restore window. */
export function clearStartupNotices(): void {
  notices.length = 0;
  restoreInProgress = false;
}
