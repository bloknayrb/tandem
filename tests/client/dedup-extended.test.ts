import { describe, expect, it } from "vitest";
import { deduplicateDocList } from "../../src/client/hooks/useYjsSync.js";
import type { DocListEntry } from "../../src/client/types.js";

function makeEntry(id: string): DocListEntry {
  return {
    id,
    filePath: `/tmp/${id}.md`,
    fileName: `${id}.md`,
    format: "md",
    readOnly: false,
  };
}

describe("deduplicateDocList — extended edge cases", () => {
  it("returns all docs when no existing tabs or pending", () => {
    const docList = [makeEntry("a"), makeEntry("b"), makeEntry("c")];
    const result = deduplicateDocList(docList, new Set(), new Set());
    expect(result).toHaveLength(3);
  });

  it("filters out docs already in existing tabs", () => {
    const docList = [makeEntry("a"), makeEntry("b"), makeEntry("c")];
    const result = deduplicateDocList(docList, new Set(["a", "c"]), new Set());
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });

  it("filters out docs in pending creation", () => {
    const docList = [makeEntry("a"), makeEntry("b"), makeEntry("c")];
    const result = deduplicateDocList(docList, new Set(), new Set(["b"]));
    expect(result).toHaveLength(2);
    expect(result.find((d) => d.id === "b")).toBeUndefined();
  });

  it("filters out docs in both existing and pending", () => {
    const docList = [makeEntry("a"), makeEntry("b"), makeEntry("c")];
    const result = deduplicateDocList(docList, new Set(["a"]), new Set(["c"]));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });

  it("returns empty when all docs are accounted for", () => {
    const docList = [makeEntry("a"), makeEntry("b")];
    const result = deduplicateDocList(docList, new Set(["a"]), new Set(["b"]));
    expect(result).toHaveLength(0);
  });

  it("handles empty doc list", () => {
    const result = deduplicateDocList([], new Set(["a"]), new Set(["b"]));
    expect(result).toHaveLength(0);
  });

  it("handles empty existing and pending sets", () => {
    const docList = [makeEntry("x")];
    const result = deduplicateDocList(docList, new Set(), new Set());
    expect(result).toHaveLength(1);
  });

  it("preserves document entry properties", () => {
    const entry: DocListEntry = {
      id: "doc-1",
      filePath: "/home/user/report.md",
      fileName: "report.md",
      format: "md",
      readOnly: true,
    };
    const result = deduplicateDocList([entry], new Set(), new Set());
    expect(result[0]).toEqual(entry);
  });

  it("does not dedup duplicate IDs within the input list itself", () => {
    const docList = [makeEntry("a"), makeEntry("a"), makeEntry("b")];
    const result = deduplicateDocList(docList, new Set(), new Set());
    // deduplicateDocList only filters against existing/pending, not within the list
    expect(result).toHaveLength(3);
  });

  it("handles large doc lists correctly", () => {
    const docList = Array.from({ length: 100 }, (_, i) => makeEntry(`doc-${i}`));
    const existing = new Set(Array.from({ length: 50 }, (_, i) => `doc-${i}`));
    const result = deduplicateDocList(docList, existing, new Set());
    expect(result).toHaveLength(50);
  });
});
