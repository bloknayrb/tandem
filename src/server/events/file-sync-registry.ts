/**
 * File-sync observer registry for durable annotation persistence.
 *
 * Tracks per-doc SyncContext so reattachObservers (in queue.ts) can
 * re-register the annotation file-writer observer against the new Y.Doc
 * after a Hocuspocus doc swap. Stored alongside the cleanup handle from
 * the prior registerAnnotationObserver call so we can dispose it
 * deterministically.
 */

import * as Y from "yjs";
import type { DocStore } from "../annotations/store.js";
import {
  type ObserverCleanupPhase,
  registerAnnotationObserver,
  type SyncContext,
} from "../annotations/sync.js";

const fileSyncContexts = new Map<
  string,
  { ctx: SyncContext; cleanup: (phase?: ObserverCleanupPhase) => void }
>();

/**
 * Run a file-sync observer cleanup in a try/catch with a uniform log line.
 * Cleanups can throw if the underlying Y.Doc was already destroyed (e.g. a
 * Hocuspocus reload beat us to it) — that's harmless, but we want the logs
 * to be consistent enough to grep.
 */
function safeCleanup(
  docName: string,
  cleanup: (phase?: ObserverCleanupPhase) => void,
  phase: ObserverCleanupPhase,
  logTag: string,
): void {
  try {
    cleanup(phase);
  } catch (err) {
    console.warn("[EventQueue] file-sync cleanup threw during %s for %s:", logTag, docName, err);
  }
}

/**
 * Register the durable-annotation sync context for a document. Called by the
 * file-opener after `loadAndMerge` returns its observer cleanup. The cleanup
 * passed here is what gets invoked on `clearFileSyncContext` or the next
 * `reattachObservers` call.
 *
 * Callers don't need to think about the swap-vs-close distinction: the queue
 * picks the phase at teardown time based on which entrypoint ran.
 */
export function setFileSyncContext(
  docName: string,
  ctx: SyncContext,
  cleanup: (phase?: ObserverCleanupPhase) => void,
): void {
  // Dispose any prior entry first so we never leak observers on duplicate
  // registration (e.g., forceReload paths that re-run loadAndMerge). Normal
  // flow pre-clears via `clearFileSyncContext`, so this branch is defensive;
  // `"close"` is correct because we're replacing — not rebinding — the
  // context, so the prior docHash's tombstones belong to a superseded state.
  const existing = fileSyncContexts.get(docName);
  if (existing) {
    safeCleanup(docName, existing.cleanup, "close", "replace");
  }
  fileSyncContexts.set(docName, { ctx, cleanup });
}

/**
 * Drop the file-sync context for a document (on close or force-reload prep).
 * Returns the dropped `{ store, docHash }` so callers can flush/clear the
 * durable store without recomputing the hash or minting a transient handle.
 * Returns `undefined` if no context was registered (e.g. feature flag off,
 * or `wireAnnotationStore` failed during open).
 */
export function clearFileSyncContext(
  docName: string,
): { store: DocStore; docHash: string } | undefined {
  const entry = fileSyncContexts.get(docName);
  if (!entry) return undefined;
  safeCleanup(docName, entry.cleanup, "close", "clear");
  fileSyncContexts.delete(docName);
  return { store: entry.ctx.store, docHash: entry.ctx.docHash };
}

/**
 * Reattach the file-sync annotation observer to a new Y.Doc after a Hocuspocus
 * doc swap. Disposes the prior cleanup via safeCleanup (swap phase), then
 * re-registers against the new doc. Called from queue.ts:reattachObservers.
 */
export function reattachFileSyncObserver(docName: string, newDoc: Y.Doc): void {
  const oldCtx = fileSyncContexts.get(docName);
  if (oldCtx) {
    safeCleanup(docName, oldCtx.cleanup, "swap", "reattach");
    const newCtx: SyncContext = {
      ydoc: newDoc,
      store: oldCtx.ctx.store,
      docHash: oldCtx.ctx.docHash,
      meta: oldCtx.ctx.meta,
    };
    const cleanup = registerAnnotationObserver(newCtx);
    fileSyncContexts.set(docName, { ctx: newCtx, cleanup });
  }
}

/** Reset all registry state. For tests only — do not call in production. */
export function resetForTesting(): void {
  for (const [docName, entry] of fileSyncContexts) {
    safeCleanup(docName, entry.cleanup, "close", "resetForTesting");
  }
  fileSyncContexts.clear();
}
