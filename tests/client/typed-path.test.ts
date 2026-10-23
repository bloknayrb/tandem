import { describe, expect, it } from "vitest";
import { parseTypedPath } from "../../src/client/utils/typed-path.js";

describe("parseTypedPath (#1895)", () => {
  it.each([
    ["/home/u/a.md", "/home/u/a.md"],
    ["C:\\Users\\me\\a.md", "C:\\Users\\me\\a.md"],
    ["C:/Users/me/a.md", "C:/Users/me/a.md"],
    ["c:\\x\\a.md", "c:\\x\\a.md"],
  ])("accepts absolute path %s", (raw, expected) => {
    expect(parseTypedPath(raw)).toEqual({ ok: true, path: expected });
  });

  it("trims surrounding whitespace", () => {
    expect(parseTypedPath("  /home/u/a.md \n")).toEqual({ ok: true, path: "/home/u/a.md" });
  });

  it("unwraps one pair of double quotes (Windows 'Copy as path')", () => {
    expect(parseTypedPath('"C:\\x\\a.md"')).toEqual({ ok: true, path: "C:\\x\\a.md" });
    expect(parseTypedPath('  " /home/u/a.md "  ')).toEqual({ ok: true, path: "/home/u/a.md" });
  });

  it("unwraps one pair of single quotes (shell drag-and-drop)", () => {
    expect(parseTypedPath("'/Users/me/my notes.md'")).toEqual({
      ok: true,
      path: "/Users/me/my notes.md",
    });
  });

  it("does not strip a lone or mismatched quote", () => {
    expect(parseTypedPath('"C:\\x\\a.md')).toMatchObject({ ok: false, reason: "relative" });
    expect(parseTypedPath('/home/u/a.md"')).toEqual({ ok: true, path: '/home/u/a.md"' });
    expect(parseTypedPath("'/home/u/a.md\"")).toMatchObject({ ok: false, reason: "relative" });
  });

  it.each(["", "   ", '""', "''", '"   "'])("empty input %j → reason empty", (raw) => {
    expect(parseTypedPath(raw)).toEqual({
      ok: false,
      reason: "empty",
      error: "Enter the full path of a file.",
    });
  });

  it.each(["notes.md", "~/a.md", "./a.md", "../a.md", "C:a.md", "file:///home/u/a.md"])(
    "relative or non-path %s → reason relative",
    (raw) => {
      const result = parseTypedPath(raw);
      expect(result).toMatchObject({ ok: false, reason: "relative" });
      if (!result.ok) expect(result.error).toMatch(/^Enter a full path/);
    },
  );

  it("passes a UNC path through for the server to refuse", () => {
    expect(parseTypedPath("\\\\server\\share\\a.md")).toEqual({
      ok: true,
      path: "\\\\server\\share\\a.md",
    });
  });
});
