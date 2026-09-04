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

import { render } from "@testing-library/svelte";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import {
  applySuggestion,
  rangeText,
  useAnnotationReview,
} from "../../src/client/panels/useAnnotationReview.svelte";
import UseAnnotationReviewHarness from "../../src/client/svelte-harness/UseAnnotationReviewHarness.svelte";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants";
import type { Annotation } from "../../src/shared/types";

function suggestion(from: number, to: number, suggestedText: string): Annotation {
  return {
    id: "a1",
    type: "comment",
    author: "claude",
    status: "pending",
    content: "why",
    suggestedText,
    timestamp: 0,
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
        // v3: `NodeType.type` is `string`, so `c.type === "text"` no longer
        // narrows the `NodeType | TextType` union — presence-narrow instead.
        `${b.type}(${(b.content ?? [])
          .map((c) =>
            "text" in c && typeof c.text === "string" ? JSON.stringify(c.text) : `<${c.type}>`,
          )
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

  it("keeps the host block's TYPE and attributes", () => {
    // Not a hardcoded paragraph. A heading rebuilt as a paragraph loses its `#`
    // run on save — the same defect the server's flatten had when it built bare
    // elements, and the same class as #1448's table-alignment loss.
    //
    // A heading also COLLAPSES rather than splitting, matching the server:
    // `extractText` maps a heading's newlines to spaces, so a two-line heading
    // serializes as `## one two` and splitting would invent a heading and a line
    // the file will not contain.
    const h = new Editor({
      extensions: buildSchemaExtensions(),
      content: "<h2>hello world</h2>",
    });
    // Flat offsets INCLUDE the heading prefix, so the text spans 3..14, not 0..11.
    applySuggestion(suggestion(3, 14, "one\ntwo"), h, ydoc, "txt");
    expect(shape(h)).toBe('heading("one two")');
    expect(h.getJSON().content?.[0]?.attrs?.level, "still an h2").toBe(2);
    h.destroy();
  });

  it("DECLINES to split inside a list item, falling back to a hard break", () => {
    // Splitting is only correct where the receiving textblock is a direct child of
    // the doc — the same predicate and the same measured reason as the undo path's
    // `canRestoreBlockBoundary`: inside a list item a split yields ONE item holding
    // two paragraphs where two items belong. The undo path has refused this since
    // #1486 while accept did not, so two halves of one feature disagreed about the
    // same document shape. Found in review.
    //
    // A hardBreak there is no NEW loss: a plaintext file cannot represent the list
    // at all, so the structure goes on the next reload regardless.
    const list = new Editor({
      extensions: buildSchemaExtensions(),
      content: "<ul><li><p>hello world</p></li></ul>",
    });
    applySuggestion(suggestion(0, 11, "one\ntwo"), list, ydoc, "txt");
    expect(list.getHTML()).toBe("<ul><li><p>one<br>two</p></li></ul>");
    list.destroy();
  });

  it("succeeds — not a decline — when the range spans two EXISTING top-level paragraphs", () => {
    // Distinct from every other case in this file: those all start from ONE
    // existing paragraph and split IT into two. Here the suggestion's range
    // already crosses a pre-existing block boundary before accept even runs.
    // `canRestoreBlockBoundary` only inspects `from`'s depth — `from` here is
    // depth 1 (a direct child of the doc), so this does NOT decline the way
    // the list-item case above does; it merges two ProseMirror `replace` calls
    // across the boundary. Found and verified empirically in plan review —
    // do not "fix" this test to assert a decline, that is not what happens.
    const twoBlocks = new Editor({
      extensions: buildSchemaExtensions(),
      content: "<p>AAAA</p><p>BBBB</p>",
    });
    // Flat text is "AAAA\nBBBB" (the block join renders as "\n", same as
    // extractText server-side). Range [2,7) = "AA\nBB".
    expect(applySuggestion(suggestion(2, 7, "one\ntwo"), twoBlocks, ydoc, "txt")).toBe(true);
    expect(shape(twoBlocks)).toBe('paragraph("AAone") paragraph("twoBB")');
    twoBlocks.destroy();
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

describe("#1460: undo still recognises what accept wrote", () => {
  /**
   * Undo gates on `rangeText(from,to) === suggestedText` and declines when they
   * differ. The heading branch means accept no longer writes `suggestedText`
   * verbatim — it writes the lines joined with spaces — so the `"\n"` the guard
   * looks for is gone from the document forever and the decline is PERMANENT while
   * taking the transient path: a live-looking Undo button that silently does
   * nothing, and no toast. Found in review, and it was a regression this fix caused
   * rather than one it inherited.
   *
   * Driven through the real hook rather than through `applySuggestion`, because the
   * defect lives in the relationship between the two halves.
   */
  function setup(html: string, ann: Annotation, format: string) {
    const ydoc = new Y.Doc();
    ydoc.getMap<Annotation>(Y_MAP_ANNOTATIONS).set(ann.id, ann);
    const editor = new Editor({ extensions: buildSchemaExtensions(), content: html });
    let api: ReturnType<typeof useAnnotationReview> | undefined;
    render(UseAnnotationReviewHarness, {
      props: {
        params: {
          getYdoc: () => ydoc,
          getEditor: () => editor,
          getAnnotations: () => [ann],
          onActiveAnnotationChange: () => {},
          getScrollBehavior: () => "auto" as ScrollBehavior,
          getFormat: () => format,
        },
        onReady: (returned: ReturnType<typeof useAnnotationReview>) => (api = returned),
      },
    });
    if (!api) throw new Error("useAnnotationReview did not report ready");
    return { editor, review: api };
  }

  it("undoes a COLLAPSED heading accept", () => {
    const ann = {
      id: "a1",
      type: "comment",
      author: "claude",
      status: "accepted",
      content: "why",
      suggestedText: "one\ntwo",
      textSnapshot: "hello world",
      timestamp: 0,
      // Flat offsets include the `## ` prefix; the accepted text is `one two`.
      range: { from: 3, to: 10 },
    } as Annotation;
    const { editor, review } = setup("<h2>one two</h2>", ann, "txt");

    expect(review.undoResolveAnnotation("a1"), "undo succeeded").toBe(true);
    expect(editor.getHTML()).toBe("<h2>hello world</h2>");
    editor.destroy();
  });

  it("undoes a CRLF suggestion, whose accepted text is normalized too", () => {
    // The same class, and wrong before the heading branch existed: the flat
    // projection spells every line ending `"\n"`, so a suggestion carrying
    // `"\r\n"` never matched its own accepted text either.
    const ann = {
      id: "a1",
      type: "comment",
      author: "claude",
      status: "accepted",
      content: "why",
      suggestedText: "one\r\ntwo",
      textSnapshot: "hello world",
      timestamp: 0,
      range: { from: 0, to: 7 },
    } as Annotation;
    const { editor, review } = setup("<p>one</p><p>two</p>", ann, "txt");

    expect(review.undoResolveAnnotation("a1"), "undo succeeded").toBe(true);
    expect(editor.getHTML()).toBe("<p>hello world</p>");
    editor.destroy();
  });

  it("restores a multi-line ORIGINAL as blocks, not as a literal newline", () => {
    // Undo's other half of #1460. `textSnapshot` here carries a `"\n"` and NO
    // recorded structure — a record written before #1486, or one whose range was
    // relocated so the offsets no longer land on newlines. The inline branch would
    // put that `"\n"` back as a literal newline inside one paragraph: the forbidden
    // shape, restored by the feature whose job is to put the document back. Found
    // in review.
    const ann = {
      id: "a1",
      type: "comment",
      author: "claude",
      status: "accepted",
      content: "why",
      suggestedText: "MERGED",
      textSnapshot: "first line\nsecond line",
      timestamp: 0,
      range: { from: 0, to: 6 },
    } as Annotation;
    const { editor, review } = setup("<p>MERGED</p>", ann, "txt");

    expect(review.undoResolveAnnotation("a1")).toBe(true);
    expect(editor.getHTML()).toBe("<p>first line</p><p>second line</p>");
    editor.destroy();
  });

  it("leaves the same restore as a hard break in MARKDOWN — the control", () => {
    // Markdown can spell an intra-paragraph break, and with no recorded structure
    // the existing behaviour is a literal newline (a soft wrap). Turning that into
    // a paragraph split would be a change of its own, in the format that can
    // actually represent the difference.
    const ann = {
      id: "a1",
      type: "comment",
      author: "claude",
      status: "accepted",
      content: "why",
      suggestedText: "MERGED",
      textSnapshot: "first line\nsecond line",
      timestamp: 0,
      range: { from: 0, to: 6 },
    } as Annotation;
    const { editor, review } = setup("<p>MERGED</p>", ann, "md");

    expect(review.undoResolveAnnotation("a1")).toBe(true);
    expect(editor.state.doc.content.childCount, "still one paragraph").toBe(1);
    editor.destroy();
  });

  it("still refuses when the text really did change — the control", () => {
    // Without this, the two above could pass with the guard deleted outright,
    // which would make undo destructive rather than declining.
    const ann = {
      id: "a1",
      type: "comment",
      author: "claude",
      status: "accepted",
      content: "why",
      suggestedText: "one\ntwo",
      textSnapshot: "hello world",
      timestamp: 0,
      range: { from: 3, to: 10 },
    } as Annotation;
    const { editor, review } = setup("<h2>edited since</h2>", ann, "txt");

    expect(review.undoResolveAnnotation("a1")).toBe(false);
    expect(editor.getHTML(), "document untouched").toBe("<h2>edited since</h2>");
    editor.destroy();
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
    // Exempt here: a code block stores a typed/accepted newline literally, so
    // there is no representation mismatch to fix at this point, and splitting
    // one would shred it into unrelated paragraphs. This is NOT the same
    // decision `flattenPlaintextBreaks` makes at Save-As promotion — that path
    // DOES split an existing code block's literal newlines into paragraphs,
    // because by then those newlines are already N lines on disk. Both are
    // correct; they answer different questions (see plaintext-breaks.ts).
    applySuggestion(suggestion(0, 3, "line1\nline2"), editor, ydoc, "txt");
    expect(shape(editor)).toBe('codeBlock("line1\\nline2")');
  });
});
