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
 *   - `MCP_ORIGIN`       → serialize + queueWrite (user intent via Claude).
 *   - `null`/`undefined` → serialize + queueWrite (browser-origin user intent).
 *
 * ## Why `rev:0` for missing `rev`?
 *
 * Session blobs written by prior Tandem versions (pre-plan) don't carry a
 * `rev` field. The observer must serialize them as `rev: 0` so Zod validation
 * in `parseAnnotationDoc` (which requires `rev`) doesn't reject our own file.
 * The observer never bumps `rev` — that's T6's job on each user-intent
 * mutation.
 *
 * ## API shape decisions
 *
 *   - `loadAndMerge` registers the observer internally AFTER merge completes.
 *     Merge mutations use `FILE_SYNC_ORIGIN` so the observer would skip them
 *     anyway, but registering after merge avoids a speculative observer fire
 *     and keeps the ordering obvious in stack traces.
 *   - `recordTombstone(docHash, id, prevRev)` does the full work — appends
 *     the tombstone, reads the current Y.Map state, serializes, and queues
 *     the store write. T6's delete MCP tool just calls this; no other
 *     bookkeeping needed at the call site.
 *   - A per-docHash context registry (`docContexts`) lets `recordTombstone`
 *     locate the Y.Doc and store without the caller threading them through.
 *     Registering the observer populates this; cleanup removes it.
 */

import * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
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

/** Per-docHash live state, populated by `registerAnnotationObserver`. */
interface DocContext {
  ydoc: Y.Doc;
  store: DocStore;
  meta: SyncMeta;
}

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

/** Tombstones live in memory, keyed by docHash. Seeded from disk on load. */
const tombstonesByDoc = new Map<string, TombstoneRecordV1[]>();

/** Live ydoc+store handles so `recordTombstone` can serialize + queue writes. */
const docContexts = new Map<string, DocContext>();

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Normalize a Y.Map annotation value into an `AnnotationRecordV1`. Supplies
 * `rev: 0` for legacy session-blob entries that lack the field. All other
 * fields pass through unchanged — the Zod schema validates on parse, not
 * here (this is called on the write path, where we trust the Y.Map state).
 */
function normalizeAnnotation(raw: unknown): AnnotationRecordV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown> & Partial<AnnotationRecordV1>;
  const rev = typeof obj.rev === "number" ? obj.rev : 0;
  return { ...(obj as AnnotationRecordV1), rev };
}

function normalizeReply(raw: unknown): AnnotationReplyRecordV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown> & Partial<AnnotationReplyRecordV1>;
  const rev = typeof obj.rev === "number" ? obj.rev : 0;
  return { ...(obj as AnnotationReplyRecordV1), rev };
}

/**
 * Build a fresh `AnnotationDocV1` snapshot from the current Y.Map state + the
 * module-level tombstones for this doc. Called on every observer fire and at
 * the end of `loadAndMerge` when there are Y-only annotations to durably
 * persist.
 */
function snapshot(ydoc: Y.Doc, docHash: string, meta: SyncMeta): AnnotationDocV1 {
  const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
  const repMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);

  const annotations: AnnotationRecordV1[] = [];
  for (const value of annMap.values()) {
    const rec = normalizeAnnotation(value);
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
 * Attach Y.Map observers for annotations and replies that mirror user-intent
 * mutations to the store. Returns a cleanup function that unobserves both
 * maps and drops the per-doc context entry.
 *
 * Callers (T6 file-opener wiring) invoke cleanup on doc close or Y.Doc swap.
 */
export function registerAnnotationObserver(
  _docName: string,
  ydoc: Y.Doc,
  store: DocStore,
  docHash: string,
  meta: SyncMeta,
): () => void {
  docContexts.set(docHash, { ydoc, store, meta });

  const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
  const repMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);

  const onMutation = (_ev: Y.YMapEvent<unknown>, txn: Y.Transaction): void => {
    // The file-sync path writes into the Y.Map; echoing that back into the
    // file would be wasted I/O and — under contention — could race.
    if (txn.origin === FILE_SYNC_ORIGIN) return;

    // Everything else is user intent: MCP_ORIGIN (Claude via an MCP tool),
    // null/undefined (browser), or any future origin tag we haven't named
    // yet. Serialize and queue. See module header for rationale.
    store.queueWrite(snapshot(ydoc, docHash, meta));
  };

  annMap.observe(onMutation);
  repMap.observe(onMutation);

  return () => {
    annMap.unobserve(onMutation);
    repMap.unobserve(onMutation);
    docContexts.delete(docHash);
  };
}

// ---------------------------------------------------------------------------
// Tombstones
// ---------------------------------------------------------------------------

/**
 * Record a deletion. Appends a tombstone at `prevRev + 1` (so the tombstone
 * wins any subsequent stale-peer merge that carries the pre-deletion copy)
 * and queues a store write so the tombstone is durably persisted.
 *
 * T6's delete MCP tool is the sole caller. The actual `Y.Map.delete(id)`
 * call is T6's responsibility (wrapped in an `MCP_ORIGIN` transaction); this
 * function only owns the tombstone ledger + the store write that captures
 * the updated tombstones array.
 */
export function recordTombstone(docHash: string, annotationId: string, prevRev: number): void {
  const list = tombstonesByDoc.get(docHash) ?? [];
  list.push({
    id: annotationId,
    rev: prevRev + 1,
    deletedAt: Date.now(),
  });
  tombstonesByDoc.set(docHash, list);

  // Trigger a write. If no context is registered (doc was never opened via
  // loadAndMerge, or was already closed), skip silently — the caller likely
  // misordered operations, but the tombstone is still in-memory and will be
  // written on the next observer fire.
  const ctx = docContexts.get(docHash);
  if (ctx) {
    ctx.store.queueWrite(snapshot(ctx.ydoc, docHash, ctx.meta));
  }
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

// ---------------------------------------------------------------------------
// loadAndMerge
// ---------------------------------------------------------------------------

/**
 * Load the on-disk annotation envelope for this doc and merge it with the
 * current Y.Doc state. Called by T6's file-opener wiring AFTER session
 * restore populates the Y.Doc but BEFORE Hocuspocus starts accepting browser
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
  docName: string,
  ydoc: Y.Doc,
  store: DocStore,
  docHash: string,
  meta: SyncMeta,
): Promise<() => void> {
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
    store.queueWrite(snapshot(ydoc, docHash, meta));
    return registerAnnotationObserver(docName, ydoc, store, docHash, meta);
  }

  if (fileEmpty && !ymapHasState) {
    // Both sides empty — nothing to merge, nothing to write.
    return registerAnnotationObserver(docName, ydoc, store, docHash, meta);
  }

  // Full merge. `needsWrite` tracks whether the final Y.Map state has
  // anything the file doesn't — in which case we queue a post-merge write so
  // those additions land durably without waiting for the next mutation.
  let needsWrite = false;

  ydoc.transact(() => {
    // --- Annotations ---
    const fileAnns = new Map(file.annotations.map((a) => [a.id, a]));

    // 1. Tombstones rule (process first so we don't overwrite a delete with
    //    a concurrent file-side alive record that shouldn't have been there).
    for (const stone of file.tombstones) {
      const ymapAnn = normalizeAnnotation(annMap.get(stone.id));
      if (!ymapAnn) continue;
      if (stone.rev > ymapAnn.rev) {
        annMap.delete(stone.id);
      }
      // else: resurrection — leave the Y.Map entry alone.
    }

    // 2. File annotations vs Y.Map.
    for (const [id, fileAnn] of fileAnns) {
      const ymapRaw = annMap.get(id);
      if (ymapRaw === undefined) {
        // Not in Y.Map and not blocked by a tombstone → file wins.
        // (If it WAS in Y.Map + got tombstone-deleted above, it'll still be
        // absent here, but that's a contradiction — a file can't carry both
        // an alive record and a winning tombstone for the same id. We treat
        // "tombstone won the deletion" as authoritative and drop the file's
        // alive record in that case.)
        const deletedByTombstone = file.tombstones.some((t) => t.id === id && t.rev > fileAnn.rev);
        if (!deletedByTombstone) {
          annMap.set(id, fileAnn);
        }
        continue;
      }
      const ymapAnn = normalizeAnnotation(ymapRaw);
      if (!ymapAnn) {
        annMap.set(id, fileAnn);
        continue;
      }
      const winner = pickWinner(fileAnn, ymapAnn);
      if (winner === "file") {
        annMap.set(id, fileAnn);
      } else {
        // Y.Map is authoritative — its state needs to land on disk.
        needsWrite = true;
      }
    }

    // 3. Y.Map annotations absent from file, not tombstoned → keep + write.
    const tombstoneIds = new Set(file.tombstones.map((t) => t.id));
    for (const id of annMap.keys()) {
      if (fileAnns.has(id)) continue;
      if (tombstoneIds.has(id)) continue;
      needsWrite = true;
    }

    // --- Replies (same shape, no tombstones) ---
    const fileReplies = new Map(file.replies.map((r) => [r.id, r]));
    for (const [id, fileRep] of fileReplies) {
      const ymapRaw = repMap.get(id);
      if (ymapRaw === undefined) {
        repMap.set(id, fileRep);
        continue;
      }
      const ymapRep = normalizeReply(ymapRaw);
      if (!ymapRep) {
        repMap.set(id, fileRep);
        continue;
      }
      const winner = pickWinner(fileRep, ymapRep);
      if (winner === "file") {
        repMap.set(id, fileRep);
      } else {
        needsWrite = true;
      }
    }

    for (const id of repMap.keys()) {
      if (!fileReplies.has(id)) needsWrite = true;
    }
  }, FILE_SYNC_ORIGIN);

  if (needsWrite) {
    store.queueWrite(snapshot(ydoc, docHash, meta));
  }

  return registerAnnotationObserver(docName, ydoc, store, docHash, meta);
}

// ---------------------------------------------------------------------------
// Test-only reset
// ---------------------------------------------------------------------------

/** Reset all module state. Tests only — never call in production. */
export function resetForTesting(): void {
  tombstonesByDoc.clear();
  docContexts.clear();
}
