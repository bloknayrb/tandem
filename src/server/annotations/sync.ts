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
 *   - `file-sync`  → **record tombstone** + skip durable-write (echo from our own file writes).
 *                    Tombstone recording is load-bearing (#700): if `loadAndMerge` fails or is
 *                    skipped, this observer must still capture file-driven deletes so they aren't
 *                    lost. `recordTombstone` dedupes by id, so a seed + observer record at the
 *                    same rev is a no-op.
 *   - `internal`   → record tombstone + skip durable-write (setup ops; in practice no
 *                    INTERNAL_ORIGIN delete reaches the observer while it is live because
 *                    `clearAndReload` detaches the observer via `clearFileSyncContext` first).
 *   - `reload`     → record tombstone + queueWrite (file-watcher reload; relRanges must persist).
 *   - `mcp`        → record tombstone + queueWrite (Claude tool intent).
 *   - `null`/`undefined` → record tombstone + queueWrite (browser-origin user intent).
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
 *     Merge mutations use `withFileSync` so the observer would skip them
 *     anyway, but registering after merge avoids a speculative observer fire
 *     and keeps the ordering obvious in stack traces.
 *   - `recordTombstone(docHash, id, prevRev)` is PURE STATE MUTATION. It
 *     appends to the tombstone ledger and returns. It does NOT queue a
 *     store write on its own. The observer that wraps `annMap` records
 *     tombstones automatically on every `delete` mutation (regardless of
 *     origin) using the value's pre-delete `rev` from `YMapEvent.changes`.
 *     Callers may also call `recordTombstone` directly (it is idempotent
 *     via dedup), but the observer guarantees deletes that bypass the MCP
 *     tool path — stale-tab CRDT merges, browser-origin deletes, future
 *     write paths — still produce tombstones. See #695.
 */

import * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { shouldSkipDurableSync, withFileSync } from "../../shared/origins.js";
import { atMapKey, type RawAnnotation, sanitizeAnnotation } from "../../shared/sanitize.js";
import { AnnotationTypeSchema } from "../../shared/types.js";
import { extractText } from "../mcp/document-model.js";
import { getAliasLedger } from "./alias-ledger.js";
import { contentHash } from "./doc-hash.js";
import { assignEnvelopeRows } from "./legacy-envelope.js";
import { forgetDoc, logLegacyMigration, relaySanitizationEvent } from "./migration-log.js";
import { pickWinner } from "./pick-winner.js";
import {
  type AnnotationDocV1,
  type AnnotationRecordV1,
  AnnotationReplyRecordSchemaV1,
  type AnnotationReplyRecordV1,
  KEY_IDENTITY_FORMAT,
  nextRev,
  SCHEMA_VERSION,
  type TombstoneRecordV1,
} from "./schema.js";
import type { DocStore } from "./store.js";
import {
  resetThreadFieldsTrustForTests,
  settleThreadFieldsAtLoad,
  threadFieldsTrusted,
} from "./thread-answers-trust.js";

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

/**
 * Tombstones live in memory, keyed by docHash → (annotationId → record).
 * Inner Map collapses dedup-by-id to a single lookup; the disk envelope still
 * carries a flat array, so `snapshot()` materializes via `Array.from(...)`.
 */
const tombstonesByDoc = new Map<string, Map<string, TombstoneRecordV1>>();

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

const CANONICAL_TYPES = new Set<string>(AnnotationTypeSchema.options);

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
  if (typeof obj.rev === "number" && isCanonical) {
    // Strip directedAt even on the fast path — pre-ADR-027 comment records may carry it.
    if (!("directedAt" in obj)) return obj as AnnotationRecordV1;

    logLegacyMigration(docHash, "directedAt");
    const { directedAt: _, ...clean } = obj;
    return clean as AnnotationRecordV1;
  }

  if (!isCanonical) {
    logLegacyMigration(docHash, "legacy-type");
  }

  const sanitized = sanitizeAnnotation(obj as unknown as RawAnnotation, (event) =>
    relaySanitizationEvent(docHash, event),
  );
  return {
    ...sanitized,
    rev: typeof obj.rev === "number" ? obj.rev : 0,
  } as unknown as AnnotationRecordV1;
}

function normalizeReply(raw: unknown): AnnotationReplyRecordV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown> & Partial<AnnotationReplyRecordV1>;
  const withRev = typeof obj.rev === "number" ? obj : { ...obj, rev: 0 };
  const parsed = AnnotationReplyRecordSchemaV1.safeParse(withRev);
  if (!parsed.success) {
    const replyId = (withRev as { id?: unknown }).id ?? "<missing>";
    console.error(
      `[ANNOTATION-STORE] normalizeReply: dropping reply id=${String(replyId)}:`,
      parsed.error.issues,
    );
    return null;
  }
  return parsed.data;
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

  let annDrops = 0;
  let replyDrops = 0;

  // Each record is persisted under its MAP KEY (`atMapKey`): a record stored
  // under key K with `id: X` reaches disk as K, never as X, so `loadAndMerge`
  // (which keys file rows by id) cannot later land it on the record at X.
  // `atMapKey` copies only when the ids differ; the fast path's raw object is
  // never mutated. An empty key cannot be a valid envelope id, so it is dropped.
  const annotations: AnnotationRecordV1[] = [];
  annMap.forEach((value, key) => {
    const rec = key === "" ? null : normalizeAnnotation(value, docHash);
    if (rec) annotations.push(atMapKey(key, rec));
    else annDrops++;
  });

  const replies: AnnotationReplyRecordV1[] = [];
  for (const value of repMap.values()) {
    const rec = normalizeReply(value);
    if (rec) replies.push(rec);
    else replyDrops++;
  }

  if (annDrops > 0 || replyDrops > 0) {
    console.error(
      `[ANNOTATION-STORE] snapshot: dropped ${annDrops} annotation(s), ${replyDrops} reply(ies) in ${docHash}`,
    );
  }

  const tombstoneMap = tombstonesByDoc.get(docHash);
  const tombstones = tombstoneMap ? Array.from(tombstoneMap.values()) : [];

  // Recompute the content hash on EVERY durable write (#313). This keeps the
  // envelope's content fingerprint in lockstep with the live document so the
  // rename-recovery path can match a renamed-but-unedited file by exact text.
  const contentHashValue = contentHash(extractText(ydoc));

  return {
    schemaVersion: SCHEMA_VERSION,
    docHash,
    // `keyIdentity: 1` marks an envelope whose every row id is its map key.
    // Additive meta (MetaSchema is `.passthrough()`), no schemaVersion bump. An
    // older build that rewrites the file drops it, which falls back to the
    // conservative old-format merge.
    meta: {
      filePath: meta.filePath,
      lastUpdated: Date.now(),
      contentHash: contentHashValue,
      keyIdentity: KEY_IDENTITY_FORMAT,
      // #2360 (ownership on): only for a document this process trusts, which
      // needs ownership on (`thread-answers-trust.ts`). Never written dark, so
      // a dark build's envelope is byte-identical to before.
      ...(threadFieldsTrusted(docHash) ? { threadAnswersTrusted: true as const } : {}),
    },
    annotations,
    tombstones,
    replies,
  };
}

/**
 * Queue a durable snapshot of `ctx`'s document now.
 *
 * For writers whose origin durable sync deliberately skips (`withInternal`,
 * `withFileSync`) but whose write must still reach disk: the key-identity
 * reconciler's reply quarantine and id repair (`key-identity.ts`).
 */
export function queueSnapshot(ctx: SyncContext): void {
  const { store, ydoc, docHash, meta } = ctx;
  store.queueWrite(() => snapshot(ydoc, docHash, meta));
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

/** The handle both registrars return. Its phase is required — see below. */
export type ObserverCleanup = (phase: ObserverCleanupPhase) => void;

/**
 * Attach Y.Map observers for annotations and replies that mirror user-intent
 * mutations to the store. Returns a cleanup function that unobserves both
 * maps and drops the per-doc context entry. The per-doc tombstone ledger is
 * cleared only on `"close"` — on `"swap"` it must persist so an in-flight
 * debounced write doesn't serialize `tombstones: []` after the old observer
 * has been torn down.
 *
 * Callers (the open pipeline and the reload family, via the queue
 * indirection) invoke cleanup with the appropriate phase on doc close or
 * Y.Doc swap.
 *
 * The phase is REQUIRED, with no default (#1695). A wrong phase fails
 * silently — `"close"` on a swap drops tombstones an in-flight debounced
 * write still needs (#333), and `"swap"` on a close leaks the ledger — so a
 * caller must name it rather than inherit one.
 */
export function registerAnnotationObserver(ctx: SyncContext): ObserverCleanup {
  const { ydoc, store, docHash, meta } = ctx;

  const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
  const repMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);

  const onAnnMutation = (ev: Y.YMapEvent<unknown>, txn: Y.Transaction): void => {
    // Record tombstones unconditionally for ALL origins — including file-sync.
    // This is the load-bearing invariant (#700/#695): if `loadAndMerge` fails
    // or is skipped, file-sync deletes must still land in the ledger so they
    // aren't lost on the next snapshot. `recordTombstone` dedupes by id
    // (keeping highest rev), so a seed + observer record at the same rev is a
    // no-op. Stale-tab CRDT merges, browser-origin deletes, and all other
    // future write paths are also covered without special-casing.
    for (const [id, change] of ev.changes.keys) {
      if (change.action !== "delete") continue;
      const oldValue = change.oldValue as { rev?: number } | undefined;
      const hasRev = typeof oldValue?.rev === "number";
      const prevRev = hasRev ? (oldValue as { rev: number }).rev : 0;
      recordTombstone(docHash, id, prevRev);
      if (!hasRev) {
        // Legacy session blob entries lack `rev`; CRDT merge ordering against
        // a same-id resurrection from a stale peer is non-deterministic.
        console.warn(
          `[ANNOTATION-SYNC] tombstone for id=${id} has no oldValue.rev (origin=${String(txn.origin)})`,
        );
      }
    }

    // Skip durable-write queue for origins that explicitly own their own
    // persistence (file-sync echo, internal setup). See #695.
    if (shouldSkipDurableSync(txn.origin)) return;

    // Everything else is user intent: MCP_ORIGIN (Claude via an MCP tool),
    // null/undefined (browser), or any future origin tag we haven't named
    // yet. Queue a LAZY snapshot — the thunk only runs when the debounce
    // timer fires, so a burst of N mutations produces one serialization.
    store.queueWrite(() => snapshot(ydoc, docHash, meta));
  };

  const onRepMutation = (_ev: Y.YMapEvent<unknown>, txn: Y.Transaction): void => {
    if (shouldSkipDurableSync(txn.origin)) return;
    store.queueWrite(() => snapshot(ydoc, docHash, meta));
  };

  annMap.observe(onAnnMutation);
  repMap.observe(onRepMutation);

  return (phase: ObserverCleanupPhase) => {
    annMap.unobserve(onAnnMutation);
    repMap.unobserve(onRepMutation);
    if (phase === "close") {
      tombstonesByDoc.delete(docHash);
      // Drop migration-log dedup so a subsequent reopen can log once again —
      // matches "close" semantics (fresh context on next open).
      forgetDoc(docHash);
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
 * PURE STATE MUTATION — no store write is queued here. The annotation
 * observer (`registerAnnotationObserver`) calls this automatically on every
 * non-file-sync Y.Map delete event, snapshotting the pre-delete `rev` from
 * `YMapEvent.changes.keys`. Callers that want a synchronous tombstone
 * record without waiting for the observer can still call this directly —
 * it is idempotent.
 *
 * Idempotent: a duplicate call with the same `(id, rev)` (or an older rev
 * for the same id) is a no-op. Guards against unbounded array growth if a
 * caller double-fires (and is the contract relied on when the observer
 * fires after a caller-side `recordTombstone`).
 *
 * **This MINTS a record; it does not carry one.** The result is always a fresh
 * `{ id, rev, deletedAt: Date.now() }`, so a caller reseeding from a STORED
 * tombstone keeps the rev and loses the original `deletedAt` and any
 * passthrough fields — and `deletedAt` is what `cleanupStaleTombstones` ages
 * against, so the reseed resets that clock. `migrateTombstoneLedger` spreads
 * instead, which is why the two differ. The one reseeding caller today
 * (`rename-recovery.ts`) is fail-safe under this and says so at its call site;
 * a new one must check its own case rather than inherit that reasoning.
 */
export function recordTombstone(docHash: string, annotationId: string, prevRev: number): void {
  const newRev = prevRev + 1;
  let entries = tombstonesByDoc.get(docHash);
  if (!entries) {
    entries = new Map();
    tombstonesByDoc.set(docHash, entries);
  }
  const existing = entries.get(annotationId);
  if (existing && existing.rev >= newRev) return; // existing entry already wins
  entries.set(annotationId, { id: annotationId, rev: newRev, deletedAt: Date.now() });
}

/**
 * Read-only accessor for tests and for `injectTutorialAnnotations`, which
 * skips a seed whose id is tombstoned here (#1696). Returns a defensive copy
 * so callers can't mutate the module-internal array.
 */
export function getTombstones(docHash: string): TombstoneRecordV1[] {
  const entries = tombstonesByDoc.get(docHash);
  return entries ? Array.from(entries.values()) : [];
}

/**
 * Migrate (merge) the in-memory tombstone ledger from `fromHash` into
 * `toHash`, in place. Used by `renameDocument` (#1040) to carry tombstones
 * across the oldHash → newHash rename WITHOUT a window where neither ledger
 * holds a just-recorded deletion.
 *
 * Why a union, not a move: a concurrent DELETE arriving during the rename's
 * observer-detached gap (window (a)) records into the OLD-hash ledger via the
 * still-attached observer. Folding old → new (dedup by id, highest rev wins)
 * means that late tombstone survives into the post-rename envelope instead of
 * being dropped — closing the resurrection window. Idempotent: re-running is a
 * no-op, and a record already present at an equal-or-higher rev under `toHash`
 * is preserved.
 *
 * Order-independent **on `rev`**, which is the only field any merge rule reads.
 * Not order-independent on the rest of the record: first writer wins a rev tie,
 * so under two folds into one destination the surviving `deletedAt` (and every
 * passthrough field) depends on fold order — and `deletedAt` is what
 * `cleanupStaleTombstones` ages against. It takes two folds from DIFFERENT
 * sources to observe, and no caller does that today. A rename does fold twice
 * into one destination (`document-service.ts` before the RMW snapshot, then
 * `loadAndMerge`'s `migrateTombstonesFrom`), but both folds share one source and
 * the first spreads it, so the records re-entering on the second are
 * byte-identical and the order dependence is unobservable. That is a property of
 * the call graph, not of this function, and nothing asserts it: a second fold
 * SOURCE is a change in kind here while looking like a change in degree at the
 * call site.
 *
 * The `fromHash` ledger is left intact; the caller's subsequent
 * `clearFileSyncContext` / observer teardown ("close" phase) deletes it.
 */
export function migrateTombstoneLedger(fromHash: string, toHash: string): void {
  if (fromHash === toHash) return;
  const from = tombstonesByDoc.get(fromHash);
  if (!from || from.size === 0) return;
  let to = tombstonesByDoc.get(toHash);
  if (!to) {
    to = new Map();
    tombstonesByDoc.set(toHash, to);
  }
  for (const [id, stone] of from) {
    const existing = to.get(id);
    if (!existing || stone.rev > existing.rev) {
      // Re-key the record under the new hash. Spread the source so passthrough
      // fields (TombstoneRecordSchemaV1 is `.passthrough()`) carry over, not just
      // id/rev/deletedAt.
      to.set(id, { ...stone });
    }
  }
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export { pickWinner } from "./pick-winner.js";

const isPrivate = (rec: unknown): boolean => (rec as { private?: unknown }).private === true;

/**
 * Stamp `private` (with a bumped `rev`) on every USER reply filed under one of
 * `ids`, in both the file's copies and the live map. An id lands here when the
 * legacy-envelope pass found its thread ambiguous: an older client posted that
 * id from another record's card, so a note-thread reply may sit under a
 * comment. Fails closed. Returns the stamped file replies and whether anything
 * was stamped (the caller is inside `withFileSync`, which durable sync skips,
 * so a stamp must force a write).
 */
export function quarantineReplies(
  fileReplies: readonly AnnotationReplyRecordV1[],
  repMap: Y.Map<unknown>,
  ids: ReadonlySet<string>,
): { fileReplies: AnnotationReplyRecordV1[]; changed: boolean; stampedLiveKeys: string[] } {
  const stampedLiveKeys: string[] = [];
  if (ids.size === 0) return { fileReplies: [...fileReplies], changed: false, stampedLiveKeys };
  const ambiguous = (r: { author?: unknown; annotationId?: unknown; private?: unknown }) =>
    r.author === "user" &&
    r.private !== true &&
    typeof r.annotationId === "string" &&
    ids.has(r.annotationId);
  let changed = false;
  const stamped = fileReplies.map((r) => {
    if (!ambiguous(r)) return r;
    changed = true;
    return { ...r, private: true, rev: nextRev(r) };
  });
  repMap.forEach((value, key) => {
    const r = value as {
      author?: unknown;
      annotationId?: unknown;
      private?: unknown;
      rev?: number;
    };
    if (!r || typeof r !== "object" || !ambiguous(r)) return;
    repMap.set(key, { ...r, private: true, rev: nextRev(r) });
    stampedLiveKeys.push(key);
    changed = true;
  });
  return { fileReplies: stamped, changed, stampedLiveKeys };
}

/**
 * Merge the file's replies into the live map: stamp the ambiguous ones private
 * (`quarantineReplies`), then merge with `private` sticky. Returns whether a
 * write must be forced. The one sequence `loadAndMerge` and
 * `mergeEnvelopeForward` share.
 */
function mergeRepliesQuarantined(
  repMap: Y.Map<unknown>,
  replies: readonly AnnotationReplyRecordV1[],
  ids: ReadonlySet<string>,
): boolean {
  const quarantined = quarantineReplies(replies, repMap, ids);
  const fileReplies = new Map(quarantined.fileReplies.map((r) => [r.id, r]));
  const merged = mergeMap(repMap, fileReplies, normalizeReply, { stickyPrivate: true });
  return quarantined.changed || merged.needsWrite;
}

/**
 * Merge a Map of file records into a Y.Map under `pickWinner`'s rules
 * (higher `rev` wins; tied `rev` falls back to `editedAt`). For each file
 * record: insert if absent (unless `shouldSkipInsert` vetoes), otherwise
 * compare normalized copies and let the winner replace. After the pass,
 * `needsWrite` is true if the Y.Map carries ids the file doesn't (minus
 * `ymapOnlyIgnoreIds`) — caller queues a post-merge write so those land.
 * `fileWon` names every id the pass wrote FROM the file (inserted or replaced),
 * so a caller can fix up records whose file copy predates something the live
 * map already reflects (#2269's post-reload remap).
 */
function mergeMap<T extends { rev: number; editedAt?: number }>(
  ymap: Y.Map<unknown>,
  fileRecs: Map<string, T>,
  normalize: (raw: unknown) => T | null,
  opts: {
    shouldSkipInsert?: (id: string, fileRec: T) => boolean;
    ymapOnlyIgnoreIds?: Set<string>;
    /**
     * Replies only: `private: true` is sticky. If either copy is private the
     * survivor is written private, with `rev = max + 1`, so a stale envelope
     * copy can never bring back a reply the key-identity reconciler withheld
     * (nothing in `src/` ever clears `private`). A winner already private is
     * left as is, or every load would write.
     */
    stickyPrivate?: boolean;
  } = {},
): { needsWrite: boolean; fileWon: Set<string> } {
  let needsWrite = false;
  const fileWon = new Set<string>();

  for (const [id, fileRec] of fileRecs) {
    const ymapRaw = ymap.get(id);
    if (ymapRaw === undefined) {
      if (opts.shouldSkipInsert?.(id, fileRec)) continue;
      ymap.set(id, fileRec);
      fileWon.add(id);
      continue;
    }
    const ymapRec = normalize(ymapRaw);
    if (!ymapRec) {
      ymap.set(id, fileRec);
      fileWon.add(id);
      continue;
    }
    const winner = pickWinner(fileRec, ymapRec);
    const survivor = winner === "file" ? fileRec : ymapRec;
    if (opts.stickyPrivate && !isPrivate(survivor) && (isPrivate(fileRec) || isPrivate(ymapRec))) {
      ymap.set(id, { ...survivor, private: true, rev: Math.max(fileRec.rev, ymapRec.rev) + 1 });
      needsWrite = true;
      if (winner === "file") fileWon.add(id);
      continue;
    }
    if (winner === "file") {
      ymap.set(id, fileRec);
      fileWon.add(id);
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

  return { needsWrite, fileWon };
}

// ---------------------------------------------------------------------------
// loadAndMerge
// ---------------------------------------------------------------------------

/**
 * Load the on-disk annotation envelope for this doc and merge it with the
 * current Y.Doc state. The only caller is `wireAnnotationStore`
 * (`documents/annotation-wiring.ts`), which four paths reach: the open
 * pipeline, the reload family, rename and save-as. On the open path it runs
 * AFTER session restore populates the Y.Doc but BEFORE Hocuspocus starts
 * accepting browser connections for this doc; the other three re-wire an
 * already-connected document.
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
 *
 * `opts.afterMerge` runs INSIDE the merge transaction with the ids of every
 * annotation the merge took from the file (inserted, or replacing the map's
 * copy), and only when there is at least one. The content-replacing reloads
 * pass it (#2269): their map was remapped onto the new content before this
 * merge, so a record whose envelope copy wins comes back in pre-reload
 * coordinates and has to be remapped too. Returning `true` (it wrote) queues
 * the post-merge durable write. Not called on the fast paths, which take
 * nothing from the file.
 */
export async function loadAndMerge(
  ctx: SyncContext,
  opts?: {
    migrateTombstonesFrom?: string;
    afterMerge?: (fileWonIds: ReadonlySet<string>) => boolean;
  },
): Promise<ObserverCleanup> {
  const { ydoc, store, docHash, meta } = ctx;
  const file = await store.load();

  // Rename only (#1040, window a2): fold the oldHash tombstone ledger forward
  // into `docHash` AFTER the `store.load()` read resolves but BEFORE the seed +
  // merge below consult the ledger. A DELETE arriving DURING the read above is
  // recorded into the oldHash ledger by the still-attached old observer; folding
  // here ensures the union seed carries it, so the merge APPLIES the tombstone
  // (and skips re-inserting the just-deleted record from the file) instead of
  // resurrecting it. No-op when `from === to` or there is nothing to migrate.
  if (opts?.migrateTombstonesFrom !== undefined) {
    migrateTombstoneLedger(opts.migrateTombstonesFrom, docHash);
  }

  const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
  const repMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);

  const fileEmpty =
    file.annotations.length === 0 && file.replies.length === 0 && file.tombstones.length === 0;
  const ymapHasState = annMap.size > 0 || repMap.size > 0;

  // Seed tombstones from the file first so the observer (registered below)
  // picks them up on its first snapshot. Highest rev wins on duplicate ids
  // (consistent with recordTombstone's dedup rule; valid disk files never
  // have duplicates, but corrupt/hand-edited files should keep the winner).
  //
  // UNION, not clobber (#1040, window a3): a tombstone may already sit in the
  // in-memory ledger for `docHash` that the file does NOT yet carry — the
  // rename flow folds the oldHash ledger forward into newHash (via
  // `migrateTombstoneLedger`) BEFORE this re-wire's `store.load()` returns, and
  // a DELETE that lands after the rename's RMW snapshot is captured forward into
  // newHash but is absent from the just-written file. Clobbering with only the
  // file seed would discard it, re-opening the resurrection window. Merge both
  // sides keeping the highest rev per id.
  //
  // Safe on force-reload: `clearAndReload` calls `clearFileSyncContext` (which
  // runs the observer cleanup's "close" phase → `tombstonesByDoc.delete(hash)`)
  // BEFORE this runs, so the IN-MEMORY ledger starts empty there and no stale
  // ledger entry can be resurrected across a legitimate reload. Since #1813 the
  // FILE seed is no longer empty on that path — `clearAndReload` flushes the
  // envelope instead of unlinking it, so the union degenerates to whatever the
  // flushed file carries, which is the pre-reload tombstone set. That is the
  // point: the flush runs BEFORE the cleanup precisely so those tombstones are
  // still in the ledger when the snapshot is taken.
  const seed = tombstonesByDoc.get(docHash) ?? new Map<string, TombstoneRecordV1>();
  // Track whether the pre-existing in-memory ledger carries tombstones the file
  // does not — those are migrated-forward deletes (rename) that must still be
  // APPLIED against the Y.Map below and PERSISTED even on the file-empty path.
  const fileTombstoneIds = new Set(file.tombstones.map((s) => s.id));
  let seedHasExtraTombstones = false;
  for (const id of seed.keys()) {
    if (!fileTombstoneIds.has(id)) seedHasExtraTombstones = true;
  }
  for (const stone of file.tombstones) {
    const existing = seed.get(stone.id);
    // Preserve the file record as-is (TombstoneRecordV1 is `.passthrough()`),
    // matching the original seed semantics — only override when the file copy
    // wins on rev.
    if (!existing || stone.rev > existing.rev) seed.set(stone.id, stone);
  }
  tombstonesByDoc.set(docHash, seed);
  // The authoritative tombstone set for the merge below is the UNIONED ledger,
  // not just the file's — so a migrated-forward delete that never reached disk
  // still drops a resurrected Y.Map entry.
  const effectiveTombstones = Array.from(seed.values());

  // #2360: the reply rows' server-only thread fields are trusted, or
  // stripped, AFTER whatever reaches the Y.Doc here (session restore before
  // this call, the file's rows in the merge below). The fast path takes
  // nothing from the file, so it decides here; the full merge, after it.
  const fileTrusted = file.meta.threadAnswersTrusted === true;

  if (fileEmpty && !seedHasExtraTombstones) {
    const rewrite = settleThreadFieldsAtLoad(ydoc, docHash, fileTrusted);
    // First-upgrade path: write one atomic snapshot capturing whatever the
    // Y.Maps currently hold. No merge work needed. A rowless file is
    // rewritten only to drop a marker (flag off): with the Y.Maps empty there
    // is nothing stripped, and a marker alone is not worth creating a file.
    if (ymapHasState || (rewrite && fileTrusted)) {
      store.queueWrite(() => snapshot(ydoc, docHash, meta));
    }
    // Both sides empty (and no migrated-forward tombstone) — nothing to merge.
    return registerAnnotationObserver(ctx);
  }

  // Full merge. `needsWrite` tracks whether the final Y.Map state has
  // anything the file doesn't — in which case we queue a post-merge write so
  // those additions land durably without waiting for the next mutation.
  let needsWrite = false;

  withFileSync(ydoc, () => {
    // Apply tombstones first so a later merge step can't overwrite a winning
    // delete. Iterate the UNIONED ledger (`effectiveTombstones`) — not just the
    // file's — so a migrated-forward delete that never reached disk (#1040,
    // window a3: a rename's late DELETE folded into newHash but absent from the
    // just-written envelope) still drops its resurrected Y.Map entry.
    for (const stone of effectiveTombstones) {
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
    // Rows are routed onto TARGET keys (`legacy-envelope.ts`): an old-format
    // envelope can hold a record under another record's id, and keying rows by
    // id (last one wins) wrote one record over another. Runs after the
    // tombstone loop, so a deleted record is no candidate. Tombstones are then
    // checked at the TARGET key, which is what they are recorded under.
    const assignment = assignEnvelopeRows(file, annMap, getAliasLedger(ydoc), docHash);
    const fileAnns = assignment.rows;
    if (assignment.moved) needsWrite = true; // write the corrected, marked envelope
    const winningTombstoneIds = new Set<string>();
    const tombstoneIds = new Set<string>();
    for (const stone of effectiveTombstones) {
      tombstoneIds.add(stone.id);
      const fileAnn = fileAnns.get(stone.id);
      if (fileAnn && stone.rev > fileAnn.rev) winningTombstoneIds.add(stone.id);
    }

    const annResult = mergeMap(annMap, fileAnns, (raw) => normalizeAnnotation(raw, docHash), {
      shouldSkipInsert: (id) => winningTombstoneIds.has(id),
      ymapOnlyIgnoreIds: tombstoneIds,
    });
    if (annResult.needsWrite) needsWrite = true;
    if (opts?.afterMerge && annResult.fileWon.size > 0 && opts.afterMerge(annResult.fileWon)) {
      needsWrite = true;
    }

    if (mergeRepliesQuarantined(repMap, file.replies, assignment.quarantineIds)) {
      needsWrite = true;
    }
  });

  if (settleThreadFieldsAtLoad(ydoc, docHash, fileTrusted)) needsWrite = true;

  // Force a write when the union pulled in tombstones the file lacked — those
  // migrated-forward deletes must land on disk so a subsequent reopen (with an
  // empty in-memory ledger) still sees them.
  if (needsWrite || seedHasExtraTombstones) {
    store.queueWrite(() => snapshot(ydoc, docHash, meta));
  }

  return registerAnnotationObserver(ctx);
}

/**
 * Merge an ALREADY-LOADED file envelope's alive records forward into the live
 * Y.Doc, applying `pickWinner` (file-wins by rev, then editedAt). Mutates the
 * Y.Maps in place under a single `FILE_SYNC_ORIGIN` transaction; records NO
 * observer and queues NO write (the caller owns persistence + observer wiring).
 *
 * RENAME-ONLY (#1040 × #1041 regression): #1051's rename RMW writes the new-hash
 * envelope from a pure live `snapshot()`. When a durable annotation is NEWER in
 * the OLD file envelope than in the live Y.Doc (e.g. a note flushed at rev 2 but
 * diverged to rev 1 in the live map via a `withInternal` write the durable-sync
 * observer skipped), that pure-live snapshot DROPS the file-newer record, and the
 * subsequent re-wire's `loadAndMerge` — now reading the just-clobbered new-hash
 * envelope — finds nothing newer than live, so the rev-2 record is lost on rename.
 * Folding the old envelope's alive records into the live doc BEFORE the RMW
 * snapshot lets the file-newer record win and land in the new envelope, so the
 * file-wins branch survives the rename. In the common case (live == file) this is
 * an idempotent no-op (every record ties on rev, so `pickWinner` leaves the live
 * entry untouched).
 *
 * Tombstones from the old envelope are handled separately by the rename flow's
 * `migrateTombstoneLedger` fold + the re-wire's unioned-ledger application, so a
 * winning tombstone still drops any record this fold resurrects — order does not
 * matter (the re-wire applies tombstones after). We still SKIP inserting a record
 * the effective ledger already tombstones-out, so a just-deleted note isn't
 * resurrected by this pre-fold even before the re-wire runs.
 */
export function mergeEnvelopeForward(
  ydoc: Y.Doc,
  file: AnnotationDocV1,
  docHash: string,
): { needsWrite: boolean } {
  const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
  const repMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);

  // Effective tombstone rev per id = the in-memory ledger for this docHash unioned
  // with the file's own tombstones (highest rev wins). Mirrors `loadAndMerge`'s
  // seed so a file-alive record that a tombstone beats is never inserted by this
  // fold. Computed into a LOCAL map — this helper must not mutate the shared
  // ledger (the re-wire's `loadAndMerge` owns the authoritative union + persist).
  const effectiveRev = new Map<string, number>();
  const ledger = tombstonesByDoc.get(docHash);
  if (ledger) {
    for (const [id, stone] of ledger) effectiveRev.set(id, stone.rev);
  }
  for (const stone of file.tombstones) {
    const existing = effectiveRev.get(stone.id);
    if (existing === undefined || stone.rev > existing) effectiveRev.set(stone.id, stone.rev);
  }
  let needsWrite = false;
  withFileSync(ydoc, () => {
    // Same routing as `loadAndMerge`: rows onto target keys, tombstones
    // checked at the target key.
    const assignment = assignEnvelopeRows(file, annMap, getAliasLedger(ydoc), docHash);
    const fileAnns = assignment.rows;
    if (assignment.moved) needsWrite = true;
    const winningTombstoneIds = new Set<string>();
    for (const [id, ann] of fileAnns) {
      const stoneRev = effectiveRev.get(id);
      if (stoneRev !== undefined && stoneRev > ann.rev) winningTombstoneIds.add(id);
    }
    const annResult = mergeMap(annMap, fileAnns, (raw) => normalizeAnnotation(raw, docHash), {
      shouldSkipInsert: (id) => winningTombstoneIds.has(id),
    });
    if (annResult.needsWrite) needsWrite = true;
    if (mergeRepliesQuarantined(repMap, file.replies, assignment.quarantineIds)) {
      needsWrite = true;
    }
  });
  // Queues no write itself; a caller that must persist reads `needsWrite`.
  return { needsWrite };
}

/**
 * Force one durable snapshot write for a document — capturing the current Y.Map
 * + tombstone-ledger state under `docHash` with `filePath` in the envelope meta,
 * then flush it synchronously.
 *
 * Used by `renameDocument` (#1017) to heal the envelope's internal
 * `meta.filePath` after a rename: `loadAndMerge` skips its post-merge write when
 * the moved envelope already equals the live Y.Map (`needsWrite === false`),
 * which would leave the stale pre-rename path in the envelope. A stale
 * `meta.filePath` (now a vanished path) is exactly the signal the PASSIVE
 * rename-recovery scan matches on — so it could match and STEAL this envelope
 * for a byte-identical doc opened later. Forcing one snapshot through the same
 * per-hash write queue rewrites `meta.filePath` to the post-rename path, closing
 * that window.
 */
export async function persistSnapshot(
  store: DocStore,
  ydoc: Y.Doc,
  docHash: string,
  filePath: string,
): Promise<void> {
  store.queueWrite(() => snapshot(ydoc, docHash, { filePath }));
  await store.flush();
}

// ---------------------------------------------------------------------------
// Test-only reset
// ---------------------------------------------------------------------------

/** Reset all module state. Tests only — never call in production. */
export function resetForTesting(): void {
  tombstonesByDoc.clear();
  resetThreadFieldsTrustForTests();
}
