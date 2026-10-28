/**
 * #2001: a range whose `from` lands on a hard break or an intra-element block
 * separator must survive a no-edit refresh unchanged.
 *
 * Before the fix, `flatOffsetToRelPos` retried an assoc-0 miss at offset+1, so
 * the anchor sat one character right of the stored `from`; the next
 * `refreshRange` resolved the anchor, saw the mismatch and reported — and
 * persisted — `updated` with the leading separator dropped. Nothing had been
 * edited. The issue's measurement table is the first two rows below.
 */

import { describe, expect, it } from "vitest";
import { extractText } from "../../src/server/mcp/document-model.js";
import { anchoredRange, refreshRange } from "../../src/server/positions.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import { makeAnnotation, makeMarkdownDoc } from "../helpers/ydoc-factory.js";

interface Case {
  name: string;
  markdown: string;
  /** The separator character the range must start on. */
  find: (flat: string) => number;
  span: number;
}

const firstNewline = (flat: string) => flat.indexOf("\n");

const CASES: Case[] = [
  { name: "hard break", markdown: "line one  \nline two\n", find: firstNewline, span: 4 },
  { name: "list separator", markdown: "- one\n- two\n", find: firstNewline, span: 4 },
  {
    name: "nested list separator",
    markdown: "- one\n  - inner\n- two\n",
    find: firstNewline,
    span: 4,
  },
  {
    name: "blockquote with two paragraphs",
    markdown: "> one\n>\n> two\n\nafter\n",
    find: firstNewline,
    span: 3,
  },
  {
    name: "table cell with a hard break",
    markdown: "| a | b |\n|---|---|\n| one\\\ntwo | three |\n",
    find: (flat) => flat.indexOf("\ntwo"),
    span: 3,
  },
];

describe("#2001: a range starting on a separator survives a no-edit refresh", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const doc = makeMarkdownDoc(c.markdown);
      const flat = extractText(doc);
      const from = c.find(flat);
      expect(from, "fixture must contain the separator").toBeGreaterThan(0);
      expect(flat[from]).toBe("\n");
      const to = from + c.span;

      const minted = anchoredRange(doc, toFlatOffset(from), toFlatOffset(to));
      expect(minted.ok).toBe(true);
      if (!minted.ok) return;
      expect(minted.fullyAnchored, "a separator-start range anchors").toBe(true);

      const ann = makeAnnotation({
        range: minted.range,
        relRange: minted.fullyAnchored ? minted.relRange : undefined,
        textSnapshot: flat.slice(from, to),
      });
      const result = refreshRange(ann, doc);
      expect(result.kind, "no edit, so nothing moved").toBe("ok");
      expect(result.annotation.range).toEqual({ from, to });
    });
  }
});
