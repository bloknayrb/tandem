// @vitest-environment happy-dom

/**
 * Accepting a multi-line suggestion in a PLAINTEXT document produces blocks,
 * not hard breaks (#1460, surface 5).
 *
 * #1477 made accept emit a `hardBreak` per newline, which is correct for
 * markdown: a suggestion string spells a hard break `"\n"`, and the serializer
 * writes it back as a trailing `\`. A plaintext file has no way to spell that.
 * `extractText` joins blocks with `"\n"` and renders a hard break as `"\n"`, so
 * the two produce IDENTICAL bytes — and the next open parses those bytes into
 * separate paragraphs. Accepting a two-line suggestion therefore left a document
 * whose model disagreed with its own file, silently, until it was reopened.
 *
 * These drive a LIVE Tiptap editor through the exported `applySuggestion` for the
 * same reason `suggestion-literal-insert.test.ts` does: the behaviour under test
 * is what Tiptap does with the argument, and the hook's own suite mocks the
 * editor wholesale.
 *
 * Every plaintext assertion has a MARKDOWN twin. Without them the whole file
 * would pass with the guard inverted, or with `applyAsBlocks` running
 * unconditionally — which would be a second, wider corruption.
 */

import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { applySuggestion, rangeText } from "../../src/client/panels/useAnnotationReview.svelte";
import type { Annotation } from "../../src/shared/types";

function suggestion(from: number, to: number, suggestedText: string): Annotation {
  return {
    id: "a1",
    type: "comment",
    author: "claude",
    status: "pending",
    text: "why",
    suggestedText,
    createdAt: 0,
    range: { from, to },
  } as Annotation;
}

/**
 * Block-and-inline shape, with `hardBreak` distinguishable from text — the whole
 * point here is telling a break apart from a boundary, and `getText()` cannot.
 */
function shape(editor: Editor): string {
  return (editor.getJSON().content ?? [])
    .map(
      (b) =>
        `${b.type}(${(b.content ?? [])
          .map((c) => (c.type === "text" ? JSON.stringify(c.text) : `<${c.type}>`))
          .join("+")})`,
    )
    .join(" ");
}

describe("#1460: a multi-line suggestion in a plaintext document", () => {
  let ydoc: Y.Doc;
  let editor: Editor;

  beforeEach(() => {
    ydoc = new Y.Doc();
    editor = new Editor({
      extensions: buildSchemaExtensions(),
      content: "<p>hello world</p>",
    });
  });
  afterEach(() => {
    editor.destroy();
    ydoc.destroy();
  });

  it("becomes two paragraphs in a .txt document", () => {
    expect(applySuggestion(suggestion(0, 11, "one\ntwo"), editor, ydoc, "txt")).toBe(true);
    expect(shape(editor)).toBe('paragraph("one") paragraph("two")');
  });

  it("becomes hard breaks in a .md document — the negative control", () => {
    // The #1477 behaviour, unchanged. Markdown CAN represent an intra-paragraph
    // break, so converting it to a boundary there would invent a paragraph.
    expect(applySuggestion(suggestion(0, 11, "one\ntwo"), editor, ydoc, "md")).toBe(true);
    expect(shape(editor)).toBe('paragraph("one"+<hardBreak>+"two")');
  });

  it("becomes hard breaks when no format is supplied at all", () => {
    // The guard fails OPEN: an unknown format leaves accept exactly as it was,
    // rather than restructuring a document on a guess. `undefined` reaches here
    // whenever no tab is active.
    applySuggestion(suggestion(0, 11, "one\ntwo"), editor, ydoc, undefined);
    expect(shape(editor)).toBe('paragraph("one"+<hardBreak>+"two")');
  });

  it("covers every plaintext-routed format, not just .txt", () => {
    // `getAdapter` falls back to `plaintextAdapter` for anything that is not `md`
    // or `docx`, so the defect is not a property of the `.txt` extension. A guard
    // keyed on the literal string would have looked right and covered one case.
    for (const format of ["html", "log", "csv", "conf"]) {
      const local = new Editor({
        extensions: buildSchemaExtensions(),
        content: "<p>hello world</p>",
      });
      applySuggestion(suggestion(0, 11, "one\ntwo"), local, ydoc, format);
      expect(shape(local), format).toBe('paragraph("one") paragraph("two")');
      local.destroy();
    }
  });

  it("keeps the untouched remainder of the paragraph on the last line", () => {
    // A partial replacement. The tail has to ride on the SECOND paragraph — an
    // open slice merges at both ends, so "world" joins "two" rather than being
    // orphaned into a third block or left stranded on the first.
    applySuggestion(suggestion(0, 5, "one\ntwo"), editor, ydoc, "txt");
    expect(shape(editor)).toBe('paragraph("one") paragraph("two world")');
  });

  it("keeps the leading remainder on the first line", () => {
    applySuggestion(suggestion(6, 11, "one\ntwo"), editor, ydoc, "txt");
    expect(shape(editor)).toBe('paragraph("hello one") paragraph("two")');
  });

  it("makes an empty line an empty paragraph rather than dropping it", () => {
    // Two consecutive newlines are three lines, and a zero-length text node is
    // invalid in ProseMirror — so the middle line has to be a childless
    // paragraph. Dropping it would delete a line the suggestion asked for.
    applySuggestion(suggestion(0, 11, "a\n\nb"), editor, ydoc, "txt");
    expect(shape(editor)).toBe('paragraph("a") paragraph() paragraph("b")');
  });

  it("splits on CRLF and on a bare CR, not only on LF", () => {
    // A suggestion string is not guaranteed LF-only, and `toLf` collapses all
    // three at save — so all three would reach the file as a break.
    applySuggestion(suggestion(0, 11, "a\r\nb\rc"), editor, ydoc, "txt");
    expect(shape(editor)).toBe('paragraph("a") paragraph("b") paragraph("c")');
  });

  it("leaves a single-line suggestion on the inline path", () => {
    // The guard is keyed on the text containing a newline, not on the format
    // alone: with no break there is nothing to restructure, and routing it
    // through `applyAsBlocks` would replace a paragraph with an identical one
    // and needlessly re-stamp authorship over it.
    applySuggestion(suggestion(0, 11, "goodbye"), editor, ydoc, "txt");
    expect(shape(editor)).toBe('paragraph("goodbye")');
  });

  it("carries the surrounding marks onto every line", () => {
    // `insertContentAt`'s mark inheritance does not apply to a hand-built slice,
    // so without an explicit stamp the SAME suggestion kept its bold on one line
    // and lost it on two — the #1477 failure again, in the new path.
    const bold = new Editor({
      extensions: buildSchemaExtensions(),
      content: "<p><strong>aXXXb</strong></p>",
    });
    applySuggestion(suggestion(1, 4, "Y\nZ"), bold, ydoc, "txt");
    expect(bold.getHTML()).toBe("<p><strong>aY</strong></p><p><strong>Zb</strong></p>");
    bold.destroy();
  });

  it("reads back as the suggestion the undo guard compares against", () => {
    // Undo re-reads the range and bails unless it matches `suggestedText`. That
    // comparison is only well-founded if accept and the guard agree on how a
    // BLOCK BOUNDARY projects to a flat string — a boundary the accept path
    // invented. Calls the product's `rangeText`, not an inline `textBetween`.
    const text = "alpha\nbravo\ncharlie";
    applySuggestion(suggestion(0, 11, text), editor, ydoc, "txt");
    expect(rangeText(editor, 0, editor.state.doc.content.size)).toBe(text);
  });

  it("is byte-identical to the hard-break version — which is the whole defect", () => {
    // The discriminating case. Both editors serialize to the same flat text, so
    // no assertion about characters could ever have caught this; only the
    // STRUCTURE differs, and only the structure survives a reopen. This is what
    // makes the fix safe (no byte moves, so no annotation offset moves) and what
    // made the bug invisible.
    const asBlocks = new Editor({
      extensions: buildSchemaExtensions(),
      content: "<p>hello world</p>",
    });
    const asBreaks = new Editor({
      extensions: buildSchemaExtensions(),
      content: "<p>hello world</p>",
    });
    applySuggestion(suggestion(0, 11, "one\ntwo"), asBlocks, ydoc, "txt");
    applySuggestion(suggestion(0, 11, "one\ntwo"), asBreaks, ydoc, "md");

    expect(rangeText(asBlocks, 0, asBlocks.state.doc.content.size)).toBe(
      rangeText(asBreaks, 0, asBreaks.state.doc.content.size),
    );
    expect(shape(asBlocks)).not.toBe(shape(asBreaks));
    asBlocks.destroy();
    asBreaks.destroy();
  });
});

describe("#1460: a code block in a plaintext document is exempt", () => {
  let ydoc: Y.Doc;
  let editor: Editor;

  beforeEach(() => {
    ydoc = new Y.Doc();
    editor = new Editor({
      extensions: buildSchemaExtensions(),
      content: "<pre><code>old</code></pre>",
    });
  });
  afterEach(() => {
    editor.destroy();
    ydoc.destroy();
  });

  it("still stores newlines literally rather than splitting into paragraphs", () => {
    // Exempt on both counts: a code block stores newlines literally, so there is
    // no representation mismatch to fix, and splitting one would shred it into
    // unrelated paragraphs. `flattenPlaintextBreaks` excludes `codeBlock` for the
    // same reason — the two halves of the fix agree.
    applySuggestion(suggestion(0, 3, "line1\nline2"), editor, ydoc, "txt");
    expect(shape(editor)).toBe('codeBlock("line1\\nline2")');
  });
});
