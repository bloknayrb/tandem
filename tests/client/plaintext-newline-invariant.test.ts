// @vitest-environment happy-dom

/**
 * A plaintext document's textblocks must hold no newline (#1460).
 *
 * `.txt` and friends load one block per line and save by joining blocks with
 * `\n`, so a newline INSIDE a block is a shape the file cannot spell — the bytes
 * say two lines, the model says one block, and the next open believes the bytes.
 * The paragraph you saved comes back as two.
 *
 * Two doorways reach it by hand, and BOTH produce a `hardBreak`, which
 * `extractText` renders as `"\n"`:
 *
 *   1. Shift+Enter — `extensions/plaintext-breaks.ts`
 *   2. A `<br>` on the clipboard — `utils/paste-breaks.ts`
 *
 * Doorway 2 is the one that stayed open longest and it is the more common of the
 * two: it needs no intent at all, because every ordinary Ctrl+V from a web page
 * or Word carries `text/html`. The guard already in place
 * (`txt-intra-paragraph-newline.test.ts`) collapses a literal NEWLINE inside a
 * pasted `<p>` and says nothing about `<br>` — a `<br>` is not whitespace, so
 * the whitespace normalizer had no reason to touch it.
 *
 * Every plaintext assertion below is paired with a MARKDOWN one. Without that
 * pairing, a "fix" that simply killed hard breaks everywhere would pass this
 * whole file while destroying the soft-wrap/hard-break distinction #1448 exists
 * to preserve.
 */

import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { makeEditorProps } from "../../src/client/editor/editor-props";
import { PlaintextBreaksExtension } from "../../src/client/editor/extensions/plaintext-breaks";
import { splitPastedHardBreaks } from "../../src/client/editor/utils/paste-breaks";
import { isPlaintextFormat } from "../../src/shared/plaintext-format";

/**
 * A live `EditorView` leaves a `DOMObserver` flush pending on a timer; left
 * undestroyed it fires after happy-dom tears down `document` and vitest reports
 * `ReferenceError: document is not defined` as an unhandled error with every
 * test green and a non-zero exit.
 */
const live: Editor[] = [];
afterEach(() => {
  while (live.length > 0) live.pop()?.destroy();
});

/** An editor wired the way `Editor.svelte` wires one, for `format`. */
function editorFor(format: string | undefined, content = "<p>alpha</p>"): Editor {
  const editor = new Editor({
    extensions: [
      ...buildSchemaExtensions(),
      PlaintextBreaksExtension.configure({ getFormat: () => format }),
    ],
    editorProps: makeEditorProps(true, () => format),
    content,
  });
  live.push(editor);
  return editor;
}

function countHardBreaks(editor: Editor): number {
  let n = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "hardBreak") n += 1;
  });
  return n;
}

/** Every block's text, rendering a hardBreak and a literal newline alike. */
function blockTexts(editor: Editor): string[] {
  return editor.state.doc.content.content.map((node) =>
    node.textBetween(0, node.content.size, "\n", "\n"),
  );
}

describe("isPlaintextFormat", () => {
  it("treats every format except md and docx as plaintext", () => {
    // Phrased as a denylist on purpose: the plaintext set is `getAdapter`'s `??`
    // fallback and therefore open-ended, so an allowlist would silently exclude
    // the next extension someone adds.
    expect(isPlaintextFormat("txt")).toBe(true);
    expect(isPlaintextFormat("html")).toBe(true);
    expect(isPlaintextFormat("log")).toBe(true);
    expect(isPlaintextFormat("md")).toBe(false);
    expect(isPlaintextFormat("docx")).toBe(false);
  });

  it("reads a missing format as NOT plaintext", () => {
    // Fails open. An un-split hardBreak is a structural difference the user sees
    // at next open; a wrong split is an edit to a document nobody asked for.
    expect(isPlaintextFormat(undefined)).toBe(false);
    expect(isPlaintextFormat(null)).toBe(false);
    expect(isPlaintextFormat("")).toBe(false);
  });
});

describe("#1460 doorway 1: Shift+Enter", () => {
  it("splits the block in a plaintext document instead of inserting a break", () => {
    const editor = editorFor("txt");
    editor.commands.setTextSelection(6); // end of "alpha"
    const handled = editor.commands.keyboardShortcut("Shift-Enter");

    expect(handled, "the keystroke was claimed").toBe(true);
    expect(countHardBreaks(editor), "no hardBreak anywhere").toBe(0);
    expect(editor.state.doc.content.childCount, "two blocks").toBe(2);
  });

  it("still inserts a hardBreak in a MARKDOWN document", () => {
    // The positive control. Markdown can spell the difference — a trailing `\`
    // is a hard break, a bare wrap is soft — so destroying it here would undo
    // #1448.
    const editor = editorFor("md");
    editor.commands.setTextSelection(6);
    editor.commands.keyboardShortcut("Shift-Enter");

    expect(countHardBreaks(editor), "the break survives").toBe(1);
    expect(editor.state.doc.content.childCount, "still one block").toBe(1);
  });

  it("is inert when the format is unknown", () => {
    const editor = editorFor(undefined);
    editor.commands.setTextSelection(6);
    editor.commands.keyboardShortcut("Shift-Enter");

    expect(countHardBreaks(editor)).toBe(1);
  });

  it("handles Mod+Enter the same way", () => {
    // A separately-reachable keystroke that HardBreak also binds. It had no test
    // at all: deleting the `"Mod-Enter"` line left the suite green. Found in
    // review.
    const editor = editorFor("txt");
    editor.commands.setTextSelection(6);
    expect(editor.commands.keyboardShortcut("Mod-Enter")).toBe(true);
    expect(countHardBreaks(editor)).toBe(0);
    expect(editor.state.doc.content.childCount).toBe(2);
  });

  it("does NOT claim the keystroke inside a code block", () => {
    // Exempt for the same reason as the other three surfaces: a newline in a code
    // block is genuinely a newline and the node stores it literally. Without the
    // exemption the override was actively harmful rather than redundant —
    // `splitBlock` has no `code` guard, so it SUCCEEDED and cut the code block in
    // two, which also swallowed `Mod-Enter`'s exit-the-block affordance. Found in
    // review.
    const editor = editorFor("txt", "<pre><code>alpha</code></pre>");
    editor.commands.setTextSelection(3);
    editor.commands.keyboardShortcut("Mod-Enter");

    // The keystroke IS claimed, just not by this extension: falling through lets
    // the base keymap's `exitCode` run, which is the affordance the un-exempted
    // version destroyed by splitting the block instead. So the assertion is on the
    // code block being INTACT, not on the return value — an earlier version of
    // this test asserted `false` and was measuring the wrong thing.
    expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");
    expect(editor.state.doc.firstChild?.textContent, "not cut in two").toBe("alpha");
    expect(countHardBreaks(editor)).toBe(0);
  });

  it("reads the format LIVE, so a Save-As promotion is not missed", () => {
    // The entire reason `getFormat` is a getter rather than a value. Save-As
    // promotes IN PLACE — same tab, same editor instance, `format` changes
    // underneath — so a captured value would keep accepting hardBreaks into a
    // document that is now plaintext, which is the guard failing in exactly the
    // case it was added for. Every other test here closes over a `const`, so all
    // of them pass with the getter replaced by a captured string. This one does
    // not. Found in review.
    let format = "md";
    const editor = new Editor({
      extensions: [
        ...buildSchemaExtensions(),
        PlaintextBreaksExtension.configure({ getFormat: () => format }),
      ],
      editorProps: makeEditorProps(true, () => format),
      content: "<p>alpha</p>",
    });
    live.push(editor);

    editor.commands.setTextSelection(6);
    editor.commands.keyboardShortcut("Shift-Enter");
    expect(countHardBreaks(editor), "markdown: a break").toBe(1);

    format = "txt"; // the promotion
    editor.commands.setContent("<p>alpha</p>");
    editor.commands.setTextSelection(6);
    editor.commands.keyboardShortcut("Shift-Enter");
    expect(countHardBreaks(editor), "after promotion: no break").toBe(0);
    expect(editor.state.doc.content.childCount).toBe(2);
  });
});

describe("#1460 doorway 2: a <br> on the clipboard", () => {
  it("becomes a block boundary in a plaintext document", () => {
    const editor = editorFor("txt", "<p></p>");
    const html =
      editor.view.props.transformPastedHTML?.("<p>alpha<br>bravo</p>", editor.view) ?? "";
    editor.commands.setContent(html);

    expect(countHardBreaks(editor), "no hardBreak").toBe(0);
    expect(blockTexts(editor)).toEqual(["alpha", "bravo"]);
  });

  it("survives as a hardBreak in a MARKDOWN document", () => {
    const editor = editorFor("md", "<p></p>");
    const html =
      editor.view.props.transformPastedHTML?.("<p>alpha<br>bravo</p>", editor.view) ?? "";
    editor.commands.setContent(html);

    expect(countHardBreaks(editor), "the break survives").toBe(1);
    expect(blockTexts(editor)).toEqual(["alpha\nbravo"]);
  });

  it("composes with whitespace collapsing without leaving a leading space", () => {
    // This test earned its place: I had the composition order backwards and it
    // said so. Whitespace trimming applies at each BLOCK's edges, so collapsing
    // BEFORE the split leaves the newline after the `<br>` interior to the
    // original paragraph — nothing trims it — and the second half comes out as
    // `" bravo"`, a leading space the user never pasted, which then reaches disk.
    // Splitting first makes each half a block, so both get trimmed.
    const editor = editorFor("txt", "<p></p>");
    const html =
      editor.view.props.transformPastedHTML?.("<p>\n  alpha<br>\n  bravo\n</p>", editor.view) ?? "";
    editor.commands.setContent(html);

    expect(blockTexts(editor)).toEqual(["alpha", "bravo"]);
  });

  it("survives a spellcheck setOptions re-supply", () => {
    // `setOptions({ editorProps })` REPLACES editorProps wholesale rather than
    // merging, so the re-supply in `Editor.svelte` has to pass the format getter
    // again. Drop it there and the paste guard dies silently on the first
    // spellcheck toggle — guard present, correct, and unreachable, which no other
    // test in this file can see. Found in review.
    const editor = editorFor("txt", "<p></p>");
    editor.setOptions({ editorProps: makeEditorProps(false, () => "txt") });

    const html =
      editor.view.props.transformPastedHTML?.("<p>alpha<br>bravo</p>", editor.view) ?? "";
    editor.commands.setContent(html);
    expect(blockTexts(editor)).toEqual(["alpha", "bravo"]);
  });
});

describe("#1460 doorway 3: a text/plain-only paste", () => {
  /** What `clipboardTextParser` builds for `text`, as block texts. */
  function pasteText(editor: Editor, text: string): string[] {
    const slice = editor.view.props.clipboardTextParser?.(
      text,
      editor.state.doc.resolve(1),
      false,
      editor.view,
    );
    if (!slice) return [];
    editor.view.dispatch(editor.state.tr.replaceSelection(slice));
    return blockTexts(editor);
  }

  it("does not leave a hardBreak in a plaintext document", () => {
    // The SIXTH producer, and the one an ordinary Ctrl+V reaches. When the
    // clipboard carries only `text/plain` — a terminal, `less`, a code editor, an
    // OS text field — `transformPastedHTML` never runs at all, and
    // `markdownToSlice` maps markdown break syntax straight onto a `hardBreak`
    // node. The commit that fixed the other five claimed to be the complete set;
    // it was not. Found in review.
    const editor = editorFor("txt", "<p></p>");
    // Markdown-ish input on purpose: `markdownToSlice` returns null for text it
    // does not recognise, and a bare two-liner falls to `buildPlainTextSlice` in
    // BOTH formats — so it cannot discriminate, and an earlier version of this test
    // passed while measuring nothing.
    expect(pasteText(editor, "**bold** alpha  \nbravo")).toEqual(["bold alpha", "bravo"]);
    expect(countHardBreaks(editor)).toBe(0);
  });

  it("keeps the hardBreak in a MARKDOWN document", () => {
    const editor = editorFor("md", "<p></p>");
    expect(pasteText(editor, "**bold** alpha  \nbravo")).toEqual(["bold alpha\nbravo"]);
    expect(countHardBreaks(editor)).toBe(1);
  });

  it("still parses markdown a plaintext document CAN hold", () => {
    // Gated on the slice actually containing a break, not on the format alone, so
    // a heading or a list still arrives as one. Without this the fix would have
    // silently turned off rich markdown paste for every `.txt` document — a
    // behaviour change well beyond the defect.
    const editor = editorFor("txt", "<p></p>");
    pasteText(editor, "## Title\n\nbody");
    expect(editor.state.doc.firstChild?.type.name).toBe("heading");
  });
});

describe("splitPastedHardBreaks", () => {
  it("splits a run of breaks into one block each", () => {
    // Three lines from two breaks. An off-by-one here would silently merge or
    // duplicate a line.
    expect(splitPastedHardBreaks("<p>a<br>b<br>c</p>")).toBe("<p>a</p><p>b</p><p>c</p>");
  });

  it("keeps an empty half rather than collapsing it", () => {
    // `<p><br></p>` is two lines, and two empty paragraphs is two lines.
    // Collapsing would drop one.
    expect(splitPastedHardBreaks("<p><br></p>")).toBe("<p></p><p></p>");
  });

  it("reopens inline markup around the split", () => {
    // The `<br>` sits inside `<em>`, so the walk clones each inline ancestor and
    // the tail keeps its emphasis. Reparenting children in one step would flatten
    // it and silently drop the formatting on "c".
    //
    // This comment used to credit `Range.extractContents` — i.e. the rejected
    // implementation. The product deliberately does not use it: happy-dom's
    // version performs no split, so the whole guard no-opped under test while
    // looking correct, and a rule that cannot be exercised in CI is not a rule.
    expect(splitPastedHardBreaks("<p>a<em>b<br>c</em>d</p>")).toBe(
      "<p>a<em>b</em></p><p><em>c</em>d</p>",
    );
  });

  it("clones the block type, so a list item splits into two items", () => {
    expect(splitPastedHardBreaks("<ul><li>a<br>b</li></ul>")).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("COLLAPSES a heading's break to a space instead of splitting it", () => {
    // This asserted two headings, matching the code at the time, and both were
    // wrong — the Save-As path reached the opposite conclusion for identical
    // content, and only that one had the measurement behind it: `extractText` maps
    // a heading's newlines to spaces, so a two-line heading serializes as
    // `## a b`. Splitting invents a second `## ` line the paste never contained.
    // Same content, two surfaces, one answer. Found in review.
    expect(splitPastedHardBreaks("<h2>a<br>b</h2>")).toBe("<h2>a b</h2>");
  });

  it("COLLAPSES a table cell's break, because splitting one adds a column", () => {
    // Worse than an invented line: `container.after()` on a `<td>` inserts a cell
    // into the ROW, so the row gains a column and ProseMirror's table parser pads
    // every other row with blanks to match. Measured; found in review.
    expect(
      splitPastedHardBreaks("<table><tbody><tr><td>a<br>b</td><td>c</td></tr></tbody></table>"),
    ).toBe("<table><tbody><tr><td>a b</td><td>c</td></tr></tbody></table>");
  });

  it("makes a break inside <pre> a literal newline", () => {
    // The one context where a newline is representable and correct: `<pre>` parses
    // to a `codeBlock`, which stores newlines literally, and the whitespace
    // normalizer treats `PRE` as verbatim so it survives. Splitting turned one
    // pasted code block into two, inside invalid `<p><pre>` wrappers.
    expect(splitPastedHardBreaks("<pre><code>a<br>b</code></pre>")).toBe(
      "<pre><code>a\nb</code></pre>",
    );
  });

  it("does not put block content inside a <p> at the top level", () => {
    // The root branch wraps each half in a paragraph, which is invalid around a
    // block element — and not merely untidy: the next HTML parse auto-closes the
    // `<p>`, leaving an EMPTY paragraph in front of each half. That is a blank line
    // the user never pasted, and it reaches the file. Measured; found in review.
    expect(splitPastedHardBreaks("<ul><li>a</li></ul><br><ul><li>b</li></ul>")).toBe(
      "<ul><li>a</li></ul><ul><li>b</li></ul>",
    );
  });

  it("wraps top-level halves in paragraphs when they are inline", () => {
    expect(splitPastedHardBreaks("alpha<br>bravo")).toBe("<p>alpha</p><p>bravo</p>");
  });

  it("does not put a newline inside an INLINE code span", () => {
    // `CODE` is deliberately absent from the preformatted set. A bare inline
    // `<code>` lives inside a paragraph, so a newline there would be precisely the
    // intra-block break this module exists to prevent — the `<pre>` exemption must
    // not generalise to it.
    expect(splitPastedHardBreaks("<p>a<code>x<br>y</code>b</p>")).toBe(
      "<p>a<code>x</code></p><p><code>y</code>b</p>",
    );
  });

  it("returns the input unchanged past MAX_SPLITS, deliberately", () => {
    // The bail leaves the breaks in place, so a pathological paste keeps the shape
    // divergence. That is the chosen direction, not an oversight: the cheap
    // alternative (collapse every `<br>` to a space) would destroy the line
    // structure in the FILE, and divergent shape with correct bytes is recoverable
    // where merged lines are not. Cap raised from 5 000 to 20 000 after measuring
    // 286ms there, since a long log pasted from a `<br>`-based viewer can exceed
    // the old figure. Found in review.
    const html = `<p>${Array.from({ length: 20_002 }, (_, i) => `l${i}`).join("<br>")}</p>`;
    expect(splitPastedHardBreaks(html)).toBe(html);
  });

  it("leaves markup with no break untouched", () => {
    expect(splitPastedHardBreaks("<p>alpha</p>")).toBe("<p>alpha</p>");
  });
});
