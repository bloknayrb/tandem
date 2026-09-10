// Shared `w:id` REUSE predicate for the Word-comment round-trip.
//
// A leaf module (no project imports) so the export side
// (`docx-comment-export.ts`) has one source of truth for "may this stored Word
// `w:id` be written back into the saved file verbatim". It used to hold a
// wider-purpose `isCanonicalWordId` shared with the import drift-dedup index in
// `docx-comments.ts`; that sharing was the #1693 defect and is gone.
//
// **The two consumers wanted different properties, and one predicate could not
// be both.** The drift index needs "this stored id equals the id the next
// import will present", which is a statement about surviving the
// `IMPORT_COMMENT_ID_MAX` slice un-truncated — nothing to do with numeric form.
// Export needs "this id can be written into a `w:id` and read back as the same
// string", which is a statement about `ST_DecimalNumber` and about `String`
// round-tripping. Gating both on one narrow predicate made them fail TOGETHER:
// an id the gate rejected missed the drift index AND was re-minted on export,
// so a comment the user had already promoted came back as a ghost note beside
// the promotion and the next save wrote two Word comments for one original
// (#1448, #1693). The drift index now carries its own length gate, in
// `docx-comments.ts` where `IMPORT_COMMENT_ID_MAX` lives.
//
// What `reusableWordId` admits, and why each term is there:
//   - `/^\d+$/` — `ST_DecimalNumber` is an int32, and a `w:id` Tandem writes is
//     an UNSIGNED decimal. A **non-numeric** id (`c-9182`, or this tree's own
//     `nc:`-tagged fallback pre-image ids) has NO representation in that type,
//     so reuse is permanently impossible for it. That is a property of the
//     format, not a gap in this predicate.
//
//     **Declining to reuse no longer means the comment ghosts**, and reading it
//     that way is what made #1693 look unfixable for this family. When export
//     mints a fresh id, `reconcileImportCommentIds` (`docx-comments.ts`) points
//     the stored `importSource.commentId` at the id that was actually written,
//     once the bytes are on disk — so the next open's drift index finds the
//     record whether or not reuse was ever possible. What is still open here is
//     narrower and is only about the VALUE written: `#1951`.
//   - `Number.isSafeInteger` + the `<= 2147483647` ceiling — a value past it
//     either loses precision through `Number` or is not a legal `w:id`.
//   - `String(n) === raw` — the round-trip term, and the one that keeps this
//     honest. `ExportComment.id` is a `number`, so a stored `"0123"` could only
//     be written back as `123`; the next import would then present an id the
//     stored record does not carry. Declining to reuse it means the stored key
//     and the written key are equal by construction whenever reuse happens at
//     all — and where it does not, the post-write reconcile named above makes
//     them equal after the fact rather than leaving them to disagree.
//
// **A NEGATIVE stored id is not reused, and that is a deliberate reversal.** An
// earlier draft of this predicate admitted the whole signed int32 window on the
// argument that re-minting a negative id reopened the ghost for every one of
// them. `reconcileImportCommentIds` removed that argument: a re-minted id is now
// pointed back at the stored record after the write, so declining reuse costs a
// negative id nothing the non-numeric family does not already pay. What reuse
// cost was worse and was never established away — writing `w:id="-1"` puts a
// value into the user's saved `.docx` that nothing in this tree shows Word emits
// or reopens, and `verifyDocxRoundtrips` cannot see it (it re-imports through
// mammoth, which is id-agnostic, and matches on author + body only). So the
// failure would have surfaced in Word, after Tandem had already overwritten the
// file, with a green verify verdict. Re-minting produces a file Word certainly
// opens; that is the trade taken here (#1693 review).

/**
 * The original Word `w:id` as a number when it may be reused verbatim on
 * export, else `null`. See the module doc for each term.
 */
export function reusableWordId(raw: string | undefined): number | null {
  // The regex carries the sign rule: a leading `-` fails here, so `"-1"` and
  // `"-0"` are both re-minted rather than written back.
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return null;
  if (n > 2147483647) return null;
  return String(n) === raw ? n : null;
}
