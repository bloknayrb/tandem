import { describe, it, expect, afterEach } from "vitest";
import * as Y from "yjs";
import { escapeRegex } from "../../src/server/mcp/response.js";
import { extractText } from "../../src/server/mcp/document.js";
import { searchText } from "../../src/server/mcp/navigation.js";
import { makeDoc } from "../helpers/ydoc-factory.js";

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

/** Replicate tandem_search logic */
function search(fullText: string, query: string, regex: boolean = false) {
  const matches: Array<{ from: number; to: number; text: string }> = [];
  const pattern = regex ? new RegExp(query, "gi") : new RegExp(escapeRegex(query), "gi");
  let match;
  while ((match = pattern.exec(fullText)) !== null) {
    matches.push({ from: match.index, to: match.index + match[0].length, text: match[0] });
    // Prevent infinite loop on zero-length matches
    if (match[0].length === 0) break;
  }
  return matches;
}

/** Replicate tandem_resolveRange logic */
function resolveRange(fullText: string, pattern: string, occurrence: number = 1) {
  const regex = new RegExp(escapeRegex(pattern), "g");
  let match;
  let count = 0;
  while ((match = regex.exec(fullText)) !== null) {
    count++;
    if (count === occurrence) {
      return { from: match.index, to: match.index + match[0].length, text: match[0] };
    }
  }
  return { error: `Text "${pattern}" not found (occurrence ${occurrence}, found ${count} total)` };
}

/** Replicate tandem_getContext logic */
function getContext(fullText: string, from: number, to: number, windowSize: number = 500) {
  const contextStart = Math.max(0, from - windowSize);
  const contextEnd = Math.min(fullText.length, to + windowSize);
  return {
    context: fullText.slice(contextStart, contextEnd),
    selection: fullText.slice(from, to),
    contextRange: { from: contextStart, to: contextEnd },
    selectionRange: { from, to },
  };
}

describe("search", () => {
  it("finds all occurrences with correct positions", () => {
    const text = "the cat and the dog";
    const matches = search(text, "the");
    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({ from: 0, to: 3, text: "the" });
    expect(matches[1]).toEqual({ from: 12, to: 15, text: "the" });
  });

  it("case-insensitive by default", () => {
    const matches = search("The cat and THE dog", "the");
    expect(matches).toHaveLength(2);
  });

  it("regex mode finds pattern matches", () => {
    const matches = search("the cat sat on the mat", "c.t", true);
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toBe("cat");
  });

  it("returns empty array for no matches", () => {
    expect(search("hello world", "xyz")).toEqual([]);
  });

  it("invalid regex throws", () => {
    expect(() => new RegExp("[", "gi")).toThrow();
  });

  it("literal search escapes metacharacters", () => {
    const text = "price is $10.00 (USD)";
    const matches = search(text, "$10.00");
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toBe("$10.00");
  });

  it("zero-length regex match terminates", () => {
    // "a*" matches empty string — our search breaks on zero-length to prevent infinite loop
    const matches = search("bbb", "a*", true);
    // Should terminate without hanging
    expect(matches).toBeDefined();
  });

  it('non-overlapping matches for literal "aa" in "aaa"', () => {
    // Regex with 'g' flag doesn't overlap
    const matches = search("aaa", "aa");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({ from: 0, to: 2, text: "aa" });
  });
});

describe("resolveRange", () => {
  const text = "the cat and the dog and the fish";

  it("finds first occurrence by default", () => {
    const result = resolveRange(text, "the");
    expect(result).toEqual({ from: 0, to: 3, text: "the" });
  });

  it("finds second occurrence", () => {
    const result = resolveRange(text, "the", 2);
    expect(result).toEqual({ from: 12, to: 15, text: "the" });
  });

  it("finds third occurrence", () => {
    const result = resolveRange(text, "the", 3);
    expect(result).toEqual({ from: 24, to: 27, text: "the" });
  });

  it("occurrence > count returns error with count", () => {
    const result = resolveRange(text, "the", 10);
    expect(result).toHaveProperty("error");
    expect((result as any).error).toContain("found 3 total");
  });

  it("pattern not found returns error with 0 count", () => {
    const result = resolveRange(text, "xyz");
    expect(result).toHaveProperty("error");
    expect((result as any).error).toContain("found 0 total");
  });
});

describe("getContext", () => {
  const text = "abcdefghij";

  it("returns correct window around range", () => {
    // from=3, windowSize=2 → contextStart=max(0,3-2)=1, contextEnd=min(10,5+2)=7
    const result = getContext(text, 3, 5, 2);
    expect(result.context).toBe("bcdefg");
    expect(result.selection).toBe("de");
    expect(result.contextRange).toEqual({ from: 1, to: 7 });
    expect(result.selectionRange).toEqual({ from: 3, to: 5 });
  });

  it("clamps at document start", () => {
    const result = getContext(text, 1, 3, 500);
    expect(result.contextRange.from).toBe(0);
    expect(result.context).toBe(text); // window exceeds both ends
  });

  it("clamps at document end", () => {
    const result = getContext(text, 8, 10, 500);
    expect(result.contextRange.to).toBe(10);
  });

  it("range at offset 0 does not go negative", () => {
    const result = getContext(text, 0, 2, 5);
    expect(result.contextRange.from).toBe(0);
    expect(result.context).toBe("abcdefg");
  });
});

describe("search on Y.Doc extracted text", () => {
  it("finds text in multi-element document", () => {
    doc = makeDoc("# Title\nFirst paragraph\n## Section\nSecond paragraph");
    const text = extractText(doc);
    const matches = search(text, "paragraph");
    expect(matches).toHaveLength(2);
  });

  it("finds text across heading prefixes", () => {
    doc = makeDoc("## Hello World");
    const text = extractText(doc);
    // extractText includes "## " prefix
    const matches = search(text, "Hello");
    expect(matches).toHaveLength(1);
    expect(matches[0].from).toBe(3); // after "## "
  });
});

describe("searchText — ReDoS protections", () => {
  it("caps results at 10,000 matches and returns an error", () => {
    // 10,001 single-char matches — each "a" matches once
    const text = "a".repeat(10_001);
    const result = searchText(text, "a");
    expect(result.matches).toHaveLength(10_000);
    expect(result.error).toMatch(/capped at 10000/i);
  });

  it("zero-length regex match does not infinite loop", () => {
    // "a*" matches empty string at every position in "bbb"
    const result = searchText("bbb", "a*", true);
    // Should complete quickly and return a defined result
    expect(result.matches).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it("returns matches alongside error when cap is hit", () => {
    const text = "x".repeat(10_001);
    const result = searchText(text, "x");
    // Matches are returned even though the cap was hit
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.error).toBeTruthy();
  });
});
