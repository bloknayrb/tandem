import { describe, expect, it } from "vitest";
import {
  fuzzyMatch,
  rankByScore,
  scoreFields,
  toSegments,
} from "../../src/client/utils/fuzzy-match.js";

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
      // "fb" against "fooBar": f(0) matches at the string start (+start
      // bonus, +boundary), then b must skip "oo" (gap of 2, -2) before
      // landing on "B" (index 3), which is itself a camelCase boundary (+8).
      // Exact score pins the -2 gap penalty, which a looser assertion (e.g.
      // "indices[0] is defined") would miss entirely.
      const result = fuzzyMatch("fb", "fooBar");
      expect(result).not.toBeNull();
      expect(result?.indices).toEqual([0, 3]);
      expect(result?.score).toBe(26);
    });
  });

  it("prefers the greedy consecutive run over an earlier non-consecutive start (tier 2 only)", () => {
    // Both cases below are NOT substrings of their targets (verified via the
    // dashes breaking up the literal run), so they exercise the tier-2
    // subsequence scan rather than tier 1 (F9b — the original test's query
    // was a literal substring of its target, so tier 2 never ran).
    //
    // Note: we intentionally do NOT test for the greedy "lookahead" branch
    // (checking `lowerTarget[searchFrom]` before falling back to `indexOf`)
    // as distinct from a plain `indexOf(qc, searchFrom)` — `indexOf` returns
    // `searchFrom` when the char matches there, so the two are observationally
    // identical. These assertions only pin greedy-leftmost matching + score.

    // "abc" vs "a-bcx": a(0), then b must skip "-" (gap 1, -1) to reach index
    // 2, then c continues the run at index 3 (+16 consecutive).
    // START 12 + boundary@0 8 + boundary@2 8 (after '-', non-alnum) - 1 gap
    // + 16 consecutive = 43.
    const abc = fuzzyMatch("abc", "a-bcx");
    expect("a-bcx".toLowerCase().includes("abc")).toBe(false);
    expect(abc?.indices).toEqual([0, 2, 3]);
    expect(abc?.score).toBe(43);

    // "aab" vs "aa-b" (NOT "aaab" — "aaab".indexOf("aab") === 1, which IS a
    // substring and would reproduce the exact bug this test fixes).
    // START 12 + boundary@0 8 + consecutive@1 16 - 1 gap (skip '-')
    // + boundary@3 8 (after '-', non-alnum) = 43.
    const aab = fuzzyMatch("aab", "aa-b");
    expect("aa-b".toLowerCase().includes("aab")).toBe(false);
    expect(aab?.indices).toEqual([0, 1, 3]);
    expect(aab?.score).toBe(43);
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

  describe("Unicode-length-changing lowercase (F6)", () => {
    it("returns an unhighlighted (empty-indices) match when toLowerCase() shifts string length", () => {
      // "İ" (U+0130, Latin capital I with dot above) lowercases to "i̇"
      // (two code units: "i" + combining dot above, U+0069 U+0307), so
      // "İstanbul".toLowerCase() has length 9 while "İstanbul" itself has
      // length 8 — every naive index would be shifted by one from that
      // point on. The match must still be found (score/rank unaffected),
      // but indices must come back empty rather than misaligned.
      expect("İstanbul".toLowerCase().length).not.toBe("İstanbul".length);
      const result = fuzzyMatch("stan", "İstanbul");
      expect(result).not.toBeNull();
      expect(result?.indices).toEqual([]);
    });
  });

  describe("substring tier searches the full target, not just the truncated prefix (F7)", () => {
    it("matches text past the 500-char truncation cap via the substring tier", () => {
      const longTarget = `${"x".repeat(520)}needle`;
      const result = fuzzyMatch("needle", longTarget);
      expect(result).not.toBeNull();
      // Deep substring match: score floors at 10000 - 499 = 9501 (no start
      // or boundary bonus — "needle" isn't at index 0 and isn't preceded by
      // a non-alphanumeric char).
      expect(result?.score).toBeGreaterThanOrEqual(9501);
      const expectedStart = longTarget.toLowerCase().indexOf("needle");
      expect(expectedStart).toBeGreaterThan(500);
      expect(result?.indices).toEqual(
        Array.from({ length: "needle".length }, (_, i) => expectedStart + i),
      );
    });
  });

  describe("tier guarantee is absolute, not just realistic-query (F8)", () => {
    it("keeps a pathological subsequence match's score at or below any substring match's floor", () => {
      // A subsequence match that gets every possible bonus (start, many
      // boundaries, long consecutive runs) still can't cross the clamp.
      const query = `${"!".repeat(250)}?${"!".repeat(248)}`;
      const target = `${"!".repeat(250)}x?${"!".repeat(248)}`;
      expect(target.toLowerCase().includes(query.toLowerCase())).toBe(false);
      const result = fuzzyMatch(query, target);
      expect(result).not.toBeNull();
      expect(result?.score).toBeLessThanOrEqual(9000);
      // Strictly below the lowest possible substring-tier score.
      expect(result?.score).toBeLessThan(9501);
    });
  });
});

describe("rankByScore", () => {
  // The shared ranking used by CommandPalette and the new-tab launcher:
  // sort desc by score with an origIndex tiebreak, then unwrap results.
  it("sorts descending by score", () => {
    const ranked = rankByScore([
      { result: "low", score: 10, origIndex: 0 },
      { result: "high", score: 30, origIndex: 1 },
      { result: "mid", score: 20, origIndex: 2 },
    ]);
    expect(ranked).toEqual(["high", "mid", "low"]);
  });

  it("keeps original insertion order for equal-score matches", () => {
    const candidates = ["Open Panel", "Open Folder", "Open Panel"].map((target, origIndex) => ({
      result: target,
      origIndex,
      score: fuzzyMatch("open", target)!.score,
    }));
    // The two "Open Panel" entries score identically to each other and (in
    // this case) to "Open Folder" too — all three share the "Open " prefix.
    expect(candidates[0].score).toBe(candidates[2].score);

    const ranked = rankByScore([...candidates]);
    expect(ranked).toEqual(["Open Panel", "Open Folder", "Open Panel"]);
  });

  it("re-sorts equal-score candidates back to original order even when shuffled beforehand", () => {
    const scored = [
      { label: "Alpha Panel", origIndex: 0 },
      { label: "Alpha Folder", origIndex: 1 },
      { label: "Alpha Widget", origIndex: 2 },
    ].map((c) => ({
      result: c.origIndex,
      origIndex: c.origIndex,
      score: fuzzyMatch("alpha", c.label)!.score,
    }));
    // Shuffle input order to confirm the sort — not insertion order — is what
    // restores origIndex order.
    const shuffled = [scored[2], scored[0], scored[1]];
    expect(rankByScore(shuffled)).toEqual([0, 1, 2]);
  });
});

describe("scoreFields", () => {
  it("scores and returns indices from the primary field alone when no secondary is given", () => {
    const primaryOnly = fuzzyMatch("panel", "Toggle Panel");
    const result = scoreFields("panel", "Toggle Panel");
    expect(result).not.toBeNull();
    expect(result?.score).toBe(primaryOnly?.score);
    expect(result?.indices).toEqual(primaryOnly?.indices);
  });

  it("matches via a secondary field only, weighting its score by 0.75 and returning empty indices", () => {
    const secondaryMatch = fuzzyMatch("shortcut", "Ctrl+Shortcut");
    const result = scoreFields("shortcut", "Toggle Panel", null, "Ctrl+Shortcut");
    expect(result).not.toBeNull();
    expect(result?.score).toBeCloseTo(secondaryMatch!.score * 0.75);
    expect(result?.indices).toEqual([]);
  });

  it("weights the winning field and picks the max across primary and secondary matches", () => {
    // Primary doesn't match; two secondaries do, at different scores — the
    // higher-scoring (weighted) secondary should win, and null/empty/falsy
    // secondaries should simply be skipped.
    const weakSecondary = fuzzyMatch("zzz", "fuzzzzy");
    const strongSecondary = fuzzyMatch("zzz", "zzzblast");
    const result = scoreFields("zzz", "no match here", "", "fuzzzzy", undefined, "zzzblast");
    expect(result).not.toBeNull();
    expect(result?.score).toBeCloseTo(
      Math.max(weakSecondary!.score, strongSecondary!.score) * 0.75,
    );
    expect(result?.indices).toEqual([]);
  });

  it("returns null when neither the primary nor any secondary field matches", () => {
    expect(scoreFields("xyz", "Toggle Panel", "Formatting", "Ctrl+X")).toBeNull();
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
