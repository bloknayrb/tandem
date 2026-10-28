/**
 * A per-Y.Doc counter of content REPLACEMENTS (#2070).
 *
 * The shared invariant, stated once: **a Y.Doc captured across an await is
 * re-validated before use, and identity alone is not enough.** Hocuspocus
 * swaps a room's Y.Doc instance in `onLoadDocument` (#1657, #2039), which an
 * identity check sees. But every content-replacing reload mutates the SAME
 * instance — the identity check stays true while the text the caller reasoned
 * about is gone. A caller that captured `contentGeneration(doc)` before its
 * await compares it afterwards: a different number means the content was
 * replaced in between.
 *
 * Bumped at exactly two sites, each inside the transaction that swaps the
 * content, so an observer of that transaction already sees the new number:
 *
 *  - `clearAndReload`'s `withInternal` (`documents/populate.ts`) — force-open
 *    and the source-view commit;
 *  - `reloadFromDisk`'s `withReload` (`documents/watcher.ts`) — the file
 *    watcher, restore-from-backup and the external-conflict Reload.
 *
 * NOT bumped, deliberately:
 *
 *  - `tandem_applyChanges` (`.docx`, dark): it writes the file and lets the
 *    watcher reload it, which bumps there. Its own re-read of the room's Y.Doc
 *    after its awaits is the same class of hazard and is tracked as #2037.
 *  - the plaintext hard-break flatten (`file-io/plaintext-flatten.ts`): it is
 *    byte-neutral in the flat projection, so a caller's offsets and quotes stay
 *    valid across it.
 *
 * A future path that replaces content without going through either site must
 * bump here too, or a parked caller cannot see it.
 *
 * A `WeakMap`, so a destroyed Y.Doc takes its counter with it, and a fresh
 * instance (a swap) starts at 0 — which the identity check covers.
 */

import type * as Y from "yjs";

const generations = new WeakMap<Y.Doc, number>();

/** How many times `doc`'s content has been replaced. 0 for a doc never reloaded. */
export function contentGeneration(doc: Y.Doc): number {
  return generations.get(doc) ?? 0;
}

/** Record a content replacement. Call inside the transaction that replaces it. */
export function bumpContentGeneration(doc: Y.Doc): void {
  generations.set(doc, contentGeneration(doc) + 1);
}
