import { describe, expect, it } from "vitest";
import { type DiffSegment, diffWords } from "../../src/client/utils/word-diff";

/** Reconstructs the "new" text from segments (equal + ins) for a sanity check. */
function reconstructNew(segments: DiffSegment[]): string {
  return segments
    .filter((s) => s.type === "equal" || s.type === "ins")
    .map((s) => s.text)
    .join("");
}

/** Reconstructs the "old" text from segments (equal + del) for a sanity check. */
function reconstructOld(segments: DiffSegment[]): string {
  return segments
    .filter((s) => s.type === "equal" || s.type === "del")
    .map((s) => s.text)
    .join("");
}

/** No two adjacent segments should share a type — merging must be exhaustive. */
function assertNoAdjacentSameType(segments: DiffSegment[]): void {
  for (let i = 1; i < segments.length; i++) {
    expect(segments[i].type).not.toBe(segments[i - 1].type);
  }
}

describe("diffWords", () => {
  it("returns a single equal segment when texts are identical", () => {
    const segments = diffWords("The quick brown fox", "The quick brown fox");
    expect(segments).toEqual([{ type: "equal", text: "The quick brown fox" }]);
  });

  it("isolates a single-word change: only the changed word is del+ins, rest stays equal", () => {
    const segments = diffWords("The quick brown fox jumps", "The quick red fox jumps");
    expect(segments).not.toBeNull();
    const s = segments as DiffSegment[];
    assertNoAdjacentSameType(s);
    expect(reconstructOld(s)).toBe("The quick brown fox jumps");
    expect(reconstructNew(s)).toBe("The quick red fox jumps");

    // Only "brown"/"red" differ — everything else must be equal segments.
    const nonEqual = s.filter((seg) => seg.type !== "equal");
    expect(nonEqual).toHaveLength(2);
    expect(nonEqual.find((seg) => seg.type === "del")?.text).toBe("brown");
    expect(nonEqual.find((seg) => seg.type === "ins")?.text).toBe("red");

    // The surrounding words are untouched equal segments, not swept into the diff.
    const equalText = s
      .filter((seg) => seg.type === "equal")
      .map((seg) => seg.text)
      .join("");
    expect(equalText).toBe("The quick  fox jumps");
  });

  it("handles insertion-only changes (old text is a prefix/subset of new)", () => {
    const segments = diffWords("The fox jumps", "The quick fox jumps");
    expect(segments).not.toBeNull();
    const s = segments as DiffSegment[];
    assertNoAdjacentSameType(s);
    expect(reconstructOld(s)).toBe("The fox jumps");
    expect(reconstructNew(s)).toBe("The quick fox jumps");
    expect(s.some((seg) => seg.type === "del")).toBe(false);
    // The DP backtrack may attach the separating whitespace to either side of
    // the inserted word, so assert on trimmed content rather than exact
    // leading/trailing whitespace placement — the reconstruction checks above
    // already prove the whitespace round-trips correctly.
    const insSegments = s.filter((seg) => seg.type === "ins");
    expect(insSegments).toHaveLength(1);
    expect(insSegments[0].text.trim()).toBe("quick");
  });

  it("handles deletion-only changes (new text is a subset of old)", () => {
    const segments = diffWords("The quick fox jumps", "The fox jumps");
    expect(segments).not.toBeNull();
    const s = segments as DiffSegment[];
    assertNoAdjacentSameType(s);
    expect(reconstructOld(s)).toBe("The quick fox jumps");
    expect(reconstructNew(s)).toBe("The fox jumps");
    expect(s.some((seg) => seg.type === "ins")).toBe(false);
    const delSegments = s.filter((seg) => seg.type === "del");
    expect(delSegments).toHaveLength(1);
    expect(delSegments[0].text.trim()).toBe("quick");
  });

  it("diffs across multi-paragraph text, preserving newlines as tokens", () => {
    const oldText = "First paragraph here.\n\nSecond paragraph unchanged.";
    const newText = "First paragraph updated.\n\nSecond paragraph unchanged.";
    const segments = diffWords(oldText, newText);
    expect(segments).not.toBeNull();
    const s = segments as DiffSegment[];
    assertNoAdjacentSameType(s);
    expect(reconstructOld(s)).toBe(oldText);
    expect(reconstructNew(s)).toBe(newText);
    // The unchanged second paragraph (including its blank-line separator)
    // should be captured as equal segments, not exploded into a full diff.
    const equalText = s
      .filter((seg) => seg.type === "equal")
      .map((seg) => seg.text)
      .join("");
    expect(equalText).toContain("\n\nSecond paragraph unchanged.");
  });

  it("diffs a whitespace-only change (e.g. collapsed double space)", () => {
    const segments = diffWords("foo  bar", "foo bar");
    expect(segments).not.toBeNull();
    const s = segments as DiffSegment[];
    assertNoAdjacentSameType(s);
    expect(reconstructOld(s)).toBe("foo  bar");
    expect(reconstructNew(s)).toBe("foo bar");
    // Something must be flagged as changed — a pure equal-only diff would
    // wrongly claim "foo  bar" and "foo bar" are the same.
    expect(s.some((seg) => seg.type !== "equal")).toBe(true);
  });

  it("returns null when the combined text length exceeds the size cap", () => {
    const big = "word ".repeat(2000); // 10_000 chars, well past MAX_COMBINED_LENGTH
    expect(diffWords(big, "short")).toBeNull();
  });

  it("returns null when the token product exceeds the size cap", () => {
    // Distinct tokens on both sides (so nothing collapses via LCS shortcuts)
    // and short enough combined length to only trip the token-product guard.
    const oldTokens = Array.from({ length: 250 }, (_, i) => `a${i}`).join(" ");
    const newTokens = Array.from({ length: 250 }, (_, i) => `b${i}`).join(" ");
    // 250 tokens * 2 (word+space) = ~500 tokens each side -> product > 40_000
    expect(oldTokens.length + newTokens.length).toBeLessThan(6_000);
    expect(diffWords(oldTokens, newTokens)).toBeNull();
  });

  it("never produces two adjacent segments of the same type", () => {
    const cases: Array<[string, string]> = [
      ["a b c d e", "a x c y e"],
      ["one two three", "one two three four"],
      ["alpha beta gamma", "gamma"],
      ["", "hello world"],
      ["hello world", ""],
    ];
    for (const [oldText, newText] of cases) {
      const segments = diffWords(oldText, newText);
      expect(segments).not.toBeNull();
      assertNoAdjacentSameType(segments as DiffSegment[]);
    }
  });

  it("handles empty strings on both sides", () => {
    expect(diffWords("", "")).toEqual([]);
  });
});
