/**
 * Document registry (ADR-033).
 *
 * Owns the multi-document state previously spread across
 * `src/server/mcp/document-service.ts`:
 *   - `openDocs` — the per-tab metadata map (filePath, format, readOnly, source)
 *   - `activeDocId` — which document MCP tools default to
 *   - the `documentMeta` broadcast that publishes both to every client
 *
 * The registry layers ABOVE `provider.ts`'s `documents: Map<string, Y.Doc>`.
 * It does NOT absorb Y.Doc instance storage — `provider.ts` legitimately
 * keeps two classes of entries (tracked-open tabs + Hocuspocus-internal
 * rooms like CTRL_ROOM) that the registry's `OpenDoc` shape cannot model
 * uniformly. See ADR-033 § "Options considered" (a) vs (b).
 *
 * ## Why the mutators are composites and the primitives are private
 *
 * The three primitives — track, untrack, set-active — used to be exported, and
 * every caller was responsible for following them with exactly one
 * `broadcastOpenDocs()`. That is a rule no type could state, and getting it
 * wrong is silent in both directions:
 *
 *   - **Broadcasting between two primitives publishes an inconsistent
 *     snapshot** — a document already listed under the *previous* active id.
 *   - **Broadcasting per primitive advances the activation epoch twice for one
 *     user gesture.** The epoch is how a client tells a genuine focus event
 *     from a stale CRDT re-broadcast, so a second advance silently overrides a
 *     tab switch the user made in between (`client/hooks/tab-reconcile.ts`).
 *
 * So `openDocument` / `activateDocument` / `updateDocument` / `closeDocument`
 * are the mutating surface, each ending in exactly one broadcast, and the
 * primitives are not reachable from outside this file. `broadcastOpenDocs`
 * stays exported for the one honest remaining case: content changed, the tab
 * list did not.
 *
 * Save/auto-save and session-restore concerns stay in `document-service.ts`;
 * a document *close* there is a broader teardown (store flush, file-sync
 * context, dirty state, session file) that calls this module's narrow
 * `closeDocument` as one step. The registry does not own that teardown.
 */

import path from "path";
import type * as Y from "yjs";
import {
  CTRL_ROOM,
  Y_MAP_ACTIVE_DOCUMENT_EPOCH,
  Y_MAP_ACTIVE_DOCUMENT_ID,
  Y_MAP_DOCUMENT_META,
  Y_MAP_OPEN_DOCUMENTS,
} from "../../shared/constants.js";
import { withInternal } from "../../shared/origins.js";
import { getOrCreateDocument } from "../yjs/provider.js";

export interface OpenDoc {
  id: string;
  filePath: string;
  format: string;
  readOnly: boolean;
  source: "file" | "upload";
}

/** All open documents, keyed by document ID (which is also the Hocuspocus room name). */
const openDocs = new Map<string, OpenDoc>();

/** The active document ID — tools default to this when no documentId is specified. */
let activeDocId: string | null = null;

// Monotonic activation counter. Every activation advances it, even when the id
// is unchanged — clients treat an advance as an intentional focus event (e.g.
// re-opening the already-active doc). Broadcast alongside the active id so
// clients can distinguish a genuine (re)activation from a stale CRDT re-broadcast
// of unchanged state, which must not clobber a local (keyboard/click) tab switch.
let activeDocEpoch = 0;

/** Private primitive — see the module doc for why it is not exported. */
function setActive(id: string | null): void {
  activeDocId = id;
  activeDocEpoch++;
}

/**
 * #1447: a scratchpad/upload can never reach disk without a Save As promotion,
 * so its dirty flag must NOT be mirrored into documentMeta — the tab would show
 * an unsaved dot that no code path could clear, across every reload. Evaluated
 * live (not latched when the dirty observer registers) so a promoted scratchpad
 * — source flips upload→file on the same docId/room — starts mirroring at its
 * post-promote markClean.
 *
 * Registered by `bootstrap/hocuspocus-lifecycle.ts` alongside the Hocuspocus
 * lifecycle (ADR-033). It used to be registered here, at module-import time;
 * that made "is it registered?" depend on whether anything had happened to
 * import this file, which is not a fact any test could state. Tests that call
 * `dirty.resetForTesting()` reinstall it through the same export.
 */
export function isDirtyMirrorEligible(id: string): boolean {
  return openDocs.get(id)?.source !== "upload";
}

export function getOpenDocs(): ReadonlyMap<string, OpenDoc> {
  return openDocs;
}

export function hasDoc(id: string): boolean {
  return openDocs.has(id);
}

export function docCount(): number {
  return openDocs.size;
}

export function getActiveDocId(): string | null {
  return activeDocId;
}

/** Current activation epoch — broadcast in documentMeta so clients can tell a
 * genuine (re)activation from a redundant re-broadcast. See `activeDocEpoch`. */
export function getActiveDocEpoch(): number {
  return activeDocEpoch;
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

/** Build the document list entry for a single OpenDoc */
export function toDocListEntry(d: OpenDoc) {
  return {
    id: d.id,
    filePath: d.filePath,
    fileName: path.basename(d.filePath),
    format: d.format,
    readOnly: d.readOnly,
    // `source` distinguishes on-disk files ("file") from ephemeral
    // scratchpads/uploads ("upload"). The client uses it to gate the rename
    // affordance (only "file" docs are renamable); see #1017.
    source: d.source,
  };
}

/**
 * Publish the open documents list.
 *
 * Writes the bootstrap room (CTRL_ROOM) so new clients discover docs, and every
 * open document's own room so no per-doc Y.Doc ever holds a stale list — one
 * transaction each, `1 + N` in total, all seeded from a single epoch read so no
 * two rooms can skew within a call.
 *
 * `withInternal`, never `withBrowser`: this is server bookkeeping mirrored to
 * clients, and `browser` is the only channel-emitting origin (Critical Rule 2,
 * ADR-031). Tagging it as a browser write would push a channel payload at the
 * AI for every tab operation.
 *
 * Exported for the one caller shape the composites below cannot express: a
 * document's *content* changed while the tab list did not (the reload path).
 * Reaching for it after a state mutation is the bug the composites exist to
 * prevent — the mutators already broadcast.
 */
export function broadcastOpenDocs(): void {
  const docList = Array.from(openDocs.values()).map(toDocListEntry);
  const id = activeDocId;
  const epoch = activeDocEpoch;

  try {
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    const ctrlMeta = ctrl.getMap(Y_MAP_DOCUMENT_META);
    withInternal(ctrl, () => {
      ctrlMeta.set(Y_MAP_OPEN_DOCUMENTS, docList);
      ctrlMeta.set(Y_MAP_ACTIVE_DOCUMENT_ID, id);
      ctrlMeta.set(Y_MAP_ACTIVE_DOCUMENT_EPOCH, epoch);
    });
  } catch (err) {
    console.error("[Tandem] broadcastOpenDocs: failed to update CTRL_ROOM:", err);
  }

  // Update ALL open doc rooms so no per-doc Y.Doc ever has a stale list.
  for (const [docId] of openDocs) {
    try {
      const ydoc = getOrCreateDocument(docId);
      const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);
      withInternal(ydoc, () => {
        meta.set(Y_MAP_OPEN_DOCUMENTS, docList);
        meta.set(Y_MAP_ACTIVE_DOCUMENT_ID, id);
        meta.set(Y_MAP_ACTIVE_DOCUMENT_EPOCH, epoch);
      });
    } catch (err) {
      console.error("[Tandem] broadcastOpenDocs: failed to update doc %s:", docId, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Composite operations — the whole mutating surface
// ---------------------------------------------------------------------------

/** Track a document and make it active, publishing both in one broadcast. */
export function openDocument(entry: OpenDoc): void {
  openDocs.set(entry.id, entry);
  setActive(entry.id);
  broadcastOpenDocs();
}

/**
 * `openDocument`, but the publish waits for `prepare`.
 *
 * Most opens are not finished at the moment the registry changes: the document
 * meta, the saved baseline, the annotation store and the dirty observer all
 * have to be wired first, and publishing the tab before that shows clients a
 * document that is not ready. Passing that work in — rather than leaving the
 * caller to mutate, prepare, then remember to broadcast — is what keeps the
 * primitives private without moving the publish earlier than it was.
 *
 * A throw from `prepare` propagates and skips the broadcast, matching the
 * hand-rolled sequences this replaces: a failed open must not publish a tab.
 */
export async function openDocumentWhenReady(
  entry: OpenDoc,
  prepare: () => void | Promise<void>,
): Promise<void> {
  openDocs.set(entry.id, entry);
  setActive(entry.id);
  await prepare();
  broadcastOpenDocs();
}

/**
 * Make a document active and publish it.
 *
 * Advances the activation epoch even when `id` is already active: re-selecting
 * the open document is a real focus event the client must honour.
 */
export function activateDocument(id: string | null): void {
  setActive(id);
  broadcastOpenDocs();
}

/**
 * Change a tracked document's entry, publishing after `prepare` resolves.
 *
 * Two properties, each of which a caller got wrong before this existed.
 *
 * **It does not activate.** A rename or a Save-As promotion changes what a tab
 * *is*, not which tab is focused. Routing either through {@link openDocument}
 * would advance the activation epoch, and the client reads an advance as an
 * intentional focus event — so the user's tab would jump under them when a
 * background file was renamed.
 *
 * **It publishes late, but unconditionally.** The registry write cannot always
 * be deferred (Save-As runs `markClean`, which reads this entry's `source`),
 * yet the publish should still wait for the work that finishes the change:
 * Save-As re-wires the annotation store and re-attaches channel observers after
 * the entry flips to `source: "file"`, and rename awaits an `fs.stat` before
 * writing the document's own `fileName`. Publishing at the mutation point shows
 * clients the new identity across those gaps.
 *
 * The broadcast is in a `finally`, which is where this DELIBERATELY diverges
 * from {@link openDocumentWhenReady}. A failed open must not add a tab, so that
 * one skips its broadcast. An update's entry is already tracked and already on
 * screen, so skipping would leave clients showing the pre-update entry forever
 * while the registry holds the new one — trading a transient inconsistency for
 * a permanent one.
 */
export async function updateDocumentWhenReady(
  entry: OpenDoc,
  prepare: () => void | Promise<void>,
): Promise<void> {
  openDocs.set(entry.id, entry);
  try {
    await prepare();
  } finally {
    broadcastOpenDocs();
  }
}

/**
 * Untrack a document and publish the result, reassigning the active id to the
 * first surviving document when the closed one held it.
 *
 * The registry's slice of a close and nothing more — the store flush,
 * file-sync context, dirty state and session file are `document-service.ts`'s,
 * and their ordering there is load-bearing.
 *
 * Returns whether the document was tracked.
 */
export function closeDocument(id: string): boolean {
  const wasTracked = openDocs.delete(id);
  if (activeDocId === id) {
    const remaining = Array.from(openDocs.keys());
    setActive(remaining.length > 0 ? remaining[0] : null);
  }
  broadcastOpenDocs();
  return wasTracked;
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------
//
// Tests legitimately need to arrange registry state without the Y.Doc writes a
// real mutation performs — a broadcast during setup is noise at best and skews
// a write-count assertion at worst. That need is what kept the primitives
// exported, and it is why they are re-exposed here rather than deleted.
//
// They are `unsafe`-prefixed and reachable only through
// `documents/registry-testing.ts`, which nothing in `src/` may import.
// `tests/docs/registry-primitive-containment.test.ts` is what holds that: the
// point is not that the primitives are unreachable, it is that reaching them
// from production code cannot happen quietly.

/** @internal Test seam. Production code must use the composites above. */
export function unsafeAddDoc(id: string, entry: OpenDoc): void {
  openDocs.set(id, entry);
}

/** @internal Test seam. Production code must use the composites above. */
export function unsafeRemoveDoc(id: string): boolean {
  return openDocs.delete(id);
}

/** @internal Test seam. Production code must use the composites above. */
export function unsafeSetActiveDocId(id: string | null): void {
  setActive(id);
}

/**
 * Resolve which document to operate on.
 * If documentId is provided, use that. Otherwise use the active doc.
 */
export function getCurrentDoc(documentId?: string): (OpenDoc & { docName: string }) | null {
  const id = documentId ?? activeDocId;
  if (!id) return null;
  const doc = openDocs.get(id);
  if (!doc) return null;
  return { ...doc, docName: id };
}

/** Returns the shared Y.Doc or null if the target doc isn't open. */
export function requireDocument(
  documentId?: string,
): { doc: Y.Doc; filePath: string; docId: string } | null {
  const current = getCurrentDoc(documentId);
  if (!current) return null;
  return {
    doc: getOrCreateDocument(current.docName),
    filePath: current.filePath,
    docId: current.id,
  };
}
