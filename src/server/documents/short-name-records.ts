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
 *   Nothing is merged, converted, rewritten or backed up.
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
 * - **Never while this instance does not own the annotation store.** A
 *   read-only instance (another Tandem holds the store lock), and one started
 *   with the store switched off (which takes no lock), move neither kind:
 *   such an instance must not write annotation files, and moving the session
 *   alone would leave the envelope with nothing that computes its key again.
 *   Both stay for an instance that holds the lock.
 *
 * After the move the open is an ordinary open of the long spelling.
 */

import path from "node:path";
import { docHash } from "../annotations/doc-hash.js";
import { isStoreFeatureDisabled, isStoreReadOnly, moveEnvelopeFile } from "../annotations/store.js";
import { moveSessionFile } from "../session/manager.js";
import { getOpenDocs } from "./registry.js";

/** Which kinds are now under the new key because this call moved them. */
export interface ShortNameMove {
  session: boolean;
  envelope: boolean;
}

function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/** Old-key records belong to a live document when one is registered under that string. */
function legacyPathIsOpen(legacyPath: string): boolean {
  for (const d of getOpenDocs().values()) {
    if (d.source === "file" && samePath(d.filePath, legacyPath)) return true;
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
    if (isStoreReadOnly() || isStoreFeatureDisabled()) return nothing;
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
