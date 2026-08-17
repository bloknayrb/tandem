/**
 * Is an annotation's `textSnapshot` a PREFIX of the annotated text rather than
 * all of it? (#1486)
 *
 * `captureSnapshot` caps the snapshot at {@link SNAPSHOT_CAP} characters, which
 * bounds annotation record size against pathological ranges (#1000 review R2).
 * Two consumers must never treat a capped snapshot as the whole text, and both
 * corrupt the document if they do:
 *
 *  - **undo** restores it verbatim, deleting everything past the cap;
 *  - **the reload relocation pass** (`file-opener.ts`) searches for it with
 *    `indexOf` and re-anchors the annotation to `match + snapshot.length`,
 *    silently shrinking a 900-character annotation to 200 — after which accept
 *    replaces the wrong span and the `.docx` apply guard, which compares the
 *    same slice, starts PASSING on the shrunken range instead of rejecting.
 *
 * Both call this. A single predicate is the point: the second consumer was
 * missed on the first pass, and a second copy of the rule is how they drift.
 *
 * Three cases, because records written before #1486 are still on disk:
 *
 *  1. `textSnapshotTruncated === true` — a record this build wrote. Definitive.
 *  2. Flag absent, exactly {@link SNAPSHOT_CAP} chars ending in `"..."` — the
 *     LEGACY marker. The old code appended an ellipsis only on the truncating
 *     branch and the result was always exactly the cap, so this pair is a good
 *     signal; a false positive needs prose that is exactly 200 characters AND
 *     ends in an ellipsis. The error is asymmetric and the check is chosen for
 *     that: a false positive declines one undo, which the editor's own Ctrl+Z
 *     still covers, while a false negative silently truncates the document.
 *  3. Anything else — complete. Note a NEW capped snapshot is exactly the cap
 *     with no ellipsis, which is why case 2 tests for both and not for length
 *     alone: a legitimately 200-character snapshot must stay undoable.
 */
/**
 * Maximum stored `textSnapshot` length. Lives here rather than beside
 * `captureSnapshot` because the legacy detection below tests against it: a
 * second copy of the number would let the writer and the detector drift apart
 * silently, and the detector fails toward corrupting the document.
 */
export const SNAPSHOT_CAP = 200;

/** The pre-#1486 truncation marker, written into the snapshot text itself. */
const LEGACY_ELLIPSIS = "...";

/**
 * What these functions accept: an annotation, or a record shaped like one.
 *
 * `id` is required, and only to keep this NOMINAL enough to exclude
 * `ChatAnchor`. A chat anchor has a required `textSnapshot` and truncates
 * itself with the same trailing `"..."`, so on the fields these functions read
 * it is structurally indistinguishable from a legacy annotation — TypeScript
 * would happily accept one. It must not be passed here: it is never written
 * back into the document, so it has no restore path to guard, and treating it
 * as truncatable would put a fourth caller behind a predicate whose contract is
 * "declines a document write".
 */
export interface SnapshotBearing {
  id: string;
  textSnapshot?: string;
  textSnapshotTruncated?: boolean;
}

export function isSnapshotTruncated(ann: SnapshotBearing): boolean {
  if (ann.textSnapshotTruncated === true) return true;
  if (ann.textSnapshotTruncated !== undefined) return false;
  const snapshot = ann.textSnapshot;
  return (
    typeof snapshot === "string" &&
    snapshot.length === SNAPSHOT_CAP &&
    snapshot.endsWith(LEGACY_ELLIPSIS)
  );
}

/**
 * The portion of `textSnapshot` that is VERBATIM document text.
 *
 * For a complete snapshot that is the whole string. For a truncated one it is
 * still a real, contiguous prefix of the annotated text — which is why undo has
 * to refuse it (a prefix is not the passage) while relocation can still use it
 * (a prefix is enough to find where the passage now starts).
 *
 * Legacy records are the reason this is not simply `ann.textSnapshot`: the old
 * writer appended `"..."` to mark the cut, and those three characters are NOT
 * in the document. Searching for them finds nothing — which is exactly why the
 * reload pass appeared safe on legacy records before this fix. Trimming them
 * turns that accidental miss into a real relocation.
 *
 * Returns `""` for an absent snapshot; callers guard on that before searching,
 * since an empty needle matches at offset 0.
 */
export function snapshotSearchPrefix(ann: SnapshotBearing): string {
  const snapshot = ann.textSnapshot;
  if (typeof snapshot !== "string") return "";
  if (!isSnapshotTruncated(ann)) return snapshot;
  // Flag present ⇒ this build wrote it and the text carries no marker.
  if (ann.textSnapshotTruncated === true) return snapshot;
  return snapshot.slice(0, -LEGACY_ELLIPSIS.length);
}
