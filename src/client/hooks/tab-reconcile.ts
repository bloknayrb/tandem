/**
 * Decide the active tab id after a server document-list reconcile.
 *
 * The active doc id is broadcast on every reconcile, but a local (keyboard/click)
 * tab switch is never propagated to the server — so the server keeps re-broadcasting
 * its own active id. A stale re-broadcast of an UNCHANGED active id must not clobber
 * the local switch; a genuine (re)activation — signalled by an advanced activation
 * epoch — must apply. See `setActiveDocId` / `getActiveDocEpoch` on the server.
 *
 * Pure function (no runes) so the epoch gate is unit-testable without a live provider.
 */
export function resolveActiveTabId(params: {
  /** Current local active tab id (may diverge from the server after a local switch). */
  prev: string | null;
  /** The server's active doc id from this reconcile (non-null; callers guard the null case). */
  serverActiveId: string;
  /** Ids the server currently lists as open. */
  serverIds: ReadonlySet<string>;
  /** Number of tabs removed in this reconcile (server no longer lists them). */
  removedCount: number;
  /** Activation epoch carried by this reconcile (null if the key is absent). */
  serverEpoch: number | null;
  /** Epoch the client last applied. */
  lastAppliedEpoch: number | null;
}): string | null {
  const { prev, serverActiveId, serverIds, removedCount, serverEpoch, lastAppliedEpoch } = params;

  // First reconcile — nothing local to preserve.
  if (prev === null) return serverActiveId;

  // The locally-active tab was closed server-side — we must follow the server.
  if (!serverIds.has(prev)) return serverActiveId;

  // A different tab closed and the server's active matches our current tab —
  // keep current (no switch intended).
  if (removedCount > 0 && serverActiveId === prev) return prev;

  // Genuine (re)activation: the epoch advanced since we last applied. Includes
  // re-opening the already-active doc (intentional focus-steal).
  if (serverEpoch !== lastAppliedEpoch) return serverActiveId;

  // Stale re-broadcast of an unchanged active id — preserve the local switch.
  return prev;
}
