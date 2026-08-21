// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import {
  normalizeAlignToWidth,
  parseAlignAttribute,
  reindexAlign,
} from "../../src/client/editor/extensions/table-align-commands";
import { loadMarkdown, saveMarkdown } from "../../src/server/file-io/markdown";

/**
 * `table.align` stays positionally aligned with the columns (#1535).
 *
 * ## Why these assert SAVED MARKDOWN
 *
 * The bug is a file-corruption bug — the issue's repro is stated as on-disk
 * markdown, and the harm is that a column op silently rewrites the user's
 * alignment row. Asserting the `align` attribute alone would pin the mechanism
 * while leaving the thing that actually matters unverified, and the two can
 * disagree: `markdown-table` sizes the delimiter row from the row width, not
 * from `align.length`, so a too-LONG array is invisible on disk while a
 * too-SHORT one corrupts it. Only the saved string distinguishes those.
 *
 * So each case drives the REAL command through a real editor bound to a real
 * Y.Doc, then runs the real server serializer over that Y.Doc. The chain under
 * test is markdown -> Y.Doc -> ProseMirror -> command -> Y.Doc -> markdown.
 *
 * ## Why the row operations are in here too
 *
 * `findWidth` takes the per-row max of colspan sums plus any rowspan carried in
 * from an earlier row, so the row operations do not change the width and must
 * NOT re-index. That was probed against the prosemirror-tables source rather
 * than assumed, and it is pinned here because the failure mode of getting it
 * wrong is identical to the bug being fixed — an array that no longer describes
 * the columns.
 */

const live: Editor[] = [];

afterEach(() => {
  for (const editor of live.splice(0)) editor.destroy();
});

const ALIGNED = ["| L | C | R |", "| :- | :-: | -: |", "| 1 | 2 | 3 |", ""].join("\n");

function boundEditor(markdown: string) {
  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, markdown);
  const editor = new Editor({
    extensions: [...buildSchemaExtensions(), Collaboration.configure({ document: ydoc })],
  });
  live.push(editor);
  return { ydoc, editor };
}

/** Positions of every cell, in document order. */
function cellPositions(editor: Editor): number[] {
  const out: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    const role = node.type.spec.tableRole;
    if (role === "cell" || role === "header_cell") out.push(pos);
  });
  return out;
}

/** Put the cursor inside the cell at `index` (cell -> paragraph -> text). */
function putCursorInCell(editor: Editor, index: number): void {
  editor.commands.setTextSelection(cellPositions(editor)[index] + 2);
}

function tableNode(editor: Editor) {
  return editor.state.doc.child(0);
}

function alignAttr(editor: Editor): unknown {
  return tableNode(editor).attrs.align;
}

function columnWidth(editor: Editor): number {
  return TableMap.get(tableNode(editor)).width;
}

/** The delimiter row — line 2 of a GFM table. */
function delimiterRow(ydoc: Y.Doc): string {
  return saveMarkdown(ydoc).split("\n")[1];
}

describe("table align re-indexing on column ops (#1535)", () => {
  it("the filed repro: addColumnBefore in column 1 no longer shifts the row", () => {
    const { ydoc, editor } = boundEditor(ALIGNED);
    putCursorInCell(editor, 1);

    expect(editor.commands.addColumnBefore()).toBe(true);

    // Before the fix this saved as `| :- | :-: | -: | - |`: the new empty column
    // acquired `center`, the original centre became `right`, and the original
    // right column lost its alignment.
    expect(saveMarkdown(ydoc)).toBe(
      ["| L | | C | R |", "| :- | - | :-: | -: |", "| 1 | | 2 | 3 |", ""].join("\n"),
    );
    expect(alignAttr(editor)).toBe(JSON.stringify(["left", null, "center", "right"]));
  });

  it("addColumnAfter splices at the right edge of the selected column", () => {
    const { ydoc, editor } = boundEditor(ALIGNED);
    putCursorInCell(editor, 1);

    expect(editor.commands.addColumnAfter()).toBe(true);

    expect(delimiterRow(ydoc)).toBe("| :- | :-: | - | -: |");
  });

  it("deleteColumn removes the entry rather than letting the survivor inherit it", () => {
    const { ydoc, editor } = boundEditor(ALIGNED);
    putCursorInCell(editor, 1);

    expect(editor.commands.deleteColumn()).toBe(true);

    // The sharpest case: with no wrapper this saves as `| :- | :-: |` — the
    // surviving R column silently inherits C's centre.
    expect(delimiterRow(ydoc)).toBe("| :- | -: |");
  });

  it("inserting before column 0 splices at the array's front", () => {
    const { ydoc, editor } = boundEditor(ALIGNED);
    putCursorInCell(editor, 0);

    expect(editor.commands.addColumnBefore()).toBe(true);

    expect(delimiterRow(ydoc)).toBe("| - | :- | :-: | -: |");
  });

  it("a multi-column CellSelection deletes one entry per selected column", () => {
    const { ydoc, editor } = boundEditor(ALIGNED);
    const cells = cellPositions(editor);
    const { doc, tr } = editor.state;
    editor.view.dispatch(tr.setSelection(CellSelection.create(doc, cells[0], cells[1])));

    // Through the chain, not `editor.commands`: `dispatch.ts` runs these as
    // `chain().focus().deleteColumn()`, and `.focus()` deliberately does not
    // re-resolve a CellSelection. That is an assumption a Tiptap upgrade could
    // break, so the test exercises the real path.
    expect(editor.chain().focus().deleteColumn().run()).toBe(true);

    expect(columnWidth(editor)).toBe(1);
    expect(delimiterRow(ydoc)).toBe("| -: |");
  });

  it("a CellSelection spanning every column refuses, and changes nothing", () => {
    const { ydoc, editor } = boundEditor(ALIGNED);
    const before = saveMarkdown(ydoc);
    const beforeAlign = alignAttr(editor);
    const cells = cellPositions(editor);
    const { doc, tr } = editor.state;
    editor.view.dispatch(tr.setSelection(CellSelection.create(doc, cells[0], cells[2])));

    // `deleteColumn` returns false from INSIDE its `if (dispatch)` branch, after
    // touching `state.tr`. A wrapper that gated on `dispatch` instead of on the
    // parent's return value would empty the align array while leaving all three
    // columns standing.
    expect(editor.commands.deleteColumn()).toBe(false);

    expect(alignAttr(editor)).toBe(beforeAlign);
    expect(saveMarkdown(ydoc)).toBe(before);
  });

  it("align.length equals the column width after every column op", () => {
    for (const op of ["addColumnBefore", "addColumnAfter", "deleteColumn"] as const) {
      const { editor } = boundEditor(ALIGNED);
      putCursorInCell(editor, 1);
      editor.commands[op]();
      const parsed = JSON.parse(String(alignAttr(editor)));
      expect(parsed).toHaveLength(columnWidth(editor));
    }
  });

  it("self-heals an array that arrived already desynchronised", () => {
    // A table whose align is short before we touch it — what a paste that grew
    // the table, or a file written by an older build, leaves behind. The op
    // normalises to the pre-op width first, so the result still describes the
    // columns instead of drifting further.
    const { ydoc, editor } = boundEditor(ALIGNED);
    const pos = 0;
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos, undefined, {
        ...tableNode(editor).attrs,
        align: JSON.stringify(["left"]),
      }),
    );

    putCursorInCell(editor, 2);
    expect(editor.commands.addColumnAfter()).toBe(true);

    expect(JSON.parse(String(alignAttr(editor)))).toEqual(["left", null, null, null]);
    expect(delimiterRow(ydoc)).toBe("| :- | - | - | - |");
  });

  it("leaves a table that never had the attribute without one", () => {
    // What `/table` and a `.docx` import produce: `align` is genuinely absent,
    // not an array of nulls. Minting `[null,null,null]` here would be a new
    // attribute where there was none.
    //
    // Note a `| - | - |` table is NOT this case — mdast reads it as
    // `align: [null, null]`, so the attribute exists and re-indexing it is both
    // correct and invisible on disk. The distinction is why
    // `parseAlignAttribute` returns null for an absent attribute AND for `[]`,
    // rather than treating "no alignment" as one thing.
    const { ydoc, editor } = boundEditor(["| A | B |", "| - | - |", "| 1 | 2 |", ""].join("\n"));
    const before = saveMarkdown(ydoc);
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(0, undefined, { ...tableNode(editor).attrs, align: null }),
    );
    putCursorInCell(editor, 0);

    expect(editor.commands.addColumnAfter()).toBe(true);

    expect(alignAttr(editor)).toBeNull();
    // And the file still round-trips to a plain delimiter row, one wider.
    expect(delimiterRow(ydoc)).toBe("| - | - | - |");
    expect(before.split("\n")[1]).toBe("| - | - |");
  });

  it("row and cell operations leave the array untouched", () => {
    // `findWidth` is the per-row max of colspan sums plus rowspan carry-over, so
    // none of these changes the width. Re-indexing on any of them would be the
    // same bug in the other direction.
    for (const op of [
      "addRowBefore",
      "addRowAfter",
      "deleteRow",
      "toggleHeaderRow",
      "mergeCells",
      "splitCell",
    ] as const) {
      const { editor } = boundEditor(ALIGNED);
      putCursorInCell(editor, 3);
      const before = alignAttr(editor);
      editor.commands[op]();
      expect(alignAttr(editor), `${op} must not touch align`).toBe(before);
    }
  });

  it("undo restores the columns and the alignment together", () => {
    // One ProseMirror transaction means one y.transact means one UndoManager
    // stack item. An appended repair would be a second transaction, atomic only
    // by captureTimeout.
    const { ydoc, editor } = boundEditor(ALIGNED);
    putCursorInCell(editor, 1);
    editor.commands.addColumnBefore();
    expect(delimiterRow(ydoc)).toBe("| :- | - | :-: | -: |");

    editor.commands.undo();

    expect(saveMarkdown(ydoc)).toBe(ALIGNED);
  });

  it("stores the attribute as a JSON string, not an array", () => {
    // `renderHTML` emits `String(attrs.align)`, so a real array survives a DOM
    // re-read as `"left,center,right"`; and the server's reader requires
    // `typeof rawAlign === "string"` before `JSON.parse`, so anything else is
    // discarded and every column saves as `-`.
    const { editor } = boundEditor(ALIGNED);
    putCursorInCell(editor, 1);
    editor.commands.addColumnBefore();

    const raw = alignAttr(editor);
    expect(typeof raw).toBe("string");
    expect(() => JSON.parse(String(raw))).not.toThrow();
  });

  it("moves an unrecognised alignment value rather than sanitising it", () => {
    // Silently rewriting a value off the user's disk is its own bug. The render
    // layer is where an allowlist belongs.
    const { editor } = boundEditor(ALIGNED);
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(0, undefined, {
        ...tableNode(editor).attrs,
        align: JSON.stringify(["justify", "center", "right"]),
      }),
    );
    putCursorInCell(editor, 0);

    expect(editor.commands.addColumnBefore()).toBe(true);

    expect(JSON.parse(String(alignAttr(editor)))).toEqual([null, "justify", "center", "right"]);
  });
});

describe("table align helpers (#1535)", () => {
  it("parseAlignAttribute returns null for everything that means 'leave it alone'", () => {
    // `null` here is not an error signal — it is the instruction to add no
    // attribute. Returning `[]` instead would make every untouched table grow
    // one on its first column op.
    for (const raw of [null, undefined, "", "not json", "{}", '"left"', "[]", 42, ["left"]]) {
      expect(parseAlignAttribute(raw), String(raw)).toBeNull();
    }
    expect(parseAlignAttribute('["left",null]')).toEqual(["left", null]);
  });

  it("normalizeAlignToWidth pads with null and trims to width", () => {
    expect(normalizeAlignToWidth(["left"], 3)).toEqual(["left", null, null]);
    expect(normalizeAlignToWidth(["left", "center", "right"], 2)).toEqual(["left", "center"]);
    // An explicit `undefined` — which mdast's own type permits — folds to the
    // `null` the server round-trips, rather than surviving as a hole.
    expect(normalizeAlignToWidth([undefined as unknown as string, "center"], 2)).toEqual([
      null,
      "center",
    ]);
  });

  it("reindexAlign puts the new entry where the new column lands", () => {
    const align = ["left", "center", "right"];
    expect(reindexAlign(align, 3, "before", 1, 2)).toEqual(["left", null, "center", "right"]);
    expect(reindexAlign(align, 3, "after", 1, 2)).toEqual(["left", "center", null, "right"]);
    expect(reindexAlign(align, 3, "delete", 1, 2)).toEqual(["left", "right"]);
    // rect.right is EXCLUSIVE, so a two-column selection removes two entries.
    expect(reindexAlign(align, 3, "delete", 0, 2)).toEqual(["right"]);
    // An insert adds exactly one entry however wide the selection is —
    // `addColumn` is called once with a single index.
    expect(reindexAlign(align, 3, "before", 0, 2)).toEqual([null, "left", "center", "right"]);
  });
});
