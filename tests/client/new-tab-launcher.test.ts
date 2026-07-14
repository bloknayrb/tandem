import { describe, expect, it } from "vitest";
import {
  type LauncherRow,
  pipClassFor,
  searchRows,
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

describe("searchRows", () => {
  const row = (path: string): LauncherRow => toLauncherRow({ path, openedAt: 0 });

  it("returns all rows in input (recency) order with a single unmatched segment for an empty query", () => {
    const rows = [row("/a/first.md"), row("/b/second.md"), row("/c/third.md")];
    for (const query of ["", "   "]) {
      const result = searchRows(rows, query);
      expect(result.map((e) => e.row.path)).toEqual(["/a/first.md", "/b/second.md", "/c/third.md"]);
      expect(result[0].nameSegments).toEqual([{ text: "first.md", match: false }]);
    }
  });

  it("matches on the name and highlights the matched run", () => {
    const result = searchRows([row("~/writing/chapter.md")], "apt");
    expect(result).toHaveLength(1);
    expect(result[0].nameSegments).toEqual([
      { text: "ch", match: false },
      { text: "apt", match: true },
      { text: "er.md", match: false },
    ]);
  });

  it("is case-insensitive", () => {
    const result = searchRows([row("~/writing/chapter.md")], "APT");
    expect(result).toHaveLength(1);
    expect(result[0].nameSegments.filter((s) => s.match).map((s) => s.text)).toEqual(["apt"]);
  });

  it("includes a dir-only match but renders the name unhighlighted", () => {
    // Indices come from the primary field (name) only — same tradeoff the
    // command palette accepts for annotation snippets.
    const result = searchRows([row("~/writing/posts/launch.md")], "posts");
    expect(result).toHaveLength(1);
    expect(result[0].nameSegments).toEqual([{ text: "launch.md", match: false }]);
  });

  it("excludes rows that match neither name nor dir", () => {
    const rows = [row("/a/alpha.md"), row("/b/beta.md")];
    const result = searchRows(rows, "zzz");
    expect(result).toEqual([]);
  });

  it("ranks a name match above a dir match (secondary field is ×0.75)", () => {
    // "draft" hits the DIR of the first (more recent) row but the NAME of the
    // second — quality outranks recency now.
    const rows = [row("/home/draft/notes.md"), row("/home/other/draft.md")];
    const result = searchRows(rows, "draft");
    expect(result.map((e) => e.row.path)).toEqual(["/home/other/draft.md", "/home/draft/notes.md"]);
  });

  it("breaks equal-score ties by recency (original index)", () => {
    // Identical names in different dirs, query matches only the names →
    // identical scores; input (recency) order must be preserved.
    const rows = [row("/x/chapter.md"), row("/y/chapter.md"), row("/z/chapter.md")];
    const result = searchRows(rows, "chapter");
    expect(result.map((e) => e.row.path)).toEqual([
      "/x/chapter.md",
      "/y/chapter.md",
      "/z/chapter.md",
    ]);
  });

  it("includes subsequence matches (deliberately more permissive than the old substring filter)", () => {
    const result = searchRows([row("~/book/chapter.md")], "chp");
    expect(result).toHaveLength(1);
    expect(result[0].row.name).toBe("chapter.md");
  });

  it("segments always reassemble to the full name", () => {
    const rows = [row("~/book/chapter.md"), row("/x/aXaXa.txt")];
    for (const query of ["chp", "a", "aaa", "chapter"]) {
      for (const entry of searchRows(rows, query)) {
        expect(entry.nameSegments.map((s) => s.text).join("")).toBe(entry.row.name);
      }
    }
  });
});
