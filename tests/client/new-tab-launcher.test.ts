import { describe, expect, it } from "vitest";
import {
  highlightSegments,
  matchesQuery,
  pipClassFor,
  toLauncherRow,
} from "../../src/client/tabs/newTabLauncher.js";

describe("pipClassFor", () => {
  it.each([
    { why: "markdown", name: "draft.md", expected: "md" },
    { why: ".markdown long form", name: "notes.markdown", expected: "md" },
    { why: "word docx", name: "review.docx", expected: "docx" },
    { why: "legacy doc", name: "old.doc", expected: "docx" },
    { why: "plain text", name: "log.txt", expected: "txt" },
    { why: "html", name: "report.html", expected: "html" },
    { why: "htm", name: "page.htm", expected: "html" },
    { why: "uppercase extension is normalized", name: "DRAFT.MD", expected: "md" },
    { why: "unknown extension", name: "data.csv", expected: "other" },
    { why: "no extension", name: "Makefile", expected: "other" },
    { why: "dotfile (leading dot, no real ext)", name: ".gitignore", expected: "other" },
    { why: "trailing dot", name: "weird.", expected: "other" },
  ])("$why → $expected", ({ name, expected }) => {
    expect(pipClassFor(name)).toBe(expected);
  });
});

describe("toLauncherRow", () => {
  const NOW = 1_000_000_000_000;

  it("splits a Windows path", () => {
    const row = toLauncherRow({ path: "C:\\Users\\me\\book\\chapter-2.md", openedAt: NOW }, NOW);
    expect(row).toMatchObject({ name: "chapter-2.md", dir: "C:/Users/me/book", pip: "md" });
  });

  it("splits a POSIX path preserving the leading slash", () => {
    const row = toLauncherRow({ path: "/home/me/notes.txt", openedAt: NOW }, NOW);
    expect(row).toMatchObject({ name: "notes.txt", dir: "/home/me", pip: "txt" });
  });

  it("splits a tilde path", () => {
    const row = toLauncherRow({ path: "~/writing/posts/launch.md", openedAt: NOW }, NOW);
    expect(row).toMatchObject({ name: "launch.md", dir: "~/writing/posts", pip: "md" });
  });

  it("handles a bare filename (no directory)", () => {
    const row = toLauncherRow({ path: "Scratchpad.md", openedAt: NOW }, NOW);
    expect(row).toMatchObject({ name: "Scratchpad.md", dir: "", pip: "md" });
  });

  it("computes the relative-time label from openedAt", () => {
    const row = toLauncherRow({ path: "/a/b.md", openedAt: NOW - 2 * 3_600_000 }, NOW);
    expect(row.when).toBe("2h");
  });

  it("omits the when label for an unknown timestamp (openedAt 0)", () => {
    const row = toLauncherRow({ path: "/a/b.md", openedAt: 0 }, NOW);
    expect(row.when).toBe("");
  });

  it("preserves the full path as the open target", () => {
    const path = "C:\\Users\\me\\book\\chapter-2.md";
    expect(toLauncherRow({ path, openedAt: NOW }, NOW).path).toBe(path);
  });
});

describe("matchesQuery", () => {
  const row = toLauncherRow({ path: "~/writing/posts/launch-day.md", openedAt: 0 });

  it.each([
    { why: "empty query matches everything", query: "", expected: true },
    { why: "whitespace query matches everything", query: "   ", expected: true },
    { why: "substring of the name", query: "launch", expected: true },
    { why: "case-insensitive name match", query: "LAUNCH", expected: true },
    { why: "substring of the directory", query: "posts", expected: true },
    { why: "no match anywhere", query: "zzz", expected: false },
  ])("$why", ({ query, expected }) => {
    expect(matchesQuery(row, query)).toBe(expected);
  });
});

describe("highlightSegments", () => {
  it("returns one unmatched segment for an empty query", () => {
    expect(highlightSegments("chapter.md", "")).toEqual([{ text: "chapter.md", match: false }]);
  });

  it("returns one unmatched segment for a whitespace query", () => {
    expect(highlightSegments("chapter.md", "  ")).toEqual([{ text: "chapter.md", match: false }]);
  });

  it("marks a single case-insensitive match in the middle", () => {
    expect(highlightSegments("chapter.md", "APT")).toEqual([
      { text: "ch", match: false },
      { text: "apt", match: true },
      { text: "er.md", match: false },
    ]);
  });

  it("marks every non-overlapping occurrence", () => {
    expect(highlightSegments("aXaXa", "a")).toEqual([
      { text: "a", match: true },
      { text: "X", match: false },
      { text: "a", match: true },
      { text: "X", match: false },
      { text: "a", match: true },
    ]);
  });

  it("returns one matched segment when the whole name matches", () => {
    expect(highlightSegments("draft", "draft")).toEqual([{ text: "draft", match: true }]);
  });

  it("returns one unmatched segment when there is no match", () => {
    expect(highlightSegments("chapter.md", "zzz")).toEqual([{ text: "chapter.md", match: false }]);
  });
});
