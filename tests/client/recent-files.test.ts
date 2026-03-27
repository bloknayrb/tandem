import { describe, it, expect } from "vitest";
import { addRecentFile } from "../../src/client/utils/recentFiles.js";

describe("addRecentFile", () => {
  it("adds to front of empty list", () => {
    expect(addRecentFile([], "/a.md")).toEqual(["/a.md"]);
  });

  it("deduplicates existing entry and moves to front", () => {
    expect(addRecentFile(["/a.md", "/b.md"], "/b.md")).toEqual(["/b.md", "/a.md"]);
  });

  it("caps at specified limit", () => {
    const list = Array.from({ length: 20 }, (_, i) => `/file${i}.md`);
    const result = addRecentFile(list, "/new.md", 20);
    expect(result).toHaveLength(20);
    expect(result[0]).toBe("/new.md");
    expect(result[19]).toBe("/file18.md");
  });

  it("moves existing entry to front preserving order", () => {
    expect(addRecentFile(["/a.md", "/b.md", "/c.md"], "/c.md")).toEqual([
      "/c.md",
      "/a.md",
      "/b.md",
    ]);
  });

  it("does not duplicate when adding the same path that is already first", () => {
    expect(addRecentFile(["/a.md", "/b.md"], "/a.md")).toEqual(["/a.md", "/b.md"]);
  });
});
