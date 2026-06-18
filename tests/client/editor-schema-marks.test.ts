import { type AnyExtension, Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { htmlToYDoc } from "../../src/server/file-io/docx-html";
import { DOCX_INLINE_MARKS } from "../../src/shared/constants";

/**
 * The editor schema MUST register a mark for every name the `.docx` import can
 * emit (`DOCX_INLINE_MARKS`). If it doesn't, y-prosemirror's sync
 * (`createTextNodesFromYText`) hits an unregistered mark, its catch deletes the
 * whole offending `Y.XmlText`, and the deletion propagates to disk — silent
 * content loss, NOT a crash. That's why the load-bearing assertion below drives a
 * REAL Collaboration sync of marked content rather than only checking that the
 * mark types exist (a registered-but-attrs-incompatible mark would still throw on
 * sync). The CONTROL test proves the guard isn't a tautology: a schema missing
 * `underline` actually drops the underlined text on the same sync path.
 *
 * Regression guard for the gap that shipped undetected: the `.docx` import emitted
 * superscript (footnote markers) and — after the underline fix — underline, but
 * the editor registered neither.
 */

// One paragraph exercising every DOCX_INLINE_MARK, plus mammoth's real footnote
// pattern (inline `[1]` ref + trailing back-linked <li>). Fed through the REAL
// server importer so the test is pinned to the exact delta-attribute shape
// production emits (not a hand-rolled approximation that could drift).
const MARKED_HTML =
  "<p>plain <strong>bold</strong> <em>italic</em> <s>strike</s> " +
  '<code>code</code> <a href="https://example.com">link</a> ' +
  "<u>under</u> <sup>sup</sup> <sub>sub</sub>" +
  '<sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup></p>' +
  '<ol><li id="footnote-1"><p>fn body <a href="#footnote-ref-1">↑</a></p></li></ol>';

// Footnote reconstruction needs the captured body so reconciliation approves the
// id (mark target + trailing <li> + body must all agree). Without it the marker
// stays plain superscript and this test wouldn't exercise the footnote-ref mark.
const FOOTNOTE_BODIES = { "1": { text: "fn body", hadFormatting: false } };

const mounted: Array<{ editor: Editor; container: HTMLDivElement }> = [];

function mount(extensions: AnyExtension[], ydoc?: Y.Doc): Editor {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    extensions: ydoc ? [...extensions, Collaboration.configure({ document: ydoc })] : extensions,
  });
  mounted.push({ editor, container });
  return editor;
}

afterEach(() => {
  for (const { editor, container } of mounted.splice(0)) {
    editor.destroy();
    container.remove();
  }
});

describe("editor schema ⊇ DOCX_INLINE_MARKS", () => {
  it("registers a mark type for every import mark (cheap secondary signal)", () => {
    const editor = mount(buildSchemaExtensions());
    for (const mark of DOCX_INLINE_MARKS) {
      expect(editor.state.schema.marks[mark], `schema must register mark "${mark}"`).toBeDefined();
    }
  });

  it("survives a real Collaboration sync of every marked run without losing content", () => {
    const ydoc = new Y.Doc();
    htmlToYDoc(ydoc, MARKED_HTML, FOOTNOTE_BODIES);
    const editor = mount(buildSchemaExtensions(), ydoc);

    const html = editor.getHTML();
    // Every run's TEXT survived the sync (not deleted by y-prosemirror's catch).
    for (const word of [
      "plain",
      "bold",
      "italic",
      "strike",
      "code",
      "link",
      "under",
      "sup",
      "sub",
    ]) {
      expect(html, `"${word}" must survive sync`).toContain(word);
    }
    // ...and the new marks round-trip as their tags.
    expect(html).toMatch(/<u>/);
    expect(html).toMatch(/<sup>/);
    expect(html).toMatch(/<sub>/);
    // Footnote reference marker survived WITH its id (MEDIUM-1): the id-bearing
    // attribute must survive the Collaboration sync, else y-prosemirror's catch
    // would have deleted the whole XmlText. A registered-but-attr-incompatible
    // mark would throw here, so this is the real id-survival gate.
    expect(html).toContain("[1]");
    expect(html).toContain('data-footnote-id="1"');
    // The Y.Doc itself was not mutated by a sync-time deletion.
    expect(ydoc.getXmlFragment("default").toString()).toContain("under");
    expect(ydoc.getXmlFragment("default").toString()).toContain("[1]");
  });

  it("CONTROL: a schema missing underline silently drops the marked text on sync", () => {
    // Without the marks registered, y-prosemirror's catch deletes the offending
    // Y.XmlText — proving the guard above detects the real failure mode rather
    // than passing vacuously.
    const ydoc = new Y.Doc();
    htmlToYDoc(ydoc, MARKED_HTML, FOOTNOTE_BODIES);
    const editor = mount([StarterKit.configure({ history: false })], ydoc);

    const html = editor.getHTML();
    // The underlined run's text is gone...
    expect(html).not.toContain("under");
    // ...and the blast radius is the WHOLE paragraph XmlText, not just the
    // offending run: htmlToYDoc packs the entire <p> into one Y.XmlText, so
    // y-prosemirror's catch deletes all of it — even the StarterKit-known
    // "bold"/"italic" runs vanish. This is why the failure is silent
    // content loss, not a localized formatting drop.
    expect(html).not.toContain("bold");
  });
});
