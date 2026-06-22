// Shared canonical-`w:id` predicate for the Word-comment round-trip.
//
// A leaf module (no project imports) so both the import side
// (`docx-comments.ts`) and the export side (`docx-comment-export.ts`) depend on
// a single source of truth for "is this Word `w:id` safe to trust as a stable
// identity" rather than duplicating the predicate. The export side previously
// carried this check inline (`reusableCommentId`); #1150 adds the import
// drift-dedup index as a second consumer, so it was extracted here.
//
// Canonical means: a non-negative decimal short enough to survive the
// `IMPORT_COMMENT_ID_MAX` (32) slice un-truncated, with no non-canonical form
// ("01") that would re-serialize differently. The 9-digit cap is well inside
// both OOXML's int32 `w:id` range and the slice width. Two consumers:
//   - import drift-dedup index (#1150) trusts only ids passing this gate; a
//     sliced or non-canonical id could collapse two distinct comments into one
//     bucket, so those degrade to the (accepted) duplicate-on-drift behavior
//     rather than a silent cross-comment content swap.
//   - export id-reuse (`reusableCommentId`) reuses the original numeric id on
//     a promote → save → re-open cycle so `importAnnotationId` stays stable.

/** True when a Word `w:id` is a canonical non-negative decimal (see module doc). */
export function isCanonicalWordId(raw: string | undefined): raw is string {
  return !!raw && /^\d{1,9}$/.test(raw) && String(Number(raw)) === raw;
}
