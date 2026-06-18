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

// One paragraph exercising every DOCX_INLINE_MARK. Produced by the REAL server
// importer so the test is pinned to the exact delta-attribute shape production
// emits (not a hand-rolled approximation that could drift).
const MARKED_HTML =
  "<p>plain <strong>bold</strong> <em>italic</em> <s>strike</s> " +
  '<code>code</code> <a href="https://example.com">link</a> ' +
  "<u>under</u> <sup>sup</sup> <sub>sub</sub></p>";

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
    htmlToYDoc(ydoc, MARKED_HTML);
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
    // The Y.Doc itself was not mutated by a sync-time deletion.
    expect(ydoc.getXmlFragment("default").toString()).toContain("under");
  });

  it("CONTROL: a schema missing underline silently drops the marked text on sync", () => {
    // Without the marks registered, y-prosemirror's catch deletes the offending
    // Y.XmlText — proving the guard above detects the real failure mode rather
    // than passing vacuously.
    const ydoc = new Y.Doc();
    htmlToYDoc(ydoc, MARKED_HTML);
    const editor = mount([StarterKit.configure({ history: false })], ydoc);

    // The underlined/sup/sub run's text node is gone (the whole XmlText is dropped).
    expect(editor.getHTML()).not.toContain("under");
  });
});
