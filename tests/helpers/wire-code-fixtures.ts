/**
 * Shared fixtures for the wire-code table tests (#1823, #1851):
 * `mcp-wire-codes.test.ts` and `mcp-wire-codes-mocked.test.ts`.
 *
 * Deliberately imports no `src/server` module, so a suite's `vi.mock` factories
 * and hoisted dynamic imports decide the module graph, not this file.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import JSZip from "jszip";
import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";

export function parseResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

/** A minimal, structurally valid .docx with one body paragraph (docx-apply.test.ts). */
export async function createMinimalDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
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

/**
 * Seed `doc` with one "Hello world" paragraph and one ACCEPTED suggestion over
 * "Hello", so `tandem_applyChanges` has something to write and the failure under
 * test is the only thing that can stop it (not NO_SUGGESTIONS).
 */
export function seedAcceptedSuggestion(doc: Y.Doc): void {
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  paragraph.insert(0, [text]);
  doc.getXmlFragment("default").insert(0, [paragraph]);
  text.insert(0, "Hello world");
  doc.getMap(Y_MAP_ANNOTATIONS).set("a1", {
    id: "a1",
    type: "comment",
    author: "claude",
    status: "accepted",
    range: { from: 0, to: 5 },
    content: "swap it",
    suggestedText: "Howdy",
    textSnapshot: "Hello",
    timestamp: Date.now(),
  });
}
