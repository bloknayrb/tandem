import { beforeEach, describe, expect, it } from "vitest";
import { extractText, populateYDoc } from "../../src/server/mcp/document.js";
import {
  addDoc,
  getOpenDocs,
  removeDoc,
  setActiveDocId,
} from "../../src/server/mcp/document-service.js";
import {
  countOccurrences,
  extractContext,
  findOccurrence,
  searchText,
} from "../../src/server/mcp/navigation.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";

function setupDoc(id: string, text: string) {
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  setActiveDocId(id);
  return ydoc;
}

beforeEach(() => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
});

describe("searchText", () => {
  it("finds literal text matches case-insensitively", () => {
    const result = searchText("The Quick Brown Fox", "quick");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].text).toBe("Quick");
    expect(result.matches[0].from).toBe(4);
    expect(result.matches[0].to).toBe(9);
  });

  it("finds multiple occurrences", () => {
    const result = searchText("cat and cat and cat", "cat");
    expect(result.matches).toHaveLength(3);
  });

  it("supports regex mode", () => {
    const result = searchText("Hello 123 World 456", "\\d+", true);
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0].text).toBe("123");
    expect(result.matches[1].text).toBe("456");
  });

  it("returns empty array for no matches", () => {
    const result = searchText("Hello world", "xyz");
    expect(result.matches).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });

  it("escapes regex metacharacters in literal mode", () => {
    const result = searchText("price is $9.99 (USD)", "$9.99");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].text).toBe("$9.99");
  });

  it("returns error for invalid regex", () => {
    const result = searchText("Hello", "[invalid", true);
    expect(result.error).toBeDefined();
    expect(result.matches).toHaveLength(0);
  });
});

describe("findOccurrence", () => {
  it("finds first occurrence by default", () => {
    const result = findOccurrence("foo bar foo baz foo", "foo", 1);
    expect("from" in result).toBe(true);
    if ("from" in result) {
      expect(result).toEqual({ from: 0, to: 3, text: "foo" });
    }
  });

  it("finds nth occurrence", () => {
    const result = findOccurrence("foo bar foo baz foo", "foo", 3);
    expect("from" in result).toBe(true);
    if ("from" in result) {
      expect(result).toEqual({ from: 16, to: 19, text: "foo" });
    }
  });

  it("returns error when occurrence not found", () => {
    const result = findOccurrence("foo bar", "foo", 5);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.totalCount).toBe(1);
      expect(result.error).toContain("occurrence 5");
      expect(result.error).toContain("found 1 total");
    }
  });

  it("returns error when text not found at all", () => {
    const result = findOccurrence("foo bar", "xyz");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.totalCount).toBe(0);
    }
  });

  // An empty pattern is a zero-length-match regex; without the guard it loops
  // forever for a non-integer occurrence (#1123). These tests would HANG the
  // runner on a regression — termination is the assertion.
  it("returns a miss for an empty pattern (integer occurrence) instead of a degenerate hit", () => {
    for (const occ of [1, 2, 3]) {
      const result = findOccurrence("abc", "", occ);
      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.totalCount).toBe(0);
    }
  });

  it("does not hang on an empty pattern with a non-integer occurrence", () => {
    const result = findOccurrence("abc", "", 1.5);
    expect("error" in result).toBe(true);
  });
});

describe("countOccurrences", () => {
  it("returns 0 for an empty pattern (the clamp-gate guard)", () => {
    expect(countOccurrences("anything at all", "")).toBe(0);
  });

  it("counts a unique pattern as 1 and a repeated one as n", () => {
    expect(countOccurrences("foo bar baz", "bar")).toBe(1);
    expect(countOccurrences("foo foo foo", "foo")).toBe(3);
  });

  it("escapes regex metacharacters like findOccurrence (literal matching)", () => {
    expect(countOccurrences("price $9.99 and $9x99", "$9.99")).toBe(1);
  });

  it("agrees with findOccurrence on overlapping patterns (non-overlapping count)", () => {
    // "aa" in "aaaa": both walk a global regex that advances past each match,
    // so both see exactly 2 non-overlapping occurrences — the invariant the
    // clamp gate (count===1) depends on.
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    const miss = findOccurrence("aaaa", "aa", 99);
    expect("error" in miss).toBe(true);
    if ("error" in miss) expect(miss.totalCount).toBe(2);
  });
});

describe("extractContext", () => {
  it("returns context window around a range", () => {
    const result = extractContext("The quick brown fox jumps over the lazy dog", 10, 19, 5);
    expect(result.selection).toBe("brown fox");
    expect(result.context).toContain("brown fox");
    expect(result.context.length).toBeGreaterThan(result.selection.length);
    expect(result.contextRange.from).toBe(5);
    expect(result.contextRange.to).toBe(24);
  });

  it("clamps at document boundaries", () => {
    const result = extractContext("Hello", 0, 5, 500);
    expect(result.contextRange.from).toBe(0);
    expect(result.contextRange.to).toBe(5);
    expect(result.context).toBe("Hello");
  });

  it("handles zero windowSize", () => {
    const result = extractContext("Hello world", 0, 5, 0);
    expect(result.context).toBe("Hello");
    expect(result.selection).toBe("Hello");
  });

  it("uses default windowSize of 500", () => {
    const text = "x".repeat(2000);
    const result = extractContext(text, 1000, 1010);
    expect(result.contextRange.from).toBe(500);
    expect(result.contextRange.to).toBe(1510);
  });
});

describe("searchText on real Y.Doc content", () => {
  it("finds text in headings (including prefix in flat text)", () => {
    const ydoc = setupDoc("heading-search", "## My Heading\nSome body text");
    const fullText = extractText(ydoc);

    const result = searchText(fullText, "My Heading");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].from).toBe(3); // After "## "
  });

  it("finds text across paragraphs", () => {
    const ydoc = setupDoc("multi-para", "first paragraph\nsecond paragraph\nthird paragraph");
    const fullText = extractText(ydoc);
    const result = searchText(fullText, "paragraph");
    expect(result.matches).toHaveLength(3);
  });
});
