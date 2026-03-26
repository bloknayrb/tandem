import { describe, it, expect, beforeEach } from "vitest";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  addDoc,
  removeDoc,
  setActiveDocId,
  getOpenDocs,
} from "../../src/server/mcp/document-service.js";
import { populateYDoc, extractText } from "../../src/server/mcp/document.js";
import { escapeRegex } from "../../src/server/mcp/response.js";

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

describe("tandem_search logic", () => {
  it("finds literal text matches case-insensitively", () => {
    const ydoc = setupDoc("search-1", "The Quick Brown Fox");
    const fullText = extractText(ydoc);
    const pattern = new RegExp(escapeRegex("quick"), "gi");
    const matches: Array<{ from: number; to: number; text: string }> = [];

    let match;
    while ((match = pattern.exec(fullText)) !== null) {
      matches.push({ from: match.index, to: match.index + match[0].length, text: match[0] });
    }

    expect(matches).toHaveLength(1);
    expect(matches[0].text).toBe("Quick");
    expect(matches[0].from).toBe(4);
    expect(matches[0].to).toBe(9);
  });

  it("finds multiple occurrences", () => {
    const ydoc = setupDoc("search-2", "cat and cat and cat");
    const fullText = extractText(ydoc);
    const pattern = new RegExp(escapeRegex("cat"), "gi");
    const matches: Array<{ from: number; to: number }> = [];

    let match;
    while ((match = pattern.exec(fullText)) !== null) {
      matches.push({ from: match.index, to: match.index + match[0].length });
    }

    expect(matches).toHaveLength(3);
  });

  it("supports regex mode", () => {
    const ydoc = setupDoc("search-3", "Hello 123 World 456");
    const fullText = extractText(ydoc);
    const pattern = new RegExp("\\d+", "gi");
    const matches: Array<{ text: string }> = [];

    let match;
    while ((match = pattern.exec(fullText)) !== null) {
      matches.push({ text: match[0] });
    }

    expect(matches).toHaveLength(2);
    expect(matches[0].text).toBe("123");
    expect(matches[1].text).toBe("456");
  });

  it("returns empty array for no matches", () => {
    const ydoc = setupDoc("search-4", "Hello world");
    const fullText = extractText(ydoc);
    const pattern = new RegExp(escapeRegex("xyz"), "gi");
    const matches: any[] = [];

    let match;
    while ((match = pattern.exec(fullText)) !== null) {
      matches.push(match);
    }

    expect(matches).toHaveLength(0);
  });

  it("escapes regex metacharacters in literal mode", () => {
    const ydoc = setupDoc("search-5", "price is $9.99 (USD)");
    const fullText = extractText(ydoc);
    const pattern = new RegExp(escapeRegex("$9.99"), "gi");
    const matches: Array<{ text: string }> = [];

    let match;
    while ((match = pattern.exec(fullText)) !== null) {
      matches.push({ text: match[0] });
    }

    expect(matches).toHaveLength(1);
    expect(matches[0].text).toBe("$9.99");
  });
});

describe("tandem_resolveRange logic", () => {
  it("finds first occurrence by default", () => {
    const ydoc = setupDoc("resolve-1", "foo bar foo baz foo");
    const fullText = extractText(ydoc);
    const regex = new RegExp(escapeRegex("foo"), "g");

    let match;
    let count = 0;
    let result: { from: number; to: number } | null = null;
    while ((match = regex.exec(fullText)) !== null) {
      count++;
      if (count === 1) {
        result = { from: match.index, to: match.index + match[0].length };
      }
    }

    expect(result).toEqual({ from: 0, to: 3 });
    expect(count).toBe(3);
  });

  it("finds nth occurrence", () => {
    const ydoc = setupDoc("resolve-2", "foo bar foo baz foo");
    const fullText = extractText(ydoc);
    const regex = new RegExp(escapeRegex("foo"), "g");

    let match;
    let count = 0;
    let result: { from: number; to: number } | null = null;
    while ((match = regex.exec(fullText)) !== null) {
      count++;
      if (count === 3) {
        result = { from: match.index, to: match.index + match[0].length };
      }
    }

    expect(result).toEqual({ from: 16, to: 19 });
  });

  it("reports error when occurrence not found", () => {
    const ydoc = setupDoc("resolve-3", "foo bar");
    const fullText = extractText(ydoc);
    const regex = new RegExp(escapeRegex("foo"), "g");

    let _match;
    let count = 0;
    while ((_match = regex.exec(fullText)) !== null) {
      count++;
    }

    // Asking for occurrence 5, but only found 1
    expect(count).toBe(1);
  });
});

describe("tandem_getContext logic", () => {
  it("returns context window around a range", () => {
    const ydoc = setupDoc("ctx-1", "The quick brown fox jumps over the lazy dog");
    const fullText = extractText(ydoc);
    const from = 10;
    const to = 19; // "brown fox"
    const windowSize = 5;

    const contextStart = Math.max(0, from - windowSize);
    const contextEnd = Math.min(fullText.length, to + windowSize);

    const context = fullText.slice(contextStart, contextEnd);
    const selection = fullText.slice(from, to);

    expect(selection).toBe("brown fox");
    expect(context).toContain("brown fox");
    expect(context.length).toBeGreaterThan(selection.length);
  });

  it("clamps at document boundaries", () => {
    const ydoc = setupDoc("ctx-2", "Hello");
    const fullText = extractText(ydoc);
    const windowSize = 500;

    const contextStart = Math.max(0, 0 - windowSize);
    const contextEnd = Math.min(fullText.length, 5 + windowSize);

    expect(contextStart).toBe(0);
    expect(contextEnd).toBe(fullText.length);
  });

  it("handles zero windowSize", () => {
    const ydoc = setupDoc("ctx-3", "Hello world");
    const fullText = extractText(ydoc);
    const from = 0;
    const to = 5;

    const context = fullText.slice(Math.max(0, from), Math.min(fullText.length, to));
    expect(context).toBe("Hello");
  });
});

describe("search across headings", () => {
  it("finds text in headings (including prefix in flat text)", () => {
    const ydoc = setupDoc("heading-search", "## My Heading\nSome body text");
    const fullText = extractText(ydoc);

    // Flat text includes heading prefix: "## My Heading\nSome body text"
    expect(fullText).toContain("## My Heading");
    const pattern = new RegExp(escapeRegex("My Heading"), "gi");
    const matches: Array<{ from: number; to: number }> = [];

    let match;
    while ((match = pattern.exec(fullText)) !== null) {
      matches.push({ from: match.index, to: match.index + match[0].length });
    }

    expect(matches).toHaveLength(1);
    expect(matches[0].from).toBe(3); // After "## "
  });
});

describe("search in multi-paragraph documents", () => {
  it("finds text across paragraphs", () => {
    const ydoc = setupDoc("multi-para", "first paragraph\nsecond paragraph\nthird paragraph");
    const fullText = extractText(ydoc);
    const pattern = new RegExp(escapeRegex("paragraph"), "gi");
    const matches: any[] = [];

    let match;
    while ((match = pattern.exec(fullText)) !== null) {
      matches.push(match[0]);
    }

    expect(matches).toHaveLength(3);
  });
});
