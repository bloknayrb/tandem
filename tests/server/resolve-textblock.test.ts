import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadMarkdown, saveMarkdown } from "../../src/server/file-io/markdown.js";
import { extractText } from "../../src/server/mcp/document.js";
import { replaceFlatRangeInElement } from "../../src/server/mcp/document-model.js";
import { isTopLevel, samePath, toFlatOffset } from "../../src/shared/positions/types.js";
import {
  elementAtPath,
  getElementTextLength,
  resolveToElement,
  resolveToTextblock,
} from "../../src/shared/positions/ydoc.js";

/**
 * Depth-aware offset resolution, and the `tandem_edit` branch selection built on it.
 *
 * `resolveToElement` walks only the fragment's direct children, so every offset
 * inside a list resolved to the `bulletList` CONTAINER. `tandem_edit` then
 * refused with "edit a specific paragraph or list item instead" — advice no tool
 * could follow, because none could address a nested block. That is why Claude
 * could read a bulleted list, annotate it, and append a new one, but could not
 * change a single word of an existing item.
 *
 * The mutation primitives were never the problem: `replaceFlatRangeInElement`
 * already handled multi-XmlText/hardBreak interiors at any depth. Only
 * resolution was missing, which is why this file tests resolution and branch
 * selection rather than a new mutation path.
 */

function withDoc<T>(md: string, fn: (doc: Y.Doc) => T): T {
  const doc = new Y.Doc();
  try {
    loadMarkdown(doc, md);
    return fn(doc);
  } finally {
    doc.destroy();
  }
}

/** Replicates `tandem_edit`'s branch selection. MUST mirror `document.ts`. */
function editOutcome(
  doc: Y.Doc,
  from: number,
  to: number,
  newText: string,
): "same-block" | "top-level-cross" | "refused" | "unresolved" {
  const frag = doc.getXmlFragment("default");
  const sp = resolveToTextblock(frag, toFlatOffset(from));
  const ep = resolveToTextblock(frag, toFlatOffset(to));
  if (!sp || !ep) return "unresolved";
  const sn = elementAtPath(frag, sp.path);
  if (!sn) return "unresolved";
  if (samePath(sp, ep)) {
    doc.transact(() => replaceFlatRangeInElement(sn, sp.textOffset, ep.textOffset, newText));
    return "same-block";
  }
  if (!isTopLevel(sp) || !isTopLevel(ep)) return "refused";
  return "top-level-cross";
}

/** Edit the first occurrence of `target`, returning the re-serialized markdown. */
function editText(md: string, target: string, replacement: string): string {
  return withDoc(md, (doc) => {
    const at = extractText(doc).indexOf(target);
    expect(at, `fixture must contain ${JSON.stringify(target)}`).toBeGreaterThanOrEqual(0);
    expect(editOutcome(doc, at, at + target.length, replacement)).toBe("same-block");
    return saveMarkdown(doc);
  });
}

describe("resolveToTextblock", () => {
  const SHAPES: Array<[string, string]> = [
    ["flat list", "- first item\n- second item\n- third\n"],
    ["nested list", "- parent\n  - nested a\n  - nested b\n"],
    ["task list", "- [ ] todo one\n- [x] done two\n"],
    ["ordered list", "1. alpha\n2. beta\n"],
    ["list among blocks", "# Title\n\nIntro.\n\n- alpha\n- beta\n\nAfter.\n"],
    ["blockquote", "> quoted para\n\nafter\n"],
    ["list in a blockquote", "> - a\n> - b\n"],
    ["table", "| a | b |\n|---|---|\n| c | d |\n"],
    ["item with marks", "- see **bold** and [link](https://e.test)\n"],
    ["heading then list", "## Section\n\n- one\n"],
  ];

  it.each(SHAPES)("%s — every offset lands in a real textblock", (_label, md) => {
    withDoc(md, (doc) => {
      const frag = doc.getXmlFragment("default");
      const flat = extractText(doc);
      for (let i = 0; i <= flat.length; i++) {
        const pos = resolveToTextblock(frag, toFlatOffset(i));
        expect(pos, `offset ${i} did not resolve`).not.toBeNull();
        const el = elementAtPath(frag, pos!.path);
        expect(el, `offset ${i} path ${pos!.path} does not name an element`).not.toBeNull();
        // A textblock, not a container — the whole point.
        expect(["paragraph", "heading", "codeBlock"]).toContain(el!.nodeName);
        // And the offset is addressable inside it.
        expect(pos!.textOffset).toBeGreaterThanOrEqual(0);
        expect(pos!.textOffset).toBeLessThanOrEqual(getElementTextLength(el!));
      }
    });
  });

  it.each(SHAPES)("%s — agrees with resolveToElement on top-level textblocks", (_label, md) => {
    // The two walkers must not drift where their domains overlap: when the
    // top-level node IS the textblock, the deep walk must report the same
    // element and the same offset within it.
    withDoc(md, (doc) => {
      const frag = doc.getXmlFragment("default");
      const flat = extractText(doc);
      for (let i = 0; i <= flat.length; i++) {
        const shallow = resolveToElement(frag, toFlatOffset(i));
        const deep = resolveToTextblock(frag, toFlatOffset(i));
        if (!shallow || !deep) continue;
        const top = frag.get(shallow.elementIndex);
        if (!(top instanceof Y.XmlElement)) continue;
        if (!["paragraph", "heading", "codeBlock"].includes(top.nodeName)) continue;
        expect(deep.path, `offset ${i}`).toEqual([shallow.elementIndex]);
        expect(deep.textOffset, `offset ${i}`).toBe(shallow.textOffset);
        expect(deep.clampedFromPrefix, `offset ${i}`).toBe(shallow.clampedFromPrefix);
      }
    });
  });

  it("reports a heading prefix only for a TOP-LEVEL heading", () => {
    // `extractTextWithBreaks` emits `"## "` in its own top-level loop; a nested
    // heading is traversed by `collectElementFlat`, which emits none. A resolver
    // that charged the prefix at depth would shift every later offset.
    withDoc("## Top\n\n- # Nested\n", (doc) => {
      const frag = doc.getXmlFragment("default");
      const flat = extractText(doc);
      expect(flat).toBe("## Top\nNested");
      // Offset 1 is inside the top-level "## " prefix.
      expect(resolveToTextblock(frag, toFlatOffset(1))?.clampedFromPrefix).toBe(true);
      // The nested heading's text starts immediately — no prefix to clamp from.
      const nestedAt = flat.indexOf("Nested");
      const pos = resolveToTextblock(frag, toFlatOffset(nestedAt));
      expect(pos?.clampedFromPrefix).toBe(false);
      expect(elementAtPath(frag, pos!.path)?.nodeName).toBe("heading");
    });
  });
});

describe("tandem_edit at depth (#1664 follow-on)", () => {
  it("rewords a list item", () => {
    expect(editText("- first item\n- second item\n- third\n", "second", "EDITED")).toBe(
      "- first item\n- EDITED item\n- third\n",
    );
  });

  it("rewords an item in a nested sublist", () => {
    expect(editText("- parent\n  - nested a\n  - nested b\n", "nested a", "EDITED")).toBe(
      "- parent\n  - EDITED\n  - nested b\n",
    );
  });

  it("rewords a task item and preserves its checkbox state", () => {
    expect(editText("- [ ] todo one\n- [x] done two\n", "todo one", "EDITED")).toBe(
      "- [ ] EDITED\n- [x] done two\n",
    );
  });

  it("rewords a blockquote paragraph", () => {
    expect(editText("> quoted text\n\npara\n", "quoted", "EDITED")).toBe("> EDITED text\n\npara\n");
  });

  it("rewords an ordered-list item", () => {
    expect(editText("1. alpha\n2. beta\n", "beta", "EDITED")).toBe("1. alpha\n2. EDITED\n");
  });

  it("edits inside a marked run exactly as it does at top level", () => {
    // Whatever tandem_edit's mark semantics are, depth must not change them.
    // Both of these are the pre-existing top-level behaviour, asserted at depth.
    expect(editText("- see **bold** here\n", "bold", "EDITED")).toBe("- see EDITED here\n");
    expect(editText("- see **bold** here\n", "bol", "X")).toBe("- see X**d** here\n");
    expect(editText("see **bold** here\n", "bol", "X")).toBe("see X**d** here\n");
  });

  it("refuses a range spanning two list items, leaving the document untouched", () => {
    // The corruption case. Two different items share a TOP-LEVEL index, so a
    // branch keyed on index equality would treat this as same-block and edit
    // with offsets measured against two different elements — inside the
    // transaction, which Y.js does not roll back.
    withDoc("- first item\n- second item\n", (doc) => {
      const before = saveMarkdown(doc);
      const flat = extractText(doc);
      const outcome = editOutcome(doc, flat.indexOf("item"), flat.indexOf("second") + 6, "X");
      expect(outcome).toBe("refused");
      expect(saveMarkdown(doc)).toBe(before);
    });
  });

  it("still takes the top-level cross-element path for two plain paragraphs", () => {
    withDoc("alpha\n\nbravo\n", (doc) => {
      const flat = extractText(doc);
      expect(editOutcome(doc, 1, flat.indexOf("bravo") + 2, "X")).toBe("top-level-cross");
    });
  });
});
