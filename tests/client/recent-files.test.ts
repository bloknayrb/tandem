import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addRecentFile,
  formatWhen,
  type RecentFileEntry,
  recentFilePaths,
} from "../../src/client/utils/recentFiles.js";

const entry = (path: string, openedAt = 1000): RecentFileEntry => ({ path, openedAt });

describe("addRecentFile", () => {
  it("adds to front of empty list, stamping openedAt", () => {
    const result = addRecentFile([], "/a.md", 5000);
    expect(result).toEqual([{ path: "/a.md", openedAt: 5000 }]);
  });

  it("deduplicates existing entry and moves to front", () => {
    const result = addRecentFile([entry("/a.md"), entry("/b.md")], "/b.md");
    expect(recentFilePaths(result)).toEqual(["/b.md", "/a.md"]);
  });

  it("preserves the existing openedAt when re-adding a known path (no churn)", () => {
    // The recents-sync effect re-adds open tabs constantly; re-stamping would
    // peg every open file to "just now". An existing path keeps its timestamp.
    const result = addRecentFile([entry("/a.md", 111), entry("/b.md", 222)], "/b.md", 9999);
    expect(result[0]).toEqual({ path: "/b.md", openedAt: 222 });
  });

  it("only stamps openedAt for a genuinely new path", () => {
    const result = addRecentFile([entry("/a.md", 111)], "/new.md", 9999);
    expect(result[0]).toEqual({ path: "/new.md", openedAt: 9999 });
    expect(result[1]).toEqual({ path: "/a.md", openedAt: 111 });
  });

  it("caps at the limit (cap is the 4th arg)", () => {
    const list = Array.from({ length: 20 }, (_, i) => entry(`/file${i}.md`, i));
    const result = addRecentFile(list, "/new.md", 9999, 20);
    expect(result).toHaveLength(20);
    expect(result[0]).toEqual({ path: "/new.md", openedAt: 9999 });
    expect(result[19]).toEqual({ path: "/file18.md", openedAt: 18 });
  });

  it("does not duplicate when adding the same path that is already first", () => {
    const result = addRecentFile([entry("/a.md", 111), entry("/b.md", 222)], "/a.md");
    expect(result).toEqual([
      { path: "/a.md", openedAt: 111 },
      { path: "/b.md", openedAt: 222 },
    ]);
  });

  it("registers a promoted scratchpad path, then dedups the effect re-add (#1019)", () => {
    // Save As (runTauriSaveAs) registers the server-resolved promoted path the
    // instant the write is confirmed. Shortly after, the recents-sync effect in
    // App.svelte re-adds the same path once the openDocuments broadcast updates
    // the open tab's filePath. Both call sites must converge on a SINGLE entry —
    // registering the identical resolved string is what prevents a duplicate.
    const promoted = "/home/user/notes/Scratchpad.md";
    const afterSaveAs = addRecentFile([entry("/a.md", 111)], promoted, 9999);
    expect(recentFilePaths(afterSaveAs)).toEqual([promoted, "/a.md"]);

    const afterEffectReAdd = addRecentFile(afterSaveAs, promoted);
    expect(recentFilePaths(afterEffectReAdd)).toEqual([promoted, "/a.md"]);
    // The re-add reuses the existing entry (keeps openedAt), so no churn.
    expect(afterEffectReAdd[0]).toEqual({ path: promoted, openedAt: 9999 });
  });
});

describe("recentFilePaths", () => {
  it("projects entries to paths newest-first", () => {
    expect(recentFilePaths([entry("/a.md"), entry("/b.md")])).toEqual(["/a.md", "/b.md"]);
  });
});

describe("loadRecentFiles — migration & tolerance", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("migrates the legacy string[] shape to entries with openedAt 0", async () => {
    localStorage.setItem("tandem:recentFiles", JSON.stringify(["/a.md", "/b.md"]));
    const { loadRecentFiles } = await import("../../src/client/utils/recentFiles.js");
    expect(loadRecentFiles()).toEqual([
      { path: "/a.md", openedAt: 0 },
      { path: "/b.md", openedAt: 0 },
    ]);
  });

  it("round-trips the current entry shape", async () => {
    const entries = [
      { path: "/a.md", openedAt: 111 },
      { path: "/b.md", openedAt: 222 },
    ];
    localStorage.setItem("tandem:recentFiles", JSON.stringify(entries));
    const { loadRecentFiles } = await import("../../src/client/utils/recentFiles.js");
    expect(loadRecentFiles()).toEqual(entries);
  });

  it("coerces a missing/non-numeric openedAt to 0", async () => {
    localStorage.setItem(
      "tandem:recentFiles",
      JSON.stringify([{ path: "/a.md" }, { path: "/b.md", openedAt: "nope" }]),
    );
    const { loadRecentFiles } = await import("../../src/client/utils/recentFiles.js");
    expect(loadRecentFiles()).toEqual([
      { path: "/a.md", openedAt: 0 },
      { path: "/b.md", openedAt: 0 },
    ]);
  });

  it("drops malformed entries (no string path) and mixed junk", async () => {
    localStorage.setItem(
      "tandem:recentFiles",
      JSON.stringify(["/keep.md", { openedAt: 5 }, null, 42, { path: 7 }]),
    );
    const { loadRecentFiles } = await import("../../src/client/utils/recentFiles.js");
    expect(loadRecentFiles()).toEqual([{ path: "/keep.md", openedAt: 0 }]);
  });

  it("returns [] for a non-array payload", async () => {
    localStorage.setItem("tandem:recentFiles", JSON.stringify({ not: "an array" }));
    const { loadRecentFiles } = await import("../../src/client/utils/recentFiles.js");
    expect(loadRecentFiles()).toEqual([]);
  });
});

describe("loadRecentFilesCached", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("returns same array on second call within 30s (no localStorage re-read)", async () => {
    const { loadRecentFilesCached, invalidateRecentFilesCache, saveRecentFiles } = await import(
      "../../src/client/utils/recentFiles.js"
    );
    invalidateRecentFilesCache();
    saveRecentFiles([entry("/a/file.md")]);

    const first = loadRecentFilesCached();
    localStorage.setItem(
      "tandem:recentFiles",
      JSON.stringify([entry("/b/other.md"), entry("/a/file.md")]),
    );
    const second = loadRecentFilesCached();
    expect(second).toBe(first); // same reference = cache hit
  });

  it("re-reads localStorage after cache is manually invalidated", async () => {
    const { loadRecentFilesCached, invalidateRecentFilesCache, saveRecentFiles } = await import(
      "../../src/client/utils/recentFiles.js"
    );
    invalidateRecentFilesCache();
    saveRecentFiles([entry("/a/file.md")]);
    loadRecentFilesCached();

    saveRecentFiles([entry("/b/other.md"), entry("/a/file.md")]);
    invalidateRecentFilesCache();

    expect(loadRecentFilesCached()[0].path).toBe("/b/other.md");
  });

  it("saveRecentFiles auto-invalidates cache so next read is fresh", async () => {
    const { loadRecentFilesCached, invalidateRecentFilesCache, saveRecentFiles } = await import(
      "../../src/client/utils/recentFiles.js"
    );
    invalidateRecentFilesCache();
    saveRecentFiles([entry("/a/file.md")]);
    loadRecentFilesCached();

    saveRecentFiles([entry("/new.md")]);
    expect(loadRecentFilesCached()[0].path).toBe("/new.md");
  });
});

describe("formatWhen", () => {
  const NOW = 1_000_000_000_000;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it.each([
    { why: "unknown timestamp (legacy/migrated entry)", openedAt: 0, expected: "" },
    { why: "under a minute", openedAt: NOW - 30_000, expected: "just now" },
    { why: "exactly at the minute boundary", openedAt: NOW - MIN, expected: "1m" },
    { why: "minutes", openedAt: NOW - 45 * MIN, expected: "45m" },
    { why: "just under an hour", openedAt: NOW - 59 * MIN, expected: "59m" },
    { why: "exactly an hour", openedAt: NOW - HOUR, expected: "1h" },
    { why: "hours", openedAt: NOW - 5 * HOUR, expected: "5h" },
    { why: "just under a day", openedAt: NOW - 23 * HOUR, expected: "23h" },
    { why: "exactly a day", openedAt: NOW - DAY, expected: "1d" },
    { why: "days", openedAt: NOW - 9 * DAY, expected: "9d" },
    {
      why: "future timestamp (clock skew) collapses to just now",
      openedAt: NOW + 5000,
      expected: "just now",
    },
  ])("$why → '$expected'", ({ openedAt, expected }) => {
    expect(formatWhen(openedAt, NOW)).toBe(expected);
  });
});
