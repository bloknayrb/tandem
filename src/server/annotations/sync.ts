/**
 * Annotation sync: bind a document's Y.Maps (annotations + replies) to the
 * durable on-disk envelope produced by `createStore`.
 *
 * Phase 1 of the durable-annotations plan. Three responsibilities:
 *
 *   1. Observer — watches `Y_MAP_ANNOTATIONS` and `Y_MAP_ANNOTATION_REPLIES`
 *      for user-intent mutations (MCP tools or browser edits) and queues a
 *      full-snapshot write to the store. File-originated writes are tagged
 *      with `FILE_SYNC_ORIGIN` so this observer skips them (no re-echo).
 *   2. Tombstones — server-side-only state. Tombstones are NOT synced to
 *      browsers (the spec: browsers observe a Y.Map.delete and that's it; the
 *      tombstone is a disk-persistence concern for stale-peer merge).
 *   3. Load+merge — on doc open, merge the on-disk envelope with whatever is
 *      already in the Y.Doc (typically session-restored). Last-writer-wins
 *      via per-annotation `rev`, with tombstones short-circuiting when the
 *      deletion is newer than the Y.Map copy.
 *
 * ## Observer origin semantics
 *
 *   - `FILE_SYNC_ORIGIN` → skip (would loop into the file we just read from).
 *   - `MCP_ORIGIN`       → queueWrite (user intent via Claude).
 *   - `null`/`undefined` → queueWrite (browser-origin user intent).
 *
 * ## Lazy snapshotting
 *
 * The observer hands `store.queueWrite` a THUNK (`() => snapshot(...)`), not
 * a pre-computed doc. The store invokes the thunk at debounce-fire time, so
 * a 50-mutation burst pays for one serialization instead of 50. The
 * last-queued thunk wins, which is exactly the semantic we want for
 * last-writer-wins coalescing.
 *
 * ## Why `rev:0` for missing `rev`?
 *
 * Session blobs written by prior Tandem versions (pre-plan) don't carry a
 * `rev` field. The observer must serialize them as `rev: 0` so Zod validation
 * in `parseAnnotationDoc` (which requires `rev`) doesn't reject our own file.
 * The observer never bumps `rev` — that's the callers' job on each
 * user-intent mutation.
 *
 * ## API shape decisions
 *
 *   - `loadAndMerge` registers the observer internally AFTER merge completes.
 *     Merge mutations use `FILE_SYNC_ORIGIN` so the observer would skip them
 *     anyway, but registering after merge avoids a speculative observer fire
 *     and keeps the ordering obvious in stack traces.
 *   - `recordTombstone(docHash, id, prevRev)` is PURE STATE MUTATION. It
 *     appends to the tombstone ledger and returns. It does NOT queue a
 *     store write on its own — the delete MCP tool always follows
 *     `recordTombstone` with a Y.Map.delete inside an MCP-origin
 *     transaction, and the observer fires on that delete, snapshotting the
 *     (already-updated) tombstone list via its lazy thunk. If the caller
 *     needs a standalone write without a Y.Map.delete, they call
 *     `store.flush()` explicitly.
 */

import * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { type RawAnnotation, sanitizeAnnotation } from "../../shared/sanitize.js";
import { AnnotationTypeSchema } from "../../shared/types.js";
import { FILE_SYNC_ORIGIN } from "../events/queue.js";
import {
  type AnnotationDocV1,
  type AnnotationRecordV1,
  type AnnotationReplyRecordV1,
  SCHEMA_VERSION,
  type TombstoneRecordV1,
} from "./schema.js";
import type { DocStore } from "./store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncMeta {
  filePath: string;
}

/** Bundle passed to `loadAndMerge` and `registerAnnotationObserver`. */
export interface SyncContext {
  ydoc: Y.Doc;
  store: DocStore;
  /** Output of `docHash(filePath)`. */
  docHash: string;
  meta: SyncMeta;
}

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

/** Tombstones live in memory, keyed by docHash. Seeded from disk on load. */
const tombstonesByDoc = new Map<string, TombstoneRecordV1[]>();

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

const CANONICAL_TYPES = new Set<string>(AnnotationTypeSchema.options);
const loggedLegacyDocs = new Set<string>();

/**
 * Normalize a Y.Map annotation value into an `AnnotationRecordV1`. Supplies
 * `rev: 0` for legacy session-blob entries that lack the field.
 *
 * Records whose `type` is outside `AnnotationTypeSchema.options` are routed
 * through `sanitizeAnnotation` which rewrites them to `"comment"`. Without
 * this, the next `parseAnnotationDoc` would reject the file and self-
 * quarantine the envelope. The Y.Map value is NOT rewritten in place, so
 * every subsequent snapshot of a legacy record re-runs the sanitize spread
 * until a user action overwrites the entry — acceptable cost given the
 * small record count and infrequent snapshots.
 *
 * Fast path for the common case (canonical type + numeric rev) skips the
 * spread/sanitize — `snapshot()` runs this across every annotation in the
 * doc on every debounced write.
 */
function normalizeAnnotation(raw: unknown, docHash?: string): AnnotationRecordV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown> & Partial<AnnotationRecordV1>;
  const isCanonical = CANONICAL_TYPES.has(obj.type as string);
  if (typeof obj.rev === "number" && isCanonical) return obj as AnnotationRecordV1;

  if (!isCanonical && docHash && !loggedLegacyDocs.has(docHash)) {
    loggedLegacyDocs.add(docHash);
    // TODO(#330): surface this lossy upgrade as a toast / doctor field once
    // migrateToV1 has a production caller.
    console.error(
      `[ANNOTATION-STORE] upgrading legacy annotation type in ${docHash} to "comment" on write`,
    );
  }

  const sanitized = sanitizeAnnotation(obj as unknown as RawAnnotation);
  return {
    ...sanitized,
    rev: typeof obj.rev === "number" ? obj.rev : 0,
  } as unknown as AnnotationRecordV1;
}

function normalizeReply(raw: unknown): AnnotationReplyRecordV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown> & Partial<AnnotationReplyRecordV1>;
  if (typeof obj.rev === "number") return obj as AnnotationReplyRecordV1;
  return { ...(obj as AnnotationReplyRecordV1), rev: 0 };
}

/**
 * Build a fresh `AnnotationDocV1` snapshot from the current Y.Map state + the
 * module-level tombstones for this doc. Invoked LAZILY by the store at
 * debounce-fire time (not at observer-fire time) so bursty mutation traffic
 * only pays for one serialization.
 */
function snapshot(ydoc: Y.Doc, docHash: string, meta: SyncMeta): AnnotationDocV1 {
  const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
  const repMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);

  const annotations: AnnotationRecordV1[] = [];
  for (const value of annMap.values()) {
    const rec = normalizeAnnotation(value, docHash);
    if (rec) annotations.push(rec);
  }

  const replies: AnnotationReplyRecordV1[] = [];
  for (const value of repMap.values()) {
    const rec = normalizeReply(value);
    if (rec) replies.push(rec);
  }

  const tombstones = [...(tombstonesByDoc.get(docHash) ?? [])];

  return {
    schemaVersion: SCHEMA_VERSION,
    docHash,
    meta: { filePath: meta.filePath, lastUpdated: Date.now() },
    annotations,
    tombstones,
    replies,
  };
}

// ---------------------------------------------------------------------------
// Observer
// ---------------------------------------------------------------------------

/**
 * Phase hint for the observer cleanup. `"swap"` runs on a Hocuspocus Y.Doc
 * swap (live — the document stays open, only the underlying CRDT instance is
 * replaced); `"close"` runs on true doc close. The distinction matters for
 * the per-doc tombstone ledger: a debounced write queued against the OLD
 * Y.Doc can still fire after the swap, and it must see the tombstones so
 * they land on disk. See #333.
 */
export type ObserverCleanupPhase = "swap" | "close";

/**
 * Attach Y.Map observers for annotations and replies that mirror user-intent
 * mutations to the store. Returns a cleanup function that unobserves both
 * maps and drops the per-doc context entry. The per-doc tombstone ledger is
 * cleared only on `"close"` — on `"swap"` it must persist so an in-flight
 * debounced write doesn't serialize `tombstones: []` after the old observer
 * has been torn down.
 *
 * Callers (the file-opener, via the queue indirection) invoke cleanup with
 * the appropriate phase on doc close or Y.Doc swap.
 */
export function registerAnnotationObserver(
  ctx: SyncContext,
): (phase?: ObserverCleanupPhase) => void {
  const { ydoc, store, docHash, meta } = ctx;

  const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
  const repMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);

  const onMutation = (_ev: Y.YMapEvent<unknown>, txn: Y.Transaction): void => {
    // The file-sync path writes into the Y.Map; echoing that back into the
    // file would be wasted I/O and — under contention — could race.
    if (txn.origin === FILE_SYNC_ORIGIN) return;

    // Everything else is user intent: MCP_ORIGIN (Claude via an MCP tool),
    // null/undefined (browser), or any future origin tag we haven't named
    // yet. Queue a LAZY snapshot — the thunk only runs when the debounce
    // timer fires, so a burst of N mutations produces one serialization.
    store.queueWrite(() => snapshot(ydoc, docHash, meta));
  };

  annMap.observe(onMutation);
  repMap.observe(onMutation);

  return (phase: ObserverCleanupPhase = "close") => {
    annMap.unobserve(onMutation);
    repMap.unobserve(onMutation);
    if (phase === "close") {
      tombstonesByDoc.delete(docHash);
      // Drop the dedupe flag so a subsequent reopen can log once again —
      // matches "close" semantics (fresh context on next open).
      loggedLegacyDocs.delete(docHash);
    }
  };
}

// ---------------------------------------------------------------------------
// Tombstones
// ---------------------------------------------------------------------------

/**
 * Record a deletion. Appends a tombstone at `prevRev + 1` (so the tombstone
 * wins any subsequent stale-peer merge that carries the pre-deletion copy).
 *
 * PURE STATE MUTATION — no store write is queued here. The delete MCP tool
 * is expected to follow `recordTombstone` with a `Y.Map.delete(id)` inside
 * an `MCP_ORIGIN` transaction; the observer fires on that delete, and its
 * lazy snapshot thunk picks up the already-updated tombstone list. If a
 * caller records a tombstone without a paired Y.Map delete (rare — not the
 * normal flow), they should `flush()` explicitly or rely on the next
 * observer-triggered snapshot to carry the tombstone forward.
 *
 * Idempotent: a duplicate call with the same `(id, rev)` (or an older rev
 * for the same id) is a no-op. Guards against unbounded array growth if a
 * caller double-fires.
 */
export function recordTombstone(docHash: string, annotationId: string, prevRev: number): void {
  const list = tombstonesByDoc.get(docHash) ?? [];
  const newRev = prevRev + 1;
  // Dedupe: if we already have a tombstone at `newRev` or higher for this id,
  // the call is redundant. Cheap linear scan — tombstone arrays are small.
  if (list.some((t) => t.id === annotationId && t.rev >= newRev)) return;
  list.push({
    id: annotationId,
    rev: newRev,
    deletedAt: Date.now(),
  });
  tombstonesByDoc.set(docHash, list);
}

/**
 * Read-only accessor for tests and (future) diagnostic tools. Returns a
 * defensive copy so callers can't mutate the module-internal array.
 */
export function getTombstones(docHash: string): TombstoneRecordV1[] {
  return [...(tombstonesByDoc.get(docHash) ?? [])];
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Pure merge rule for a pair of (file, ymap) records that share an id. Used
 * for annotations and replies (both carry `rev` and `editedAt`). Returns
 * `"file"` if the file copy should replace the Y.Map entry, `"ymap"` if the
 * Y.Map entry should be left alone.
 *
 * Rules (in order):
 *   1. Higher `rev` wins.
 *   2. On tie, higher `editedAt` wins.
 *   3. On tie with `editedAt` undefined on Y.Map only (session-restored
 *      pre-plan state) and a real `editedAt` on file → file wins.
 *   4. Otherwise Y.Map wins (the live-session state is preferred by default
 *      when nothing distinguishes the two).
 */
function pickWinner(
  fileRec: { rev: number; editedAt?: number },
  ymapRec: { rev: number; editedAt?: number },
): "file" | "ymap" {
  if (fileRec.rev > ymapRec.rev) return "file";
  if (ymapRec.rev > fileRec.rev) return "ymap";
  // Tie on rev.
  const fileEdit = fileRec.editedAt;
  const ymapEdit = ymapRec.editedAt;
  if (typeof fileEdit === "number" && typeof ymapEdit === "number") {
    return fileEdit > ymapEdit ? "file" : "ymap";
  }
  if (typeof fileEdit === "number" && ymapEdit === undefined) {
    // Heuristic: session-restored Y.Map entries lack editedAt; file wins.
    return "file";
  }
  return "ymap";
}

/**
 * Merge a Map of file records into a Y.Map under `pickWinner`'s rules
 * (higher `rev` wins; tied `rev` falls back to `editedAt`). For each file
 * record: insert if absent (unless `shouldSkipInsert` vetoes), otherwise
 * compare normalized copies and let the winner replace. After the pass,
 * `needsWrite` is true if the Y.Map carries ids the file doesn't (minus
 * `ymapOnlyIgnoreIds`) — caller queues a post-merge write so those land.
 */
function mergeMap<T extends { rev: number; editedAt?: number }>(
  ymap: Y.Map<unknown>,
  fileRecs: Map<string, T>,
  normalize: (raw: unknown) => T | null,
  opts: {
    shouldSkipInsert?: (id: string, fileRec: T) => boolean;
    ymapOnlyIgnoreIds?: Set<string>;
  } = {},
): { needsWrite: boolean } {
  let needsWrite = false;

  for (const [id, fileRec] of fileRecs) {
    const ymapRaw = ymap.get(id);
    if (ymapRaw === undefined) {
      if (opts.shouldSkipInsert?.(id, fileRec)) continue;
      ymap.set(id, fileRec);
      continue;
    }
    const ymapRec = normalize(ymapRaw);
    if (!ymapRec) {
      ymap.set(id, fileRec);
      continue;
    }
    const winner = pickWinner(fileRec, ymapRec);
    if (winner === "file") {
      ymap.set(id, fileRec);
    } else {
      needsWrite = true;
    }
  }

  for (const id of ymap.keys()) {
    if (fileRecs.has(id)) continue;
    if (opts.ymapOnlyIgnoreIds?.has(id)) continue;
    needsWrite = true;
    break;
  }

  return { needsWrite };
}

// ---------------------------------------------------------------------------
// loadAndMerge
// ---------------------------------------------------------------------------

/**
 * Load the on-disk annotation envelope for this doc and merge it with the
 * current Y.Doc state. Called by the file-opener AFTER session restore
 * populates the Y.Doc but BEFORE Hocuspocus starts accepting browser
 * connections for this doc.
 *
 * Algorithm (see the Phase 1 plan §"Merge rules" for background):
 *
 *   1. `store.load()` returns a migrated empty envelope on fresh-install or
 *      read error. `parseAnnotationDoc` has already quarantined corrupt
 *      files and parked future-schema files at `.future` by this point.
 *
 *   2. Fast path: if the file is empty AND the Y.Map already has annotations
 *      (first-upgrade case — pre-plan session state hitting post-plan code),
 *      write one snapshot and return. No merge needed; we just captured the
 *      existing state durably.
 *
 *   3. Full merge inside a single `FILE_SYNC_ORIGIN` transaction:
 *        - For each tombstone: delete the Y.Map entry if the tombstone's
 *          rev beats the Y.Map entry's rev. Otherwise leave it (the entry
 *          was re-created after deletion — "resurrection").
 *        - For each alive file annotation: pick the winner vs the Y.Map
 *          entry (if any) using `pickWinner`. File-wins replaces the Y.Map
 *          entry; Y.Map-wins leaves it and schedules a write so the newer
 *          state lands on disk.
 *        - Y.Map entries absent from file and not tombstoned are preserved;
 *          we queue a write at the end to durably capture them.
 *        - Replies follow the same shape (no tombstones — a deleted parent
 *          annotation just orphans its replies).
 *
 *   4. Seed `tombstonesByDoc[docHash]` from the file so subsequent
 *      `recordTombstone` calls + observer serializations carry them forward.
 *
 *   5. Register the observer AFTER merge completes. Returns the observer
 *      cleanup so the caller can unregister on doc close.
 */
export async function loadAndMerge(
  ctx: SyncContext,
): Promise<(phase?: ObserverCleanupPhase) => void> {
  const { ydoc, store, docHash, meta } = ctx;
  const file = await store.load();

  const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
  const repMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);

  const fileEmpty =
    file.annotations.length === 0 && file.replies.length === 0 && file.tombstones.length === 0;
  const ymapHasState = annMap.size > 0 || repMap.size > 0;

  // Seed tombstones from the file first so the observer (registered below)
  // picks them up on its first snapshot.
  tombstonesByDoc.set(docHash, [...file.tombstones]);

  if (fileEmpty && ymapHasState) {
    // First-upgrade path. Write one atomic snapshot capturing whatever the
    // Y.Maps currently hold. No merge work needed.
    store.queueWrite(() => snapshot(ydoc, docHash, meta));
    return registerAnnotationObserver(ctx);
  }

  if (fileEmpty && !ymapHasState) {
    // Both sides empty — nothing to merge, nothing to write.
    return registerAnnotationObserver(ctx);
  }

  // Full merge. `needsWrite` tracks whether the final Y.Map state has
  // anything the file doesn't — in which case we queue a post-merge write so
  // those additions land durably without waiting for the next mutation.
  let needsWrite = false;

  ydoc.transact(() => {
    // Apply tombstones first so a later merge step can't overwrite a winning
    // delete.
    for (const stone of file.tombstones) {
      const ymapAnn = normalizeAnnotation(annMap.get(stone.id), docHash);
      if (!ymapAnn) continue;
      if (stone.rev > ymapAnn.rev) {
        annMap.delete(stone.id);
      }
      // else: resurrection — leave the Y.Map entry alone.
    }

    // Set of ids where a tombstone beats the file's alive record. The file
    // shouldn't carry both (contradiction — bug or manual edit), but if it
    // does the tombstone is authoritative. This guards only the
    // Y.Map-absent insert path; the preceding loop already handled the
    // Y.Map-present case.
    const fileAnns = new Map(file.annotations.map((a) => [a.id, a]));
    const winningTombstoneIds = new Set<string>();
    const tombstoneIds = new Set<string>();
    for (const stone of file.tombstones) {
      tombstoneIds.add(stone.id);
      const fileAnn = fileAnns.get(stone.id);
      if (fileAnn && stone.rev > fileAnn.rev) winningTombstoneIds.add(stone.id);
    }

    const annResult = mergeMap(annMap, fileAnns, (raw) => normalizeAnnotation(raw, docHash), {
      shouldSkipInsert: (id) => winningTombstoneIds.has(id),
      ymapOnlyIgnoreIds: tombstoneIds,
    });
    if (annResult.needsWrite) needsWrite = true;

    const fileReplies = new Map(file.replies.map((r) => [r.id, r]));
    const repResult = mergeMap(repMap, fileReplies, normalizeReply);
    if (repResult.needsWrite) needsWrite = true;
  }, FILE_SYNC_ORIGIN);

  if (needsWrite) {
    store.queueWrite(() => snapshot(ydoc, docHash, meta));
  }

  return registerAnnotationObserver(ctx);
}

// ---------------------------------------------------------------------------
// Test-only reset
// ---------------------------------------------------------------------------

/** Reset all module state. Tests only — never call in production. */
export function resetForTesting(): void {
  tombstonesByDoc.clear();
  loggedLegacyDocs.clear();
}
