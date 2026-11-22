import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { exportYDocToDocx } from "../../src/server/file-io/docx-export.js";
import { loadMarkdown, saveMarkdown } from "../../src/server/file-io/markdown.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { registerDocumentTools } from "../../src/server/mcp/document.js";
import { extractText, replaceFlatRangeInElement } from "../../src/server/mcp/document-model.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { FOOTNOTE_REF_MARK, RAW_MARKDOWN_MARK } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { ownershipTestDispatch } from "../helpers/ownership-caller.js";

/**
 * #1823: the marks `tandem_edit` gives its new text.
 *
 * Before, the text took whatever Yjs had open at the insert point. Beside a
 * `rawMarkdown` run that made it raw, and a raw run is emitted UNESCAPED on save —
 * so `*x*` typed after a footnote ref came back as emphasis. The rule now is
 * ProseMirror's: `marksAcross` for a replacement (the client's Accept rule),
 * `$pos.marks()` for a point insert, with `rawMarkdown` and `footnote-ref`
 * non-inclusive. `tests/client/edit-mark-parity.test.ts` pins the parity with the
 * real editor schema; this file pins the server's answers through the real tool.
 */

let client: Client;
let close: (() => Promise<void>) | undefined;
const registered: string[] = [];
let seq = 0;

function setupMd(md: string): Y.Doc {
  const id = `edit-marks-${++seq}`;
  const ydoc = getOrCreateDocument(id);
  withInternal(ydoc, () => loadMarkdown(ydoc, md));
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  setActiveDocId(id);
  registered.push(id);
  return ydoc;
}

async function edit(from: number, to: number, newText: string) {
  const res = parseResult(
    await client.callTool({ name: "tandem_edit", arguments: { from, to, newText } }),
  );
  expect(res.error, JSON.stringify(res)).not.toBe(true);
  return res;
}

/** Point-insert `text` at the flat offset just after `anchor`'s first occurrence. */
async function insertAfter(ydoc: Y.Doc, anchor: string, text: string): Promise<string> {
  const at = extractText(ydoc).indexOf(anchor);
  expect(at, `fixture must contain ${JSON.stringify(anchor)}`).toBeGreaterThanOrEqual(0);
  await edit(at + anchor.length, at + anchor.length, text);
  return saveMarkdown(ydoc);
}

/** Replace the first occurrence of `target` with `text`. */
async function replace(ydoc: Y.Doc, target: string, text: string): Promise<string> {
  const at = extractText(ydoc).indexOf(target);
  expect(at, `fixture must contain ${JSON.stringify(target)}`).toBeGreaterThanOrEqual(0);
  await edit(at, at + target.length, text);
  return saveMarkdown(ydoc);
}

describe("tandem_edit mark inheritance (#1823)", () => {
  beforeEach(async () => {
    ({ client, close } = await setupMcpServer([registerDocumentTools, registerAnnotationTools], {
      dispatch: ownershipTestDispatch,
    }));
  });

  afterEach(async () => {
    for (const id of registered.splice(0)) removeDoc(id);
    await close?.();
    close = undefined;
  });

  describe("raw markdown runs are non-inclusive", () => {
    const FOOTNOTE = "see[^1] after\n\n[^1]: the note\n";

    it("text inserted at a raw run's end is plain and escaped on save", async () => {
      const out = await insertAfter(setupMd(FOOTNOTE), "see[^1]", "*x*");
      expect(out).toContain("see[^1]\\*x\\* after");
    });

    it("text inserted at block offset 0, before a raw run, is plain", async () => {
      // PM's `if (!main)` swap: the right-hand char decides, with no `other` side,
      // so the non-inclusive raw mark drops.
      const out = await insertAfter(setupMd("[^1] after\n\n[^1]: the note\n"), "", "*x*");
      expect(out).toContain("\\*x\\*[^1] after");
    });

    it("an edit inside a raw run keeps it raw", async () => {
      // First replaced char `1` and the char at `to`, `]`, are both raw.
      const out = await replace(setupMd(FOOTNOTE), "1", "12");
      expect(out).toContain("see[^12] after");
    });

    it("replacing a whole raw run gives plain, escaped text (Accept's rule too)", async () => {
      // `marksAcross`: the char at `to` (a space) does not continue the raw mark.
      const out = await replace(setupMd(FOOTNOTE), "[^1]", "*x*");
      expect(out).toContain("see\\*x\\* after");
    });

    it("KNOWN EXCEPTION: the seam between two adjacent raw runs stays raw", async () => {
      // Every raw run carries an equal `{}`, so Yjs and ProseMirror alike read
      // `[^1][^2]` as ONE run and an insert at the seam is inside it. Closing this
      // would need a per-run attribute; documented in NON_INCLUSIVE_MARKS' rule.
      const md = "see[^1][^2] after\n\n[^1]: one\n\n[^2]: two\n";
      const out = await insertAfter(setupMd(md), "see[^1]", "*x*");
      expect(out).toContain("see[^1]*x*[^2] after");
    });
  });

  describe("links and bold stay inclusive, as in the editor", () => {
    it("rewording a whole link keeps the link", async () => {
      const out = await replace(setupMd("see [link](https://x.test) after\n"), "link", "LINK");
      expect(out).toContain("[LINK](https://x.test)");
    });

    it("an insert inside a link keeps it one link", async () => {
      const out = await insertAfter(setupMd("see [link](https://x.test) after\n"), "li", "X");
      expect(out).toContain("[liXnk](https://x.test)");
    });

    it("an insert at a link's end extends it, the same as typing", async () => {
      const out = await insertAfter(setupMd("see [link](https://x.test) after\n"), "link", "X");
      expect(out).toContain("[linkX](https://x.test)");
    });

    it("a replacement starting in bold takes bold (marksAcross: first char)", async () => {
      const out = await replace(setupMd("see **bo**ld after\n"), "bold", "X");
      expect(out).toContain("see **X** after");
    });

    it("an insert at the end of bold continues bold", async () => {
      const out = await insertAfter(setupMd("see **bold** after\n"), "bold", "X");
      expect(out).toContain("**boldX**");
    });
  });

  describe("hard breaks count as a character with no marks", () => {
    it("an insert right after a break takes no marks from the bold text to its right", async () => {
      const ydoc = setupMd("line\\\n**bold** tail\n");
      const at = extractText(ydoc).indexOf("bold");
      await edit(at, at, "X");
      expect(saveMarkdown(ydoc)).toContain("X**bold**");
    });

    it("a raw run ending at a break does not extend past it", async () => {
      // Insert just before the break: left char raw, right char the break → plain.
      const ydoc = setupMd("see[^1]\\\nnext\n\n[^1]: the note\n");
      const out = await insertAfter(ydoc, "see[^1]", "*x*");
      expect(out).toContain("see[^1]\\*x\\*");
    });
  });

  describe("annotation anchors across a marked replacement", () => {
    it("an annotation overlapping a reworded link keeps its far end and its text", async () => {
      // Keeping the link makes yjs step past the deleted characters to stay inside
      // the link's format span, which could move an endpoint anchored on one of
      // them. Measured before and after #1823: the span is the same either way —
      // the start grows to cover the whole rewritten word. Pinned so a change shows.
      const ydoc = setupMd("see [link](https://x.test) after\n");
      const flat = extractText(ydoc);
      const from = flat.indexOf("nk");
      const to = flat.indexOf("after") + 3;
      const created = parseResult(
        await client.callTool({
          name: "tandem_comment",
          arguments: { from, to, text: "spans the link's tail" },
        }),
      );
      expect(created.error, JSON.stringify(created)).not.toBe(true);
      await replace(ydoc, "link", "LINK");
      const listed = parseResult(
        await client.callTool({ name: "tandem_getAnnotations", arguments: {} }),
      );
      const ann = (listed.data?.annotations ?? listed.data) as Array<{
        range: { from: number; to: number };
        anchor?: string;
      }>;
      const after = extractText(ydoc);
      expect(after).toBe("see LINK after");
      expect(ann).toHaveLength(1);
      expect(ann[0].anchor).toBeUndefined();
      expect(after.slice(ann[0].range.from, ann[0].range.to)).toBe("LINK aft");
    });
  });

  describe("cross-block replace", () => {
    it("takes the first replaced character's marks", async () => {
      const ydoc = setupMd("**alpha** one\n\ntwo end\n");
      const flat = extractText(ydoc);
      await edit(flat.indexOf("pha"), flat.indexOf("two") + 2, "X");
      expect(saveMarkdown(ydoc)).toContain("**alX**o end");
    });

    it("starting on the block separator takes no marks", async () => {
      const ydoc = setupMd("**alpha**\n\n**two** end\n");
      const flat = extractText(ydoc);
      const sep = flat.indexOf("\n");
      await edit(sep, flat.indexOf("two") + 3, "X");
      expect(saveMarkdown(ydoc)).toContain("**alpha**X end");
    });

    it("drops a raw mark when the range ends at the end of the last block", async () => {
      const ydoc = setupMd("see[^1]\n\nend\n\n[^1]: the note\n");
      const flat = extractText(ydoc);
      await edit(flat.indexOf("[^1]"), flat.indexOf("end") + 3, "*x*");
      expect(saveMarkdown(ydoc)).toContain("see\\*x\\*");
    });
  });
});

describe("footnote-ref is non-inclusive (#1823, .docx path)", () => {
  function footnoteDoc(): { doc: Y.Doc; p: Y.XmlElement } {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    withInternal(doc, () => {
      fragment.insert(0, [p]);
      const t = new Y.XmlText();
      p.insert(0, [t]);
      t.insert(0, "see");
      t.insert(3, "[1]", { [FOOTNOTE_REF_MARK]: { id: "1", kind: "footnote" } });
      t.insert(6, " after", { [FOOTNOTE_REF_MARK]: null });
    });
    return { doc, p };
  }

  it("text inserted after a footnote marker does not join it", async () => {
    const { doc, p } = footnoteDoc();
    withInternal(doc, () => replaceFlatRangeInElement(p, 6, 6, "X"));
    const delta = (p.get(0) as Y.XmlText).toDelta() as Array<{
      insert: string;
      attributes?: Record<string, unknown>;
    }>;
    const x = delta.find((d) => d.insert.startsWith("X"));
    expect(x?.attributes?.[FOOTNOTE_REF_MARK]).toBeUndefined();

    // The export turns each footnote-ref run into a `<w:footnoteReference>`, so a
    // joined `X` would vanish into the reference instead of reaching the body.
    const zip = await JSZip.loadAsync(await exportYDocToDocx(doc));
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toMatch(/>X after</);
    doc.destroy();
  });

  it("an edit inside the marker keeps it a marker", () => {
    const { doc, p } = footnoteDoc();
    withInternal(doc, () => replaceFlatRangeInElement(p, 4, 5, "2"));
    const delta = (p.get(0) as Y.XmlText).toDelta() as Array<{
      insert: string;
      attributes?: Record<string, unknown>;
    }>;
    expect(delta.find((d) => d.insert === "[2]")?.attributes?.[FOOTNOTE_REF_MARK]).toEqual({
      id: "1",
      kind: "footnote",
    });
    doc.destroy();
  });

  it("RAW_MARKDOWN_MARK is the key the markdown loader writes", () => {
    const doc = new Y.Doc();
    loadMarkdown(doc, "see[^1]\n\n[^1]: n\n");
    const p = doc.getXmlFragment("default").get(0) as Y.XmlElement;
    const delta = (p.get(0) as Y.XmlText).toDelta() as Array<{
      insert: string;
      attributes?: Record<string, unknown>;
    }>;
    expect(delta.find((d) => d.insert === "[^1]")?.attributes).toHaveProperty(RAW_MARKDOWN_MARK);
    doc.destroy();
  });
});
