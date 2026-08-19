// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import {
  AuthorshipExtension,
  buildAuthorshipDecorations,
} from "../../src/client/editor/extensions/authorship";
import { loadMarkdown } from "../../src/server/file-io/markdown";
import { Y_MAP_AUTHORSHIP } from "../../src/shared/constants";
import { anchorFlatRange } from "../../src/shared/positions/ydoc";
import type { AuthorshipRange } from "../../src/shared/types";

/**
 * The block gutter counts CONTENT positions, not block tokens.
 *
 * `authorAt` is filled over ProseMirror positions, and the per-block count used
 * to run `[blockFrom, blockTo)` — which includes the block's own open and close
 * tokens. A within-block entry can never mark those, so the bug was invisible
 * for years: an entry's endpoints are content positions by construction. An
 * entry SPANNING a block boundary marks both, and each adjacent block then
 * gained one phantom authored character.
 *
 * One character decides a near-tied block, because `dominant` is
 * `userChars >= claudeChars`. Cross-block entries already arrive from a
 * multi-block paste today, and #1512's repair will make them the ordinary shape
 * of a typing run that crossed an Enter — which is why this is a prerequisite
 * for that work rather than a tidy-up.
 *
 * Assertions go through `buildAuthorshipDecorations` against a real
 * `Collaboration` binding. The sibling `authorship-decoration.test.ts` mocks
 * ProseMirror wholesale, and a mock of the position system cannot see a
 * position bug — it would encode the same off-by-one the code has.
 */

const live: Editor[] = [];

afterEach(() => {
  for (const editor of live.splice(0)) editor.destroy();
});

/** Two paragraphs: `seedUSER` then `TEXT`. */
function twoBlocks() {
  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, "seedUSER\n\nTEXT\n");
  const editor = new Editor({
    extensions: [
      ...buildSchemaExtensions(),
      Collaboration.configure({ document: ydoc }),
      AuthorshipExtension.configure({ ydoc }),
    ],
  });
  live.push(editor);
  return { ydoc, editor };
}

function decorationAttr(decoration: unknown, name: string): string | undefined {
  return (decoration as { type?: { attrs?: Record<string, string> } }).type?.attrs?.[name];
}

/** `pos:author` per block gutter decoration, in document order. */
function gutter(ydoc: Y.Doc, editor: Editor): string[] {
  const doc = editor.state.doc;
  const set = buildAuthorshipDecorations(doc, ydoc.getMap(Y_MAP_AUTHORSHIP), ydoc, true);
  const blocks: { from: number; author: string }[] = [];
  for (const decoration of set.find()) {
    const author = decorationAttr(decoration, "data-tandem-author-block");
    if (author) blocks.push({ from: decoration.from, author });
  }
  return blocks.sort((a, b) => a.from - b.from).map((b) => `${b.from}:${b.author}`);
}

/** Place an anchored entry over a flat range. Returns false if the mint declined. */
function put(
  ydoc: Y.Doc,
  id: string,
  author: AuthorshipRange["author"],
  from: number,
  to: number,
): boolean {
  const relRange = anchorFlatRange(ydoc, from, to);
  ydoc.getMap(Y_MAP_AUTHORSHIP).set(id, {
    id,
    author,
    range: { from, to },
    ...(relRange ? { relRange } : {}),
    timestamp: 1,
  } satisfies AuthorshipRange);
  return relRange !== null;
}

describe("the block gutter counts content positions only", () => {
  it("TEST 0 — the binding is real and hand-placed entries anchor", () => {
    // ANTI-VACUUM. Without a Collaboration binding the fragment is empty, every
    // mint declines, entries fall back to frozen flat offsets, and every
    // assertion below would be testing the degraded path.
    const { ydoc, editor } = twoBlocks();
    expect(ydoc.getXmlFragment("default").length).toBeGreaterThan(0);
    expect(put(ydoc, "u1", "user", 4, 8), "the fixture's entries must be anchored").toBe(true);
    expect(gutter(ydoc, editor)).toEqual(["0:user"]);
  });

  it("a cross-block entry does not win a block it barely touches", () => {
    // THE BUG. Flat offsets: `seedUSER` is 0..8, the separator is 8, `TEXT` is
    // 9..13. In the second block the user really owns one character (`T` at 9)
    // and Claude owns two (`EX` at 10..12), so the bar must read `claude`.
    //
    // The counts have to STRADDLE the tipping point or the mutation survives:
    // `dominant` is `userChars >= claudeChars`, so 1 vs 2 reads `claude` and the
    // single phantom character makes it 2 vs 2, which reads `user`.
    const { ydoc, editor } = twoBlocks();
    put(ydoc, "u1", "user", 4, 10);
    put(ydoc, "c1", "claude", 10, 12);

    expect(gutter(ydoc, editor)).toEqual(["0:user", "10:claude"]);
  });

  it("the same coverage split into per-block entries reads the same", () => {
    // The control for the test above: two entries covering exactly the same
    // characters, with no entry crossing the boundary and therefore no phantom.
    // Before the fix these two fixtures disagreed, which is the whole defect —
    // the gutter depended on how the coverage happened to be stored.
    const { ydoc, editor } = twoBlocks();
    put(ydoc, "u1", "user", 4, 8);
    put(ydoc, "u1#1", "user", 9, 10);
    put(ydoc, "c1", "claude", 10, 12);

    expect(gutter(ydoc, editor)).toEqual(["0:user", "10:claude"]);
  });

  it("a character at either end of a block is still counted", () => {
    // The bounds moved, so this pins that they did not move too far. The first
    // content character sits at `blockFrom + 1` and the last at `blockTo - 2`;
    // an entry covering only one of them must still carry its block.
    const { ydoc, editor } = twoBlocks();
    put(ydoc, "c1", "claude", 0, 1); // `s`, the first character of block 1
    put(ydoc, "c2", "claude", 12, 13); // `T`, the last character of block 2

    expect(gutter(ydoc, editor)).toEqual(["0:claude", "10:claude"]);
  });

  it("a within-block tie still breaks to the user", () => {
    // Unchanged behaviour, and the reason the fix is bounds-only rather than a
    // change to `dominant`. Both blocks are untouched by any boundary.
    const { ydoc, editor } = twoBlocks();
    put(ydoc, "u1", "user", 9, 11);
    put(ydoc, "c1", "claude", 11, 13);

    expect(gutter(ydoc, editor)).toEqual(["10:user"]);
  });
});
