// @vitest-environment happy-dom

/**
 * The client's flat projection must equal the server's, character for
 * character (#1631).
 *
 * `src/client/positions.ts` has always modelled the server's flat text as
 * ARITHMETIC — `textblockFlatLength`, `pmNodeFlatTextLength`, the heading-prefix
 * accounting in `pmPosToFlatOffset`. Nothing modelled the characters, so the
 * first caller that needed flat TEXT on the client reached for
 * `doc.textBetween(from, to, "\n", "\n")`, which is a DIFFERENT projection.
 *
 * It diverges on three shapes, and each one made a suggestion permanently
 * unacceptable on a document nobody had edited:
 *
 *   - a heading's `"## "` is in flat text and in no PM text node;
 *   - a hard break inside a heading is a SPACE in flat text
 *     (`flattenHeadingText`) and a newline to `textBetween`;
 *   - a block leaf (`horizontalRule`, block `image`) contributes nothing to
 *     flat text and one `leafText` character to `textBetween`.
 *
 * That is what this file exists to stop recurring. It is the general form of
 * the hard-break case in `suggestion-accept-drift-guard.test.ts` — that one was
 * the right instinct scoped one construct too narrowly, and the two shapes it
 * did not cover are the ones that broke.
 *
 * Both halves are asserted, because they fail independently:
 *
 *   1. TEXT — `pmDocFlatText(pmDoc)` against `extractText(ydoc)`, the server's
 *      own function, on a Y.Doc built from the same source.
 *   2. LENGTH — `pmDocFlatText(doc).length` against
 *      `pmPosToFlatOffset(doc, content.size)`. The text walk and the length
 *      walk are separate code; if they disagree, every offset the guard slices
 *      with is wrong even when the projection itself is right.
 */

import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { flatTextForPmRange, pmDocFlatText, pmPosToFlatOffset } from "../../src/client/positions";
import { extractText } from "../../src/server/mcp/document-model";
import { toPmPos } from "../../src/shared/positions/types";

/** Build a Y.Doc fragment mirroring the HTML fixture, the way the server holds it. */
type Block =
  | { tag: "paragraph" | "codeBlock"; text: string }
  | { tag: "heading"; level: number; text: string }
  | { tag: "horizontalRule" };

function buildYDoc(blocks: Block[]): Y.Doc {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment("default");
  const nodes = blocks.map((b) => {
    const el = new Y.XmlElement(b.tag === "heading" ? "heading" : b.tag);
    if (b.tag === "heading") el.setAttribute("level", b.level as never);
    if (b.tag !== "horizontalRule") {
      const t = new Y.XmlText();
      el.insert(0, [t]);
      // A "\n" in the source stands for a hard break, which the server stores
      // as an embed and counts as one flat character.
      let at = 0;
      for (const [i, piece] of b.text.split("\n").entries()) {
        if (i > 0) {
          t.insertEmbed(at, { br: true });
          at += 1;
        }
        t.insert(at, piece);
        at += piece.length;
      }
    }
    return el;
  });
  frag.insert(0, nodes);
  return doc;
}

function buildEditor(html: string): Editor {
  return new Editor({ extensions: buildSchemaExtensions(), content: html });
}

const CASES: Array<{ name: string; html: string; blocks: Block[] }> = [
  {
    name: "two paragraphs (control)",
    html: "<p>alpha beta</p><p>gamma</p>",
    blocks: [
      { tag: "paragraph", text: "alpha beta" },
      { tag: "paragraph", text: "gamma" },
    ],
  },
  {
    name: "paragraph then heading — the prefix case",
    html: "<p>alpha beta</p><h2>Title Here</h2>",
    blocks: [
      { tag: "paragraph", text: "alpha beta" },
      { tag: "heading", level: 2, text: "Title Here" },
    ],
  },
  {
    name: "every heading level",
    html: "<h1>One</h1><h2>Two</h2><h3>Three</h3>",
    blocks: [
      { tag: "heading", level: 1, text: "One" },
      { tag: "heading", level: 2, text: "Two" },
      { tag: "heading", level: 3, text: "Three" },
    ],
  },
  {
    name: "hard break inside a heading — flattened to a space",
    html: "<h2>one<br>two</h2>",
    blocks: [{ tag: "heading", level: 2, text: "one\ntwo" }],
  },
  {
    name: "hard break inside a paragraph — stays a newline",
    html: "<p>one<br>two</p>",
    blocks: [{ tag: "paragraph", text: "one\ntwo" }],
  },
  {
    name: "block leaf between paragraphs — contributes no characters",
    html: "<p>alpha</p><hr><p>beta</p>",
    blocks: [
      { tag: "paragraph", text: "alpha" },
      { tag: "horizontalRule" },
      { tag: "paragraph", text: "beta" },
    ],
  },
  {
    name: "code block",
    html: "<pre><code>const x = 1;</code></pre>",
    blocks: [{ tag: "codeBlock", text: "const x = 1;" }],
  },
];

describe("#1631: the client flat projection equals the server's", () => {
  for (const c of CASES) {
    it(`${c.name}: pmDocFlatText === extractText`, () => {
      const editor = buildEditor(c.html);
      const ydoc = buildYDoc(c.blocks);
      try {
        expect(pmDocFlatText(editor.state.doc)).toBe(extractText(ydoc));
      } finally {
        editor.destroy();
        ydoc.destroy();
      }
    });

    it(`${c.name}: the text walk and the length walk agree`, () => {
      const editor = buildEditor(c.html);
      try {
        const doc = editor.state.doc;
        expect(pmDocFlatText(doc).length).toBe(pmPosToFlatOffset(doc, toPmPos(doc.content.size)));
      } finally {
        editor.destroy();
      }
    });
  }

  it("flatTextForPmRange slices the same projection", () => {
    // The guard never reads the whole document — it reads a range. Pin that the
    // slice agrees with the whole, or the boundary math could drift alone.
    const editor = buildEditor("<p>alpha beta</p><h2>Title Here</h2>");
    try {
      const doc = editor.state.doc;
      const whole = pmDocFlatText(doc);
      expect(flatTextForPmRange(doc, toPmPos(0), toPmPos(doc.content.size))).toBe(whole);
      expect(whole).toBe("alpha beta\n## Title Here");
    } finally {
      editor.destroy();
    }
  });
});
