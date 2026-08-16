// @vitest-environment happy-dom

/**
 * Accepting a suggestion inserts `suggestedText` LITERALLY (#1477).
 *
 * `insertContentAt(pos, someString)` does not insert that string — Tiptap wraps
 * it in `<body>` and runs `DOMParser`, so the argument is parsed as HTML. Two
 * corruptions followed, both through the primary review action and both silent:
 *
 *   - a suggestion that merely MENTIONED markup was parsed as markup: `<div>`
 *     SPLIT THE PARAGRAPH IN TWO and `<b>` became a real bold mark;
 *   - every newline arrived as a literal "\n" inside a text node rather than a
 *     `hardBreak`. `suggestedText` spells a hard break "\n" (the
 *     `getElementText()` convention), and a literal newline in a paragraph is
 *     how this editor represents a SOFT WRAP — so accepting a suggestion over a
 *     multi-line paragraph silently downgraded every hard break to a soft one,
 *     which renders differently.
 *
 * MEASUREMENT NOTE, because it cost a wrong issue body: probing this with
 * `createNodeFromContent` in isolation gives DIFFERENT answers than the
 * shipping path — a collapsed space, and decoded entities. Neither happens
 * through a real editor, whose paragraph carries `whitespace: "pre"` (#1461).
 * Entities are NOT decoded here. Measure through the Editor or not at all.
 *
 * These drive a LIVE Tiptap editor through the exported `applySuggestion`,
 * because the defect lives in what Tiptap does with the argument. The hook's
 * own suite mocks the editor wholesale and cannot see it — the same reason
 * #1388 shipped past it.
 */

import { render } from "@testing-library/svelte";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { literalInlineContent } from "../../src/client/editor/utils/literal-content";
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
    text: "why",
    suggestedText,
    createdAt: 0,
    range: { from, to },
  } as Annotation;
}

/** Inline shape of the first block, with hardBreak distinguishable from text. */
function inlineShape(editor: Editor): string {
  const doc = editor.getJSON();
  const blocks = doc.content ?? [];
  return blocks
    .map(
      (b) =>
        `${b.type}(${(b.content ?? [])
          .map((c) =>
            c.type === "text"
              ? `${JSON.stringify(c.text)}${c.marks?.length ? `^${c.marks.map((m) => m.type).join(",")}` : ""}`
              : `<${c.type}>`,
          )
          .join("+")})`,
    )
    .join(" ");
}

describe("#1477: accepting inserts the suggestion literally", () => {
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

  it("a plain replacement still works (positive control)", () => {
    // Without this, every assertion below could be passing because the accept
    // silently did nothing at all.
    expect(applySuggestion(suggestion(0, 11, "goodbye world"), editor, ydoc)).toBe(true);
    expect(inlineShape(editor)).toBe('paragraph("goodbye world")');
  });

  it("a newline becomes a hard break, not a literal newline", () => {
    // Before the fix: paragraph("one\ntwo") — one text node holding a literal
    // newline, which this editor treats as a SOFT wrap and the serializer
    // writes back without the trailing backslash. The break is gone from the
    // file even though the characters survive.
    applySuggestion(suggestion(0, 11, "one\ntwo"), editor, ydoc);
    expect(inlineShape(editor)).toBe('paragraph("one"+<hardBreak>+"two")');
  });

  it("several newlines each become their own break", () => {
    applySuggestion(suggestion(0, 11, "a\nb\nc"), editor, ydoc);
    expect(inlineShape(editor)).toBe('paragraph("a"+<hardBreak>+"b"+<hardBreak>+"c")');
  });

  it("markup in the suggestion is text, not markup", () => {
    // Before the fix this split the paragraph in two.
    applySuggestion(suggestion(0, 11, "use <div> for layout"), editor, ydoc);
    expect(inlineShape(editor)).toBe('paragraph("use <div> for layout")');
  });

  it("an inline tag does not become a mark", () => {
    // Before the fix: text carrying a real bold mark.
    applySuggestion(suggestion(0, 11, "<b>bold</b> text"), editor, ydoc);
    expect(inlineShape(editor)).toBe('paragraph("<b>bold</b> text")');
  });

  it("an HTML entity survives — as it already did (regression guard, not a fix)", () => {
    // Deliberately labelled: this passes BEFORE the fix too. An isolated
    // `createNodeFromContent` probe decodes this to "AT&T", which is what put a
    // wrong claim in #1477's original body; the shipping path never did. Kept
    // as a guard so the new JSON path cannot start decoding, but it is not
    // evidence for the fix and must not be read as such.
    applySuggestion(suggestion(0, 11, "AT&amp;T"), editor, ydoc);
    expect(inlineShape(editor)).toBe('paragraph("AT&amp;T")');
  });

  it("an empty suggestion deletes the range without inserting anything", () => {
    // `insertContentAt` with an empty array returns null and logs a Tiptap
    // warning, so the insert has to be skipped rather than passed through.
    expect(applySuggestion(suggestion(0, 11, ""), editor, ydoc)).toBe(true);
    expect(inlineShape(editor)).toBe("paragraph()");
  });

  it("the accepted text reads back as the suggestion the guard compares against", () => {
    // Undo re-reads the range and bails if it does not match `suggestedText`.
    // That comparison is only well-founded if accept and the guard agree on how
    // a hard break projects — so this pins the two halves together.
    //
    // Calls the PRODUCT's `rangeText`, not an inline `textBetween`. An earlier
    // version of this test inlined it and therefore asserted a property of
    // ProseMirror: revert the guard to a bare `textBetween` and it stayed green.
    const text = "alpha\nbravo\ncharlie";
    applySuggestion(suggestion(0, 11, text), editor, ydoc);
    expect(rangeText(editor, 0, editor.state.doc.content.size)).toBe(text);
  });

  it("keeps the surrounding marks whether or not the suggestion has a newline", () => {
    // `insertContentAt` branches on `isOnlyTextContent`: one unmarked text node
    // goes through `tr.insertText`, which inherits marks across the range, and
    // anything else through `tr.replaceWith`, which does not. A newline is
    // exactly what moves this content from the first shape to the second — so
    // without an explicit mark stamp the SAME suggestion kept its bold on one
    // line and silently lost it on two, all the way to disk.
    const bold = () =>
      new Editor({ extensions: buildSchemaExtensions(), content: "<p><strong>aXXXb</strong></p>" });

    const one = bold();
    applySuggestion(suggestion(1, 4, "Y"), one, ydoc);
    expect(one.getHTML(), "single line").toBe("<p><strong>aYb</strong></p>");
    one.destroy();

    const two = bold();
    applySuggestion(suggestion(1, 4, "Y\nZ"), two, ydoc);
    expect(two.getHTML(), "with a newline").toBe(
      "<p><strong>aY</strong><br><strong>Zb</strong></p>",
    );
    two.destroy();
  });
});

describe("#1477: code blocks store a newline as a newline", () => {
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

  it("inserts literal newlines rather than schema-invalid break nodes", () => {
    // `codeBlock` declares `code: true` and its content expression does not
    // admit `hardBreak`, so emitting breaks here would build invalid content.
    // A newline in a code block is genuinely a newline.
    applySuggestion(suggestion(0, 3, "line1\nline2"), editor, ydoc);
    expect(inlineShape(editor)).toBe('codeBlock("line1\\nline2")');
  });
});

describe("#1477: undoing an accept restores the breaks it recorded", () => {
  /**
   * Undo is the half the accept-only tests above cannot reach, and the diff
   * changed it in three independent ways (the staleness guard's projection, the
   * literal restore, and the empty-content skip). It needs the real hook, so
   * this mounts it through the Svelte harness the way the hook's own suite does.
   */
  function mountReview(params: Parameters<typeof useAnnotationReview>[0]) {
    let api: ReturnType<typeof useAnnotationReview> | undefined;
    render(UseAnnotationReviewHarness, {
      props: { params, onReady: (returned) => (api = returned) },
    });
    if (!api) throw new Error("useAnnotationReview did not report ready");
    return api;
  }

  function setup(html: string, ann: Annotation) {
    const ydoc = new Y.Doc();
    ydoc.getMap(Y_MAP_ANNOTATIONS).set(ann.id, ann);
    const editor = new Editor({ extensions: buildSchemaExtensions(), content: html });
    const review = mountReview({
      getYdoc: () => ydoc,
      getEditor: () => editor,
      getAnnotations: () => [ann],
      onActiveAnnotationChange: () => {},
      getScrollBehavior: () => "auto",
    });
    return { ydoc, editor, review };
  }

  it("puts back a multi-line snapshot as hard breaks, not a soft wrap", () => {
    // The round trip that matters: accept replaced a break-bearing paragraph,
    // undo has to restore one. Through a raw string the restore produced a
    // literal newline — a soft wrap — so the `\` never came back to the file
    // even though the characters did.
    const ann = {
      id: "u1",
      type: "comment",
      author: "claude",
      status: "accepted",
      text: "why",
      suggestedText: "one\ntwo",
      textSnapshot: "alpha\nbravo",
      createdAt: 0,
      range: { from: 0, to: 7 },
    } as Annotation;
    const { editor, review } = setup("<p>one<br>two</p>", ann);

    expect(review.undoResolveAnnotation("u1")).toBe(true);
    expect(inlineShape(editor)).toBe('paragraph("alpha"+<hardBreak>+"bravo")');
  });

  it("declines when the text changed since accept", () => {
    // The guard's whole job. Pinned because `rangeText`'s separators are what
    // make the comparison well-founded — a projection mismatch would make this
    // decline on EVERY multi-line accept instead of only edited ones.
    const ann = {
      id: "u2",
      type: "comment",
      author: "claude",
      status: "accepted",
      text: "why",
      suggestedText: "one\ntwo",
      textSnapshot: "alpha\nbravo",
      createdAt: 0,
      range: { from: 0, to: 7 },
    } as Annotation;
    const { editor, review } = setup("<p>edited since</p>", ann);

    expect(review.undoResolveAnnotation("u2")).toBe(false);
    expect(inlineShape(editor)).toBe('paragraph("edited since")');
  });

  it("an empty snapshot deletes the accepted text without inserting", () => {
    const ann = {
      id: "u3",
      type: "comment",
      author: "claude",
      status: "accepted",
      text: "why",
      suggestedText: "one",
      textSnapshot: "",
      createdAt: 0,
      range: { from: 0, to: 3 },
    } as Annotation;
    const { editor, review } = setup("<p>one</p>", ann);

    expect(review.undoResolveAnnotation("u3")).toBe(true);
    expect(inlineShape(editor)).toBe("paragraph()");
  });
});

describe("literalInlineContent", () => {
  it("splits on every line-ending convention", () => {
    for (const nl of ["\n", "\r\n", "\r"]) {
      expect(literalInlineContent(`a${nl}b`), nl).toEqual([
        { type: "text", text: "a" },
        { type: "hardBreak" },
        { type: "text", text: "b" },
      ]);
    }
  });

  it("keeps a leading or trailing newline as a break with no empty text node", () => {
    // A zero-length text node is invalid in ProseMirror, so the break has to
    // survive without one beside it.
    expect(literalInlineContent("\nb")).toEqual([
      { type: "hardBreak" },
      { type: "text", text: "b" },
    ]);
    expect(literalInlineContent("a\n")).toEqual([
      { type: "text", text: "a" },
      { type: "hardBreak" },
    ]);
  });

  it("turns a run of newlines into that many breaks", () => {
    expect(literalInlineContent("\n\n")).toEqual([{ type: "hardBreak" }, { type: "hardBreak" }]);
  });

  it("returns an empty array for empty text", () => {
    expect(literalInlineContent("")).toEqual([]);
    expect(literalInlineContent("", true)).toEqual([]);
  });

  it("leaves newlines alone in code mode", () => {
    expect(literalInlineContent("a\nb", true)).toEqual([{ type: "text", text: "a\nb" }]);
  });
});
