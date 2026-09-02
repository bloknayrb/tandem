import * as Y from "yjs";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, FootnoteReferenceRun, CommentRangeStart, CommentRangeEnd, CommentReference, SymbolRun } from "docx";
import mammoth from "mammoth";
import { extractText } from "../../../../src/server/mcp/document-model.ts";
import { walkDocumentBody } from "../../../../src/server/file-io/docx-walker.ts";
import { extractDocxComments } from "../../../../src/server/file-io/docx-comments.ts";
import { getAdapter } from "../../../../src/server/file-io/index.ts";

async function check(label: string, doc: Document) {
  const buf = await Packer.toBuffer(doc);
  const { value: html } = await mammoth.convertToHtml({ buffer: buf }, { styleMap: ["u => u"] });
  const ydoc = new Y.Doc();
  // go through the real adapter so footnote reconciliation runs
  const adapter = getAdapter("docx");
  const prepared = await adapter.parse(buf);
  ydoc.transact(() => adapter.apply(ydoc, prepared, { fileName: "t.docx" }), "internal");
  const flatY = extractText(ydoc);
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file("word/document.xml")!.async("text");
  const { flatText } = walkDocumentBody(xml);
  console.log(`=== ${label} ===`);
  console.log("html:", JSON.stringify(html).slice(0, 300));
  console.log("ydoc :", JSON.stringify(flatY));
  console.log("walk :", JSON.stringify(flatText));
  console.log(flatY === flatText ? "MATCH" : "MISMATCH");
  const comments = await extractDocxComments(buf);
  for (const c of comments) console.log(`comment ${c.commentId} [${c.from},${c.to}) walker-text=${JSON.stringify(flatText.slice(c.from, c.to))} ydoc-text=${JSON.stringify(flatY.slice(c.from, c.to))} body=${JSON.stringify(c.bodyText)}`);
}

// A. heading inside a table cell, then a commented paragraph
await check("heading in table cell", new Document({
  comments: { children: [{ id: 0, author: "Rev", date: new Date(), children: [new Paragraph("note on target")] }] },
  sections: [{ children: [
    new Paragraph("Intro para."),
    new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph({ text: "Cell Heading", heading: HeadingLevel.HEADING_2 })] }), new TableCell({ children: [new Paragraph("plain cell")] })] })] }),
    new Paragraph({ children: [new TextRun("After the table "), new CommentRangeStart(0), new TextRun("target"), new CommentRangeEnd(0), new CommentReference(0), new TextRun(" end.")] }),
  ] }],
}));

// B. footnote reference before a commented span
await check("footnote ref before comment", new Document({
  footnotes: { 1: { children: [new Paragraph("The footnote body.")] } },
  comments: { children: [{ id: 0, author: "Rev", date: new Date(), children: [new Paragraph("note")] }] },
  sections: [{ children: [
    new Paragraph({ children: [new TextRun("Claim"), new FootnoteReferenceRun(1), new TextRun(" then "), new CommentRangeStart(0), new TextRun("target"), new CommentRangeEnd(0), new CommentReference(0), new TextRun(" end.")] }),
  ] }],
}));

// C. symbol run (Wingdings) before a commented span
await check("w:sym before comment", new Document({
  comments: { children: [{ id: 0, author: "Rev", date: new Date(), children: [new Paragraph("note")] }] },
  sections: [{ children: [
    new Paragraph({ children: [new SymbolRun({ char: "F0FC", symbolfont: "Wingdings" }), new TextRun(" then "), new CommentRangeStart(0), new TextRun("target"), new CommentRangeEnd(0), new CommentReference(0)] }),
  ] }],
}));

// D. numbered heading (heading style inside list) + hyperlink? keep simple: heading with a tab
await check("bullet list + heading", new Document({
  numbering: { config: [{ reference: "b", levels: [{ level: 0, format: "bullet", text: "•" }] }] },
  comments: { children: [{ id: 0, author: "Rev", date: new Date(), children: [new Paragraph("note")] }] },
  sections: [{ children: [
    new Paragraph({ text: "Item one", numbering: { reference: "b", level: 0 } }),
    new Paragraph({ text: "Item two", numbering: { reference: "b", level: 0 } }),
    new Paragraph({ text: "Sub Heading", heading: HeadingLevel.HEADING_3 }),
    new Paragraph({ children: [new CommentRangeStart(0), new TextRun("target"), new CommentRangeEnd(0), new CommentReference(0)] }),
  ] }],
}));
