import { describe, it, expect } from "vitest";
import { deduplicateDocList } from "../../src/client/hooks/useYjsSync";
import type { DocListEntry } from "../../src/client/types";

function entry(id: string): DocListEntry {
  return { id, filePath: `/test/${id}.md`, fileName: `${id}.md`, format: "md", readOnly: false };
}

describe("deduplicateDocList", () => {
  it("returns all docs when nothing exists or is pending", () => {
    const result = deduplicateDocList([entry("a"), entry("b")], new Set(), new Set());
    expect(result.map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("filters out docs already in tabs", () => {
    const result = deduplicateDocList(
      [entry("a"), entry("b"), entry("c")],
      new Set(["a", "c"]),
      new Set(),
    );
    expect(result.map((d) => d.id)).toEqual(["b"]);
  });

  it("filters out docs with pending providers", () => {
    const result = deduplicateDocList([entry("a"), entry("b")], new Set(), new Set(["a"]));
    expect(result.map((d) => d.id)).toEqual(["b"]);
  });

  it("filters out docs matching either existing or pending", () => {
    const result = deduplicateDocList(
      [entry("a"), entry("b"), entry("c"), entry("d")],
      new Set(["a"]),
      new Set(["c"]),
    );
    expect(result.map((d) => d.id)).toEqual(["b", "d"]);
  });

  it("returns empty when all docs are accounted for", () => {
    const result = deduplicateDocList([entry("a"), entry("b")], new Set(["a"]), new Set(["b"]));
    expect(result).toEqual([]);
  });

  it("handles empty doc list", () => {
    const result = deduplicateDocList([], new Set(["a"]), new Set(["b"]));
    expect(result).toEqual([]);
  });
});
