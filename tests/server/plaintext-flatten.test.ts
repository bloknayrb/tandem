/**
 * `flattenPlaintextBreaks` — the Save-As promotion half of #1460.
 *
 * Save-As promotes a document IN PLACE (same docId, same Y.Doc, same provider,
 * `format` swapped), so a `.md` scratchpad or an uploaded `.docx` holding a hard
 * break becomes a live `.txt` document still holding one. Neither client guard
 * covers it — nothing was typed or pasted, and the content was legitimate until
 * the destination changed under it.
 *
 * The property that makes this safe to run against a live document is that it is
 * BYTE-NEUTRAL: `extractText` renders a hard break and a block boundary
 * identically as `"\n"`. Every test here asserts the flat text is unchanged
 * alongside whatever else it checks, because that is the claim the annotation
 * safety argument rests on — if a change here ever moved a byte, an annotation's
 * flat-offset fallback would start pointing at the wrong characters, silently.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { flattenPlaintextBreaks } from "../../src/server/file-io/plaintext-flatten.js";
import { extractText, populateYDoc } from "../../src/server/mcp/document-model.js";
import { anchoredRange, refreshRange } from "../../src/server/positions.js";
import type { Annotation, FlatOffset } from "../../src/shared/types.js";

/** Build a fragment from a spec, attaching before populating throughout. */
function build(
  doc: Y.Doc,
  blocks: Array<{ name?: string; parts: Array<string | "break" | { bold: string }> }>,
): void {
  const fragment = doc.getXmlFragment("default");
  for (const { name = "paragraph", parts } of blocks) {
    const el = new Y.XmlElement(name);
    fragment.insert(fragment.length, [el]);
    let text: Y.XmlText | null = null;
    for (const part of parts) {
      if (part === "break") {
        // A SIBLING hardBreak element — the representation the markdown and
        // .docx importers produce via `normalizeHardBreaks`.
        el.insert(el.length, [new Y.XmlElement("hardBreak")]);
        text = null;
        continue;
      }
      if (!text) {
        text = new Y.XmlText();
        el.insert(el.length, [text]);
      }
      if (typeof part === "string") text.insert(text.length, part);
      else text.insert(text.length, part.bold, { bold: true });
    }
  }
}

function blockNames(doc: Y.Doc): string[] {
  const fragment = doc.getXmlFragment("default");
  const out: string[] = [];
  for (let i = 0; i < fragment.length; i += 1) {
    out.push((fragment.get(i) as Y.XmlElement).nodeName);
  }
  return out;
}

describe("flattenPlaintextBreaks", () => {
  it("splits a sibling hardBreak into two blocks without moving a byte", () => {
    const doc = new Y.Doc();
    try {
      build(doc, [{ parts: ["alpha", "break", "bravo"] }]);
      const before = extractText(doc);
      expect(before).toBe("alpha\nbravo");

      expect(flattenPlaintextBreaks(doc)).toBe(true);
      expect(extractText(doc), "byte-neutral").toBe(before);
      expect(doc.getXmlFragment("default").length).toBe(2);
    } finally {
      doc.destroy();
    }
  });

  it("splits a hardBreak EMBED inside the XmlText too", () => {
    // The second representation, and the one an inline importer produces. Both
    // render as "\n" in flat text, so handling only the sibling form would leave
    // the invariant broken for content that arrived the other way — and the two
    // routes are exactly the markdown and .docx importers Save-As promotes from.
    const doc = new Y.Doc();
    try {
      const fragment = doc.getXmlFragment("default");
      const p = new Y.XmlElement("paragraph");
      fragment.insert(0, [p]);
      const text = new Y.XmlText();
      p.insert(0, [text]);
      text.insert(0, "alpha");
      text.insertEmbed(5, new Y.XmlElement("hardBreak"));
      text.insert(6, "bravo");

      const before = extractText(doc);
      expect(before).toBe("alpha\nbravo");
      expect(flattenPlaintextBreaks(doc)).toBe(true);
      expect(extractText(doc), "byte-neutral").toBe(before);
      expect(fragment.length).toBe(2);
    } finally {
      doc.destroy();
    }
  });

  it("splits a LITERAL newline, the #1448 soft wrap", () => {
    const doc = new Y.Doc();
    try {
      build(doc, [{ parts: ["alpha\nbravo"] }]);
      const before = extractText(doc);
      expect(flattenPlaintextBreaks(doc)).toBe(true);
      expect(extractText(doc), "byte-neutral").toBe(before);
      expect(doc.getXmlFragment("default").length).toBe(2);
    } finally {
      doc.destroy();
    }
  });

  it("COLLAPSES a heading to spaces instead of splitting it", () => {
    // This test was written asserting the opposite — two headings — and the
    // byte-neutrality assertion beside it is what proved that wrong. `extractText`
    // runs heading text through `flattenHeadingText`, which maps a newline to a
    // SPACE so a heading never presents as multiple lines. So the bytes already
    // read `# one two`, and splitting would have written `# one\n# two`,
    // inventing a heading and a line that were never in the file.
    //
    // Collapsing reproduces what the bytes say, which is also what the next open
    // parses — the definition of not changing the document.
    const doc = new Y.Doc();
    try {
      build(doc, [{ name: "heading", parts: ["one", "break", "two"] }]);
      const before = extractText(doc);
      expect(before, "the newline was already a space on disk").toBe("# one two");

      expect(flattenPlaintextBreaks(doc)).toBe(true);
      expect(blockNames(doc), "still one heading").toEqual(["heading"]);
      expect(extractText(doc), "byte-neutral").toBe(before);
    } finally {
      doc.destroy();
    }
  });

  it("carries a heading's LEVEL onto the block it produces", () => {
    // Found by a throwaway probe, not by the assertions above, and it was a real
    // byte change: a fresh `Y.XmlElement("heading")` has no `level`, and
    // `collectElementFlat` reads `level` to choose the `#` run — so `## Title`
    // came back `# Title`. Demoting a heading is precisely the class of
    // unrequested change this whole function exists to remove.
    const doc = new Y.Doc();
    try {
      const fragment = doc.getXmlFragment("default");
      const h = new Y.XmlElement("heading");
      h.setAttribute("level", 2 as never);
      fragment.insert(0, [h]);
      const text = new Y.XmlText();
      h.insert(0, [text]);
      text.insert(0, "one");
      text.insertEmbed(3, new Y.XmlElement("hardBreak"));
      text.insert(4, "two");

      const before = extractText(doc);
      expect(before).toBe("## one two");
      expect(flattenPlaintextBreaks(doc)).toBe(true);
      expect(extractText(doc), "byte-neutral").toBe(before);
      expect((fragment.get(0) as Y.XmlElement).getAttribute("level")).toBe(2);
    } finally {
      doc.destroy();
    }
  });

  it("carries a paragraph's attributes onto EVERY block it produces", () => {
    // A split makes N blocks from one, so "attributes survive" is not enough —
    // they have to survive on all of them, or the second line silently loses its
    // alignment.
    const doc = new Y.Doc();
    try {
      const fragment = doc.getXmlFragment("default");
      const p = new Y.XmlElement("paragraph");
      p.setAttribute("textAlign", "center");
      fragment.insert(0, [p]);
      const text = new Y.XmlText();
      p.insert(0, [text]);
      text.insert(0, "a\nb");

      expect(flattenPlaintextBreaks(doc)).toBe(true);
      expect(fragment.length).toBe(2);
      for (let i = 0; i < fragment.length; i += 1) {
        expect((fragment.get(i) as Y.XmlElement).getAttribute("textAlign"), `block ${i}`).toBe(
          "center",
        );
      }
    } finally {
      doc.destroy();
    }
  });

  it("does NOT carry a verbatim-markdown marker onto the split blocks", () => {
    // The one attribute class deliberately dropped. `markdownRaw` marks a
    // paragraph as verbatim markdown source (a footnote definition, raw HTML,
    // frontmatter). The construct does not exist in a plaintext document, and
    // copying the marker onto each produced block would show N metadata blocks in
    // the editor where there was one. Bytes are unaffected either way — the txt
    // adapter reads no attributes — so only this assertion pins the choice.
    const doc = new Y.Doc();
    try {
      const fragment = doc.getXmlFragment("default");
      const p = new Y.XmlElement("paragraph");
      p.setAttribute("markdownRaw", "true");
      p.setAttribute("markdownFrontmatter", "true");
      fragment.insert(0, [p]);
      const text = new Y.XmlText();
      p.insert(0, [text]);
      text.insert(0, "title: X\ntags: [a]");

      const before = extractText(doc);
      expect(flattenPlaintextBreaks(doc)).toBe(true);
      expect(extractText(doc), "byte-neutral").toBe(before);
      for (let i = 0; i < fragment.length; i += 1) {
        const el = fragment.get(i) as Y.XmlElement;
        expect(el.getAttribute("markdownRaw"), `block ${i}`).toBeUndefined();
        expect(el.getAttribute("markdownFrontmatter"), `block ${i}`).toBeUndefined();
      }
    } finally {
      doc.destroy();
    }
  });

  it("handles a leading, trailing or lone break", () => {
    // Edge shapes where one of the produced blocks is empty. `lines` has an entry
    // for the empty half, and dropping it would delete a line the file has.
    for (const input of ["\nb", "a\n", "\n"]) {
      const doc = new Y.Doc();
      try {
        build(doc, [{ parts: [input] }]);
        const before = extractText(doc);
        expect(flattenPlaintextBreaks(doc)).toBe(true);
        expect(extractText(doc), `byte-neutral for ${JSON.stringify(input)}`).toBe(before);
        expect(doc.getXmlFragment("default").length).toBe(2);
      } finally {
        doc.destroy();
      }
    }
  });

  it("flattens two blocks in one pass without shifting the other's index", () => {
    // The reverse-order mutation loop: each replacement inserts a DIFFERENT number
    // of elements than it deleted, so an ascending walk would corrupt the second
    // block's index. Two blocks each needing a different number of splits is the
    // shape that discriminates.
    const doc = new Y.Doc();
    try {
      build(doc, [{ parts: ["a\nb\nc"] }, { parts: ["d\ne"] }]);
      const before = extractText(doc);
      expect(before).toBe("a\nb\nc\nd\ne");
      expect(flattenPlaintextBreaks(doc)).toBe(true);
      expect(extractText(doc), "byte-neutral").toBe(before);
      expect(doc.getXmlFragment("default").length).toBe(5);
    } finally {
      doc.destroy();
    }
  });

  it("a collapsed heading round-trips through save and reopen", () => {
    const doc = new Y.Doc();
    const reopened = new Y.Doc();
    try {
      build(doc, [{ name: "heading", parts: ["one", "break", "two"] }]);
      flattenPlaintextBreaks(doc);
      const bytes = extractText(doc);

      populateYDoc(reopened, bytes);
      expect(extractText(reopened)).toBe(bytes);
      expect(blockNames(reopened)).toEqual(["heading"]);
    } finally {
      doc.destroy();
      reopened.destroy();
    }
  });

  it("carries marks across the split instead of flattening them", () => {
    // Bold in a `.txt` document is already doomed at save. Destroying it HERE
    // would be a second, unrelated loss inflicted at promotion, visible
    // immediately and buying nothing.
    const doc = new Y.Doc();
    try {
      build(doc, [{ parts: [{ bold: "alpha" }, "break", { bold: "bravo" }] }]);
      expect(flattenPlaintextBreaks(doc)).toBe(true);

      const fragment = doc.getXmlFragment("default");
      for (let i = 0; i < fragment.length; i += 1) {
        const text = (fragment.get(i) as Y.XmlElement).get(0) as Y.XmlText;
        const delta = text.toDelta() as Array<{ attributes?: Record<string, unknown> }>;
        expect(delta[0]?.attributes?.bold, `block ${i} kept its bold`).toBe(true);
      }
    } finally {
      doc.destroy();
    }
  });

  it("preserves an empty line rather than dropping it", () => {
    // Two consecutive breaks are three lines. Collapsing would lose one, and the
    // byte assertion is what catches that.
    const doc = new Y.Doc();
    try {
      build(doc, [{ parts: ["a", "break", "break", "b"] }]);
      const before = extractText(doc);
      expect(before).toBe("a\n\nb");
      expect(flattenPlaintextBreaks(doc)).toBe(true);
      expect(extractText(doc), "byte-neutral").toBe(before);
      expect(doc.getXmlFragment("default").length).toBe(3);
    } finally {
      doc.destroy();
    }
  });

  it("is a no-op — and reports so — when there is nothing to split", () => {
    // Load-bearing: a write here would re-dirty the document and arm another
    // autosave on every promotion of already-flat content.
    const doc = new Y.Doc();
    try {
      populateYDoc(doc, "alpha\nbravo\n");
      const before = extractText(doc);
      const blocks = doc.getXmlFragment("default").length;

      expect(flattenPlaintextBreaks(doc)).toBe(false);
      expect(extractText(doc)).toBe(before);
      expect(doc.getXmlFragment("default").length).toBe(blocks);
    } finally {
      doc.destroy();
    }
  });

  it("splits a codeBlock into code blocks — it is not exempt", () => {
    // This test asserted the OPPOSITE, on the argument that a newline in a code
    // block is genuinely a newline and splitting would shred it. Right for
    // markdown, irrelevant here: `collectElementFlat` emits a code block's text
    // with NO fences, so a two-line code block already writes two lines and the
    // reopen already parses two paragraphs. Excluding it left the divergence in
    // place for exactly the content most likely to be multi-line. Found in review.
    //
    // Split into blocks of the SAME type, so the monospace display survives until
    // the reload that was always going to take it.
    const doc = new Y.Doc();
    try {
      build(doc, [{ name: "codeBlock", parts: ["line one\nline two"] }]);
      const before = extractText(doc);
      expect(before, "no fences in the flat projection").toBe("line one\nline two");

      expect(flattenPlaintextBreaks(doc)).toBe(true);
      expect(extractText(doc), "byte-neutral").toBe(before);
      expect(blockNames(doc)).toEqual(["codeBlock", "codeBlock"]);
    } finally {
      doc.destroy();
    }
  });

  it("reports a break it cannot fix instead of implying it did", () => {
    // A nested container returns `null`, and the boolean plus the call-site comment
    // otherwise read as "the invariant now holds" for a document where it does not.
    // Nothing here can make it hold — `populateYDoc` cannot rebuild a list from
    // flat text — so the honest move is to say so. Found in review.
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    const doc = new Y.Doc();
    try {
      const fragment = doc.getXmlFragment("default");
      const list = new Y.XmlElement("bulletList");
      fragment.insert(0, [list]);
      const item = new Y.XmlElement("listItem");
      list.insert(0, [item]);
      const p = new Y.XmlElement("paragraph");
      item.insert(0, [p]);
      const text = new Y.XmlText();
      p.insert(0, [text]);
      text.insert(0, "a\nb");

      expect(flattenPlaintextBreaks(doc)).toBe(false);
      expect(warnings.join(" ")).toContain("bulletList");
    } finally {
      console.warn = original;
      doc.destroy();
    }
  });

  it("says nothing when a nested container holds NO break", () => {
    // The control for the warning above: a list without a break is not a skip
    // worth reporting, and a warning on every promotion of every list would be
    // noise that trains the reader to ignore the real one.
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    const doc = new Y.Doc();
    try {
      const fragment = doc.getXmlFragment("default");
      const list = new Y.XmlElement("bulletList");
      fragment.insert(0, [list]);
      const item = new Y.XmlElement("listItem");
      list.insert(0, [item]);
      const p = new Y.XmlElement("paragraph");
      item.insert(0, [p]);
      const text = new Y.XmlText();
      p.insert(0, [text]);
      text.insert(0, "no break here");

      expect(flattenPlaintextBreaks(doc)).toBe(false);
      expect(warnings).toEqual([]);
    } finally {
      console.warn = original;
      doc.destroy();
    }
  });

  it("splits on a bare CR and on CRLF, not only on LF", () => {
    // `restoreLineEndings` runs `toLf` first, so all three reach the file as a
    // break. The other four guards in this fix match `[\r\n]`; this one matched
    // only `\n`, which is three notions of "line break" in one change. Found in
    // review — latent rather than demonstrated, since both loaders normalize.
    for (const input of ["a\r\nb", "a\rb"]) {
      const doc = new Y.Doc();
      try {
        build(doc, [{ parts: [input] }]);
        expect(flattenPlaintextBreaks(doc), input).toBe(true);
        expect(doc.getXmlFragment("default").length, input).toBe(2);
      } finally {
        doc.destroy();
      }
    }
  });

  it("leaves a nested container alone", () => {
    // Out of scope: `populateYDoc` cannot rebuild a list from flat text at all,
    // so such a document already loses the structure on reload. Splitting inside
    // one would neither fix that nor worsen it.
    const doc = new Y.Doc();
    try {
      const fragment = doc.getXmlFragment("default");
      const list = new Y.XmlElement("bulletList");
      fragment.insert(0, [list]);
      const item = new Y.XmlElement("listItem");
      list.insert(0, [item]);
      const p = new Y.XmlElement("paragraph");
      item.insert(0, [p]);
      const text = new Y.XmlText();
      p.insert(0, [text]);
      text.insert(0, "a\nb");

      expect(flattenPlaintextBreaks(doc)).toBe(false);
      expect(blockNames(doc)).toEqual(["bulletList"]);
    } finally {
      doc.destroy();
    }
  });

  it("makes the document survive a save/reopen round-trip unchanged", () => {
    // The whole point, end to end. Before flattening, one block reopens as two;
    // after, the block count is stable — with identical bytes on both sides.
    const doc = new Y.Doc();
    const reopened = new Y.Doc();
    try {
      build(doc, [{ parts: ["alpha", "break", "bravo"] }, { parts: ["charlie"] }]);

      flattenPlaintextBreaks(doc);
      const bytes = extractText(doc);
      const blocks = doc.getXmlFragment("default").length;

      populateYDoc(reopened, bytes);
      expect(extractText(reopened), "bytes round-trip").toBe(bytes);
      expect(reopened.getXmlFragment("default").length, "structure round-trips").toBe(blocks);
    } finally {
      doc.destroy();
      reopened.destroy();
    }
  });

  it("an annotation still covers the same characters after the flatten", () => {
    // THE test this file was missing, and the one the whole safety argument rests
    // on. The docstring claims the flatten is safe against a live document because
    // when the split kills a `relRange`, `refreshRange` re-anchors from the stored
    // FLAT offsets and byte-neutrality makes those still correct. That was verified
    // by hand and then not written down — so a future change to `refreshRange`, or
    // to which node the flatten replaces, would break annotation anchoring with
    // every other assertion here green. Found in review.
    //
    // Note what is NOT asserted: that the `relRange` survives. It does not, and it
    // is not supposed to — the CRDT items it names are deleted. The claim is that
    // the recovery path lands in the right place.
    const doc = new Y.Doc();
    try {
      build(doc, [{ parts: ["alpha", "break", "bravo charlie"] }]);
      const flat = extractText(doc);
      expect(flat).toBe("alpha\nbravo charlie");

      // "bravo" — on the far side of the break, so the split moves the CRDT items
      // under it. Offsets 6..11.
      const anchored = anchoredRange(doc, 6 as FlatOffset, 11 as FlatOffset, "bravo");
      expect(anchored.ok, "fixture anchors").toBe(true);
      if (!anchored.ok) return;
      const ann = {
        id: "a1",
        type: "highlight",
        author: "user",
        status: "pending",
        text: "",
        createdAt: 0,
        range: { from: 6, to: 11 },
        relRange: anchored.relRange,
      } as unknown as Annotation;

      expect(flattenPlaintextBreaks(doc)).toBe(true);

      const refreshed = refreshRange(ann, doc);
      expect(refreshed.kind, "the relRange died and the flat fallback recovered").toBe("repaired");
      const { from, to } = refreshed.annotation.range;
      expect(extractText(doc).slice(from, to), "still on the same word").toBe("bravo");
    } finally {
      doc.destroy();
    }
  });

  it("WITHOUT flattening, the same document diverges — the defect itself", () => {
    // The discriminating case. Without it, every assertion above could pass with
    // the function doing nothing useful and nobody would learn anything.
    const doc = new Y.Doc();
    const reopened = new Y.Doc();
    try {
      build(doc, [{ parts: ["alpha", "break", "bravo"] }, { parts: ["charlie"] }]);
      const bytes = extractText(doc);
      expect(doc.getXmlFragment("default").length).toBe(2);

      populateYDoc(reopened, bytes);
      expect(extractText(reopened), "bytes are fine, they always were").toBe(bytes);
      expect(reopened.getXmlFragment("default").length, "structure is not").toBe(3);
    } finally {
      doc.destroy();
      reopened.destroy();
    }
  });
});
