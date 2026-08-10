/**
 * Copy-out plain-text serialization (#1365).
 *
 * The reported defect: copying from Tandem and pasting into another app "adds
 * double line breaks which kind of ruin formatting in the target
 * applications". ProseMirror's default `clipboardTextSerializer` is
 * `textBetween(…, "\n\n")`, which inserts a blank line between EVERY block —
 * consecutive list items included.
 *
 * These drive the REAL production serializer out of `makeEditorProps` against
 * the REAL production schema from `buildSchemaExtensions()`, the same pattern
 * as `link-paste.test.ts`. Asserting on a hand-written `textBetween` call
 * would test this file's arithmetic rather than the editor's behaviour.
 */

import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { makeEditorProps } from "../../src/client/editor/editor-props";

let open: { editor: Editor; container: HTMLDivElement } | null = null;

function makeEditor(content: string): Editor {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    extensions: buildSchemaExtensions(),
    content,
    editorProps: makeEditorProps(true),
  });
  open = { editor, container };
  return editor;
}

afterEach(() => {
  open?.editor.destroy();
  open?.container.remove();
  open = null;
});

/**
 * Serialize the whole document the way a Ctrl+C would.
 *
 * Goes through `view.someProp("clipboardTextSerializer", …)` — the exact
 * lookup `prosemirror-view`'s `serializeForClipboard` performs — so a prop
 * that failed to reach `editorProps` shows up as a miss here rather than
 * being papered over by calling the factory's function directly.
 */
function copyAll(editor: Editor): string {
  const { doc, tr } = editor.state;
  editor.view.dispatch(tr.setSelection(TextSelection.create(doc, 0, doc.content.size)));
  const slice = editor.state.selection.content();
  const serializer = editor.view.someProp("clipboardTextSerializer");
  expect(serializer, "clipboardTextSerializer never reached editorProps").toBeTypeOf("function");
  return (serializer as (s: typeof slice, v: unknown) => string)(slice, editor.view);
}

describe("copying to the clipboard as plain text", () => {
  it("separates list items with one newline, not a blank line", () => {
    const editor = makeEditor(
      "<ul><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ul>",
    );
    expect(copyAll(editor)).toBe("one\ntwo\nthree");
  });

  it("separates paragraphs with one newline", () => {
    const editor = makeEditor("<p>first</p><p>second</p>");
    expect(copyAll(editor)).toBe("first\nsecond");
  });

  it("does not double-space a heading followed by its paragraph", () => {
    const editor = makeEditor("<h2>Title</h2><p>Body text.</p>");
    expect(copyAll(editor)).toBe("Title\nBody text.");
  });

  it("keeps a hard break as a line break instead of dropping it", () => {
    // Independent of the separator: hardBreak is an inline leaf with no text
    // and no `leafText` spec, so ProseMirror's default contributes NOTHING for
    // it and "a<br>b" copied as "ab".
    const editor = makeEditor("<p>alpha<br>beta</p>");
    expect(copyAll(editor)).toBe("alpha\nbeta");
  });

  it("still emits no blank lines for a mixed document", () => {
    // The end-to-end shape of the complaint. The assertion that matters is the
    // absence of "\n\n" anywhere; the exact text is pinned alongside it so
    // this cannot pass by serializing to something empty or truncated.
    const editor = makeEditor(
      "<p>Intro.</p><ul><li><p>one</p></li><li><p>two</p></li></ul><p>Outro.</p>",
    );
    const copied = copyAll(editor);
    expect(copied).not.toContain("\n\n");
    expect(copied).toBe("Intro.\none\ntwo\nOutro.");
  });
});
