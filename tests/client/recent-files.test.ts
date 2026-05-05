import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("loadRecentFilesCached", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns same array on second call within 30s (no localStorage re-read)", async () => {
    const { loadRecentFilesCached, invalidateRecentFilesCache, saveRecentFiles } = await import(
      "../../src/client/utils/recentFiles.js"
    );
    invalidateRecentFilesCache();

    // Seed one file
    saveRecentFiles(["/a/file.md"]);

    const first = loadRecentFilesCached();
    // Write directly to localStorage (bypassing saveRecentFiles) to simulate an
    // external write that does NOT call invalidateRecentFilesCache
    localStorage.setItem("tandem:recentFiles", JSON.stringify(["/b/other.md", "/a/file.md"]));

    // Second call within TTL should return the cached (stale) result
    const second = loadRecentFilesCached();
    expect(second).toBe(first); // same reference = cache hit
  });

  it("re-reads localStorage after cache is manually invalidated", async () => {
    const { loadRecentFilesCached, invalidateRecentFilesCache, saveRecentFiles } = await import(
      "../../src/client/utils/recentFiles.js"
    );
    invalidateRecentFilesCache();

    saveRecentFiles(["/a/file.md"]);
    loadRecentFilesCached(); // warm cache

    saveRecentFiles(["/b/other.md", "/a/file.md"]);
    invalidateRecentFilesCache();

    const result = loadRecentFilesCached();
    expect(result[0]).toBe("/b/other.md"); // fresh read
  });

  it("saveRecentFiles auto-invalidates cache so next read is fresh", async () => {
    const { loadRecentFilesCached, invalidateRecentFilesCache, saveRecentFiles } = await import(
      "../../src/client/utils/recentFiles.js"
    );
    invalidateRecentFilesCache();

    saveRecentFiles(["/a/file.md"]);
    loadRecentFilesCached(); // warm cache

    // saveRecentFiles should bust the cache
    saveRecentFiles(["/new.md"]);
    const result = loadRecentFilesCached();
    expect(result[0]).toBe("/new.md");
  });
});
