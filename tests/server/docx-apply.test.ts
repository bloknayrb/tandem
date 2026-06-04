import render from "dom-serializer";
import JSZip from "jszip";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applySingleSuggestion,
  applyTrackedChanges,
  buildOffsetMap,
  resolveWordComments,
} from "../../src/server/file-io/docx-apply.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import {
  addDoc,
  getOpenDocs,
  removeDoc,
  setActiveDocId,
} from "../../src/server/mcp/document-service.js";
import { applyChangesCore } from "../../src/server/mcp/docx-apply.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapBody(bodyContent: string): string {
  return `<?xml version="1.0"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
      <w:body>${bodyContent}</w:body>
    </w:document>`;
}

async function createTestDocx(documentXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

function makeYTableCell(text: string): Y.XmlElement {
  const cell = new Y.XmlElement("tableCell");
  const paragraph = new Y.XmlElement("paragraph");
  const xmlText = new Y.XmlText();
  xmlText.insert(0, text);
  paragraph.insert(0, [xmlText]);
  cell.insert(0, [paragraph]);
  return cell;
}

function makeYParagraph(text: string): Y.XmlElement {
  const paragraph = new Y.XmlElement("paragraph");
  const xmlText = new Y.XmlText();
  xmlText.insert(0, text);
  paragraph.insert(0, [xmlText]);
  return paragraph;
}

// ---------------------------------------------------------------------------
// buildOffsetMap
// ---------------------------------------------------------------------------

describe("buildOffsetMap", () => {
  it("maps offsets in a single run", () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello</w:t></w:r></w:p>`);
    const map = buildOffsetMap(xml, new Set([0, 2, 5]));

    expect(map.flatText).toBe("Hello");
    expect(map.totalLength).toBe(5);

    const at0 = map.get(0);
    expect(at0).toBeDefined();
    expect(at0!.charIndex).toBe(0);

    const at2 = map.get(2);
    expect(at2).toBeDefined();
    expect(at2!.charIndex).toBe(2);

    // Offset 5 = end of document = end of text node
    const at5 = map.get(5);
    expect(at5).toBeDefined();
    expect(at5!.charIndex).toBe(5);
  });

  it("maps offsets across multiple runs", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>Hello</w:t></w:r>
        <w:r><w:t> World</w:t></w:r>
      </w:p>
    `);
    const map = buildOffsetMap(xml, new Set([0, 5, 7]));

    expect(map.flatText).toBe("Hello World");

    const at0 = map.get(0);
    expect(at0).toBeDefined();
    expect(at0!.charIndex).toBe(0);

    // Offset 5 is start of second run (" World")
    const at5 = map.get(5);
    expect(at5).toBeDefined();
    expect(at5!.charIndex).toBe(0);

    // Offset 7 is "Wo" -> charIndex 2 in second run
    const at7 = map.get(7);
    expect(at7).toBeDefined();
    expect(at7!.charIndex).toBe(2);
  });

  it("accounts for heading prefix in offsets", () => {
    const xml = wrapBody(`
      <w:p>
        <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
        <w:r><w:t>Title</w:t></w:r>
      </w:p>
    `);
    // "## " prefix is 3 chars, then "Title" starts at offset 3
    const map = buildOffsetMap(xml, new Set([3, 5]));

    expect(map.flatText).toBe("## Title");

    const at3 = map.get(3);
    expect(at3).toBeDefined();
    expect(at3!.charIndex).toBe(0); // start of "Title"

    const at5 = map.get(5);
    expect(at5).toBeDefined();
    expect(at5!.charIndex).toBe(2); // "Ti" -> index 2
  });

  it("returns flatText for comparison guard", () => {
    const xml = wrapBody(`
      <w:p><w:r><w:t>First</w:t></w:r></w:p>
      <w:p><w:r><w:t>Second</w:t></w:r></w:p>
    `);
    const map = buildOffsetMap(xml, new Set());
    expect(map.flatText).toBe("First\nSecond");
    expect(map.totalLength).toBe(12);
  });

  it("matches Y.Doc flat text for table cells followed by a paragraph", () => {
    const xml = wrapBody(`
      <w:tbl>
        <w:tr>
          <w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc>
        </w:tr>
      </w:tbl>
      <w:p><w:r><w:t>After</w:t></w:r></w:p>
    `);
    const map = buildOffsetMap(xml, new Set());
    expect(map.flatText).toBe("A\nB\nAfter");
  });

  it("returns undefined for unmapped offsets", () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hi</w:t></w:r></w:p>`);
    const map = buildOffsetMap(xml, new Set([99]));
    expect(map.get(99)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applySingleSuggestion
// ---------------------------------------------------------------------------

describe("applySingleSuggestion", () => {
  it("replaces a single run with del + ins markup", () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>`);
    const map = buildOffsetMap(xml, new Set([0, 11]));

    const result = applySingleSuggestion(map, {
      from: 0,
      to: 11,
      newText: "Hi Earth",
      author: "Test Author",
      date: "2024-01-01T00:00:00Z",
      revisionId: 100,
    });

    expect(result.ok).toBe(true);

    const output = render(map.body, { xmlMode: true });
    // Should contain w:del with w:delText
    expect(output).toContain("w:del");
    expect(output).toContain("w:delText");
    expect(output).toContain("Hello World");
    // Should contain w:ins with w:t
    expect(output).toContain("w:ins");
    expect(output).toContain("Hi Earth");
    // Should have author and date
    expect(output).toContain('w:author="Test Author"');
    expect(output).toContain('w:date="2024-01-01T00:00:00Z"');
  });

  it("inherits rPr from the first deleted run", () => {
    const xml = wrapBody(`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold text</w:t></w:r></w:p>`);
    const map = buildOffsetMap(xml, new Set([0, 9]));

    const result = applySingleSuggestion(map, {
      from: 0,
      to: 9,
      newText: "New bold",
      author: "Author",
      date: "2024-01-01T00:00:00Z",
      revisionId: 200,
    });

    expect(result.ok).toBe(true);
    const output = render(map.body, { xmlMode: true });
    // The ins run should have w:rPr with w:b
    const insMatch = output.match(/<w:ins[^>]*>(.*?)<\/w:ins>/s);
    expect(insMatch).toBeTruthy();
    expect(insMatch![1]).toContain("<w:rPr><w:b/></w:rPr>");
  });

  it("handles partial-run split at start boundary", () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>`);
    // Replace "World" (offset 6..11)
    const map = buildOffsetMap(xml, new Set([6, 11]));

    const result = applySingleSuggestion(map, {
      from: 6,
      to: 11,
      newText: "Earth",
      author: "Author",
      date: "2024-01-01T00:00:00Z",
      revisionId: 300,
    });

    expect(result.ok).toBe(true);
    const output = render(map.body, { xmlMode: true });
    // "Hello " should remain as a plain run (with xml:space preserve due to trailing space)
    expect(output).toContain('xml:space="preserve">Hello </w:t>');
    // "World" should be in w:delText
    expect(output).toContain("<w:delText>World</w:delText>");
    // "Earth" should be in w:ins
    expect(output).toContain("Earth");
  });

  it("handles partial-run split at end boundary", () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>`);
    // Replace "Hello" (offset 0..5)
    const map = buildOffsetMap(xml, new Set([0, 5]));

    const result = applySingleSuggestion(map, {
      from: 0,
      to: 5,
      newText: "Hi",
      author: "Author",
      date: "2024-01-01T00:00:00Z",
      revisionId: 400,
    });

    expect(result.ok).toBe(true);
    const output = render(map.body, { xmlMode: true });
    // "Hello" should be in w:delText
    expect(output).toContain("<w:delText>Hello</w:delText>");
    // " World" should remain as a plain run (with xml:space preserve due to leading space)
    expect(output).toContain('xml:space="preserve"> World</w:t>');
    // "Hi" should be in w:ins
    expect(output).toContain("Hi");
  });

  it("handles deletion only (empty newText)", () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Delete me</w:t></w:r></w:p>`);
    const map = buildOffsetMap(xml, new Set([0, 9]));

    const result = applySingleSuggestion(map, {
      from: 0,
      to: 9,
      newText: "",
      author: "Author",
      date: "2024-01-01T00:00:00Z",
      revisionId: 500,
    });

    expect(result.ok).toBe(true);
    const output = render(map.body, { xmlMode: true });
    expect(output).toContain("w:del");
    expect(output).toContain("<w:delText>Delete me</w:delText>");
    expect(output).not.toContain("w:ins");
  });

  it("handles cross-run replacement", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>Hello</w:t></w:r>
        <w:r><w:t> World</w:t></w:r>
      </w:p>
    `);
    // Replace "lo Wo" (offset 3..8) spanning two runs
    const map = buildOffsetMap(xml, new Set([3, 8]));

    const result = applySingleSuggestion(map, {
      from: 3,
      to: 8,
      newText: "LO WO",
      author: "Author",
      date: "2024-01-01T00:00:00Z",
      revisionId: 600,
    });

    expect(result.ok).toBe(true);
    const output = render(map.body, { xmlMode: true });
    // Should have del and ins
    expect(output).toContain("w:del");
    expect(output).toContain("w:ins");
    expect(output).toContain("LO WO");
    // "Hel" should remain
    expect(output).toContain("<w:t>Hel</w:t>");
    // "rld" should remain
    expect(output).toContain("<w:t>rld</w:t>");
  });
});

// ---------------------------------------------------------------------------
// applyTrackedChanges (end-to-end with JSZip)
// ---------------------------------------------------------------------------

describe("applyTrackedChanges", () => {
  it("applies a suggestion and round-trips through JSZip", async () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>`);
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [{ id: "s1", from: 0, to: 5, newText: "Hi" }],
      { author: "Test", ydocFlatText: "Hello World" },
    );

    expect(output.applied).toBe(1);
    expect(output.rejected).toBe(0);

    // Verify the XML in the output buffer
    const zip = await JSZip.loadAsync(output.buffer);
    const resultXml = await zip.file("word/document.xml")!.async("text");
    expect(resultXml).toContain("w:del");
    expect(resultXml).toContain("w:ins");
    expect(resultXml).toContain("Hi");
    expect(resultXml).toContain("<w:delText>Hello</w:delText>");
  });

  it("rejects suggestions with textSnapshot mismatch", async () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>`);
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [{ id: "s1", from: 0, to: 5, newText: "Hi", textSnapshot: "WRONG" }],
      { author: "Test", ydocFlatText: "Hello World" },
    );

    expect(output.applied).toBe(0);
    expect(output.rejected).toBe(1);
    expect(output.rejectedDetails[0].id).toBe("s1");
    expect(output.rejectedDetails[0].reason).toContain("snapshot mismatch");
  });

  it("throws on comparison guard failure", async () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>`);
    const docxBuffer = await createTestDocx(xml);

    await expect(
      applyTrackedChanges(docxBuffer, [{ id: "s1", from: 0, to: 5, newText: "Hi" }], {
        author: "Test",
        ydocFlatText: "TOTALLY DIFFERENT TEXT",
      }),
    ).rejects.toThrow("Flat text mismatch");
  });

  it("applies multiple suggestions in reverse order", async () => {
    // Each suggestion targets a separate run so the same-run check doesn't fire
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>Hello</w:t></w:r>
        <w:r><w:t> World </w:t></w:r>
        <w:r><w:t>Today</w:t></w:r>
      </w:p>
    `);
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [
        { id: "s1", from: 0, to: 5, newText: "Hi" },
        { id: "s2", from: 12, to: 17, newText: "Now" },
      ],
      { author: "Test", ydocFlatText: "Hello World Today" },
    );

    expect(output.applied).toBe(2);
    expect(output.rejected).toBe(0);

    const zip = await JSZip.loadAsync(output.buffer);
    const resultXml = await zip.file("word/document.xml")!.async("text");
    expect(resultXml).toContain("Hi");
    expect(resultXml).toContain("Now");
  });

  it("rejects overlapping ranges", async () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>`);
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [
        { id: "s1", from: 0, to: 7, newText: "A" },
        { id: "s2", from: 5, to: 11, newText: "B" },
      ],
      { author: "Test", ydocFlatText: "Hello World" },
    );

    // One should be applied, the other rejected for overlap
    expect(output.applied + output.rejected).toBe(2);
    expect(output.rejected).toBeGreaterThanOrEqual(1);
    expect(output.rejectedDetails.some((r) => r.reason.includes("Overlapping"))).toBe(true);
  });

  it("rejects suggestions containing complex elements (footnoteReference)", async () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>See note</w:t><w:footnoteReference w:id="1"/></w:r>
        <w:r><w:t> and more text</w:t></w:r>
      </w:p>
    `);
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [
        { id: "s1", from: 0, to: 8, newText: "Check note" },
        { id: "s2", from: 8, to: 22, newText: " plus extra" },
      ],
      { author: "Test", ydocFlatText: "See note and more text" },
    );

    // s1 targets the run with footnoteReference — should be rejected
    expect(
      output.rejectedDetails.some((r) => r.id === "s1" && r.reason.includes("complex element")),
    ).toBe(true);
    // s2 targets the clean second run — should apply
    expect(output.applied).toBeGreaterThanOrEqual(1);
  });

  it("rejects later suggestion when two target the same run", async () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello World Today</w:t></w:r></w:p>`);
    const docxBuffer = await createTestDocx(xml);

    const output = await applyTrackedChanges(
      docxBuffer,
      [
        { id: "s1", from: 0, to: 5, newText: "Hi" },
        { id: "s2", from: 6, to: 11, newText: "Earth" },
      ],
      { author: "Test", ydocFlatText: "Hello World Today" },
    );

    // Both target the same single run — one should apply, one rejected
    expect(output.applied).toBe(1);
    expect(output.rejected).toBeGreaterThanOrEqual(1);
    expect(output.rejectedDetails.some((r) => r.reason.includes("same text run"))).toBe(true);
  });

  it("rejects cross-paragraph suggestions", async () => {
    const xml = wrapBody(`
      <w:p><w:r><w:t>First paragraph</w:t></w:r></w:p>
      <w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>
    `);
    const docxBuffer = await createTestDocx(xml);

    // "paragraph\nSecond" spans the paragraph boundary (offset 6..22 in "First paragraph\nSecond paragraph")
    const output = await applyTrackedChanges(
      docxBuffer,
      [{ id: "s1", from: 6, to: 22, newText: "REPLACED" }],
      { author: "Test", ydocFlatText: "First paragraph\nSecond paragraph" },
    );

    expect(output.applied).toBe(0);
    expect(output.rejected).toBe(1);
    expect(output.rejectedDetails[0].reason).toContain("Cross-paragraph");
  });

  it("applies a suggestion after a table without flat-text mismatch", async () => {
    const xml = wrapBody(`
      <w:tbl>
        <w:tr>
          <w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc>
        </w:tr>
      </w:tbl>
      <w:p><w:r><w:t>After</w:t></w:r></w:p>
    `);
    const docxBuffer = await createTestDocx(xml);

    const ydoc = new Y.Doc();
    const table = new Y.XmlElement("table");
    const row = new Y.XmlElement("tableRow");
    row.insert(0, [makeYTableCell("A"), makeYTableCell("B")]);
    table.insert(0, [row]);
    ydoc.getXmlFragment("default").insert(0, [table, makeYParagraph("After")]);
    const ydocFlatText = extractText(ydoc);
    expect(ydocFlatText).toBe("A\nB\nAfter");

    const from = ydocFlatText.indexOf("After");
    const output = await applyTrackedChanges(
      docxBuffer,
      [{ id: "s1", from, to: from + "After".length, newText: "Later" }],
      { author: "Test", ydocFlatText },
    );

    expect(output.applied).toBe(1);
    expect(output.rejected).toBe(0);
    ydoc.destroy();
  });
});

// ---------------------------------------------------------------------------
// resolveWordComments
// ---------------------------------------------------------------------------

describe("resolveWordComments", () => {
  const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml";

  /** Build a minimal word/comments.xml. Each comment lists its paragraph paraIds in order. */
  function commentsXml(comments: Array<{ id: string; paraIds: string[] }>): string {
    const body = comments
      .map(
        (c) =>
          `<w:comment w:id="${c.id}" w:author="A" w:date="2026-01-01T00:00:00Z">` +
          c.paraIds.map((p) => `<w:p w14:paraId="${p}"><w:r><w:t>body</w:t></w:r></w:p>`).join("") +
          `</w:comment>`,
      )
      .join("");
    return `<?xml version="1.0"?><w:comments xmlns:w="${W_NS}" xmlns:w14="${W14_NS}">${body}</w:comments>`;
  }

  function countCommentEx(xml: string): number {
    return (xml.match(/<w15:commentEx\b/g) || []).length;
  }

  it("marks a comment done using its OWN last-paragraph paraId, not the document anchor (#1007)", async () => {
    const zip = new JSZip();
    // The comment body has two paragraphs; CT_CommentEx must reference the LAST.
    zip.file("word/comments.xml", commentsXml([{ id: "42", paraIds: ["AAAA1111", "BBBB2222"] }]));
    zip.file("word/document.xml", "<stub/>");
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    );
    zip.file(
      "word/_rels/document.xml.rels",
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
    );

    const suggestions = [{ id: "s1", from: 0, to: 5, newText: "New", importCommentId: "42" }];
    const resolved = await resolveWordComments(zip, suggestions);
    expect(resolved).toBe(1);

    const extXml = await zip.file("word/commentsExtended.xml")!.async("text");
    expect(extXml).toContain('w15:paraId="BBBB2222"'); // the comment's last paragraph
    expect(extXml).not.toContain("AAAA1111"); // NOT the first/anchor paragraph
    expect(extXml).toContain('w15:done="1"');

    // Still wires up the content type + relationship for the new part.
    expect(await zip.file("[Content_Types].xml")!.async("text")).toContain("commentsExtended");
    expect(await zip.file("word/_rels/document.xml.rels")!.async("text")).toContain(
      "commentsExtended",
    );
  });

  it("updates an existing commentEx entry in place rather than duplicating it (#1007)", async () => {
    const zip = new JSZip();
    zip.file("word/comments.xml", commentsXml([{ id: "7", paraIds: ["0BBB0002"] }]));
    // Word already tracks this comment with done="0".
    zip.file(
      "word/commentsExtended.xml",
      `<?xml version="1.0"?><w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:commentEx w15:paraId="0BBB0002" w15:done="0"/></w15:commentsEx>`,
    );

    const suggestions = [{ id: "s1", from: 0, to: 5, newText: "X", importCommentId: "7" }];
    const resolved = await resolveWordComments(zip, suggestions);
    expect(resolved).toBe(1);

    const extXml = await zip.file("word/commentsExtended.xml")!.async("text");
    expect(countCommentEx(extXml)).toBe(1); // updated in place, not duplicated
    expect(extXml).toContain('w15:paraId="0BBB0002"');
    expect(extXml).toContain('w15:done="1"');
    expect(extXml).not.toContain('w15:done="0"');
  });

  it("adds done to an existing entry that had no done attribute", async () => {
    const zip = new JSZip();
    zip.file("word/comments.xml", commentsXml([{ id: "7", paraIds: ["0BBB0002"] }]));
    zip.file(
      "word/commentsExtended.xml",
      `<?xml version="1.0"?><w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:commentEx w15:paraId="0BBB0002"/></w15:commentsEx>`,
    );

    const suggestions = [{ id: "s1", from: 0, to: 5, newText: "X", importCommentId: "7" }];
    expect(await resolveWordComments(zip, suggestions)).toBe(1);

    const extXml = await zip.file("word/commentsExtended.xml")!.async("text");
    expect(countCommentEx(extXml)).toBe(1);
    expect(extXml).toContain('w15:done="1"');
  });

  it("matches an existing entry case-insensitively (preserving its original case)", async () => {
    const zip = new JSZip();
    // comments.xml uses lowercase; the existing commentEx uses uppercase.
    zip.file("word/comments.xml", commentsXml([{ id: "7", paraIds: ["abcd1234"] }]));
    zip.file(
      "word/commentsExtended.xml",
      `<?xml version="1.0"?><w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:commentEx w15:paraId="ABCD1234" w15:done="0"/></w15:commentsEx>`,
    );

    const suggestions = [{ id: "s1", from: 0, to: 5, newText: "X", importCommentId: "7" }];
    expect(await resolveWordComments(zip, suggestions)).toBe(1);

    const extXml = await zip.file("word/commentsExtended.xml")!.async("text");
    expect(countCommentEx(extXml)).toBe(1); // updated in place, not duplicated
    expect(extXml).toContain('w15:paraId="ABCD1234"'); // existing case preserved
    expect(extXml).toContain('w15:done="1"');
    expect(extXml).not.toContain('w15:done="0"');
  });

  it("appends a new entry alongside an unrelated existing one", async () => {
    const zip = new JSZip();
    zip.file("word/comments.xml", commentsXml([{ id: "99", paraIds: ["NEWPARA0"] }]));
    zip.file(
      "word/commentsExtended.xml",
      `<?xml version="1.0"?><w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:commentEx w15:paraId="OTHER000" w15:done="0"/></w15:commentsEx>`,
    );

    const suggestions = [{ id: "s1", from: 0, to: 5, newText: "X", importCommentId: "99" }];
    const resolved = await resolveWordComments(zip, suggestions);
    expect(resolved).toBe(1);

    const extXml = await zip.file("word/commentsExtended.xml")!.async("text");
    expect(extXml).toContain('w15:paraId="OTHER000"'); // untouched
    expect(extXml).toContain('w15:paraId="NEWPARA0"'); // newly resolved
    expect(countCommentEx(extXml)).toBe(2);
  });

  it("returns 0 when no suggestions have importCommentId", async () => {
    const zip = new JSZip();
    const suggestions = [{ id: "s1", from: 0, to: 5, newText: "X" }];
    const resolved = await resolveWordComments(zip, suggestions);
    expect(resolved).toBe(0);
  });

  it("skips a comment with no paragraph id in comments.xml", async () => {
    const zip = new JSZip();
    // No word/comments.xml at all → nothing to resolve against.
    const suggestions = [{ id: "s1", from: 0, to: 5, newText: "X", importCommentId: "42" }];
    const resolved = await resolveWordComments(zip, suggestions);
    expect(resolved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyChangesCore — UNC backupPath rejection
// ---------------------------------------------------------------------------

describe("applyChangesCore — UNC backupPath rejection", () => {
  const DOC_ID = "unc-test-doc";

  beforeEach(() => {
    for (const id of [...getOpenDocs().keys()]) removeDoc(id);
    setActiveDocId(null);

    // Register a fake .docx document so the format/source checks pass
    getOrCreateDocument(DOC_ID);
    addDoc(DOC_ID, {
      id: DOC_ID,
      filePath: "/tmp/test.docx",
      format: "docx",
      readOnly: false,
      source: "file",
    });
    setActiveDocId(DOC_ID);
  });

  it("rejects a UNC backupPath starting with \\\\", async () => {
    // Only meaningful on win32; on other platforms path.resolve won't produce
    // a UNC path, so the check is a no-op — skip on non-Windows.
    if (process.platform !== "win32") return;

    await expect(
      applyChangesCore(DOC_ID, "Test Author", "\\\\attacker.com\\share\\backup.docx"),
    ).rejects.toMatchObject({ code: "INVALID_PATH", message: /UNC paths are not supported/ });
  });

  it("rejects a UNC backupPath starting with //", async () => {
    if (process.platform !== "win32") return;

    await expect(
      applyChangesCore(DOC_ID, "Test Author", "//attacker.com/share/backup.docx"),
    ).rejects.toMatchObject({ code: "INVALID_PATH", message: /UNC paths are not supported/ });
  });
});
