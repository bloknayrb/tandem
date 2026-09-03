/* Probe script: drives real MCP tool handlers through an in-memory client. Read-only w.r.t. the repo. */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-probe-"));
process.env.TANDEM_APP_DATA_DIR = path.join(scratch, "appdata");
await fs.mkdir(process.env.TANDEM_APP_DATA_DIR, { recursive: true });

const { addDoc, setActiveDocId } = await import(
  "../../../../src/server/documents/registry-testing.ts"
);
const { registerAnnotationTools } = await import("../../../../src/server/mcp/annotations.ts");
const { registerAwarenessTools } = await import("../../../../src/server/mcp/awareness.ts");
const { populateYDoc, registerDocumentTools } = await import(
  "../../../../src/server/mcp/document.ts"
);
const { extractText } = await import("../../../../src/server/mcp/document-model.ts");
const { registerNavigationTools } = await import("../../../../src/server/mcp/navigation.ts");
const { registerApplyTools } = await import("../../../../src/server/mcp/docx-apply.ts");
const { getOrCreateDocument } = await import("../../../../src/server/yjs/provider.ts");
const { Y_MAP_ANNOTATIONS } = await import("../../../../src/shared/constants.ts");

const server = new McpServer({ name: "probe", version: "0.0.0" });
registerDocumentTools(server);
registerAnnotationTools(server);
registerNavigationTools(server);
registerAwarenessTools(server);
registerApplyTools(server);
const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "probe-client", version: "0.0.0" });
await server.connect(st);
await client.connect(ct);

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text?: string }>;
  const t = content.find((c) => c.type === "text")?.text;
  return t ? JSON.parse(t) : res;
}

function setupDoc(id: string, text: string, extra: Record<string, unknown> = {}) {
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, {
    id,
    filePath: path.join(scratch, `${id}.md`),
    format: "md",
    readOnly: false,
    source: "file",
    ...extra,
  } as any);
  setActiveDocId(id);
  return ydoc;
}

const tools = (await client.listTools()).tools;
console.log("== tool count:", tools.length);

// H1: tandem_edit with out-of-bounds offsets
{
  const ydoc = setupDoc("h1", "First paragraph here\nSecond paragraph\n# Heading\nThird para");
  console.log("H1 before:", JSON.stringify(extractText(ydoc)), "len", extractText(ydoc).length);
  const r = await call("tandem_edit", { from: 6, to: 99999, newText: "X" });
  console.log("H1 edit(6, 99999):", JSON.stringify(r));
  console.log("H1 after:", JSON.stringify(extractText(ydoc)));
}
{
  const ydoc = setupDoc("h1b", "Alpha beta gamma\nDelta");
  const r = await call("tandem_edit", { from: -7, to: 5, newText: "Z" });
  console.log("H1b edit(-7, 5):", JSON.stringify(r));
  console.log("H1b after:", JSON.stringify(extractText(ydoc)));
}
{
  const ydoc = setupDoc("h1c", "Alpha beta gamma\nDelta");
  const r = await call("tandem_comment", { from: 40, to: 60, text: "past the end" });
  console.log("H1c comment(40, 60):", JSON.stringify(r));
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  map.forEach((v: any) => console.log("H1c stored range:", JSON.stringify(v.range), "snapshot:", JSON.stringify(v.textSnapshot)));
  const g = await call("tandem_getAnnotations", {});
  console.log("H1c getAnnotations range:", JSON.stringify(g.data?.annotations?.[0]?.range));
}

// H4: getContext with inverted / negative range
{
  setupDoc("h4", "Alpha beta gamma\nDelta");
  console.log("H4 getContext(10, 3):", JSON.stringify(await call("tandem_getContext", { from: 10, to: 3 })));
  console.log("H4 getContext(-5, 3):", JSON.stringify(await call("tandem_getContext", { from: -5, to: 3 })));
}

// H2: convertToMarkdown with nonexistent output directory
{
  const id = "h2";
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, "Some docx content");
  addDoc(id, { id, filePath: path.join(scratch, "h2.docx"), format: "docx", readOnly: false, source: "file" } as any);
  setActiveDocId(id);
  const r = await call("tandem_convertToMarkdown", { outputPath: path.join(scratch, "does-not-exist") });
  console.log("H2 convert(nonexistent dir):", JSON.stringify(r));
}

// H52: tandem_save on an .html document
{
  const id = "h52";
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, "html content");
  const fp = path.join(scratch, "h52.html");
  await fs.writeFile(fp, "<p>html content</p>");
  addDoc(id, { id, filePath: fp, format: "html", readOnly: false, source: "file" } as any);
  setActiveDocId(id);
  const e = await call("tandem_edit", { from: 0, to: 4, newText: "HTML" });
  console.log("H52 edit html:", JSON.stringify(e));
  const r = await call("tandem_save", {});
  console.log("H52 save html:", JSON.stringify(r));
  console.log("H52 disk after save:", JSON.stringify(await fs.readFile(fp, "utf-8")));
}

// H53 (#1798): the real .html open + edit + save sequence, through openFromDisk
// rather than addDoc, so the readOnly derivation in resolveAndValidatePath is
// the thing under observation.
{
  const { openFromDisk } = await import("../../../../src/server/documents/open.ts");
  const fp = path.join(scratch, "h53.html");
  await fs.writeFile(fp, "<p>original html</p>");
  const opened = await openFromDisk(fp);
  setActiveDocId(opened.documentId);
  console.log("H53 open .html readOnly:", JSON.stringify(opened.readOnly));
  const e = await call("tandem_edit", { from: 0, to: 8, newText: "EDITED" });
  console.log("H53 edit:", JSON.stringify(e));
  const s = await call("tandem_save", {});
  console.log("H53 save:", JSON.stringify(s));
  console.log("H53 disk after save:", JSON.stringify(await fs.readFile(fp, "utf-8")));
  const { saveDocumentToDisk } = await import("../../../../src/server/mcp/document-service.ts");
  console.log(
    "H53 saveDocumentToDisk (the Ctrl+S path):",
    JSON.stringify(await saveDocumentToDisk(opened.documentId, "mcp")),
  );
  const rn = await call("tandem_rename", { newName: "h53-renamed.html" });
  console.log("H53 rename:", JSON.stringify(rn));
}

// H5: restoreBackup no-arg on a READ-ONLY docx with a sidecar present
{
  const id = "h5";
  const fp = path.join(scratch, "report.docx");
  const sidecar = path.join(scratch, "report.backup.docx");
  await fs.writeFile(fp, "CURRENT bytes");
  await fs.writeFile(sidecar, "OLD backup bytes");
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, "x");
  addDoc(id, { id, filePath: fp, format: "docx", readOnly: true, source: "file" } as any);
  setActiveDocId(id);
  const r = await call("tandem_restoreBackup", {});
  console.log("H5 restoreBackup({}) on readOnly docx:", JSON.stringify(r));
  console.log("H5 disk after:", JSON.stringify(await fs.readFile(fp, "utf-8")));
}

// H66: search with > cap matches -> error?
{
  setupDoc("h66", "a".repeat(20000));
  const r = await call("tandem_search", { query: "a" });
  console.log("H66 search 20000 matches:", JSON.stringify(r).slice(0, 200));
}

// H62: section read has no base offset
{
  setupDoc("h62", "Intro line\n## Costs\nCost body text\n## Other\nz");
  const r = await call("tandem_getTextContent", { section: "Costs" });
  console.log("H62 section read:", JSON.stringify(r));
}

// H7: status write with unknown documentId while a doc IS open
{
  setupDoc("h7", "open doc");
  const r = await call("tandem_status", { text: "working", documentId: "nope-123" });
  console.log("H7 status write unknown docId:", JSON.stringify(r));
}

// H22: annotationReply on a highlight parent -> message content
{
  const ydoc = setupDoc("h22", "Alpha beta gamma");
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  map.set("hl1", { id: "hl1", author: "user", type: "highlight", color: "yellow", range: { from: 0, to: 5 }, content: "", status: "pending", timestamp: 1 });
  const r = await call("tandem_annotationReply", { annotationId: "hl1", text: "hi" });
  console.log("H22 reply to highlight:", JSON.stringify(r));
}

// H26: editAnnotation / resolveAnnotation / removeAnnotation on a {comment, audience: private} record
{
  const ydoc = setupDoc("h26", "Alpha beta gamma");
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  map.set("cp1", { id: "cp1", author: "user", type: "comment", audience: "private", range: { from: 0, to: 5 }, content: "private comment", status: "pending", timestamp: 1 });
  console.log("H26 getAnnotations sees it?:", JSON.stringify((await call("tandem_getAnnotations", {})).data?.annotations?.map((a: any) => [a.id, a.audience])));
  console.log("H26 reply:", JSON.stringify(await call("tandem_annotationReply", { annotationId: "cp1", text: "x" })));
  console.log("H26 edit:", JSON.stringify(await call("tandem_editAnnotation", { id: "cp1", content: "edited by claude" })));
  console.log("H26 resolve:", JSON.stringify(await call("tandem_resolveAnnotation", { id: "cp1", action: "dismiss" })));
  console.log("H26 remove:", JSON.stringify(await call("tandem_removeAnnotation", { id: "cp1" })));
}


// H60: range whose INTERIOR contains a heading prefix (endpoints clean)
{
  const ydoc = setupDoc("h60", "Para one\n## Head\nTail");
  console.log("H60 before:", JSON.stringify(extractText(ydoc)));
  const r = await call("tandem_edit", { from: 4, to: 13, newText: "X" });
  console.log("H60 edit(4,13) across heading prefix:", JSON.stringify(r));
  console.log("H60 after:", JSON.stringify(extractText(ydoc)));
  const frag = ydoc.getXmlFragment("default");
  const names: string[] = [];
  for (let i = 0; i < frag.length; i++) names.push((frag.get(i) as any).nodeName);
  console.log("H60 node names after:", names.join(","));
}

// H16: closeDocumentById with a directory component in the id
{
  const { closeDocumentById, getOpenDocs } = await import("../../../../src/server/mcp/document-service.ts");
  setupDoc("h16", "close me");
  const r = await closeDocumentById("dir/h16");
  console.log("H16 closeDocumentById('dir/h16'):", JSON.stringify(r), "still registered:", getOpenDocs().has("h16"));
}

await client.close();
await fs.rm(scratch, { recursive: true, force: true });
process.exit(0);
