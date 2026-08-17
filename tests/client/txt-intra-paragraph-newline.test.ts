// @vitest-environment happy-dom

/**
 * No paste may put a literal newline INSIDE a paragraph (#1460).
 *
 * `.txt` load and save are inverses only while that holds. `populateYDoc` makes
 * one paragraph per line and `extractText` joins blocks with `"\n"`, so a
 * paragraph carrying its own newline reopens as two paragraphs. The bytes are
 * unaffected either way — that is measured in
 * `tests/server/txt-byte-fidelity.test.ts` — so this was never file corruption;
 * it is the editor showing a different shape than the one you saved.
 *
 * #1460 was filed believing plain-text paste was a live doorway to it. It is
 * not, and neither is rich paste — `buildPlainTextSlice` splits on newline runs
 * and `normalizePastedHtmlWhitespace` collapses them to a space. Both were
 * verified by driving them, not by reading them.
 *
 * The reason this is a test rather than a note on the issue: those two
 * normalizers are the whole argument, they were added for unrelated reasons
 * (#923 and the #1448 sweep), and nothing else records that `.txt`'s round-trip
 * now leans on them. Loosening either one to a `<br>` or a preserved newline
 * would silently reopen the divergence, and the failure would surface as
 * "reopening my file splits my paragraphs" with no trail back to the paste
 * change that caused it.
 */

import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { normalizePastedHtmlWhitespace } from "../../src/client/editor/utils/paste-whitespace";
import { buildPlainTextSlice } from "../../src/client/editor/utils/plain-paste";

/** Every paragraph's text, with a hardBreak and a literal newline both as "\n". */
function paragraphTexts(editor: Editor): string[] {
  return editor.state.doc.content.content.map((node) =>
    node.textBetween(0, node.content.size, "\n", "\n"),
  );
}

/**
 * Editors must be destroyed, and the failure if they are not is misleading.
 *
 * A live `EditorView` leaves a `DOMObserver` flush pending on a timer. Once the
 * suite finishes, happy-dom tears down `document` and that timer fires into the
 * void: vitest reports `ReferenceError: document is not defined` as an UNHANDLED
 * ERROR attributed to this file, with every test green and a non-zero exit. It
 * is timing-dependent — this passed locally and failed in CI.
 */
const live: Editor[] = [];

afterEach(() => {
  while (live.length > 0) live.pop()?.destroy();
});

function blankEditor(): Editor {
  const editor = new Editor({ extensions: buildSchemaExtensions(), content: "<p></p>" });
  live.push(editor);
  return editor;
}

describe("#1460: paste cannot put a newline inside a paragraph", () => {
  it("plain-text paste splits on the newline instead of keeping it", () => {
    const editor = blankEditor();
    const slice = buildPlainTextSlice("alpha\nbravo", editor.state.schema, []);
    editor.view.dispatch(editor.state.tr.replaceSelection(slice));

    expect(paragraphTexts(editor)).toEqual(["alpha", "bravo"]);
  });

  it("plain-text paste splits on CRLF and on runs of newlines", () => {
    const editor = blankEditor();
    const slice = buildPlainTextSlice("alpha\r\n\r\nbravo\n\n\ncharlie", editor.state.schema, []);
    editor.view.dispatch(editor.state.tr.replaceSelection(slice));

    expect(paragraphTexts(editor)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("rich HTML paste collapses a newline inside a <p> to a space", () => {
    // The doorway #1460 named. `whitespace: "pre"` (#1448) is what would let the
    // newline survive; the normalizer runs before the parse sees it.
    expect(normalizePastedHtmlWhitespace("<p>alpha\nbravo</p>")).toBe("<p>alpha bravo</p>");
  });

  it("no paste path leaves a paragraph holding a newline", () => {
    // The property itself, asserted over both surfaces, so a third surface
    // added later has an obvious place to join.
    //
    // Two editors deliberately: `setContent` REPLACES the document, so running
    // both surfaces through one editor discards whatever the first one built
    // and the property is only ever checked against the second. That mistake
    // costs nothing to make and hides half the coverage — it survived one
    // negative-control round here before the failure count gave it away.
    const texts: string[] = [];

    const plain = blankEditor();
    const slice = buildPlainTextSlice("one\ntwo\n\nthree", plain.state.schema, []);
    plain.view.dispatch(plain.state.tr.replaceSelection(slice));
    texts.push(...paragraphTexts(plain));

    const rich = blankEditor();
    rich.commands.setContent(normalizePastedHtmlWhitespace("<p>four\nfive</p>"));
    texts.push(...paragraphTexts(rich));

    expect(texts.length, "both surfaces contributed").toBeGreaterThanOrEqual(4);
    for (const text of texts) {
      expect(text, `"${text}" carries a newline`).not.toContain("\n");
    }
  });
});
