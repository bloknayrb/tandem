import { Editor } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
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

  // #885 follow-up: an image in pasted markdown used to throw an
  // "unsupported token" parser error and fall back to plain text, losing
  // ALL surrounding formatting. Now the image is silently dropped and
  // the rest of the markdown converts normally.
  it("drops embedded images without losing surrounding formatting", () => {
    const slice = markdownToSlice(
      "**bold** then ![alt](https://example.com/x.png) and a [link](https://example.com)",
      schema,
    );
    expect(slice).not.toBeNull();
    let sawBold = false;
    let sawLink = false;
    slice!.content.descendants((node) => {
      if (node.marks.some((m) => m.type.name === "bold")) sawBold = true;
      if (node.marks.some((m) => m.type.name === "link")) sawLink = true;
    });
    expect(sawBold).toBe(true);
    expect(sawLink).toBe(true);
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
