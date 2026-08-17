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
    // A Range is what makes this work: the `<br>` sits inside `<em>`, and
    // `extractContents` splits the partially contained element so the tail keeps
    // its emphasis. Reparenting children by hand would flatten it and silently
    // drop the formatting on "c".
    expect(splitPastedHardBreaks("<p>a<em>b<br>c</em>d</p>")).toBe(
      "<p>a<em>b</em></p><p><em>c</em>d</p>",
    );
  });

  it("clones the block type, so a heading splits into two headings", () => {
    expect(splitPastedHardBreaks("<h2>a<br>b</h2>")).toBe("<h2>a</h2><h2>b</h2>");
  });

  it("wraps top-level halves in paragraphs when there is no block to clone", () => {
    expect(splitPastedHardBreaks("alpha<br>bravo")).toBe("<p>alpha</p><p>bravo</p>");
  });

  it("leaves markup with no break untouched", () => {
    expect(splitPastedHardBreaks("<p>alpha</p>")).toBe("<p>alpha</p>");
  });

  it("splits a break inside a list item into two items", () => {
    expect(splitPastedHardBreaks("<ul><li>a<br>b</li></ul>")).toBe("<ul><li>a</li><li>b</li></ul>");
  });
});
