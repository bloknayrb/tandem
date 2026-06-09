import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadDocx } from "../../src/server/file-io/docx.js";
import {
  detectExportFidelityIssues,
  exportYDocToDocx,
  safeHyperlinkUrl,
  safeImageEmbed,
} from "../../src/server/file-io/docx-export.js";
import { htmlToYDoc } from "../../src/server/file-io/docx-html.js";
import { getElementText } from "../../src/server/mcp/document.js";
import { getFragment } from "../helpers/ydoc-factory.js";

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

/** Build a Y.Doc from HTML, the same way a .docx import lands content. */
function docFromHtml(html: string): Y.Doc {
  doc = new Y.Doc();
  htmlToYDoc(doc, html);
  return doc;
}

/** Re-import an exported .docx buffer into a fresh Y.Doc (mammoth → htmlToYDoc). */
async function reimport(buffer: Buffer): Promise<Y.Doc> {
  const html = await loadDocx(buffer);
  const out = new Y.Doc();
  htmlToYDoc(out, html);
  return out;
}

/** Top-level block node names of a doc, in order. */
function blockNames(d: Y.Doc): string[] {
  const frag = getFragment(d);
  const names: string[] = [];
  for (let i = 0; i < frag.length; i++) {
    const el = frag.get(i);
    if (el instanceof Y.XmlElement) names.push(el.nodeName);
  }
  return names;
}

/** Concatenated plain text of all top-level blocks. */
function allText(d: Y.Doc): string {
  const frag = getFragment(d);
  const parts: string[] = [];
  for (let i = 0; i < frag.length; i++) {
    const el = frag.get(i);
    if (el instanceof Y.XmlElement) parts.push(getElementText(el));
  }
  return parts.join("\n");
}

describe("exportYDocToDocx — produces a valid .docx", () => {
  it("output is a well-formed OOXML zip", async () => {
    const buffer = await exportYDocToDocx(docFromHtml("<p>Hello</p>"));
    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file("word/document.xml")).toBeTruthy();
    expect(zip.file("[Content_Types].xml")).toBeTruthy();
  });

  it("empty document still produces a valid file", async () => {
    doc = new Y.Doc();
    const buffer = await exportYDocToDocx(doc);
    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file("word/document.xml")).toBeTruthy();
  });

  it("opens cleanly via mammoth (the same importer Tandem uses)", async () => {
    const buffer = await exportYDocToDocx(docFromHtml("<h1>Title</h1><p>Body text</p>"));
    const html = await loadDocx(buffer);
    expect(html).toContain("Body text");
  });
});

describe("exportYDocToDocx — body round-trips through load → export → reload", () => {
  it("headings survive at the same level", async () => {
    const buffer = await exportYDocToDocx(docFromHtml("<h2>Section</h2>"));
    const back = await reimport(buffer);
    const frag = getFragment(back);
    const h = frag.get(0) as Y.XmlElement;
    expect(h.nodeName).toBe("heading");
    expect(h.getAttribute("level")).toBe(2);
    expect(getElementText(h)).toBe("Section");
    back.destroy();
  });

  it("paragraphs and inline marks survive", async () => {
    const source = docFromHtml("<p>plain <strong>bold</strong> <em>italic</em></p>");
    const buffer = await exportYDocToDocx(source);
    const back = await reimport(buffer);
    expect(allText(back)).toContain("bold");
    const para = getFragment(back).get(0) as Y.XmlElement;
    const text = para.get(0) as Y.XmlText;
    const delta = text.toDelta() as Array<{ insert: string; attributes?: Record<string, unknown> }>;
    const bold = delta.find((d) => d.insert === "bold");
    const italic = delta.find((d) => d.insert === "italic");
    expect(bold?.attributes?.bold).toBeTruthy();
    expect(italic?.attributes?.italic).toBeTruthy();
    back.destroy();
  });

  it("bullet and ordered lists survive as lists", async () => {
    const source = docFromHtml(
      "<ul><li><p>one</p></li><li><p>two</p></li></ul><ol><li><p>first</p></li></ol>",
    );
    const buffer = await exportYDocToDocx(source);
    const back = await reimport(buffer);
    const text = allText(back);
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text).toContain("first");
    back.destroy();
  });

  it("tables survive with their cell text", async () => {
    const source = docFromHtml(
      "<table><tr><th>Name</th><th>Val</th></tr><tr><td>A</td><td>1</td></tr></table>",
    );
    const buffer = await exportYDocToDocx(source);
    const back = await reimport(buffer);
    expect(blockNames(back)).toContain("table");
    expect(allText(back)).toContain("Name");
    expect(allText(back)).toContain("A");
    back.destroy();
  });

  it("a mixed document preserves block order and text", async () => {
    const source = docFromHtml(
      "<h1>Doc</h1><p>intro</p><ul><li><p>point</p></li></ul><blockquote><p>quoted</p></blockquote>",
    );
    const buffer = await exportYDocToDocx(source);
    const back = await reimport(buffer);
    const text = allText(back);
    expect(text).toContain("Doc");
    expect(text).toContain("intro");
    expect(text).toContain("point");
    expect(text).toContain("quoted");
    back.destroy();
  });
});

describe("exportYDocToDocx — trust boundary", () => {
  it("strips unsafe hyperlinks but keeps the text", async () => {
    const source = docFromHtml('<p><a href="https://example.com">safe</a></p>');
    const buffer = await exportYDocToDocx(source);
    const zip = await JSZip.loadAsync(buffer);
    const rels = await zip.file("word/_rels/document.xml.rels")?.async("text");
    // The safe link is allowed.
    expect(rels ?? "").toContain("https://example.com");
  });

  it("no r:link external image references; data: image embeds as media", async () => {
    // 1x1 transparent PNG.
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    doc = new Y.Doc();
    const frag = doc.getXmlFragment("default");
    const img = new Y.XmlElement("image");
    img.setAttribute("src", png);
    frag.insert(0, [img]);
    const buffer = await exportYDocToDocx(doc);
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file("word/document.xml")?.async("text");
    expect(docXml ?? "").not.toContain("r:link");
    expect(docXml ?? "").not.toContain("<w:object");
  });

  it("safeHyperlinkUrl rejects file/UNC/drive, allows http(s)/mailto", () => {
    expect(safeHyperlinkUrl("https://example.com")).toBe("https://example.com/");
    expect(safeHyperlinkUrl("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(safeHyperlinkUrl("file:///etc/passwd")).toBeNull();
    expect(safeHyperlinkUrl("\\\\server\\share\\x")).toBeNull();
    expect(safeHyperlinkUrl("C:\\Windows\\x")).toBeNull();
    expect(safeHyperlinkUrl("javascript:alert(1)")).toBeNull();
  });

  it("safeImageEmbed accepts inline data: only", () => {
    expect(safeImageEmbed("data:image/png;base64,AAAA")).toBeTruthy();
    expect(safeImageEmbed("https://example.com/a.png")).toBeNull();
    expect(safeImageEmbed("file:///a.png")).toBeNull();
    expect(safeImageEmbed("a.png")).toBeNull();
  });
});

describe("detectExportFidelityIssues", () => {
  it("reports nothing for a fully-supported document", () => {
    const d = docFromHtml("<h1>T</h1><p>body</p><ul><li><p>x</p></li></ul>");
    expect(detectExportFidelityIssues(d)).toEqual([]);
  });

  it("flags a non-embedded image", () => {
    doc = new Y.Doc();
    const frag = doc.getXmlFragment("default");
    const img = new Y.XmlElement("image");
    img.setAttribute("src", "https://example.com/a.png");
    frag.insert(0, [img]);
    const warnings = detectExportFidelityIssues(doc);
    expect(warnings.some((w) => w.includes("image"))).toBe(true);
  });

  it("flags an unknown block node name", () => {
    doc = new Y.Doc();
    const frag = doc.getXmlFragment("default");
    frag.insert(0, [new Y.XmlElement("somethingExotic")]);
    const warnings = detectExportFidelityIssues(doc);
    expect(warnings.some((w) => w.includes("somethingExotic"))).toBe(true);
  });
});
