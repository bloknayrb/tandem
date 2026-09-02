import * as Y from "yjs";
import { Document, Packer, Paragraph, TextRun, Tab } from "docx";
import { extractText } from "../../../../src/server/mcp/document-model.ts";
import { walkDocumentBody } from "../../../../src/server/file-io/docx-walker.ts";
import { getAdapter } from "../../../../src/server/file-io/index.ts";
import { applyTrackedChanges } from "../../../../src/server/file-io/docx-apply.ts";
import JSZip from "jszip";

async function load(doc: Document) {
  const buf = await Packer.toBuffer(doc);
  const ydoc = new Y.Doc();
  const adapter = getAdapter("docx");
  const prepared = await adapter.parse(buf);
  ydoc.transact(() => adapter.apply(ydoc, prepared, { fileName: "t.docx" }), "internal");
  const flatY = extractText(ydoc);
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file("word/document.xml")!.async("text");
  const { flatText } = walkDocumentBody(xml);
  return { buf, ydoc, flatY, flatText };
}

async function tryApply(label: string, doc: Document, targetWord: string) {
  const { buf, flatY, flatText } = await load(doc);
  console.log(`=== ${label} ===`);
  console.log("ydoc :", JSON.stringify(flatY));
  console.log("walk :", JSON.stringify(flatText), flatY === flatText ? "MATCH" : "MISMATCH");
  const from = flatY.indexOf(targetWord), to = from + targetWord.length;
  try {
    const out = await applyTrackedChanges(buf, [{ id: "s1", from, to, newText: "REPLACED", textSnapshot: targetWord }], { author: "Claude", ydocFlatText: flatY });
    console.log("applyTrackedChanges: applied", out.applied, "rejected", out.rejected, JSON.stringify(out.rejectedDetails));
  } catch (e) { console.log("applyTrackedChanges THROWS:", String(e).slice(0, 120)); }
}

await tryApply("plain paragraph (control)", new Document({ sections: [{ children: [new Paragraph("Hello target world.")] }] }), "target");
await tryApply("tab in paragraph", new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun("Name:"), new Tab(), new TextRun("target here")] })] }] }), "target");
await tryApply("manual line break (Shift+Enter)", new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun("Line one"), new TextRun({ break: 1 }), new TextRun("target line two")] })] }] }), "target");
