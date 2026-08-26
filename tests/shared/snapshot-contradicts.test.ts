/**
 * `snapshotContradicts` is the single question both destructive write paths ask
 * before replacing user text: the `.docx` tracked-changes apply and, since
 * #1629, accepting a suggestion in the editor.
 *
 * It exists as one function because the two sites spelled the rule out
 * separately and had already drifted — the `.docx` guard compared against
 * `snapshotSearchPrefix(s)` on the truncated branch but raw `s.textSnapshot` on
 * the other, which happen to agree today and would not have survived a change
 * to either. `shared/snapshot.ts` says this in its own header: a second copy of
 * the rule is how they drift.
 *
 * The cases below are the ones a call site can get wrong silently. The
 * behavioural arms — that the editor actually declines the accept, that the
 * document is left untouched — live in `tests/client/suggestion-accept-drift-
 * guard.test.ts`; this file pins the predicate itself.
 */

import { describe, expect, it } from "vitest";
import { SNAPSHOT_CAP, snapshotContradicts } from "../../src/shared/snapshot";

const ann = (fields: Record<string, unknown>) => ({ id: "a1", ...fields });

describe("snapshotContradicts", () => {
  it("reports no contradiction for a record that captured nothing", () => {
    // The contract the NAME carries. An affirmative `snapshotMatches` would
    // have to return true here — asserting a match it cannot possibly have
    // checked, while gating a delete. Absent means "no evidence of drift".
    expect(snapshotContradicts(ann({}), "anything at all")).toBe(false);
  });

  it("treats a stored EMPTY snapshot as a real claim, not as absent", () => {
    // The distinction the extraction had to preserve. `snapshotSearchPrefix`
    // collapses absent and empty to the same `""`, so keying the carve-out on
    // it would have made this case silently unguarded — and this is the case
    // the `.docx` guard has always checked, via `s.textSnapshot !== undefined`.
    expect(snapshotContradicts(ann({ textSnapshot: "" }), "text arrived here")).toBe(true);
    expect(snapshotContradicts(ann({ textSnapshot: "" }), "")).toBe(false);
  });

  it("demands equality for a complete snapshot", () => {
    expect(snapshotContradicts(ann({ textSnapshot: "hello world" }), "hello world")).toBe(false);
    expect(snapshotContradicts(ann({ textSnapshot: "hello world" }), "hello worlds")).toBe(true);
    expect(snapshotContradicts(ann({ textSnapshot: "hello world" }), "hello")).toBe(true);
  });

  it("prefix-matches a snapshot this build truncated", () => {
    // Equality here would decline EVERY suggestion over a span longer than the
    // cap — turning a silent-overwrite bug into a cannot-accept-anything bug.
    const capped = "a".repeat(SNAPSHOT_CAP);
    const rec = ann({ textSnapshot: capped, textSnapshotTruncated: true });

    expect(snapshotContradicts(rec, `${capped} and the tail past the cap`)).toBe(false);
    expect(snapshotContradicts(rec, `${"b".repeat(SNAPSHOT_CAP)} and the tail`)).toBe(true);
  });

  it("prefix-matches a LEGACY truncated snapshot without chasing its ellipsis", () => {
    // Pre-#1486 records marked the cut with a trailing "..." that appears
    // nowhere in the document. Comparing against the stored string verbatim
    // would report drift on text that never changed.
    const rec = ann({ textSnapshot: `${"a".repeat(SNAPSHOT_CAP - 3)}...` });
    expect(snapshotContradicts(rec, `${"a".repeat(SNAPSHOT_CAP - 3)} real tail`)).toBe(false);
  });

  it("does not read a legitimately cap-length snapshot as truncated", () => {
    // Complete-but-exactly-200 must still get equality, or a real drift on a
    // 200-character span passes as a prefix match.
    const exact = "a".repeat(SNAPSHOT_CAP);
    expect(snapshotContradicts(ann({ textSnapshot: exact }), `${exact} more`)).toBe(true);
  });
});
