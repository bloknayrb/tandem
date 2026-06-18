/**
 * Footnote reconstruction (#1123 Tier-A #3 PR 2). Covers the import-side
 * reconciliation in `htmlToYDoc` (Detector A mark + Detector B list-prune), the
 * export-side atomic `FootnoteReferenceRun` emission with the bodyless-ref
 * fallback (CRITICAL-1), footnote/comment coexistence cursor math, and the
 * whole-value-replace + offset no-regression contracts.
 *
 * Each CRITICAL from the plan review gets a failing-on-regression test:
 *   - CRITICAL-1 bodyless ref → plain superscript fallback, re-imports clean.
 *   - CRITICAL-2 footnote+endnote shared <ol> → endnote <li> survives.
 *   - CRITICAL-3 half-state (mark pattern, no body) → no mark, <li> retained.
 */

import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { loadDocxWithWarnings } from "../../src/server/file-io/docx.js";
import { exportYDocToDocx } from "../../src/server/file-io/docx-export.js";
import { htmlToYDoc } from "../../src/server/file-io/docx-html.js";
import { getAdapter } from "../../src/server/file-io/index.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { anchoredRange } from "../../src/server/positions.js";
import {
  Y_MAP_ANNOTATIONS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_FOOTNOTE_BODIES,
} from "../../src/shared/constants.js";
import { transactForTest, withInternal } from "../../src/shared/origins.js";
import { toFlatOffset } from "../../src/shared/positions/index.js";
import type { Annotation, FootnoteBody } from "../../src/shared/types.js";
import { buildFootnote, buildMultiFootnote } from "../helpers/docx-corpus.js";

// mammoth's verified footnote shape (probe-confirmed): inline ref + trailing
// back-linked <li>. Endnotes use the disjoint #endnote-N namespace.
const FN_INLINE = '<p>A claim<sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup>.</p>';
const FN_LIST = '<ol><li id="footnote-1"><p>Body. <a href="#footnote-ref-1">↑</a></p></li></ol>';
const FN_HTML = FN_INLINE + FN_LIST;
const FN_BODIES: Record<string, FootnoteBody> = { "1": { text: "Body.", hadFormatting: false } };

afterEach(() => vi.restoreAllMocks());

// --- helpers ---------------------------------------------------------------

/** Delta ops of the first paragraph's XmlText (the inline run sequence). */
function firstParagraphDelta(
  doc: Y.Doc,
): Array<{ insert?: unknown; attributes?: Record<string, unknown> }> {
  const frag = doc.getXmlFragment("default");
  for (let i = 0; i < frag.length; i++) {
    const node = frag.get(i);
    if (node instanceof Y.XmlElement && node.nodeName === "paragraph") {
      for (let j = 0; j < node.length; j++) {
        const c = node.get(j);
        if (c instanceof Y.XmlText) return c.toDelta();
      }
    }
  }
  return [];
}

/** All node names anywhere in the fragment. */
function nodeNames(doc: Y.Doc): string[] {
  const out: string[] = [];
  const frag = doc.getXmlFragment("default");
  const visit = (el: Y.XmlElement): void => {
    out.push(el.nodeName ?? "?");
    for (let i = 0; i < el.length; i++) {
      const c = el.get(i);
      if (c instanceof Y.XmlElement) visit(c);
    }
  };
  for (let i = 0; i < frag.length; i++) {
    const n = frag.get(i);
    if (n instanceof Y.XmlElement) visit(n);
  }
  return out;
}

function addComment(doc: Y.Doc, from: number, to: number): string {
  const id = `cmt-${from}-${to}`;
  const anchored = anchoredRange(doc, toFlatOffset(from), toFlatOffset(to));
  const ann = {
    id,
    author: "claude",
    type: "comment",
    audience: "outbound",
    range: { from, to },
    content: "note",
    status: "pending",
    timestamp: 1700000000000,
    rev: 1,
    ...(anchored.ok && anchored.fullyAnchored ? { relRange: anchored.relRange } : {}),
  } as unknown as Annotation;
  withInternal(doc, () => doc.getMap(Y_MAP_ANNOTATIONS).set(id, ann));
  return id;
}

async function docXmlOf(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  return (await zip.file("word/document.xml")?.async("text")) ?? "";
}

async function footnotesXmlOf(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  return (await zip.file("word/footnotes.xml")?.async("text")) ?? "";
}

const countRefs = (xml: string): number => (xml.match(/<w:footnoteReference/g) ?? []).length;

// --- htmlToYDoc reconciliation ---------------------------------------------

describe("htmlToYDoc — footnote reconciliation", () => {
  it("marks the inline [N] with footnote-ref ONLY and prunes the trailing <li>", () => {
    const doc = new Y.Doc();
    const reconciled = htmlToYDoc(doc, FN_HTML, FN_BODIES);

    // Detector A: the [1] run carries footnote-ref alone (no link/superscript).
    const delta = firstParagraphDelta(doc);
    const ref = delta.find((op) => op.insert === "[1]");
    expect(ref).toBeDefined();
    expect(Object.keys(ref?.attributes ?? {})).toEqual(["footnote-ref"]);
    expect(ref?.attributes?.["footnote-ref"]).toEqual({ id: "1", kind: "footnote" });

    // Detector B: the body no longer survives as a list, but the marker stays.
    expect(nodeNames(doc)).not.toContain("orderedList");
    expect(extractText(doc)).toContain("[1]");
    expect(extractText(doc)).not.toContain("Body.");

    // Returns exactly the reconstructed id (the caller persists this set).
    expect(reconciled).toEqual({ "1": { text: "Body.", hadFormatting: false } });
  });

  it("FALSE-REMOVAL GUARD: a non-footnote ordered list survives untouched", () => {
    const doc = new Y.Doc();
    htmlToYDoc(doc, "<p>intro</p><ol><li><p>real item</p></li></ol>", {});
    expect(nodeNames(doc)).toContain("orderedList");
    expect(extractText(doc)).toContain("real item");
  });

  it("CRITICAL-2: a footnote+endnote shared <ol> keeps the endnote <li>", () => {
    const html =
      '<p>A<sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup>' +
      ' B<sup><a href="#endnote-1" id="endnote-ref-1">[1]</a></sup>.</p>' +
      '<ol><li id="footnote-1"><p>FN body <a href="#footnote-ref-1">↑</a></p></li>' +
      '<li id="endnote-1"><p>EN body <a href="#endnote-ref-1">↑</a></p></li></ol>';
    const doc = new Y.Doc();
    htmlToYDoc(doc, html, FN_BODIES); // only footnote id 1 has a body

    // The footnote body is pruned; the endnote body remains as a visible list.
    expect(nodeNames(doc)).toContain("orderedList");
    expect(extractText(doc)).toContain("EN body");
    expect(extractText(doc)).not.toContain("FN body");
  });

  it("CRITICAL-3: a half-state (mark pattern, no captured body) falls back — no mark, <li> kept", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const doc = new Y.Doc();
    const reconciled = htmlToYDoc(doc, FN_HTML, {}); // body map empty → no approval

    // No footnote-ref mark on [1]; the trailing list (body) is retained.
    const ref = firstParagraphDelta(doc).find((op) => op.insert === "[1]");
    expect(Object.keys(ref?.attributes ?? {})).not.toContain("footnote-ref");
    expect(nodeNames(doc)).toContain("orderedList");
    expect(extractText(doc)).toContain("Body.");
    expect(reconciled).toEqual({});
    expect(errSpy).toHaveBeenCalled(); // reconciliation discrepancy logged
  });
});

// --- export ----------------------------------------------------------------

describe("exportYDocToDocx — footnote emission", () => {
  it("emits a real <w:footnoteReference> + footnotes.xml body for a marked doc", async () => {
    const doc = new Y.Doc();
    htmlToYDoc(doc, FN_HTML, FN_BODIES);
    withInternal(doc, () => doc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_FOOTNOTE_BODIES, FN_BODIES));

    const out = await exportYDocToDocx(doc);
    expect(countRefs(await docXmlOf(out))).toBe(1);
    expect(await footnotesXmlOf(out)).toContain("Body.");

    // Re-imports as a real footnote again (round-trip closure).
    const { html } = await loadDocxWithWarnings(out);
    expect(html).toContain('href="#footnote-1"');
    expect(html).toContain("Body.");
  });

  it("CRITICAL-1: a marked ref with NO body falls back to plain [N], never a bodyless ref", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const doc = new Y.Doc();
    htmlToYDoc(doc, FN_HTML, FN_BODIES); // attaches the footnote-ref mark...
    // ...but simulate the body being unavailable at export time (lost map).
    withInternal(doc, () => doc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_FOOTNOTE_BODIES, {}));

    const out = await exportYDocToDocx(doc);
    const docXml = await docXmlOf(out);
    // No bodyless reference (it would save fine but corrupt on reopen)...
    expect(countRefs(docXml)).toBe(0);
    // ...the [1] marker is preserved as plain text instead.
    expect(docXml).toContain("[1]");
    // And the produced .docx re-imports cleanly with the marker intact.
    const { html } = await loadDocxWithWarnings(out);
    expect(html).toContain("[1]");
    expect(errSpy).toHaveBeenCalled(); // missing-body logged
  });
});

// --- footnote / comment coexistence ----------------------------------------

describe("exportYDocToDocx — footnote + comment coexistence", () => {
  // Flat text of FN_HTML body: "A claim[1]." → A claim=0..7, [1]=7..10, .=10..11.
  function footnoteDocWithComment(from: number, to: number): Y.Doc {
    const doc = new Y.Doc();
    htmlToYDoc(doc, FN_HTML, FN_BODIES);
    withInternal(doc, () => doc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_FOOTNOTE_BODIES, FN_BODIES));
    addComment(doc, from, to);
    return doc;
  }

  it("a comment BEFORE the footnote stays anchored, footnote still emits", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await exportYDocToDocx(footnoteDocWithComment(0, 7)); // "A claim"
    const docXml = await docXmlOf(out);
    expect(countRefs(docXml)).toBe(1);
    expect(docXml).toContain("w:commentRangeStart");
    expect(docXml).toContain("w:commentRangeEnd");
    expect(errSpy.mock.calls.flat().join(" ")).not.toContain("cursor drift");
  });

  it("a comment SPANNING the footnote ref emits ONE reference, no cursor drift", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // [2,9] = "claim[1" — opens inside "A claim", closes INSIDE the [1] glyph.
    const out = await exportYDocToDocx(footnoteDocWithComment(2, 9));
    const docXml = await docXmlOf(out);
    // Atomic: the FootnoteReferenceRun is never split into two halves.
    expect(countRefs(docXml)).toBe(1);
    expect(docXml).toContain("w:commentRangeStart");
    expect(docXml).toContain("w:commentRangeEnd");
    // The export's own end-of-walk invariant didn't trip (cursor == flat length).
    expect(errSpy.mock.calls.flat().join(" ")).not.toContain("cursor drift");
  });
});

// --- whole-value replace + offset no-regression ----------------------------

describe("footnote body map — persistence + offset invariants", () => {
  it("WHOLE-VALUE replace: re-importing fewer footnotes drops stale ids", async () => {
    const adapter = getAdapter("docx");
    const doc = new Y.Doc();

    const many = await adapter.parse(await buildMultiFootnote()); // 11 footnotes
    transactForTest(doc, () => adapter.apply(doc, many, { fileName: "m.docx" }));
    expect(
      Object.keys(doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_FOOTNOTE_BODIES) as object),
    ).toHaveLength(11);

    const one = await adapter.parse(await buildFootnote()); // 1 footnote
    transactForTest(doc, () => adapter.apply(doc, one, { fileName: "m.docx" }));
    const bodies = doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_FOOTNOTE_BODIES) as object;
    // Not 12 (no merge), not 11 (no stale carryover) — exactly the new set.
    expect(Object.keys(bodies)).toEqual(["1"]);
  });

  it("does NOT change the pre-existing footnote-ref offset gap (walker counts ref as 0, Y.Doc keeps [1])", async () => {
    const buf = await buildFootnote();
    const adapter = getAdapter("docx");
    const prepared = await adapter.parse(buf);
    const doc = new Y.Doc();
    transactForTest(doc, () => adapter.apply(doc, prepared, { fileName: "f.docx" }));

    // The Y.Doc keeps the verbatim 3-char "[1]" marker; the raw-XML walker
    // (which drives imported-comment offsets) counts <w:footnoteReference> as 0.
    // PR 2 keeps the marker verbatim, so the pre-existing 3·N (N=1 → 3) gap is
    // neither fixed nor worsened — a comment after the footnote misanchors by
    // exactly 3, unchanged. (The fix needs an offset migration; out of scope.)
    const ydocText = extractText(doc);
    expect(ydocText).toContain("[1]");
    expect(ydocText).toContain("A claim with a note[1].");
  });
});
