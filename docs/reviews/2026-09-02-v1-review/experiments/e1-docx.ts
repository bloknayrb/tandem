import JSZip from "jszip";
import * as Y from "yjs";
import { getAdapter } from "../../../../src/server/file-io/index.ts";
import { extractText } from "../../../../src/server/mcp/document-model.ts";
import { walkDocumentBody } from "../../../../src/server/file-io/docx-walker.ts";
import { Y_MAP_ANNOTATIONS } from "../../../../src/shared/constants.ts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';

function run(t: string) { return `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`; }
function cs(id: string) { return `<w:commentRangeStart w:id="${id}"/>`; }
function ce(id: string) { return `<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`; }

async function build(bodyXml: string, comments: { id: string; text: string }[]) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document ${W}><w:body>${bodyXml}</w:body></w:document>`);
  zip.file("word/comments.xml", `<?xml version="1.0"?><w:comments ${W}>${comments.map((c) => `<w:comment w:id="${c.id}" w:author="Tester" w:initials="T" w:date="2026-01-01T00:00:00Z"><w:p>${run(c.text)}</w:p></w:comment>`).join("")}</w:comments>`);
  return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
}

async function importDocx(buf: Buffer, label: string, docXml: string) {
  const a = getAdapter("docx");
  const prepared = await a.parse(buf, {} as any);
  const doc = new Y.Doc();
  doc.transact(() => { a.apply(doc, prepared as any, { fileName: "t.docx" } as any); }, "internal");
  const flat = extractText(doc);
  const walker = walkDocumentBody(docXml);
  console.log(`--- ${label}`);
  console.log("  walker flat :", JSON.stringify(walker.flatText));
  console.log("  ydoc   flat :", JSON.stringify(flat));
  const map = doc.getMap(Y_MAP_ANNOTATIONS);
  for (const [, v] of map.entries()) {
    const an: any = v;
    if (an.type === "reply" || !an.range) continue;
    console.log(`  ann body=${JSON.stringify(an.body ?? an.text ?? "")} range=${JSON.stringify(an.range)} covers=${JSON.stringify(flat.slice(an.range.from, an.range.to))} snapshot=${JSON.stringify(an.textSnapshot ?? "")}`);
  }
  return { flat, doc };
}

// CASE 1: empty paragraph between two commented paragraphs
{
  const body =
    `<w:p>${run("Alpha ")}${cs("1")}${run("beta")}${ce("1")}</w:p>` +
    `<w:p/>` +
    `<w:p>${run("Gamma ")}${cs("2")}${run("delta")}${ce("2")}</w:p>`;
  const xml = `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`;
  const buf = await build(body, [{ id: "1", text: "on beta" }, { id: "2", text: "on delta" }]);
  await importDocx(buf, "CASE 1 empty paragraph (expect beta / delta)", xml);
}

// CASE 2a: w:tab inside a table cell, comment after it
{
  const cell = (inner: string) => `<w:tc><w:p>${inner}</w:p></w:tc>`;
  const body =
    `<w:p>${run("Intro")}</w:p>` +
    `<w:tbl><w:tr>${cell(`<w:r><w:tab/><w:t xml:space="preserve">head </w:t></w:r>${cs("1")}${run("cellword")}${ce("1")}`)}</w:tr></w:tbl>` +
    `<w:p>${run("Tail ")}${cs("2")}${run("last")}${ce("2")}</w:p>`;
  const xml = `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`;
  const buf = await build(body, [{ id: "1", text: "on cellword" }, { id: "2", text: "on last" }]);
  await importDocx(buf, "CASE 2a w:tab in table cell (expect cellword / last)", xml);
}

// CASE 2b: w:br w:type="page", comment after it
{
  const body =
    `<w:p>${run("Before")}<w:r><w:br w:type="page"/></w:r>${run("After ")}${cs("1")}${run("target")}${ce("1")}</w:p>` +
    `<w:p>${run("Next ")}${cs("2")}${run("word")}${ce("2")}</w:p>`;
  const xml = `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`;
  const buf = await build(body, [{ id: "1", text: "on target" }, { id: "2", text: "on word" }]);
  await importDocx(buf, "CASE 2b w:br page (expect target / word)", xml);
}

// CASE 2c: w:tab in a plain paragraph (control)
{
  const body =
    `<w:p><w:r><w:t xml:space="preserve">A</w:t></w:r><w:r><w:tab/></w:r>${run("B ")}${cs("1")}${run("zed")}${ce("1")}</w:p>`;
  const xml = `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`;
  const buf = await build(body, [{ id: "1", text: "on zed" }]);
  await importDocx(buf, "CASE 2c w:tab in paragraph (expect zed)", xml);
}
