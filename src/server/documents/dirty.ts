/**
 * Per-document "dirty" tracking for autosave gating (#851).
 *
 * Problem: the 60s autosave timer used to round-trip EVERY open document
 * through the serializer + `atomicWrite`, even ones that were merely opened to
 * view and never edited. Opening a file to read it would silently rewrite it on
 * disk (serializer escape noise, mtime churn). See lesson #69 / issue #605.
 *
 * Fix: track a per-document dirty flag, set whenever the document BODY — its
 * ProseMirror `Y.XmlFragment("default")` — actually changes. Autosave only
 * writes a doc that is dirty-since-last-save.
 *
 * Design notes (CRDT review, MANDATORY):
 *  - We observe the XmlFragment directly via `observeDeep`, NOT `doc.on("update")`
 *    filtered by transaction origin. Observing the body shared type means
 *    meta-only writes (`Y_MAP_DOCUMENT_META` / `Y_MAP_SAVED_AT_VERSION`) and
 *    awareness writes never mark the doc dirty — only real content edits do.
 *  - We do NOT gate on browser-origin writes. Claude's `tandem_edit` writes are
 *    `mcp`-origin; gating on browser-only would mean Claude's edits never get
 *    persisted to disk (silent disk/editor divergence). ANY content edit
 *    (browser / mcp / reload) marks the doc dirty.
 *  - The observer MUST survive the Hocuspocus Y.Doc swap (`onLoadDocument`
 *    replaces the Y.Doc instance). It is registered from the event-queue
 *    `attachObservers` path, which is re-run on every swap via
 *    `reattachObservers`. State is keyed by docId in this module (mirroring
 *    how `savingDocs` is kept) so it persists across swaps.
 *  - The dirty flag's SOURCE OF TRUTH lives in MODULE STATE, never in the Y.Doc.
 *    Since #1447 a read-only MIRROR of the derived boolean is projected into the
 *    document's own `documentMeta` under `Y_MAP_DIRTY` so the client's tab can
 *    show an unsaved dot for an edit that landed before any browser attached —
 *    see `publishDirty` below for why that write cannot feed back into the flag
 *    it mirrors, and `Y_MAP_DIRTY`'s doc comment in `shared/constants.ts` for
 *    the user-visible reason it exists.
 *
 * Dirty is represented as a monotonically increasing edit counter (a "version")
 * rather than a boolean. This lets `saveDocumentToDisk` snapshot the version
 * BEFORE the async write and clear-to-clean only if no new edit landed during
 * the write — avoiding the lost-update race where a mid-write edit would
 * otherwise be marked saved.
 */

import type * as Y from "yjs";
import { Y_MAP_DIRTY, Y_MAP_DOCUMENT_META } from "../../shared/constants.js";
import { withInternal } from "../../shared/origins.js";
import { getDocument } from "../yjs/provider.js";

/** Name of the ProseMirror body XmlFragment. Matches `doc.getXmlFragment("default")` everywhere else. */
const BODY_FRAGMENT = "default";

interface DirtyState {
  /** Monotonic edit counter. Bumped on every body-content change. */
  version: number;
  /** Version that was last persisted to disk (or the open-time baseline). */
  savedVersion: number;
  /** The deep observer callback currently attached, so we can detach on re-register. */
  observer: (() => void) | null;
}

const dirtyStates = new Map<string, DirtyState>();

/**
 * Predicate deciding whether a document's dirty flag may be mirrored into its
 * `documentMeta` (#1447). Registered by `documents/registry.ts`, which owns the
 * `source: "file" | "upload"` fact — the same callback-injection pattern
 * `yjs/provider.ts` uses for `setShouldKeepDocument`.
 *
 * Injected rather than imported: `events/queue.ts` imports THIS module, so an
 * `import { getOpenDocs } from "./registry.js"` here would pull the registry's
 * module-scope `setShouldKeepDocument(...)` side effect into the event queue's
 * import graph. It does — it broke two suites that partially mock
 * `yjs/provider.js`. Inverting the direction keeps this module a leaf.
 *
 * Unregistered means "mirror everything", which is the right default for a
 * docId the registry doesn't track.
 */
let mirrorEligible: ((docId: string) => boolean) | null = null;

/** @see mirrorEligible */
export function setDirtyMirrorEligibility(fn: (docId: string) => boolean): void {
  mirrorEligible = fn;
}

function getOrInit(docId: string): DirtyState {
  let state = dirtyStates.get(docId);
  if (!state) {
    state = { version: 0, savedVersion: 0, observer: null };
    dirtyStates.set(docId, state);
  }
  return state;
}

/**
 * Register (or re-register on Y.Doc swap) a deep observer on the document body
 * that bumps the dirty version on any content change. Idempotent: detaches a
 * previously-attached observer for this docId first.
 *
 * IMPORTANT: this preserves the existing version/savedVersion across swaps so a
 * doc edited-then-reconnected stays dirty.
 */
export function registerDirtyObserver(docId: string, doc: Y.Doc): void {
  const state = getOrInit(docId);

  // Detach the prior observer (old Y.Doc instance) before attaching to the new one.
  if (state.observer) {
    state.observer();
    state.observer = null;
  }

  const fragment = doc.getXmlFragment(BODY_FRAGMENT);
  const handler = () => {
    state.version += 1;
    publishDirty(docId);
  };
  fragment.observeDeep(handler);
  state.observer = () => fragment.unobserveDeep(handler);

  // Publish AFTER (re)attaching, unconditionally. This is the heal point: it
  // seeds the mirror on a fresh doc after the Hocuspocus swap, and it corrects a
  // stale value carried in from a restored session snapshot. The map itself is
  // the transition test (see publishDirty), so re-publishing an unchanged value
  // costs one Y.Map read and writes nothing.
  publishDirty(docId);
}

/**
 * Project the derived dirty boolean into the document's own `documentMeta`
 * (#1447). Everything about this function is deliberate:
 *
 *  - The LIVE Y.Doc is resolved through `getDocument(docId)` on every call, never
 *    cached in module state. Hocuspocus replaces the Y.Doc in `onLoadDocument`
 *    and `destroy()`s the old instance (yjs/provider.ts), and `detachObservers`
 *    does not detach this observer — so a cached reference could outlive its doc
 *    and publish into an orphan nobody syncs. A docId with no live doc (closed,
 *    unloaded) simply doesn't publish.
 *  - The Y.MAP is the transition test, not a module-state cache. A cached
 *    "last published" boolean survives the doc swap (this module deliberately
 *    preserves per-docId state across swaps), so it would suppress the write
 *    that seeds the NEW doc's map. Reading the map is inherently correct across
 *    swaps, restarts and session restore.
 *  - `source: "upload"` docs are excluded, via the injected `mirrorEligible`
 *    predicate. A scratchpad/upload can't be written to disk without a Save As
 *    promotion (`saveDocumentToDisk` returns PROMOTION_REQUIRED, autosave skips
 *    them, nothing calls `markClean`), so a mirrored `true` would be a dot with
 *    no code path able to clear it. Evaluated live, not latched at registration,
 *    so a promoted scratchpad (source flips upload→file, same docId/room) starts
 *    mirroring at its post-promote `markClean`.
 *  - `withInternal` is the contract-correct helper: a server metadata broadcast,
 *    like `broadcastOpenDocs`. `withBrowser` is the ONLY channel-emitting origin,
 *    so it would fire a spurious channel event at Claude on every save.
 *  - No feedback loop: `registerDirtyObserver` observes the body XmlFragment
 *    only, and this write is off-fragment, so it bumps no version.
 *  - Called from inside the fragment observer, i.e. during yjs's transaction
 *    cleanup. That does NOT inherit the outer transaction's origin: yjs 13.6.30
 *    nulls `doc._transaction` (yjs.cjs:3455) BEFORE running observers via
 *    `cleanupTransactions` (yjs.cjs:3465), so the nested `transact` allocates a
 *    fresh Transaction tagged `internal`.
 */
function publishDirty(docId: string): void {
  const state = dirtyStates.get(docId);
  if (!state) return;

  const doc = getDocument(docId);
  if (!doc) return;
  if (mirrorEligible && !mirrorEligible(docId)) return;

  // Derived from `isDirty`, never re-derived: the mirror and the flag it mirrors
  // must not have two independent definitions. A future guard added to `isDirty`
  // (readOnly and source are both already live concerns in this module's
  // callers) would otherwise leave this projecting the OLD predicate — autosave
  // acting on one boolean while the tab dot shows the other, with no type error
  // and no failing test. The `!state` branch inside `isDirty` is unreachable
  // here; the early return above already covers it.
  const value = isDirty(docId);
  const meta = doc.getMap(Y_MAP_DOCUMENT_META);
  if (meta.get(Y_MAP_DIRTY) === value) return;

  withInternal(doc, () => meta.set(Y_MAP_DIRTY, value));
}

/** Detach the dirty observer for a doc and drop its tracked state. Call on close. */
export function clearDirtyState(docId: string): void {
  const state = dirtyStates.get(docId);
  if (state?.observer) state.observer();
  dirtyStates.delete(docId);
}

/**
 * Mark a document dirty without a body edit (#1069). Used after restoring a
 * session whose `dirty` flag was set: the restored content was never persisted
 * to disk, but the observer registered at open time starts from a clean
 * baseline — without this bump, autosave would skip the restored edits and the
 * file watcher's dirty check would treat the doc as clean (and auto-reload over
 * the only copy of those edits, in any format since #1238).
 */
export function markDirty(docId: string): void {
  getOrInit(docId).version += 1;
  publishDirty(docId);
}

/** True if the document has body edits that have not been persisted to disk. */
export function isDirty(docId: string): boolean {
  const state = dirtyStates.get(docId);
  if (!state) return false;
  return state.version > state.savedVersion;
}

/**
 * Snapshot the current edit version. Pass the result to `markCleanIfUnchanged`
 * after the async disk write so a mid-write edit isn't lost.
 */
export function snapshotDirtyVersion(docId: string): number {
  return getOrInit(docId).version;
}

/**
 * Mark the document clean IF no new edit landed since `snapshot` was taken.
 * Returns true if it was marked clean, false if a concurrent edit kept it dirty.
 *
 * Called by `saveDocumentToDisk` ONLY on `status === "saved"`. A skipped save
 * (e.g. "file modified externally") must NOT clear the flag — the in-memory
 * edits are still unpersisted.
 */
export function markCleanIfUnchanged(docId: string, snapshot: number): boolean {
  const state = dirtyStates.get(docId);
  if (!state) return false;
  if (state.version !== snapshot) {
    // A new edit arrived during the write — keep the doc dirty so the next
    // autosave pass picks it up. Re-publish anyway (a no-op write-wise): this is
    // the path where `saveDocumentToDisk` has ALREADY written a fresh
    // Y_MAP_SAVED_AT_VERSION, so the mirror is the only thing left telling the
    // client not to treat that save as having made the tab clean.
    publishDirty(docId);
    return false;
  }
  state.savedVersion = state.version;
  publishDirty(docId);
  return true;
}

/**
 * Mark a document clean unconditionally at its current version. Used when the
 * baseline is known-persisted (open from disk / post-promote) and there's no
 * in-flight async write to race against.
 */
export function markClean(docId: string): void {
  const state = getOrInit(docId);
  state.savedVersion = state.version;
  publishDirty(docId);
}

/** Reset all dirty state — including the injected mirror predicate. For tests only. */
export function resetForTesting(): void {
  for (const state of dirtyStates.values()) {
    if (state.observer) state.observer();
  }
  dirtyStates.clear();
  // Inert today (the only registrar is `registry.ts`'s module scope, and vitest
  // isolates per file), but a test that calls `setDirtyMirrorEligibility`
  // directly would otherwise leak its predicate into every later test in the
  // file — and the symptom, a mirror that silently stops publishing, looks
  // exactly like a product bug.
  mirrorEligible = null;
}
