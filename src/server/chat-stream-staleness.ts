/**
 * Staleness tripwire for the `chatStream` sidecar (#1340).
 *
 * A sidecar entry should live for exactly one stream — seconds to minutes. An
 * entry older than {@link STREAM_SIDECAR_WARN_MS} means a producer started
 * streaming and never called `finalizeClaudeChatMessage`: its chat row stays
 * frozen at the last flush in durable state, and its `Y.Text` is never
 * collected from the live doc (the snapshot fold only cleans CLONES).
 *
 * The detector deliberately does NOT sit on the write path. The failure it
 * names — a producer that crashes, hangs, or is torn down without finalizing —
 * emits no further `updateClaudeChatMessage` calls, so a check inside that
 * function could only ever fire for a producer that is STILL streaming after
 * ten minutes, which is not the leak. `foldChatStream` (session/manager.ts)
 * enumerates every live entry on every persist and every restore, regardless
 * of producer activity, so the sweep calls {@link reconcileStreamSidecars}
 * from there.
 *
 * This is a leaf module with no project imports on purpose: `session/manager.ts`
 * cannot import `mcp/awareness.ts` (awareness → mcp/document → session/manager
 * is an import cycle), so the ledger both sides need lives on its own.
 */

/** Age at which a live sidecar entry is reported as abandoned. */
export const STREAM_SIDECAR_WARN_MS = 10 * 60 * 1000;

/** id → epoch ms at which the sidecar entry was first observed. */
const streamStartedAt = new Map<string, number>();
/** ids already warned about — the warning is once per id, not per sweep. */
const streamWarnedIds = new Set<string>();

/** Record that `id` has an in-flight sidecar entry. First observation wins. */
export function noteStreamSidecar(id: string, now = Date.now()): void {
  if (!streamStartedAt.has(id)) streamStartedAt.set(id, now);
}

/** Retire `id`'s ledger entry — its sidecar is gone (finalized or cleared). */
export function clearStreamStaleness(id: string): void {
  streamStartedAt.delete(id);
  streamWarnedIds.delete(id);
}

/**
 * Reconcile the ledger against the sidecar entries a sweep actually found, and
 * warn once for any that has been live past the threshold.
 *
 * Reconciliation is what bounds the ledger: an abandoned entry's `startedAt`
 * would otherwise be retained forever alongside the `Y.Text` it describes, and
 * an entry deleted by a path that does not call {@link clearStreamStaleness}
 * (`clearCtrlChatDurably`'s live-doc pass) would leak a ledger row.
 *
 * `console.error` is deliberate and always on: it is stderr NATIVELY, so
 * Critical Rule 3 (stdout is reserved for the MCP wire) is satisfied without
 * the `index.ts` redirect, and the server has no reusable DEV-only gate. Once
 * per id keeps it from becoming noise.
 */
export function reconcileStreamSidecars(liveIds: Iterable<string>, now = Date.now()): void {
  const seen = new Set<string>();
  for (const id of liveIds) {
    seen.add(id);
    const started = streamStartedAt.get(id);
    if (started === undefined) {
      // First sight of an entry this process never started — e.g. one carried
      // in by a snapshot from a build that persisted live entries. Start its
      // clock here rather than warning on an age we cannot know.
      streamStartedAt.set(id, now);
      continue;
    }
    if (now - started <= STREAM_SIDECAR_WARN_MS || streamWarnedIds.has(id)) continue;
    streamWarnedIds.add(id);
    console.error(
      `[Tandem] chatStream entry ${id} has been live for over ` +
        `${STREAM_SIDECAR_WARN_MS / 60000} minutes — a streaming producer never called ` +
        `finalizeClaudeChatMessage(). The durable chat row for this message is stale.`,
    );
  }
  for (const id of Array.from(streamStartedAt.keys())) {
    if (!seen.has(id)) clearStreamStaleness(id);
  }
}

/** Test-only: drop all ledger state so suites cannot leak into one another. */
export function resetStreamStalenessForTests(): void {
  streamStartedAt.clear();
  streamWarnedIds.clear();
}
