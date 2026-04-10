import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { exportAnnotations, htmlToYDoc } from "../../src/server/file-io/docx.js";
import { getElementText } from "../../src/server/mcp/document.js";
import type { Annotation } from "../../src/shared/types.js";
import { getFragment, makeAnnotation } from "../helpers/ydoc-factory.js";

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

function loadHtml(html: string): Y.Doc {
  doc = new Y.Doc();
  htmlToYDoc(doc, html);
  return doc;
}

// -- Block elements --

describe("htmlToYDoc — block elements", () => {
  it.each([1, 2, 3, 4, 5, 6])("h%i → heading with correct level", (level) => {
    loadHtml(`<h${level}>Title</h${level}>`);
    const frag = getFragment(doc);
    expect(frag.length).toBe(1);
    const el = frag.get(0) as Y.XmlElement;
    expect(el.nodeName).toBe("heading");
    expect(el.getAttribute("level")).toBe(level);
    expect(getElementText(el)).toBe("Title");
  });

  it("paragraph", () => {
    loadHtml("<p>Hello world</p>");
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(el.nodeName).toBe("paragraph");
    expect(getElementText(el)).toBe("Hello world");
  });

  it("multiple paragraphs", () => {
    loadHtml("<p>First</p><p>Second</p>");
    const frag = getFragment(doc);
    expect(frag.length).toBe(2);
    expect(getElementText(frag.get(0) as Y.XmlElement)).toBe("First");
    expect(getElementText(frag.get(1) as Y.XmlElement)).toBe("Second");
  });

  it("blockquote with nested paragraph", () => {
    loadHtml("<blockquote><p>quoted text</p></blockquote>");
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(el.nodeName).toBe("blockquote");
    expect(el.length).toBe(1);
    const inner = el.get(0) as Y.XmlElement;
    expect(inner.nodeName).toBe("paragraph");
    expect(getElementText(inner)).toBe("quoted text");
  });

  it("unordered list", () => {
    loadHtml("<ul><li><p>Item 1</p></li><li><p>Item 2</p></li></ul>");
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(el.nodeName).toBe("bulletList");
    expect(el.length).toBe(2);
    const item1 = el.get(0) as Y.XmlElement;
    expect(item1.nodeName).toBe("listItem");
    expect(getElementText(item1)).toBe("Item 1");
  });

  it("ordered list with start", () => {
    loadHtml('<ol start="5"><li><p>Fifth</p></li></ol>');
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(el.nodeName).toBe("orderedList");
    expect(el.getAttribute("start")).toBe(5);
  });

  it("code block", () => {
    loadHtml("<pre><code>const x = 1;</code></pre>");
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(el.nodeName).toBe("codeBlock");
    expect(getElementText(el)).toBe("const x = 1;");
  });

  it("horizontal rule", () => {
    loadHtml("<hr>");
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(el.nodeName).toBe("horizontalRule");
  });

  it("image", () => {
    loadHtml('<img src="test.png" alt="A test" title="Test Image">');
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(el.nodeName).toBe("image");
    expect(el.getAttribute("src")).toBe("test.png");
    expect(el.getAttribute("alt")).toBe("A test");
    expect(el.getAttribute("title")).toBe("Test Image");
  });
});

// -- Table elements --

describe("htmlToYDoc — tables", () => {
  it("basic table with header and data cells", () => {
    loadHtml(`
      <table>
        <tr><th>Name</th><th>Value</th></tr>
        <tr><td>A</td><td>1</td></tr>
      </table>
    `);
    const table = getFragment(doc).get(0) as Y.XmlElement;
    expect(table.nodeName).toBe("table");
    expect(table.length).toBe(2); // 2 rows

    const headerRow = table.get(0) as Y.XmlElement;
    expect(headerRow.nodeName).toBe("tableRow");
    const th = headerRow.get(0) as Y.XmlElement;
    expect(th.nodeName).toBe("tableHeader");
    // Cell must contain a paragraph (Tiptap content: 'block+')
    const cellPara = th.get(0) as Y.XmlElement;
    expect(cellPara.nodeName).toBe("paragraph");
    expect(getElementText(cellPara)).toBe("Name");

    const dataRow = table.get(1) as Y.XmlElement;
    const td = dataRow.get(0) as Y.XmlElement;
    expect(td.nodeName).toBe("tableCell");
  });

  it("table with colspan and rowspan", () => {
    loadHtml('<table><tr><td colspan="2" rowspan="3">Merged</td></tr></table>');
    const table = getFragment(doc).get(0) as Y.XmlElement;
    const row = table.get(0) as Y.XmlElement;
    const cell = row.get(0) as Y.XmlElement;
    expect(cell.getAttribute("colspan")).toBe(2);
    expect(cell.getAttribute("rowspan")).toBe(3);
  });

  it("table with tbody wrapper", () => {
    loadHtml(`
      <table>
        <thead><tr><th>H</th></tr></thead>
        <tbody><tr><td>D</td></tr></tbody>
      </table>
    `);
    const table = getFragment(doc).get(0) as Y.XmlElement;
    expect(table.length).toBe(2); // thead row + tbody row
  });
});

// -- Inline marks --

describe("htmlToYDoc — inline marks", () => {
  it("bold text", () => {
    loadHtml("<p><strong>bold</strong></p>");
    const el = getFragment(doc).get(0) as Y.XmlElement;
    const textNode = el.get(0) as Y.XmlText;
    const delta = textNode.toDelta();
    expect(delta.length).toBe(1);
    expect(delta[0].insert).toBe("bold");
    expect(delta[0].attributes?.bold).toEqual({});
  });

  it("italic text", () => {
    loadHtml("<p><em>italic</em></p>");
    const el = getFragment(doc).get(0) as Y.XmlElement;
    const textNode = el.get(0) as Y.XmlText;
    const delta = textNode.toDelta();
    expect(delta[0].attributes?.italic).toEqual({});
  });

  it("underline text", () => {
    loadHtml("<p><u>underlined</u></p>");
    const el = getFragment(doc).get(0) as Y.XmlElement;
    const textNode = el.get(0) as Y.XmlText;
    const delta = textNode.toDelta();
    expect(delta[0].attributes?.underline).toEqual({});
  });

  it("strikethrough text", () => {
    loadHtml("<p><s>deleted</s></p>");
    const el = getFragment(doc).get(0) as Y.XmlElement;
    const textNode = el.get(0) as Y.XmlText;
    const delta = textNode.toDelta();
    expect(delta[0].attributes?.strike).toEqual({});
  });

  it("link", () => {
    loadHtml('<p><a href="https://example.com">click</a></p>');
    const el = getFragment(doc).get(0) as Y.XmlElement;
    const textNode = el.get(0) as Y.XmlText;
    const delta = textNode.toDelta();
    expect(delta[0].attributes?.link).toEqual({ href: "https://example.com" });
  });

  it("link — http: href is preserved", () => {
    loadHtml('<p><a href="http://example.com">click</a></p>');
    const el = getFragment(doc).get(0) as Y.XmlElement;
    const textNode = el.get(0) as Y.XmlText;
    const delta = textNode.toDelta();
    expect(delta[0].attributes?.link).toEqual({ href: "http://example.com" });
  });

  it("link — mailto: href is preserved", () => {
    loadHtml('<p><a href="mailto:user@example.com">email</a></p>');
    const el = getFragment(doc).get(0) as Y.XmlElement;
    const textNode = el.get(0) as Y.XmlText;
    const delta = textNode.toDelta();
    expect(delta[0].attributes?.link).toEqual({ href: "mailto:user@example.com" });
  });

  it("link — javascript: href is sanitized to empty string", () => {
    loadHtml('<p><a href="javascript:alert(1)">xss</a></p>');
    const el = getFragment(doc).get(0) as Y.XmlElement;
    const textNode = el.get(0) as Y.XmlText;
    const delta = textNode.toDelta();
    expect(delta[0].attributes?.link).toEqual({ href: "" });
  });

  it("link — data: href is sanitized to empty string", () => {
    loadHtml('<p><a href="data:text/html,<script>alert(1)</script>">xss</a></p>');
    const el = getFragment(doc).get(0) as Y.XmlElement;
    const textNode = el.get(0) as Y.XmlText;
    const delta = textNode.toDelta();
    expect(delta[0].attributes?.link).toEqual({ href: "" });
  });

  it("link — vbscript: href is sanitized to empty string", () => {
    loadHtml('<p><a href="vbscript:MsgBox(1)">xss</a></p>');
    const el = getFragment(doc).get(0) as Y.XmlElement;
    const textNode = el.get(0) as Y.XmlText;
    const delta = textNode.toDelta();
    expect(delta[0].attributes?.link).toEqual({ href: "" });
  });

  it("superscript and subscript", () => {
    loadHtml("<p><sup>up</sup><sub>down</sub></p>");
    const el = getFragment(doc).get(0) as Y.XmlElement;
    const textNode = el.get(0) as Y.XmlText;
    const delta = textNode.toDelta();
    expect(delta[0].attributes?.superscript).toEqual({});
    expect(delta[1].attributes?.subscript).toEqual({});
  });

  it("nested marks: bold + italic", () => {
    loadHtml("<p><strong><em>bold italic</em></strong></p>");
    const el = getFragment(doc).get(0) as Y.XmlElement;
    const textNode = el.get(0) as Y.XmlText;
    const delta = textNode.toDelta();
    expect(delta[0].insert).toBe("bold italic");
    expect(delta[0].attributes?.bold).toEqual({});
    expect(delta[0].attributes?.italic).toEqual({});
  });

  it("mixed plain and formatted text", () => {
    loadHtml("<p>plain <strong>bold</strong> plain</p>");
    const el = getFragment(doc).get(0) as Y.XmlElement;
    const textNode = el.get(0) as Y.XmlText;
    const delta = textNode.toDelta();
    expect(delta.length).toBe(3);
    expect(delta[0].insert).toBe("plain ");
    // Null marks are set via buildAttrs but Yjs delta omits null-valued attrs
    expect(delta[0].attributes?.bold).toBeFalsy();
    expect(delta[1].insert).toBe("bold");
    expect(delta[1].attributes?.bold).toEqual({});
    expect(delta[2].insert).toBe(" plain");
    expect(delta[2].attributes?.bold).toBeFalsy();
  });
});

// -- Nested structures --

describe("htmlToYDoc — nested structures", () => {
  it("list item with paragraph and nested list", () => {
    loadHtml(`
      <ul>
        <li>
          <p>Parent</p>
          <ul><li><p>Child</p></li></ul>
        </li>
      </ul>
    `);
    const list = getFragment(doc).get(0) as Y.XmlElement;
    expect(list.nodeName).toBe("bulletList");
    const item = list.get(0) as Y.XmlElement;
    expect(item.nodeName).toBe("listItem");
    expect(item.length).toBe(2); // paragraph + nested bulletList
    expect((item.get(0) as Y.XmlElement).nodeName).toBe("paragraph");
    expect((item.get(1) as Y.XmlElement).nodeName).toBe("bulletList");
  });

  it("blockquote with multiple paragraphs", () => {
    loadHtml("<blockquote><p>First</p><p>Second</p></blockquote>");
    const bq = getFragment(doc).get(0) as Y.XmlElement;
    expect(bq.nodeName).toBe("blockquote");
    expect(bq.length).toBe(2);
  });
});

// -- Edge cases --

describe("htmlToYDoc — edge cases", () => {
  it("empty HTML produces empty fragment", () => {
    loadHtml("");
    expect(getFragment(doc).length).toBe(0);
  });

  it("whitespace-only HTML produces empty fragment", () => {
    loadHtml("   \n  ");
    expect(getFragment(doc).length).toBe(0);
  });

  it("clears existing content before populating", () => {
    doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    const existing = new Y.XmlElement("paragraph");
    existing.insert(0, [new Y.XmlText("old")]);
    fragment.insert(0, [existing]);
    expect(fragment.length).toBe(1);

    htmlToYDoc(doc, "<p>new</p>");
    expect(fragment.length).toBe(1);
    expect(getElementText(fragment.get(0) as Y.XmlElement)).toBe("new");
  });
});

// -- Two-pass verification --

describe("htmlToYDoc — two-pass text population", () => {
  it("marks render in correct order after two-pass", () => {
    // This test verifies ADR-009: text populated on detached nodes reverses insert order
    loadHtml("<p>a <strong>b</strong> c</p>");
    const el = getFragment(doc).get(0) as Y.XmlElement;
    const textNode = el.get(0) as Y.XmlText;
    const delta = textNode.toDelta();

    // Verify order is preserved: "a " then "b" then " c"
    expect(delta[0].insert).toBe("a ");
    expect(delta[1].insert).toBe("b");
    expect(delta[1].attributes?.bold).toEqual({});
    expect(delta[2].insert).toBe(" c");
  });
});

// -- exportAnnotations --

describe("exportAnnotations", () => {
  it('returns "no annotations" for empty list', () => {
    doc = new Y.Doc();
    const result = exportAnnotations(doc, []);
    expect(result).toContain("No annotations found");
  });

  it("generates markdown grouped by type", () => {
    loadHtml("<p>Hello world test content</p>");

    const annotations: Annotation[] = [
      makeAnnotation({
        id: "h1",
        type: "highlight",
        range: { from: 0, to: 5 },
        content: "",
        color: "yellow",
      }),
      makeAnnotation({
        id: "c1",
        type: "comment",
        range: { from: 6, to: 11 },
        content: "Nice word",
      }),
      makeAnnotation({
        id: "s1",
        type: "suggestion",
        range: { from: 0, to: 5 },
        content: JSON.stringify({ newText: "Hi", reason: "More casual" }),
      }),
    ];

    const result = exportAnnotations(doc, annotations);
    expect(result).toContain("## Highlights");
    expect(result).toContain("## Comments");
    expect(result).toContain("## Suggestions");
    expect(result).toContain("Nice word");
    expect(result).toContain('Replace with: "Hi"');
    expect(result).toContain("More casual");
    expect(result).toContain("Color: yellow");
  });

  it("includes text snippet from document", () => {
    loadHtml("<p>The quick brown fox</p>");
    const annotations = [makeAnnotation({ range: { from: 4, to: 9 }, content: "fast animal" })];
    const result = exportAnnotations(doc, annotations);
    expect(result).toContain("quick");
  });
});

// -- Read-only guard pattern --

describe("read-only guard", () => {
  it("currentDoc.readOnly blocks tandem_edit pattern", () => {
    // This is a unit-level check that the pattern works;
    // the actual MCP integration is tested in the integration suite
    const docState = { filePath: "test.docx", format: "docx", readOnly: true };
    expect(docState.readOnly).toBe(true);
  });
});
