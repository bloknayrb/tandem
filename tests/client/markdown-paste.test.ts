import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import {
  createMarkdownParser,
  looksLikeMarkdown,
  markdownToSlice,
} from "../../src/client/editor/utils/markdown-paste";

// Build an editor whose schema IS the production editor's schema — the exact same
// `buildSchemaExtensions()` Editor.svelte uses — so the parser is exercised
// against the real node/mark names it must target (`bold`, `italic`,
// `bulletList`, `codeBlock`, ...) with no drift between test and production.
function makeSchema(): { schema: Schema; editor: Editor; container: HTMLDivElement } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    extensions: buildSchemaExtensions(),
    content: "",
  });
  return { schema: editor.state.schema, editor, container };
}

let schema: Schema;
let editor: Editor;
let container: HTMLDivElement;

beforeEach(() => {
  ({ schema, editor, container } = makeSchema());
});

afterEach(() => {
  editor.destroy();
  container.remove();
});

describe("looksLikeMarkdown", () => {
  it("detects headings, lists, blockquotes, fences, and rules", () => {
    expect(looksLikeMarkdown("# Title")).toBe(true);
    expect(looksLikeMarkdown("- item")).toBe(true);
    expect(looksLikeMarkdown("1. item")).toBe(true);
    expect(looksLikeMarkdown("> quote")).toBe(true);
    expect(looksLikeMarkdown("```\ncode\n```")).toBe(true);
    expect(looksLikeMarkdown("---")).toBe(true);
  });

  it("detects inline emphasis, code, strike, and links", () => {
    expect(looksLikeMarkdown("this is **bold**")).toBe(true);
    expect(looksLikeMarkdown("this is *italic*")).toBe(true);
    expect(looksLikeMarkdown("use `code` here")).toBe(true);
    expect(looksLikeMarkdown("~~gone~~")).toBe(true);
    expect(looksLikeMarkdown("see [docs](https://x.com)")).toBe(true);
  });

  it("treats ordinary prose as plain text", () => {
    expect(looksLikeMarkdown("Just a normal sentence.")).toBe(false);
    expect(looksLikeMarkdown("multiplication a * b * c without spaces? a*b")).toBe(false);
    expect(looksLikeMarkdown("")).toBe(false);
  });
});

describe("markdownToSlice", () => {
  function parseToDoc(md: string) {
    const slice = markdownToSlice(md, schema);
    expect(slice).not.toBeNull();
    // Wrap the slice content in a doc node for easy assertions.
    return schema.topNodeType.create(null, slice!.content);
  }

  it("returns null for non-markdown text", () => {
    expect(markdownToSlice("just plain prose", schema)).toBeNull();
  });

  it("converts headings with the correct level", () => {
    const doc = parseToDoc("## Hello world");
    const first = doc.firstChild!;
    expect(first.type.name).toBe("heading");
    expect(first.attrs.level).toBe(2);
    expect(first.textContent).toBe("Hello world");
  });

  it("converts bold, italic, code, and strike marks", () => {
    const doc = parseToDoc("**bold** and *italic* and `code` and ~~strike~~");
    const markNames = new Set<string>();
    doc.descendants((node) => {
      for (const m of node.marks) markNames.add(m.type.name);
    });
    expect(markNames.has("bold")).toBe(true);
    expect(markNames.has("italic")).toBe(true);
    expect(markNames.has("code")).toBe(true);
    expect(markNames.has("strike")).toBe(true);
  });

  it("converts links with href", () => {
    const doc = parseToDoc("see [docs](https://example.com)");
    let href: string | null = null;
    doc.descendants((node) => {
      const link = node.marks.find((m) => m.type.name === "link");
      if (link) href = link.attrs.href as string;
    });
    expect(href).toBe("https://example.com");
  });

  // #885 follow-up: links with XSS-relevant schemes must never produce a
  // clickable link in the editor. Either markdown-it's CommonMark URL
  // validator drops the link token entirely (preferred — link mark never
  // created) or our `sanitizeHref` returns null at attr-build time. Both
  // outcomes are safe; assert no link mark carries the literal unsafe href.
  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,x",
    "vbscript:msgbox",
  ])("blocks unsafe link scheme: %s", (href) => {
    const doc = parseToDoc(`click [me](${href})`);
    const observedHrefs: unknown[] = [];
    doc.descendants((node) => {
      const link = node.marks.find((m) => m.type.name === "link");
      if (link) observedHrefs.push(link.attrs.href);
    });
    expect(observedHrefs.every((h) => h !== href && h !== href.toLowerCase())).toBe(true);
  });

  it("preserves a safe link href when adjacent to an unsafe one", () => {
    const doc = parseToDoc("[good](https://example.com) and [bad](javascript:alert(1))");
    const hrefs: unknown[] = [];
    doc.descendants((node) => {
      const link = node.marks.find((m) => m.type.name === "link");
      if (link) hrefs.push(link.attrs.href);
    });
    expect(hrefs).toContain("https://example.com");
    expect(hrefs.every((h) => h !== "javascript:alert(1)")).toBe(true);
  });

  // #885 follow-up: an image mixed with other text in the same paragraph
  // used to throw an "unsupported token" parser error and fall back to
  // plain text, losing ALL surrounding formatting. Then (pre-A1) the image
  // was silently dropped while surrounding formatting survived. Now the
  // image node itself is block-level and can't live inline next to text, so
  // it's downgraded to its alt text (still inline) — surrounding formatting
  // is untouched either way; only a standalone-paragraph image (see the
  // "converts a standalone image" test below) becomes a real image node.
  it("downgrades an image mixed with text to alt text without losing surrounding formatting", () => {
    const slice = markdownToSlice(
      "**bold** then ![alt](https://example.com/x.png) and a [link](https://example.com)",
      schema,
    );
    expect(slice).not.toBeNull();
    let sawBold = false;
    let sawLink = false;
    let sawImageNode = false;
    let sawAltText = false;
    slice!.content.descendants((node) => {
      if (node.marks.some((m) => m.type.name === "bold")) sawBold = true;
      if (node.marks.some((m) => m.type.name === "link")) sawLink = true;
      if (node.type.name === "image") sawImageNode = true;
      if (node.isText && node.text?.includes("alt")) sawAltText = true;
    });
    expect(sawBold).toBe(true);
    expect(sawLink).toBe(true);
    expect(sawImageNode).toBe(false);
    expect(sawAltText).toBe(true);
  });

  // #885 follow-up: a markdown image is now supported end-to-end (schema +
  // server already round-trip it; only the client paste path was dropping
  // it). A paragraph whose ENTIRE content is a single image hoists to a
  // real block-level `image` node.
  it("converts a standalone image to a block image node", () => {
    const doc = parseToDoc("![a cat](https://example.com/cat.png)");
    const first = doc.firstChild!;
    expect(first.type.name).toBe("image");
    expect(first.attrs.src).toBe("https://example.com/cat.png");
    expect(first.attrs.alt).toBe("a cat");
  });

  // markdown-it has its OWN built-in destination blocklist (`javascript:`,
  // `vbscript:`, `file:`, and `data:` outside a small good-image-subtype
  // list) that runs during tokenizing, before our code ever sees a token —
  // a `![...](javascript:...)` never becomes an `image` token at all; the
  // whole construct falls back to literal source text (see the
  // `sanitizeHrefForPaste`-scheme tests in url-safety.test.ts for the
  // link-level equivalent). `blob:` is NOT in markdown-it's small blocklist,
  // so it DOES produce a real `image` token — this is what exercises OUR
  // allowlist-based `sanitizeImageSrcForPaste` end-to-end through the full
  // paste pipeline.
  it("downgrades an image with an unsafe src (blob:) to alt text", () => {
    const slice = markdownToSlice("before ![bad](blob:https://example.com/x) after", schema)!;
    expect(slice).not.toBeNull();
    let sawImageNode = false;
    let text = "";
    slice.content.descendants((node) => {
      if (node.type.name === "image") sawImageNode = true;
      if (node.isText) text += node.text;
    });
    expect(sawImageNode).toBe(false);
    expect(text).toContain("bad");
  });

  it("downgrades a standalone image with an unsafe src (blob:) to a plain-text paragraph", () => {
    const doc = parseToDoc("![bad](blob:https://example.com/x)");
    const first = doc.firstChild!;
    expect(first.type.name).toBe("paragraph");
    expect(first.textContent).toBe("bad");
  });

  it("accepts a standalone image with an allowlisted base64 data: URI", () => {
    const doc = parseToDoc(
      "![tiny](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=)",
    );
    const first = doc.firstChild!;
    expect(first.type.name).toBe("image");
    expect(first.attrs.src?.startsWith("data:image/png;base64,")).toBe(true);
  });

  // markdown-it's own `GOOD_DATA_RE` only checks for a `data:image/<subtype>;`
  // prefix — it does NOT require base64 encoding, so this URI passes
  // markdown-it's laxer built-in check and DOES become a real `image` token.
  // Our stricter `sanitizeImageSrcForPaste` (base64-only) then rejects it,
  // proving our allowlist is narrower than markdown-it's default, not just
  // redundant with it.
  it("rejects a standalone image with a non-base64 data: URI (stricter than markdown-it's own check)", () => {
    const doc = parseToDoc("![evil](data:image/webp;not-base64,xyz)");
    const first = doc.firstChild!;
    expect(first.type.name).toBe("paragraph");
    expect(first.textContent).toBe("evil");
  });

  it("converts bullet lists", () => {
    const doc = parseToDoc("- one\n- two\n- three");
    const list = doc.firstChild!;
    expect(list.type.name).toBe("bulletList");
    expect(list.childCount).toBe(3);
    expect(list.firstChild!.type.name).toBe("listItem");
  });

  it("converts ordered lists and preserves start", () => {
    const doc = parseToDoc("3. three\n4. four");
    const list = doc.firstChild!;
    expect(list.type.name).toBe("orderedList");
    expect(list.attrs.start).toBe(3);
    expect(list.childCount).toBe(2);
  });

  it("converts blockquotes", () => {
    const doc = parseToDoc("> a quoted line");
    const bq = doc.firstChild!;
    expect(bq.type.name).toBe("blockquote");
    expect(bq.textContent).toContain("a quoted line");
  });

  it("converts fenced code blocks with language", () => {
    const doc = parseToDoc("```js\nconst x = 1;\n```");
    const code = doc.firstChild!;
    expect(code.type.name).toBe("codeBlock");
    expect(code.attrs.language).toBe("js");
    expect(code.textContent).toBe("const x = 1;");
  });

  it("produces multiple block nodes for mixed content", () => {
    const doc = parseToDoc("# Title\n\nA paragraph with **bold**.\n\n- a\n- b");
    expect(doc.childCount).toBe(3);
    expect(doc.child(0).type.name).toBe("heading");
    expect(doc.child(1).type.name).toBe("paragraph");
    expect(doc.child(2).type.name).toBe("bulletList");
  });

  // #885 follow-up: GFM tables used to be silently dropped (`ignore: true`).
  // Cells must be paragraph-wrapped (Tiptap's tableHeader/tableCell are
  // `block+`) and inline marks inside cells must survive.
  it("converts a GFM table with paragraph-wrapped cells and marks inside cells", () => {
    const doc = parseToDoc("| Name | Note |\n| --- | --- |\n| Alice | **hi** |\n| Bob | plain |");
    const table = doc.firstChild!;
    expect(table.type.name).toBe("table");
    expect(table.childCount).toBe(3); // header row + 2 body rows

    const headerRow = table.child(0);
    expect(headerRow.type.name).toBe("tableRow");
    expect(headerRow.childCount).toBe(2);
    const headerCell = headerRow.child(0);
    expect(headerCell.type.name).toBe("tableHeader");
    // Cell content must be paragraph-wrapped, not bare inline content.
    expect(headerCell.childCount).toBe(1);
    expect(headerCell.child(0).type.name).toBe("paragraph");
    expect(headerCell.textContent).toBe("Name");

    const bodyRow1 = table.child(1);
    expect(bodyRow1.type.name).toBe("tableRow");
    const noteCell = bodyRow1.child(1);
    expect(noteCell.type.name).toBe("tableCell");
    expect(noteCell.child(0).type.name).toBe("paragraph");
    expect(noteCell.textContent).toBe("hi");
    let sawBoldInCell = false;
    noteCell.descendants((node) => {
      if (node.marks.some((m) => m.type.name === "bold")) sawBoldInCell = true;
    });
    expect(sawBoldInCell).toBe(true);

    const bodyRow2 = table.child(2);
    expect(bodyRow2.child(0).textContent).toBe("Bob");
    expect(bodyRow2.child(1).textContent).toBe("plain");
  });

  it("does NOT convert a lone pipe-containing line with no delimiter row", () => {
    expect(looksLikeMarkdown("| just | pipes |")).toBe(false);
    expect(markdownToSlice("| just | pipes |", schema)).toBeNull();
  });

  // F2: hasMarkdownTable now requires the header row and delimiter row to
  // have the same cell count, mirroring markdown-it. Without this, a
  // hand-typed table with a column-count typo routed through the markdown
  // path anyway, where `softbreak: ignore` glued every line into one
  // word-soup paragraph.
  describe("table column-count detection (F2)", () => {
    it("does NOT convert a header/delimiter pair with mismatched column counts", () => {
      const text = "a | b\n--- |\nmore | data";
      expect(looksLikeMarkdown(text)).toBe(false);
      expect(markdownToSlice(text, schema)).toBeNull();
    });

    // Header row has an escaped pipe (`\|`, one literal backslash then a
    // pipe in the actual pasted text — written here as `\\|` in the JS
    // string source) — 2 real cells vs the delimiter row's 3. A naive
    // (non-escape-aware) split would count 3 header cells too and wrongly
    // treat this as a matching table; markdown-it's own escapedSplit
    // refuses it, and so must we (P1).
    it("does NOT convert when an escaped pipe makes the header cell count disagree with markdown-it", () => {
      const text = "a \\| b | c\n--- | --- | ---";
      expect(looksLikeMarkdown(text)).toBe(false);
      expect(markdownToSlice(text, schema)).toBeNull();
    });

    it("still converts a normal two-column table", () => {
      const text = "a | b\n--- | ---";
      expect(looksLikeMarkdown(text)).toBe(true);
      expect(markdownToSlice(text, schema)).not.toBeNull();
    });

    it("still converts a single-column table", () => {
      const text = "| a |\n| --- |";
      expect(looksLikeMarkdown(text)).toBe(true);
      expect(markdownToSlice(text, schema)).not.toBeNull();
    });
  });

  // F3: a solo image pasted inside a table cell used to hoist straight into
  // the cell (`tableCell > image`), a shape the server's save path
  // (`cellToPhrasingContent` in mdast-ydoc.ts) silently drops on the very
  // next save — the image pastes fine, then vanishes from the file. Inside
  // a cell it must downgrade to its alt-text fallback instead, same as a
  // mixed-content paragraph image.
  describe("table cell image safety (F3)", () => {
    it("does not hoist a solo image inside a table cell; downgrades it to alt text instead", () => {
      const doc = parseToDoc("| a |\n| --- |\n| ![pic](https://example.com/y.png) |");
      const table = doc.firstChild!;
      expect(table.type.name).toBe("table");
      let sawImageNode = false;
      let sawCellText = false;
      table.descendants((node) => {
        if (node.type.name === "image") sawImageNode = true;
        if (node.type.name === "tableCell" && node.textContent === "pic") sawCellText = true;
      });
      expect(sawImageNode).toBe(false);
      expect(sawCellText).toBe(true);
    });

    it("still hoists a top-level solo image alongside a table in the same paste", () => {
      const doc = parseToDoc("![top](https://example.com/top.png)\n\n| a |\n| --- |\n| text |");
      const topLevel: ProseMirrorNode[] = [];
      doc.forEach((node) => topLevel.push(node));
      expect(topLevel.some((n) => n.type.name === "image")).toBe(true);
      expect(topLevel.some((n) => n.type.name === "table")).toBe(true);
    });
  });

  // F5: accepted limitation, pinned rather than fixed. A solo image hoisted
  // inside a listItem yields `listItem(paragraph(empty), image)` because
  // the schema's listItem requires a paragraph head and `createAndFill`
  // inserts one. Downgrading instead would lose the image entirely, which
  // is worse; the server's own .docx import path independently produces
  // `listItem > image`, so the shapes converge after a save/reload anyway.
  it("solo image in a list item keeps the image (accepted: schema inserts an empty paragraph head)", () => {
    const doc = parseToDoc("- ![cat](https://example.com/c.png)");
    const list = doc.firstChild!;
    expect(list.type.name).toBe("bulletList");
    const item = list.firstChild!;
    expect(item.type.name).toBe("listItem");
    expect(item.childCount).toBe(2);
    expect(item.child(0).type.name).toBe("paragraph");
    expect(item.child(0).content.size).toBe(0);
    expect(item.child(1).type.name).toBe("image");
    expect(item.child(1).attrs.src).toBe("https://example.com/c.png");
    expect(item.child(1).attrs.alt).toBe("cat");
  });
});

describe("slice open-ness (paste integration)", () => {
  // The slice must be max-opened so inline-only markdown merges into the
  // surrounding paragraph rather than splitting it into separate blocks.
  it("merges inline-only markdown into the current paragraph", () => {
    editor.commands.setContent("<p>hello world</p>");
    editor.commands.setTextSelection(7); // between "hello " and "world"
    const slice = markdownToSlice("**bold**", schema)!;
    expect(slice).not.toBeNull();
    editor.view.dispatch(editor.state.tr.replaceSelection(slice));
    expect(editor.getHTML()).toBe("<p>hello <strong>bold</strong>world</p>");
  });

  it("pastes block-level markdown as distinct blocks", () => {
    editor.commands.setContent("<p></p>");
    editor.commands.setTextSelection(1);
    const slice = markdownToSlice("# Title\n\n- a\n- b", schema)!;
    editor.view.dispatch(editor.state.tr.replaceSelection(slice));
    const html = editor.getHTML();
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<ul>");
  });

  // `table` is `isolating: true` (@tiptap/extension-table). `Slice.maxOpen`
  // defaults to descending into isolating nodes (`openIsolating = true`),
  // which would open a table-first slice ~4 levels deep and mangle a paste
  // landing mid-paragraph in surrounding, unrelated content. Asserts the
  // `markdownToSlice(..., false)` fix: the table lands as a sibling block
  // after the split paragraph, not spliced into its inline content.
  it("pastes a table mid-paragraph as a sibling block, not spliced into inline content", () => {
    editor.commands.setContent("<p>before after</p>");
    editor.commands.setTextSelection(7); // between "before " and "after"
    const slice = markdownToSlice("| a | b |\n| --- | --- |\n| 1 | 2 |", schema)!;
    expect(slice).not.toBeNull();
    editor.view.dispatch(editor.state.tr.replaceSelection(slice));
    const doc = editor.state.doc;
    const topLevel: ProseMirrorNode[] = [];
    doc.forEach((node) => topLevel.push(node));
    expect(topLevel.map((n) => n.type.name)).toContain("table");
    // The paragraph must have been split around the paste point, not have
    // the table's cell text merged into its own inline run. Only check
    // TOP-LEVEL paragraphs here — table cells legitimately contain their own
    // (paragraph-wrapped) "1"/"2" text and are not part of this assertion.
    const topLevelParagraphs = topLevel.filter((n) => n.type.name === "paragraph");
    expect(topLevelParagraphs.length).toBeGreaterThanOrEqual(1);
    for (const p of topLevelParagraphs) {
      expect(p.textContent).not.toContain("1");
      expect(p.textContent).not.toContain("2");
    }
  });
});

describe("createMarkdownParser", () => {
  it("binds to the provided schema", () => {
    const parser = createMarkdownParser(schema);
    expect(parser.schema).toBe(schema);
    const doc = parser.parse("**x**");
    let sawBold = false;
    doc.descendants((node) => {
      if (node.marks.some((m) => m.type.name === "bold")) sawBold = true;
    });
    expect(sawBold).toBe(true);
  });
});
