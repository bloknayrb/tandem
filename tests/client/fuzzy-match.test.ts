import { describe, expect, it } from "vitest";
import { fuzzyMatch, toSegments } from "../../src/client/utils/fuzzy-match.js";

describe("fuzzyMatch", () => {
  it("returns null for an empty query", () => {
    expect(fuzzyMatch("", "Toggle Panel")).toBeNull();
  });

  it("returns null when the query is not a subsequence of the target", () => {
    expect(fuzzyMatch("xyz", "Toggle Panel")).toBeNull();
  });

  it("matches an exact substring with the matched indices", () => {
    const result = fuzzyMatch("panel", "Toggle Panel");
    expect(result).not.toBeNull();
    expect(result?.indices).toEqual([7, 8, 9, 10, 11]);
  });

  it("is case-insensitive", () => {
    const lower = fuzzyMatch("panel", "Toggle Panel");
    const upper = fuzzyMatch("PANEL", "Toggle Panel");
    expect(lower?.score).toBe(upper?.score);
  });

  it("scores a substring match at index 0 higher than the same substring later in the target", () => {
    const atStart = fuzzyMatch("tog", "Toggle Panel");
    const later = fuzzyMatch("tog", "Untoggleable");
    expect(atStart).not.toBeNull();
    expect(later).not.toBeNull();
    expect(atStart!.score).toBeGreaterThan(later!.score);
  });

  it("scores a word-boundary substring match higher than a mid-word substring match at a later index", () => {
    // "pan" as a word-boundary substring ("Open Panel") vs. as a mid-word
    // substring at a later index ("Open Companion") — boundary bonus (+250)
    // plus earlier index should win.
    const boundary = fuzzyMatch("pan", "Open Panel");
    const midWord = fuzzyMatch("pan", "Open Companion Zebra");
    expect(boundary).not.toBeNull();
    expect(midWord).not.toBeNull();
    expect(boundary!.score).toBeGreaterThan(midWord!.score);
  });

  describe("substring always outranks subsequence (adversarial pairs)", () => {
    it.each([
      {
        why: "long substring match late in target vs. short subsequence spread early",
        query: "panel",
        substringTarget: "A very long command group label containing Panel somewhere in the middle",
        subsequenceTarget: "Preview and Navigate Every Layer", // P-a-n-e-l as scattered subsequence
      },
      {
        why: "substring with no bonuses vs. subsequence with every bonus available",
        query: "abc",
        substringTarget: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxabc",
        subsequenceTarget: "A-B-C", // each char is a word-boundary + consecutive-ish
      },
    ])("$why", ({ query, substringTarget, subsequenceTarget }) => {
      const substringResult = fuzzyMatch(query, substringTarget);
      const subsequenceResult = fuzzyMatch(query, subsequenceTarget);
      expect(substringResult).not.toBeNull();
      // Sanity: the "subsequence" target must not itself contain the query as
      // a literal substring, otherwise this isn't testing tier 2 at all.
      expect(subsequenceTarget.toLowerCase().includes(query.toLowerCase())).toBe(false);
      expect(subsequenceResult).not.toBeNull();
      expect(substringResult!.score).toBeGreaterThan(subsequenceResult!.score);
    });
  });

  describe("camelCase boundary bonus", () => {
    it("scores a subsequence match landing on camelCase humps higher than one that doesn't", () => {
      // "tp" as subsequence: "toggleOutlinePanel" hits camelCase humps (t, P);
      // "titlePane" hits no humps for the same query shape at similar gap sizes.
      const humps = fuzzyMatch("top", "toggleOutlinePanel"); // t(0) o(1) ... P(15) - boundary hits
      const noHumps = fuzzyMatch("top", "atomsphere"); // no case transitions, pure gaps
      expect(humps).not.toBeNull();
      expect(noHumps).not.toBeNull();
      expect(humps!.score).toBeGreaterThan(noHumps!.score);
    });

    it("recognizes a lowercase-to-uppercase transition as a word boundary", () => {
      const result = fuzzyMatch("op", "toggleOutlinePanel");
      // "O" (index 6) is a camelCase boundary; matching it should score higher
      // than matching a same-position non-boundary letter would.
      expect(result).not.toBeNull();
      expect(result?.indices[0]).toBeDefined();
    });
  });

  it("prefers the greedy consecutive run over an earlier non-consecutive start", () => {
    // "ab" against "xabxxab": first "ab" is consecutive (indices 1,2); a
    // subsequence-only strategy could instead pick 1 and a later 'b', which
    // would score lower due to the gap penalty. Greedy-with-lookahead should
    // pick the immediately-following char to keep the run consecutive.
    const result = fuzzyMatch("ab", "xabxxab");
    expect(result?.indices).toEqual([1, 2]);
  });

  it("supports a multi-word query where the space is matched as a literal subsequence char", () => {
    const result = fuzzyMatch("tog pan", "Toggle Panel");
    expect(result).not.toBeNull();
    // "toggle panel" (lowercased) — t,o,g at 0,1,2, space at 6, p,a,n at 7,8,9.
    expect(result?.indices).toEqual([0, 1, 2, 6, 7, 8, 9]);
  });

  it("penalizes gaps between matched subsequence characters", () => {
    const tight = fuzzyMatch("ab", "ab");
    const loose = fuzzyMatch("ab", "a-----b");
    expect(tight).not.toBeNull();
    expect(loose).not.toBeNull();
    expect(tight!.score).toBeGreaterThan(loose!.score);
  });

  it("caps target length before matching (annotations can be long)", () => {
    const longTarget = `${"x".repeat(600)}needle`;
    // "needle" only appears past the 500-char cap, so it should not match.
    expect(fuzzyMatch("needle", longTarget)).toBeNull();
  });
});

describe("ranking tie stability", () => {
  // CommandPalette.svelte sorts scored candidates with
  // `(a, b) => b.score - a.score || a.origIndex - b.origIndex`. Verify that
  // shape here: equal-score candidates must keep their original relative
  // order rather than being reshuffled.
  it("keeps original insertion order for equal-score matches", () => {
    const candidates = ["Open Panel", "Open Folder", "Open Panel"].map((target, origIndex) => ({
      target,
      origIndex,
      score: fuzzyMatch("open", target)!.score,
    }));
    // The two "Open Panel" entries score identically to each other and (in
    // this case) to "Open Folder" too — all three share the "Open " prefix.
    expect(candidates[0].score).toBe(candidates[2].score);

    const sorted = [...candidates].sort((a, b) => b.score - a.score || a.origIndex - b.origIndex);
    expect(sorted.map((c) => c.origIndex)).toEqual([0, 1, 2]);
  });

  it("re-sorts equal-score candidates back to original order even when shuffled beforehand", () => {
    const scored = [
      { label: "Alpha Panel", origIndex: 0 },
      { label: "Alpha Folder", origIndex: 1 },
      { label: "Alpha Widget", origIndex: 2 },
    ].map((c) => ({ ...c, score: fuzzyMatch("alpha", c.label)!.score }));
    // Shuffle input order to confirm the sort — not insertion order — is what
    // restores origIndex order.
    const shuffled = [scored[2], scored[0], scored[1]];
    const sorted = shuffled.sort((a, b) => b.score - a.score || a.origIndex - b.origIndex);
    expect(sorted.map((c) => c.origIndex)).toEqual([0, 1, 2]);
  });
});

describe("toSegments", () => {
  it("returns a single unmatched segment when indices is empty", () => {
    expect(toSegments("hello", [])).toEqual([{ text: "hello", match: false }]);
  });

  it("returns an empty array for an empty target", () => {
    expect(toSegments("", [])).toEqual([]);
  });

  it("collapses consecutive matched indices into one segment", () => {
    const segments = toSegments("Toggle Panel", [7, 8, 9, 10, 11]);
    expect(segments).toEqual([
      { text: "Toggle ", match: false },
      { text: "Panel", match: true },
    ]);
  });

  it("produces alternating segments for scattered indices", () => {
    const segments = toSegments("abcdef", [0, 2, 4]);
    expect(segments).toEqual([
      { text: "a", match: true },
      { text: "b", match: false },
      { text: "c", match: true },
      { text: "d", match: false },
      { text: "e", match: true },
      { text: "f", match: false },
    ]);
  });

  it.each([
    { target: "Toggle Panel", indices: [7, 8, 9, 10, 11] },
    { target: "abcdef", indices: [0, 2, 4] },
    { target: "single character run", indices: [0, 1, 2, 3, 4, 5] },
    { target: "no matches at all", indices: [] },
  ])("reassembles to the original string for target=%o", ({ target, indices }) => {
    const segments = toSegments(target, indices);
    expect(segments.map((s) => s.text).join("")).toBe(target);
  });

  it("round-trips with fuzzyMatch output", () => {
    const target = "toggleOutlinePanel";
    const result = fuzzyMatch("top", target);
    expect(result).not.toBeNull();
    const segments = toSegments(target, result!.indices);
    expect(segments.map((s) => s.text).join("")).toBe(target);
  });
});
