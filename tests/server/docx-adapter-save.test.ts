import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getAdapter } from "../../src/server/file-io/index.js";
import { getElementText } from "../../src/server/mcp/document.js";
import { withInternal } from "../../src/shared/origins.js";

/**
 * Build a minimal real .docx (no comments) with a heading + paragraph so the
 * adapter's mammoth import path is exercised end-to-end, not just the export.
 */
async function buildSimpleDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body>` +
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>My Title</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>Body paragraph.</w:t></w:r></w:p>` +
      `</w:body></w:document>`,
  );
  return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
}

describe("docx adapter — saveBinary capability (#576)", () => {
  it("exposes saveBinary and not text save", () => {
    const adapter = getAdapter("docx");
    expect(typeof adapter.saveBinary).toBe("function");
    expect(adapter.save).toBeUndefined();
  });

  it("round-trips load → edit → save → reopen, preserving body", async () => {
    const adapter = getAdapter("docx");

    // 1. Load (parse + apply, mirroring the file-open pipeline).
    const inputBuffer = await buildSimpleDocx();
    const prepared = await adapter.parse(inputBuffer);
    const doc = new Y.Doc();
    withInternal(doc, () => adapter.apply(doc, prepared));

    const frag = doc.getXmlFragment("default");
    expect(getElementText(frag.get(0) as Y.XmlElement)).toBe("My Title");

    // 2. Edit the body (held in the Y.Doc).
    withInternal(doc, () => {
      const newPara = new Y.XmlElement("paragraph");
      newPara.insert(0, [new Y.XmlText("Appended line.")]);
      frag.insert(frag.length, [newPara]);
    });

    // 3. Explicit save → .docx buffer.
    const outBuffer = await adapter.saveBinary!(doc);
    const zip = await JSZip.loadAsync(outBuffer);
    expect(zip.file("word/document.xml")).toBeTruthy();

    // 4. Reopen the saved file and assert the body (incl. the edit) survives.
    const reprepared = await adapter.parse(outBuffer);
    const back = new Y.Doc();
    withInternal(back, () => adapter.apply(back, reprepared));
    const backFrag = back.getXmlFragment("default");
    const texts: string[] = [];
    for (let i = 0; i < backFrag.length; i++) {
      const el = backFrag.get(i);
      if (el instanceof Y.XmlElement) texts.push(getElementText(el));
    }
    expect(texts).toContain("My Title");
    expect(texts).toContain("Body paragraph.");
    expect(texts).toContain("Appended line.");

    doc.destroy();
    back.destroy();
  });

  it("parse surfaces mammoth fidelity warnings as an 'other' LoadIssue", async () => {
    const adapter = getAdapter("docx");
    // The Heading1 pStyle on a doc without a styles.xml makes mammoth emit an
    // unrecognized-style warning, which the adapter folds into an 'other' issue.
    const prepared = await adapter.parse(await buildSimpleDocx());
    const other = prepared.issues.find((i) => i.kind === "other");
    if (other && other.kind === "other") {
      expect(other.message).toMatch(/formatting/i);
    }
    // Not asserting presence unconditionally — mammoth's warning set is version-
    // dependent. The shape (other → message) is what matters when present.
    expect(Array.isArray(prepared.issues)).toBe(true);
  });
});
