/**
 * Records stored under a Windows 8.3 short spelling of a file (#2400).
 *
 * Before #2400 a file opened by a short spelling (`C:\AFOLDE~1\x.md`) had its
 * session and its annotation envelope stored under a key computed from that
 * spelling (the "old key"). The same open now computes the key of the long
 * spelling (the "new key"). This module MOVES the old-key records to the new
 * key, and does nothing else:
 *
 * - **Per kind, only into an empty place.** The session file and the envelope
 *   file are moved independently, and each only when the new key has no record
 *   of that kind. A record that cannot move (the place is taken, or the move
 *   failed) is left exactly as it is and ages out under the existing cleanups.
 *   Nothing is merged, converted or backed up. If the old name cannot be
 *   removed after the new one exists, both are kept: no record is ever only
 *   under a name the open will not read.
 * - **Found by key only.** The old key is computed from `legacyPath`: the
 *   string master's canonicalisation produced for the caller's own spelling,
 *   after it passed the UNC screens in `resolveAndValidatePath`. No stored
 *   `filePath` or `meta` string chooses a record, and nothing here lists a
 *   directory. A file opened only by its long spelling never looks at the old
 *   key.
 * - **Never the records of a live document.** When a document is registered
 *   under the short string (an expansion that failed earlier in this run
 *   opened it under master's string), its records are being written and are
 *   not moved.
 * - **Only while this instance holds the annotation store lock.** A
 *   read-only instance (another Tandem holds it), one started with the store
 *   switched off (which takes no lock), and one whose attempt to take it
 *   threw, move neither kind:
 *   such an instance must not write annotation files, and moving the session
 *   alone would leave the envelope with nothing that computes its key again.
 *   Both stay for an instance that holds the lock.
 *
 * After the move the open is an ordinary open of the long spelling.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { docHash } from "../annotations/doc-hash.js";
import { isPartialParse, parseAnnotationDoc } from "../annotations/schema.js";
import { envelopePath, isStoreLockHeld, moveEnvelopeFile } from "../annotations/store.js";
import { getTombstones } from "../annotations/sync.js";
import { getFileSyncContext } from "../events/queue.js";
import { moveSessionFile } from "../session/manager.js";
import { persistEnvelopeNow } from "./annotation-wiring.js";
import { getOpenDocs } from "./registry.js";

/** Which kinds are now under the new key because this call moved them. */
export interface ShortNameMove {
  session: boolean;
  envelope: boolean;
}

/**
 * Old-key records belong to a live document when one is registered under a
 * path with the same KEY. Compared by `docHash`, the function that names the
 * record files, so whatever folding it applies (case, on Windows) applies
 * here too: `c:\afolde~1\x.md` registered after a failed expansion and a
 * later `C:\AFOLDE~1\X.MD` are one key.
 */
function legacyPathIsOpen(legacyPath: string): boolean {
  const key = docHash(legacyPath);
  for (const d of getOpenDocs().values()) {
    if (d.source === "file" && docHash(d.filePath) === key) return true;
  }
  return false;
}

/**
 * Move the records stored under `legacyPath`'s key to `resolved`'s key. Call
 * only for a document that is not open yet, before its session is restored and
 * its annotation store is wired. Never throws.
 */
export async function moveShortNameRecords(
  legacyPath: string,
  resolved: string,
): Promise<ShortNameMove> {
  const nothing: ShortNameMove = { session: false, envelope: false };
  try {
    if (legacyPathIsOpen(legacyPath)) return nothing;
    // Keyed on the lock itself, not on a read-only flag: with the feature off,
    // before the lock was tried, or after taking it threw, nobody holds it.
    if (!isStoreLockHeld()) return nothing;
    // Independent: a failure moving one kind neither undoes nor blocks the other.
    const envelope = await moveEnvelopeFile(docHash(legacyPath), docHash(resolved));
    const session = await moveSessionFile(legacyPath, resolved);
    if (envelope === "moved" || session === "moved") {
      console.error(
        "[Tandem] Records saved under a short path for %s were moved to its full path (session: %s, annotations: %s).",
        path.basename(resolved),
        session,
        envelope,
      );
    }
    return { session: session === "moved", envelope: envelope === "moved" };
  } catch (err) {
    console.error("[Tandem] Moving records saved under a short path failed:", err);
    return nothing;
  }
}

/**
 * After the open wired the store: make a moved envelope describe itself.
 *
 * The moved file's inner `meta.filePath` still names the short spelling, and
 * rename recovery reads OTHER envelopes' `meta.filePath`: if that alias later
 * stopped existing while the long path stayed, a byte-identical copy opened
 * with no envelope could adopt this live document's comments. A snapshot
 * rewrites the inner key and path (`renameDocument` forces one for the same
 * window).
 *
 * Only when the moved file LOADED: a forced snapshot after a failed read would
 * replace it with the empty map. So the file is read again here, and the
 * snapshot is written only if it parses completely, the store is wired for
 * this document, and every annotation and reply it holds is in the document
 * or covered by a tombstone in the ledger. Never throws.
 */
export async function rewriteMovedEnvelope(
  id: string,
  doc: Y.Doc,
  resolved: string,
): Promise<void> {
  try {
    const hash = docHash(resolved);
    if (!isStoreLockHeld() || getFileSyncContext(id)?.docHash !== hash) return;
    const parsed = parseAnnotationDoc(await fs.readFile(envelopePath(hash), "utf-8"));
    if (!parsed.ok || isPartialParse(parsed)) return;
    const annotations = doc.getMap(Y_MAP_ANNOTATIONS);
    const replies = doc.getMap(Y_MAP_ANNOTATION_REPLIES);
    const stones = new Set(getTombstones(hash).map((t) => t.id));
    const loaded =
      parsed.doc.annotations.every((a) => annotations.has(a.id) || stones.has(a.id)) &&
      parsed.doc.replies.every((r) => replies.has(r.id) || stones.has(r.annotationId)) &&
      parsed.doc.tombstones.every((t) => stones.has(t.id));
    if (!loaded) return;
    await persistEnvelopeNow(id, doc, resolved);
  } catch (err) {
    console.error("[Tandem] The moved annotation file was left as it is:", err);
  }
}
