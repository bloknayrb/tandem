// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import {
  FindReplaceExtension,
  type FindReplaceOptions,
  getFindState,
  replaceAll,
} from "../../src/client/editor/extensions/find-replace";

/**
 * find/replace was off by one PER HARD BREAK (#1774).
 *
 * `walkMatches` searched `node.textContent` and mapped each match with
 * `pos + 1 + idx`. The two counts disagree at exactly one node type:
 *
 *   text node   → `textContent` charges `text.length`, PM charges `text.length`
 *   `hardBreak` → `textContent` charges **0**, PM charges **1** (`nodeSize`)
 *
 * so the index-into-text and the PM offset drifted by one per *preceding* break
 * inside the block. On the fixture below, `gamma` matched at `[11,16] [22,27]
 * [37,42]` — covering `" gamm"`, `"a gam"` and `"gamma"`, drift 1, 2, 0 — and
 * `replaceAll("DELTA")` produced `"alpha\nbetaDELTAa\ndeltDELTAma\nplain DELTA"`.
 * The count and the highlight both looked right, because the decoration is drawn
 * at the same wrong offset.
 *
 * THE DRIFT COMPOUNDS PER BREAK, so the fixture carries TWO breaks: a one-break
 * document cannot tell a real fix from a constant `-1` correction.
 *
 * These go through the plugin rather than calling `walkMatches`, which is
 * module-private: seed with `editor.commands.find(...)`, then read
 * `getFindState(editor.state)!.matches`. Not added to
 * `live-regions-find-replace.test.ts`, which `vi.mock`s this whole module and so
 * pins nothing about matching.
 */
const TWO_BREAKS = "<p>alpha<br>beta gamma<br>delta gamma</p><p>plain gamma</p>";
const NO_BREAK = "<p>alpha beta gamma</p><p>plain gamma</p>";

const live: Editor[] = [];

afterEach(() => {
  for (const editor of live.splice(0)) editor.destroy();
});

function findEditor(content: string, opts: Partial<FindReplaceOptions> = {}) {
  const editor = new Editor({
    content,
    extensions: [...buildSchemaExtensions(), FindReplaceExtension],
  });
  live.push(editor);
  editor.commands.find({
    query: "gamma",
    caseSensitive: false,
    wholeWord: false,
    regexMode: false,
    ...opts,
  });
  return editor;
}

function matches(editor: Editor) {
  const state = getFindState(editor.state);
  if (!state) throw new Error("find plugin state absent");
  return state.matches;
}

/**
 * The document's text with a hard break rendered as one `\n`.
 *
 * Named explicitly because the obvious readers are both wrong here:
 * `editor.getText()` defaults to a `"\n\n"` block separator, and a
 * `textBetween` with no `leafText` renders a hardBreak as nothing.
 */
function readText(editor: Editor): string {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n", "\n");
}

describe("find/replace across hard breaks (#1774)", () => {
  it("(1) every match covers exactly the query, on both sides of two breaks", () => {
    const editor = findEditor(TWO_BREAKS);
    const found = matches(editor);
    expect(found).toHaveLength(3);
    for (const { from, to } of found) {
      expect(editor.state.doc.textBetween(from, to, "\n", "\n")).toBe("gamma");
    }
  });

  it("(2) replaceAll writes the right text", async () => {
    const editor = findEditor(TWO_BREAKS);
    await replaceAll(editor.view, "DELTA");
    expect(readText(editor)).toBe("alpha\nbeta DELTA\ndelta DELTA\nplain DELTA");
  });

  it("(3) control: a break-free document is unaffected by the arithmetic", () => {
    // Green under BOTH arithmetics — a break-free textblock has zero drift. This
    // is the guard against an over-correction that adds an offset
    // unconditionally. A red here under the old arithmetic means the control was
    // mis-written, not that the mutation check found something.
    const editor = findEditor(NO_BREAK);
    const found = matches(editor);
    expect(found).toHaveLength(2);
    for (const { from, to } of found) {
      expect(editor.state.doc.textBetween(from, to, "\n", "\n")).toBe("gamma");
    }
  });

  it("(4) no match spans a break", () => {
    // `textContent` glued the segments either side of a break into one string,
    // so "alphabeta" matched. Kills a "fix" that keeps a zero-width placeholder
    // and merely subtracts a correction.
    const editor = findEditor(TWO_BREAKS, { query: "alphabeta" });
    expect(matches(editor)).toHaveLength(0);
  });

  it("(5) wholeWord gets WIDER: a segment beside a break is now its own word", () => {
    // `\balpha\b` found 0 matches while `alpha` and `beta` were glued; the break
    // reading as `\n` makes `alpha` a word. User-visible: whole-word counts
    // change on any document containing a hard break.
    const editor = findEditor(TWO_BREAKS, { query: "alpha", wholeWord: true });
    expect(matches(editor)).toHaveLength(1);
  });
});
