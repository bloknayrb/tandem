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
import { SNAPSHOT_CAP, snapshotContradicts, snapshotSearchPrefix } from "../../src/shared/snapshot";

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

/**
 * #1767: healing a snapshot a pre-fix cap left mid-surrogate-pair.
 *
 * The heal is a TRIM inside `snapshotSearchPrefix`, not a migration of the
 * stored record — rewriting snapshots on disk would be a write from a read
 * path, which is what #1764 has just removed. Shortening a search prefix is
 * free: a prefix of a prefix is still a prefix, so the cost of trimming a
 * legitimate trailing U+FFFD is one character of search specificity.
 *
 * Its PLACEMENT is what these tests really pin. Every record the fix targets
 * carries `textSnapshotTruncated: true`, so a heal written after the
 * legacy-ellipsis trim is unreachable for exactly the population it is for —
 * the first two cases below are the ones the wrong placement cannot reach.
 */
describe("#1767: snapshotSearchPrefix heals a split-pair tail", () => {
  const HIGH = "\uD83D"; // lone high half of U+1F600
  const rec = (fields: Record<string, unknown>) => ({ id: "a1", ...fields });

  it("trims a trailing U+FFFD from a record THIS build wrote", () => {
    // What the corrupted record looks like after one Yjs round-trip. This is
    // the flag-bearing branch — the one a heal placed after the ellipsis trim
    // never sees.
    const head = "a".repeat(SNAPSHOT_CAP - 1);
    const stored = rec({ textSnapshot: `${head}\uFFFD`, textSnapshotTruncated: true });
    const actual = `${head}\u{1F600} and the tail past the cap`;

    expect(snapshotSearchPrefix(stored)).toBe(head);
    expect(snapshotContradicts(stored, actual)).toBe(false);
  });

  it("trims a trailing LONE HIGH SURROGATE from the same record before any round-trip", () => {
    // The other spelling of one record. The JSON envelope on disk is lossless,
    // so a record read back from it still carries the raw lone surrogate; only
    // the CRDT path turns it into U+FFFD. Both must heal or the bug survives on
    // whichever path is not covered.
    const head = "a".repeat(SNAPSHOT_CAP - 1);
    const stored = rec({ textSnapshot: `${head}${HIGH}`, textSnapshotTruncated: true });
    const actual = `${head}\u{1F600} and the tail past the cap`;

    expect(snapshotSearchPrefix(stored)).toBe(head);
    expect(snapshotContradicts(stored, actual)).toBe(false);
  });

  it("trims BOTH markers off a legacy ellipsis record", () => {
    // No flag, cap-length, trailing "..." — and the old writer's own cut, three
    // units earlier, could split a pair just as readily. The ellipsis goes
    // first, then the split tail underneath it.
    const head = "a".repeat(SNAPSHOT_CAP - 4);
    const snapshot = `${head}${HIGH}...`;
    // Cap-length is half of what makes `isSnapshotTruncated` fire on a flagless
    // record, so assert it rather than counting the fixture by eye.
    expect(snapshot).toHaveLength(SNAPSHOT_CAP);
    const stored = rec({ textSnapshot: snapshot });

    expect(snapshotSearchPrefix(stored)).toBe(head);
    expect(snapshotContradicts(stored, `${head}\u{1F600} real tail`)).toBe(false);
  });

  it("leaves a U+FFFD on a NON-truncated snapshot alone", () => {
    // The discriminating negative. An uncapped snapshot was never cut, so a
    // U+FFFD in it is real document text; trimming it would break the equality
    // a complete snapshot is held to.
    const complete = rec({ textSnapshot: "the glyph did not load: \uFFFD" });
    expect(snapshotSearchPrefix(complete)).toBe("the glyph did not load: \uFFFD");
    expect(snapshotContradicts(complete, "the glyph did not load: \uFFFD")).toBe(false);
    expect(snapshotContradicts(complete, "the glyph did not load: ")).toBe(true);
  });

  it("still reports a contradiction when the healed prefix genuinely does not match", () => {
    // Without this, the heal could make `snapshotContradicts` unreachable on
    // the truncated branch and every test above would still pass.
    const head = "a".repeat(SNAPSHOT_CAP - 1);
    const stored = rec({ textSnapshot: `${head}\uFFFD`, textSnapshotTruncated: true });
    expect(snapshotContradicts(stored, `${"b".repeat(SNAPSHOT_CAP)} and a tail`)).toBe(true);
  });

  it("does not trim a truncated snapshot whose tail is a COMPLETE pair", () => {
    // The other half of "only when it is split". A back-off already happened,
    // or the cut landed between two astral characters — either way the last
    // unit is a LOW surrogate with its partner in front of it, and trimming
    // would cut a real character out of the search prefix.
    const stored = rec({
      textSnapshot: `${"a".repeat(SNAPSHOT_CAP - 2)}\u{1F600}`,
      textSnapshotTruncated: true,
    });
    expect(snapshotSearchPrefix(stored)).toBe(`${"a".repeat(SNAPSHOT_CAP - 2)}\u{1F600}`);
  });
});
