/**
 * `snapshotContradicts` is the single question both destructive write paths ask
 * before replacing user text: the `.docx` tracked-changes apply and, since
 * #1629, accepting a suggestion in the editor.
 *
 * It exists as one function because the `.docx` guard spelled the rule out
 * inline and had already drifted against ITSELF — the truncated branch compared
 * `snapshotSearchPrefix(s)`, the other raw `s.textSnapshot`. Those agree only
 * because `snapshotSearchPrefix` is the identity on a complete snapshot, and a
 * change to either would have separated them silently. Adding a second inline
 * copy for the editor path is what this avoids; `shared/snapshot.ts` says the
 * same thing in its own header.
 *
 * The cases below are the ones a call site can get wrong silently. The
 * behavioural arms — that the editor actually declines the accept, that the
 * document is left untouched — live in `tests/client/suggestion-accept-drift-
 * guard.test.ts`; this file pins the predicate itself.
 */

import { describe, expect, it, vi } from "vitest";
import { SNAPSHOT_CAP, snapshotContradicts } from "../../src/shared/snapshot";

const ann = (fields: Record<string, unknown>) => ({ id: "a1", ...fields });

describe("snapshotContradicts", () => {
  it("reports no contradiction for a record that captured nothing", () => {
    // The contract the NAME carries. An affirmative `snapshotMatches` would
    // have to return true here — asserting a match it cannot possibly have
    // checked, while gating a delete. Absent means "no evidence of drift".
    expect(snapshotContradicts(ann({}), "anything at all")).toBe(false);
  });

  it("treats a PRESENT-but-malformed snapshot as a contradiction, not as absent", () => {
    // The direction that matters. `textSnapshot` is the one field of its trio
    // that `sanitizeAnnotation` copies through on a bare presence check, and
    // annotations arrive over a Y.Map any connected client can write — so a
    // non-string is reachable with no type error anywhere.
    //
    // An earlier draft of this predicate keyed the carve-out on
    // `typeof !== "string"`, which answered "no contradiction" and let the
    // delete through — the #1629 defect, inside the fix for #1629. The old
    // `.docx` guard reached the safe verdict by accident (`actual !== null` is
    // always true); this reaches it on purpose and says so.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(snapshotContradicts(ann({ textSnapshot: null }), "real text")).toBe(true);
      expect(snapshotContradicts(ann({ textSnapshot: 42 }), "real text")).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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

  it("honours an explicit textSnapshotTruncated:false over the legacy sniff", () => {
    // The one input class the legacy heuristic and the explicit flag disagree
    // about: 200 chars ending in "..." that a record swears is COMPLETE. The
    // flag wins (`isSnapshotTruncated` returns early on it), so the ellipsis is
    // real document text and must be compared, not trimmed.
    const looksLegacy = `${"a".repeat(SNAPSHOT_CAP - 3)}...`;
    const rec = ann({ textSnapshot: looksLegacy, textSnapshotTruncated: false });

    expect(snapshotContradicts(rec, looksLegacy)).toBe(false);
    expect(snapshotContradicts(rec, `${"a".repeat(SNAPSHOT_CAP - 3)} real tail`)).toBe(true);
  });
});
