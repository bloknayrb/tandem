/**
 * The capped-`textSnapshot` rule (#1486), and the predicates that read it.
 *
 * `captureSnapshot` caps the snapshot at {@link SNAPSHOT_CAP} characters, which
 * bounds annotation record size against pathological ranges (#1000 review R2).
 * Every consumer that then treats a capped snapshot as the WHOLE text corrupts
 * the document. Two do it by writing text back:
 *
 *  - **undo** restores it verbatim, deleting everything past the cap;
 *  - **the reload relocation pass** (`documents/watcher.ts`) searches for it with
 *    `indexOf` and re-anchors the annotation to `match + snapshot.length`,
 *    silently shrinking a 900-character annotation to 200 — after which accept
 *    replaces the wrong span and the `.docx` apply guard, which compares the
 *    same slice, starts PASSING on the shrunken range instead of rejecting.
 *
 * A third reads it to REFUSE a write: {@link snapshotContradicts}, shared by the
 * `.docx` apply and the editor's accept.
 *
 * Deliberately phrased without a count. The previous version said "two
 * consumers … both call this" and was already wrong when written — the `.docx`
 * guard and `SuggestionCard` were callers too, and it named the first of those
 * as a downstream victim rather than as a caller, which is how the count went
 * stale without anyone noticing. A single predicate is the point: the second
 * consumer was missed on the first pass, and a second copy of the rule is how
 * they drift.
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

/**
 * Is an annotation's `textSnapshot` a PREFIX of the annotated text rather than
 * all of it? (#1486)
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

/**
 * Does `actual` — the text now under this record's range — CONTRADICT what its
 * snapshot captured? Both paths that ACCEPT a stored suggestion gate on this:
 * the `.docx` tracked-changes apply, and accepting one in the editor. (Not
 * every destructive write — `tandem_edit` and a forced `tandem_open` replace
 * text too, and answer to nothing here.)
 *
 * **Phrased as a contradiction on purpose, and the name is the contract.** A
 * record with no snapshot captured nothing, so nothing can contradict it and
 * this returns `false`. Read that as *no evidence of drift*, never as
 * *verified* — an affirmative `snapshotMatches` would return `true` for exactly
 * the records it knows least about, and it would be gating a delete.
 *
 * Composing the two predicates above, plus one distinction neither of them
 * makes, is the whole job — and it has to be done in one place. A truncated
 * snapshot is a real, contiguous PREFIX (#1486), so it can only ever be
 * prefix-matched, while demanding equality would decline every suggestion over
 * a span longer than {@link SNAPSHOT_CAP}. That turns a silent-overwrite bug
 * into a cannot-accept-anything bug.
 *
 * The `.docx` guard (which has asked this question since #171, and gained the
 * prefix rule in #1486) spelled it out inline and had already drifted against
 * ITSELF: the truncated branch compared `snapshotSearchPrefix(s)`, the other
 * raw `s.textSnapshot`. Those agree only because `snapshotSearchPrefix` is the
 * identity on a complete snapshot — a change to either would have separated
 * them silently. Adding a second inline copy for the editor path is what this
 * exists to avoid.
 *
 * `actual` must be in the SERVER's flat-text projection — the same one
 * `captureSnapshot` slices from — or this compares unlike with unlike. On the
 * server that is `offsetMap.flatText`. On the client it is
 * `flatTextForPmRange`, and specifically NOT `textBetween`, which omits heading
 * prefixes and mis-spells hard breaks in headings and block leaves; getting
 * that wrong made three ordinary document shapes permanently unacceptable
 * (#1631).
 *
 * Note the direction of failure, which is chosen rather than incidental:
 * wherever the projections disagree, this reports a contradiction and the
 * caller declines a write that would have been fine. That is safer than the
 * silent overwrite it exists to prevent — but it is not free, and #1631 is the
 * proof: a SYSTEMATIC disagreement does not read as a cautious decline, it
 * reads as a feature that no longer works.
 */
export function snapshotContradicts(ann: SnapshotBearing, actual: string): boolean {
  // ABSENT, not empty and not malformed. `snapshotSearchPrefix` collapses all
  // three to `""`, so keying the carve-out on it would silently unguard a
  // stored empty snapshot — which is a real claim that the range held no text.
  if (ann.textSnapshot === undefined) return false;
  if (typeof ann.textSnapshot !== "string") {
    // Present but not a string. `textSnapshot` is the one field of its trio
    // that `sanitizeAnnotation` copies through on a bare presence check, and
    // annotations arrive over a Y.Map any connected client can write — so this
    // is reachable without a type error anywhere.
    //
    // A malformed snapshot is evidence the RECORD is corrupt. It is not
    // evidence the text is intact, and `false` is the one answer that lets the
    // delete through. Fail toward refusing, and say so — the old `.docx` guard
    // reached the same verdict by accident (`actual !== null` is always true)
    // and said nothing.
    console.warn(`[snapshot] Non-string textSnapshot on ${ann.id}; treating as a contradiction`);
    return true;
  }
  const expected = snapshotSearchPrefix(ann);
  return isSnapshotTruncated(ann) ? !actual.startsWith(expected) : actual !== expected;
}
