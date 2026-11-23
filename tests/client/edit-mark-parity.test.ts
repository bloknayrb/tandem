import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import type { Mark } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import {
  getElementTextLength,
  resolvePointInsertMarks,
  resolveReplacementMarks,
} from "../../src/server/mcp/document-model";
import { NON_INCLUSIVE_MARKS, RAW_MARKDOWN_MARK } from "../../src/shared/constants";
import { makeMarkdownDoc } from "../helpers/ydoc-factory";

/**
 * #1823: `tandem_edit`, Accept and typing give new text the same marks.
 *
 * The server resolves marks on the Y.Doc (`resolveReplacementMarks`,
 * `resolvePointInsertMarks`); the editor resolves them on the ProseMirror doc —
 * Accept through `marksAcross` (`useAnnotationReview.svelte.ts`), typing through
 * `$pos.marks()`. They agree only while the server's `NON_INCLUSIVE_MARKS` matches
 * the editor schema's `inclusive: false` marks. Each fixture is loaded by the REAL
 * markdown loader and synced into a REAL editor through Collaboration, and every
 * offset (and every range) of its first paragraph is compared both ways.
 */

const mounted: Array<{ editor: Editor; container: HTMLDivElement }> = [];

function mount(ydoc: Y.Doc): Editor {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    extensions: [...buildSchemaExtensions(), Collaboration.configure({ document: ydoc })],
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

const names = (marks: readonly Mark[] | null | undefined): string[] =>
  (marks ?? []).map((m) => m.type.name).sort();

function setup(md: string) {
  const ydoc = makeMarkdownDoc(md);
  const editor = mount(ydoc);
  const para = ydoc.getXmlFragment("default").get(0) as Y.XmlElement;
  // A first-block paragraph's content starts at PM position 1, and a hardBreak is
  // one position wide in both systems, so element offset n ↔ PM position n + 1.
  return { ydoc, editor, para, len: getElementTextLength(para) };
}

// Keep each fixture's first paragraph short: the replacement check is O(n²) in it.
const FIXTURES: Array<[string, string]> = [
  ["raw run mid-paragraph", "see[^1] after\n\n[^1]: n\n"],
  ["raw run at block start and end", "[^1] mid [^2]\n\n[^1]: a\n\n[^2]: b\n"],
  ["adjacent raw runs (the seam exception)", "see[^1][^2] after\n\n[^1]: a\n\n[^2]: b\n"],
  ["bold, italic and a link", "a **bold** *it* [link](https://x.test) z\n"],
  ["hard break between marked runs", "see[^1]\\\n**bold** tail\n\n[^1]: n\n"],
];

describe("tandem_edit marks match the editor's (#1823)", () => {
  it("the editor schema's non-inclusive marks are exactly NON_INCLUSIVE_MARKS", () => {
    const { editor } = setup("x\n");
    const nonInclusive = Object.values(editor.schema.marks)
      .filter((t) => t.spec.inclusive === false)
      .map((t) => t.name)
      .sort();
    expect(nonInclusive).toEqual([...NON_INCLUSIVE_MARKS].sort());
  });

  for (const [label, md] of FIXTURES) {
    it(`point insert = $pos.marks() (typing): ${label}`, () => {
      const { editor, para, len } = setup(md);
      for (let n = 0; n <= len; n++) {
        const pm = names(editor.state.doc.resolve(n + 1).marks());
        const server = Object.keys(resolvePointInsertMarks(para, n)).sort();
        expect(server, `offset ${n}`).toEqual(pm);
      }
    });

    it(`replacement = marksAcross (Accept): ${label}`, () => {
      const { editor, para, len } = setup(md);
      const { doc } = editor.state;
      for (let from = 0; from < len; from++) {
        for (let to = from + 1; to <= len; to++) {
          const pm = names(doc.resolve(from + 1).marksAcross(doc.resolve(to + 1)));
          const server = Object.keys(resolveReplacementMarks(para, from, para, to)).sort();
          expect(server, `[${from}, ${to})`).toEqual(pm);
        }
      }
    });
  }

  it("typing at a raw run's edge stays out of it; typing inside stays in", () => {
    const { editor, para } = setup("see[^1] after\n\n[^1]: n\n");
    const rawOf = (text: string) =>
      (
        (para.get(0) as Y.XmlText).toDelta() as Array<{
          insert: string;
          attributes?: Record<string, unknown>;
        }>
      ).filter((d) => d.insert.includes(text) && d.attributes?.[RAW_MARKDOWN_MARK] !== undefined);

    // Element offset 7 is just past `[^1]`; offset 5 is inside it.
    editor.view.dispatch(editor.state.tr.insertText("Q", 8));
    expect(rawOf("Q")).toHaveLength(0);
    editor.view.dispatch(editor.state.tr.insertText("Z", 6));
    expect(rawOf("Z")).toHaveLength(1);
  });
});
