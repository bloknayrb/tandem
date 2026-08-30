import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadMarkdown } from "../../src/server/file-io/markdown.js";
import { extractText } from "../../src/server/mcp/document.js";
import { collectBlocks } from "../../src/server/mcp/document-model.js";

/**
 * Structure visibility for `tandem_getOutline({ includeBlocks: true })`.
 *
 * The flat projection is structurally blind: `- [ ] task item` reads as bare
 * `task item`, so an MCP caller cannot tell a list item from a paragraph, nor
 * see nesting, ordered-ness, or checkbox state. Without this the list-editing
 * path is undiscoverable — the AI has no way to know a line is a list item.
 *
 * The load-bearing assertion is that every reported `[from, to)` slices exactly
 * the block's text out of `extractText`. `blocks` that disagreed with the
 * coordinate system would be worse than no blocks at all, because the offsets
 * are what the caller then hands back to `tandem_edit`.
 */

function blocksOf(md: string): { flat: string; blocks: ReturnType<typeof collectBlocks> } {
  const doc = new Y.Doc();
  try {
    loadMarkdown(doc, md);
    return { flat: extractText(doc), blocks: collectBlocks(doc) };
  } finally {
    doc.destroy();
  }
}

const SHAPES: Array<[string, string]> = [
  ["flat list", "- first item\n- second item\n"],
  ["task list", "- [ ] todo one\n- [x] done two\n"],
  ["nested list", "- parent\n  - child a\n  - child b\n"],
  ["ordered list", "1. alpha\n2. beta\n"],
  ["mixed document", "# Title\n\nIntro.\n\n- alpha\n- beta\n\nAfter.\n"],
  ["blockquote", "> quoted\n\npara\n"],
  ["heading then image", "# T\n\n![x](a.png)\n\ntail\n"],
  ["nested heading", "## Top\n\n- # Nested\n"],
  ["list in a blockquote", "> - a\n> - b\n"],
  ["table", "| a | b |\n|---|---|\n| c | d |\n"],
  ["code block in an item", "- text\n\n  ```\n  code\n  ```\n"],
];

describe("collectBlocks", () => {
  it.each(SHAPES)("%s — every range slices its own text out of extractText", (_label, md) => {
    const { flat, blocks } = blocksOf(md);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      expect(b.from, `from within document`).toBeGreaterThanOrEqual(0);
      expect(b.to, `to within document`).toBeLessThanOrEqual(flat.length);
      expect(b.from).toBeLessThanOrEqual(b.to);
      // The slice must be the block's own text — no separator, no prefix.
      expect(flat.slice(b.from, b.to)).not.toContain("\n");
    }
    // Blocks come out in document order and never overlap.
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].from, `block ${i} starts after block ${i - 1} ends`).toBeGreaterThanOrEqual(
        blocks[i - 1].to,
      );
    }
  });

  it("surfaces the list structure flat text throws away", () => {
    const { flat, blocks } = blocksOf("- [ ] todo one\n- [x] done two\n");
    // The whole point: flat text shows no markers and no checkbox state.
    expect(flat).toBe("todo one\ndone two");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      node: "paragraph",
      container: "listItem",
      listType: "bullet",
      listItemIndex: 1,
      checked: false,
    });
    expect(blocks[1]).toMatchObject({ listItemIndex: 2, checked: true });
    expect(flat.slice(blocks[1].from, blocks[1].to)).toBe("done two");
  });

  it("reports ordered lists and per-list item ordinals", () => {
    const { blocks } = blocksOf("1. alpha\n2. beta\n");
    expect(blocks.map((b) => [b.listType, b.listItemIndex])).toEqual([
      ["ordered", 1],
      ["ordered", 2],
    ]);
  });

  it("numbers a nested list's items within their own list, and reports depth", () => {
    const { blocks } = blocksOf("- parent\n  - child a\n  - child b\n");
    expect(blocks.map((b) => b.listItemIndex)).toEqual([1, 1, 2]);
    // The children sit deeper than the parent.
    expect(blocks[1].depth).toBeGreaterThan(blocks[0].depth);
  });

  it("omits a plain bullet's `checked` rather than reporting false", () => {
    // `null` (plain bullet) stores no attribute — reporting `false` would claim
    // an unticked checkbox that is not in the document.
    const { blocks } = blocksOf("- plain\n- [ ] unticked\n");
    expect(blocks[0].checked).toBeUndefined();
    expect(blocks[1].checked).toBe(false);
  });

  it("starts a top-level heading past its prefix and a nested heading at its text", () => {
    // extractTextWithBreaks emits `"## "` in its own top-level loop; a nested
    // heading is traversed by collectElementFlat and gets none. A walker that
    // treated them alike would report offsets that disagree with `text`.
    const { flat, blocks } = blocksOf("## Top\n\n- # Nested\n");
    expect(flat).toBe("## Top\nNested");
    expect(flat.slice(blocks[0].from, blocks[0].to)).toBe("Top");
    expect(blocks[0]).toMatchObject({ node: "heading", headingLevel: 2, depth: 0 });
    expect(flat.slice(blocks[1].from, blocks[1].to)).toBe("Nested");
    expect(blocks[1]).toMatchObject({ node: "heading", container: "listItem" });
  });

  it("advances past a zero-text block without emitting one for it", () => {
    // A block image contributes no characters but still consumes a separator.
    // Getting that wrong shifts every later offset by one.
    const { flat, blocks } = blocksOf("# T\n\n![x](a.png)\n\ntail\n");
    const tail = blocks[blocks.length - 1];
    expect(flat.slice(tail.from, tail.to)).toBe("tail");
  });

  it("marks a blockquote paragraph as contained", () => {
    const { blocks } = blocksOf("> quoted\n\npara\n");
    expect(blocks[0].container).toBe("blockquote");
    expect(blocks[1].container).toBeUndefined();
  });
});
