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

  it("leaves a codeBlock alone", () => {
    // `code: true` — a newline in there is genuinely a newline, and the block is
    // already stored as one XmlText full of them. Splitting would shred it.
    const doc = new Y.Doc();
    try {
      build(doc, [{ name: "codeBlock", parts: ["line one\nline two"] }]);
      expect(flattenPlaintextBreaks(doc)).toBe(false);
      expect(blockNames(doc)).toEqual(["codeBlock"]);
    } finally {
      doc.destroy();
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
