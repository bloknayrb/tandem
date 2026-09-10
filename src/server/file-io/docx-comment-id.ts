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
//   - `/^-?\d+$/` — `ST_DecimalNumber` is an int32, optionally signed. A
//     **non-numeric** id (`c-9182`, or this tree's own `nc:`-tagged fallback
//     pre-image ids) has NO representation in that type, so reuse is
//     permanently impossible for it. That is a property of the format, not a
//     gap in this predicate.
//   - `Number.isSafeInteger` + the int32 window — a value outside it either
//     loses precision through `Number` or is not a legal `w:id`.
//   - `String(n) === raw` — the round-trip term, and the one that keeps this
//     honest. `ExportComment.id` is a `number`, so a stored `"0123"` could only
//     be written back as `123`; the next import would then present an id the
//     stored record does not carry, which is the same ghost one step removed.
//     Declining to reuse it means the stored key and the written key are equal
//     by construction whenever reuse happens at all.
//
// **Negative ids are an accepted, explicitly unverified change to bytes in the
// user's file.** A `-1` reaching us was already in their document, but nothing
// in this tree establishes that Word emits or reopens a negative
// `w:comment/@w:id`. It is accepted because the alternative re-mints the id and
// reopens the ghost for every negative id, and because the value written is
// exactly the value read. Stated as a bound, not as a fact about Word.

/**
 * The original Word `w:id` as a number when it may be reused verbatim on
 * export, else `null`. See the module doc for each term.
 */
export function reusableWordId(raw: string | undefined): number | null {
  if (!raw || !/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return null;
  if (n < -2147483648 || n > 2147483647) return null;
  // `String(-0) === "0"`, so this also rejects "-0" — deliberately: it would be
  // written back as `0` and re-imported under a different stored key.
  return String(n) === raw ? n : null;
}
