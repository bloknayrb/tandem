import { Editor } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { isSafeExternalHref } from "../../src/client/editor/utils/url-safety";

// Build an editor whose schema IS the production editor's schema — the exact
// same `buildSchemaExtensions()` Editor.svelte uses — so link-mark assertions
// target the real `link` mark. See tests/client/markdown-paste.test.ts for
// the same pattern.
//
// `editorProps.handlePaste` is NOT part of `buildSchemaExtensions()` — it's
// wired inline in Editor.svelte's `editorProps` block (production code isn't
// exported as a standalone function). `withLinkPasteHandler` below reproduces
// that exact handler so we can drive it through a REAL `paste` DOM event
// (ProseMirror's `editHandlers.paste` reads `event.clipboardData` and calls
// `view.someProp("handlePaste", ...)` — see prosemirror-view's `doPaste`),
// not just a unit-tested pure function. Keep this in lockstep with
// Editor.svelte's `handlePaste` if that implementation changes.
function linkPasteHandler(view: import("@tiptap/pm/view").EditorView, event: ClipboardEvent) {
  const text = event.clipboardData?.getData("text/plain")?.trim();
  if (!text || /\s/.test(text)) return false;
  if (!isSafeExternalHref(text)) return false;

  const { selection } = view.state;
  if (selection.empty || !(selection instanceof TextSelection)) return false;

  const linkType = view.state.schema.marks.link;
  if (!linkType) return false;

  view.dispatch(
    view.state.tr.addMark(selection.from, selection.to, linkType.create({ href: text })),
  );
  return true;
}

function makeEditor(opts: { content: string; withHandler: boolean }): {
  editor: Editor;
  schema: Schema;
  container: HTMLDivElement;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    extensions: buildSchemaExtensions(),
    content: opts.content,
    editorProps: opts.withHandler
      ? {
          handlePaste: (view, event) => linkPasteHandler(view, event as ClipboardEvent),
        }
      : undefined,
  });
  return { editor, schema: editor.state.schema, container };
}

/** Dispatch a real `paste` ClipboardEvent carrying only `text/plain`. */
function pasteText(editor: Editor, text: string) {
  const dataTransfer = new DataTransfer();
  dataTransfer.setData("text/plain", text);
  const event = new ClipboardEvent("paste", {
    clipboardData: dataTransfer,
    bubbles: true,
    cancelable: true,
  });
  editor.view.dom.dispatchEvent(event);
}

/** Select the full text content of the (single-paragraph) doc. */
function selectAll(editor: Editor) {
  const { doc } = editor.state;
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(doc, 1, doc.content.size - 1)),
  );
}

function linkHrefsIn(editor: Editor): string[] {
  const hrefs: string[] = [];
  editor.state.doc.descendants((node) => {
    const link = node.marks.find((m) => m.type.name === "link");
    if (link) hrefs.push(link.attrs.href as string);
  });
  return hrefs;
}

let editor: Editor;
let container: HTMLDivElement;

afterEach(() => {
  editor?.destroy();
  container?.remove();
});

// Step 0 probe: does Tiptap's Link extension (linkOnPaste defaults to true)
// already turn a bare-URL paste over a selection into a link on its own,
// with NO custom handlePaste wired at all? This runs against the exact
// production schema (buildSchemaExtensions()) with no extra editorProps.
describe("probe: Link's built-in paste-link behavior (no custom handlePaste)", () => {
  it("records whether the stock Link pasteHandler links a URL pasted over a selection", () => {
    ({ editor, container } = makeEditor({ content: "<p>hello world</p>", withHandler: false }));
    selectAll(editor);
    pasteText(editor, "https://example.com");

    const hrefs = linkHrefsIn(editor);
    // Documented for the report regardless of outcome — see Editor.svelte's
    // handlePaste comment: direct editorProps handlers run BEFORE plugin
    // handlers, so our deterministic implementation is correct either way.
    // Exact-equality comparison (not substring matching) — this is a test
    // assertion on link hrefs, not URL sanitization (CodeQL js/incomplete-url-substring-sanitization).
    const didLink = hrefs.some((href) => href === "https://example.com");

    console.log(
      `[probe] Link's built-in pasteHandler ${didLink ? "DID" : "did NOT"} link the pasted URL over a selection (no custom handlePaste).`,
    );
    expect(typeof didLink).toBe("boolean");
  });
});

describe("Editor.svelte handlePaste: paste URL over selection creates a link", () => {
  beforeEach(() => {
    ({ editor, container } = makeEditor({ content: "<p>hello world</p>", withHandler: true }));
  });

  it("links the selected text and leaves the text content unchanged", () => {
    selectAll(editor);
    pasteText(editor, "https://example.com");

    expect(editor.state.doc.textContent).toBe("hello world");
    expect(linkHrefsIn(editor)).toContain("https://example.com");
  });

  it("rejects an unsafe scheme (javascript:) and falls through to normal paste, replacing the selection with no link mark", () => {
    selectAll(editor);
    pasteText(editor, "javascript:alert(1)");

    expect(linkHrefsIn(editor)).toEqual([]);
    // Falls through to the browser/ProseMirror default paste path, which
    // replaces the selection with the pasted text.
    expect(editor.state.doc.textContent).toBe("javascript:alert(1)");
  });

  it("inserts the URL as plain text (no link mark required) when the selection is empty", () => {
    editor.commands.setTextSelection(1); // collapsed, start of "hello world"
    pasteText(editor, "https://example.com");

    expect(editor.state.doc.textContent).toBe("https://example.comhello world");
  });

  it("falls through to normal paste for text containing whitespace", () => {
    selectAll(editor);
    pasteText(editor, "https://a.com and more");

    // Our handler bails (whitespace present) so this falls to the normal
    // paste path, which replaces the selection with the pasted text. Link's
    // OWN paste/autolink plugin may still mark a URL-shaped substring within
    // that fallback — that's independent, pre-existing behavior, not
    // something this handler controls either way.
    expect(editor.state.doc.textContent).toBe("https://a.com and more");
  });
});
