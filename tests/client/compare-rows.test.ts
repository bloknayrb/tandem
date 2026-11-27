/**
 * `buildDiffRows` (ADR-057 PR 4): the compare view's unified diff of another
 * version against the document now.
 */

import { describe, expect, it } from "vitest";
import {
  buildDiffRows,
  DIFF_CONTEXT_LINES,
  MAX_DIFF_ROWS,
} from "../../src/client/utils/compare.js";

const kinds = (rows: ReturnType<typeof buildDiffRows>) => rows?.map((r) => r.kind);

describe("buildDiffRows", () => {
  it("no differences is an empty list", () => {
    expect(buildDiffRows("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("marks lines only in the other version as removed and only in the document as added", () => {
    const rows = buildDiffRows("keep\nold only\n", "keep\nnew only\nextra\n");
    expect(rows).toEqual(
      expect.arrayContaining([
        { kind: "same", text: "keep" },
        expect.objectContaining({ kind: "remove", text: "old only" }),
        expect.objectContaining({ kind: "add", text: "new only" }),
        expect.objectContaining({ kind: "add", text: "extra" }),
      ]),
    );
  });

  it("highlights the changed words of an equal-sized replaced block", () => {
    const rows = buildDiffRows("the quick fox\n", "the slow fox\n");
    const removed = rows?.find((r) => r.kind === "remove");
    const added = rows?.find((r) => r.kind === "add");
    expect(removed && "segments" in removed && removed.segments).toEqual(
      expect.arrayContaining([{ text: "quick", changed: true }]),
    );
    expect(added && "segments" in added && added.segments).toEqual(
      expect.arrayContaining([{ text: "slow", changed: true }]),
    );
  });

  it("collapses long unchanged runs to the context around each change", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const other = `${body.join("\n")}\n`;
    const changed = [...body];
    changed[20] = "line 20 edited";
    const rows = buildDiffRows(other, `${changed.join("\n")}\n`);
    const gaps = rows?.filter((r) => r.kind === "gap") ?? [];
    expect(gaps).toHaveLength(2);
    // Context kept on both sides of the change.
    const firstChange = rows?.findIndex((r) => r.kind !== "same" && r.kind !== "gap") ?? -1;
    expect(kinds(rows)?.slice(firstChange - DIFF_CONTEXT_LINES, firstChange)).toEqual(
      Array(DIFF_CONTEXT_LINES).fill("same"),
    );
  });

  it("gives up (null) when the diff exceeds its time budget", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
    // A zero budget: the line diff is abandoned before it finishes.
    expect(buildDiffRows(a, b, 0)).toBeNull();
  });

  it("returns at most MAX_DIFF_ROWS rows and counts the rest in one more row", () => {
    const n = MAX_DIFF_ROWS + 500;
    const other = Array.from({ length: n }, (_, i) => `x${i}`).join("\n");
    const current = Array.from({ length: n }, (_, i) => (i % 2 ? `x${i}` : `y${i}`)).join("\n");
    const rows = buildDiffRows(other, current, 10_000) ?? [];
    expect(rows).toHaveLength(MAX_DIFF_ROWS + 1);
    const last = rows[rows.length - 1];
    expect(last.kind).toBe("more");
    expect(last.kind === "more" && last.count).toBeGreaterThan(0);
  });
});
