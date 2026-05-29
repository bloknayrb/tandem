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
 *  - The dirty flag lives in MODULE STATE, never in the Y.Doc. We don't write a
 *    flag back into the CRDT (that would itself be a write needing an origin
 *    tag and could create observer feedback).
 *
 * Dirty is represented as a monotonically increasing edit counter (a "version")
 * rather than a boolean. This lets `saveDocumentToDisk` snapshot the version
 * BEFORE the async write and clear-to-clean only if no new edit landed during
 * the write — avoiding the lost-update race where a mid-write edit would
 * otherwise be marked saved.
 */

import type * as Y from "yjs";

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
  };
  fragment.observeDeep(handler);
  state.observer = () => fragment.unobserveDeep(handler);
}

/** Detach the dirty observer for a doc and drop its tracked state. Call on close. */
export function clearDirtyState(docId: string): void {
  const state = dirtyStates.get(docId);
  if (state?.observer) state.observer();
  dirtyStates.delete(docId);
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
    // autosave pass picks it up.
    return false;
  }
  state.savedVersion = state.version;
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
}

/** Reset all dirty state. For tests only. */
export function resetForTesting(): void {
  for (const state of dirtyStates.values()) {
    if (state.observer) state.observer();
  }
  dirtyStates.clear();
}
