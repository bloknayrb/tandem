/**
 * GFM column alignment must reach the editor's cells (#995).
 *
 * #1462 stopped `table.align` being destroyed; nothing rendered it, so a
 * document's alignment was invisible. `extensions/table-column-align.ts` maps
 * each cell to its column through prosemirror-tables' `TableMap` and decorates
 * it. Every test here builds its editor from `buildSchemaExtensions()`, so a
 * plugin that works but is not registered in production fails this file rather
 * than passing it.
 *
 * The mapping is the part that fails silently: `row.child(i) → column i` is
 * correct for a rectangular table and wrong for every table the #923 context
 * menu can produce. T3/T4 are the tests that separate the two implementations.
 */

import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { DOMParser as PMDOMParser } from "@tiptap/pm/model";
import { CellSelection } from "@tiptap/pm/tables";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { loadMarkdown, saveMarkdown } from "../../src/server/file-io/markdown";
import { productionSchema, yDocToPmNode } from "./editor-roundtrip-harness";

const ALIGNED_MD = "| L | C | R |\n| :- | :-: | -: |\n| 1 | 2 | 3 |\n";

const mounted: Array<{ editor: Editor; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const { editor, container } of mounted.splice(0)) {
    editor.destroy();
    container.remove();
  }
});

/** A real mounted editor — decorations only exist once there is an EditorView. */
function mount(opts: { content?: unknown; ydoc?: Y.Doc } = {}): Editor {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    extensions: opts.ydoc
      ? [...buildSchemaExtensions(), Collaboration.configure({ document: opts.ydoc })]
      : buildSchemaExtensions(),
    ...(opts.content === undefined ? {} : { content: opts.content }),
  });
  mounted.push({ editor, container });
  return editor;
}

/**
 * Markdown → Y.Doc → ProseMirror JSON, through the REAL server loader.
 *
 * Preferred over hand-written HTML wherever the fixture allows it: it proves the
 * whole chain (mdast `align` → Y attribute → PM attribute → decoration) rather
 * than the last link of it. `attrs.align` arrives as the JSON STRING the server
 * wrote — the only shape production ever produces.
 */
function fromMarkdown(markdown: string): unknown {
  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, markdown);
  const node = yDocToPmNode(ydoc, productionSchema());
  ydoc.destroy();
  return node.toJSON();
}

/** The alignment class on an element, or null. */
function alignOf(el: Element): string | null {
  for (const token of Array.from(el.classList)) {
    if (token.startsWith("tandem-cell-align-")) return token.slice("tandem-cell-align-".length);
  }
  return null;
}

/** Alignment of every cell, in document order, tagged with its element name. */
function cellAlignments(editor: Editor): string[] {
  return Array.from(editor.view.dom.querySelectorAll("th, td")).map(
    (cell) => `${cell.tagName.toLowerCase()}:${alignOf(cell) ?? "-"}`,
  );
}

/** Document positions of every cell node, in document order. */
function cellPositions(editor: Editor): number[] {
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    const role = node.type.spec.tableRole;
    if (role === "cell" || role === "header_cell") positions.push(pos);
    return true;
  });
  return positions;
}

describe("T1 — alignment declared in the file reaches the cells", () => {
  it("renders left/center/right on header AND body cells", () => {
    const editor = mount({ content: fromMarkdown(ALIGNED_MD) });

    // Header cells included deliberately: GFM alignment governs the whole
    // column, and a body-rows-only implementation passes without this half.
    expect(cellAlignments(editor)).toEqual([
      "th:left",
      "th:center",
      "th:right",
      "td:left",
      "td:center",
      "td:right",
    ]);
  });

  it("reads the JSON-string shape the server actually writes", () => {
    // Pins the assumption the parser is built on. `renderHTML` is
    // `String(attrs.align)`, so an array would come back comma-joined from a DOM
    // re-read, never as JSON — there is no already-parsed-array branch to test.
    const editor = mount({ content: fromMarkdown(ALIGNED_MD) });
    expect(editor.state.doc.child(0).attrs.align).toBe('["left","center","right"]');
  });
});

describe("T2 — an unaligned table is left alone", () => {
  it("decorates nothing when every column is null", () => {
    // The negative control. A decorate-everything or default-to-left
    // implementation passes T1 and fails here. This is also every table Tandem's
    // own `/table` command creates.
    const editor = mount({ content: fromMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |\n") });

    expect(editor.state.doc.child(0).attrs.align).toBe("[null,null]");
    expect(cellAlignments(editor)).toEqual(["th:-", "th:-", "td:-", "td:-"]);
  });
});

describe("T3 — colspan does not shift the mapping", () => {
  it("gives the cell after a colspan its true column", () => {
    const editor = mount({
      content:
        `<table data-align='["left","center","right"]'><tbody>` +
        '<tr><td colspan="2">A</td><td>B</td></tr>' +
        "<tr><td>C</td><td>D</td><td>E</td></tr>" +
        "</tbody></table>",
    });

    // A spans columns 0-1 and takes its LEFTMOST column's alignment; B is column
    // 2, not column 1. `row.child(i) → column i` gives B "center" and fails.
    expect(cellAlignments(editor)).toEqual([
      "td:left",
      "td:right",
      "td:left",
      "td:center",
      "td:right",
    ]);
  });
});

describe("T4 — rowspan does not shift the mapping", () => {
  it("gives a row under a rowspan its true columns", () => {
    const editor = mount({
      content:
        `<table data-align='["left","center","right"]'><tbody>` +
        '<tr><td rowspan="2">A</td><td>B</td><td>C</td></tr>' +
        "<tr><td>D</td><td>E</td></tr>" +
        "</tbody></table>",
    });

    // THE load-bearing case. Row 2 contains no spanning cell of its own, yet its
    // children are columns 1 and 2 because A occupies column 0 from above. The
    // map is [p0,p1,p2, p0,p3,p4]. A naive child-index mapping gives D/E
    // "left"/"center" — shifting a whole table's alignment one column, silently.
    expect(cellAlignments(editor)).toEqual([
      "td:left",
      "td:center",
      "td:right",
      "td:center",
      "td:right",
    ]);
  });
});

describe("T5 — structural edits from the #923 context menu", () => {
  // All six table ops funnel through `editor.commands.*`
  // (`context-menu/dispatch.ts:103-124`), so driving the commands drives the
  // menu.

  it("stops decorating once a column op desynchronises align from the columns", () => {
    const editor = mount({ content: fromMarkdown(ALIGNED_MD) });
    expect(cellAlignments(editor)).toContain("th:center");

    editor.commands.setTextSelection(cellPositions(editor)[1] + 2);
    expect(editor.commands.addColumnBefore()).toBe(true);

    // The `align` array is NOT maintained by the column commands — it still has
    // 3 entries against 4 columns. Rendering it anyway would put every column
    // from the insertion point one place wrong and silently drop the last one,
    // with no recourse for the user while the alignment UI is unbuilt. The width
    // guard bails instead, which is exactly the pre-#995 behaviour for this
    // table. Re-indexing the array is tracked as #1535; when that lands, this
    // expectation changes to the corrected alignment.
    expect(editor.state.doc.child(0).attrs.align).toBe('["left","center","right"]');
    expect(cellAlignments(editor).every((entry) => entry.endsWith(":-"))).toBe(true);
  });

  it("stops decorating after a column delete too", () => {
    const editor = mount({ content: fromMarkdown(ALIGNED_MD) });

    editor.commands.setTextSelection(cellPositions(editor)[1] + 2);
    expect(editor.commands.deleteColumn()).toBe(true);

    expect(cellAlignments(editor).every((entry) => entry.endsWith(":-"))).toBe(true);
  });

  it("recomputes — not maps forward — across a merge that keeps the column count", () => {
    const editor = mount({ content: fromMarkdown(ALIGNED_MD) });

    // Merge the first two BODY cells. Column count is unchanged, so the width
    // guard stays open and the decorations must survive, recomputed against the
    // new structure: the merged cell takes its leftmost column's alignment.
    const cells = cellPositions(editor);
    const selection = CellSelection.create(editor.state.doc, cells[3], cells[4]);
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    expect(editor.commands.mergeCells()).toBe(true);

    expect(cellAlignments(editor)).toEqual([
      "th:left",
      "th:center",
      "th:right",
      "td:left",
      "td:right",
    ]);
    // An implementation that mapped an old DecorationSet forward instead of
    // rebuilding keeps a stale decoration on the vanished cell and fails above.
  });
});

describe("T6 — values off the disk are not trusted", () => {
  it("ignores non-alignment values and never emits them as class tokens", () => {
    const editor = mount({
      content:
        `<table data-align='["left","not-an-align","x y z","center"]'><tbody>` +
        "<tr><td>A</td><td>B</td><td>C</td><td>D</td></tr>" +
        "</tbody></table>",
    });

    // Four columns, four entries, so the width guard is open and the allowlist is
    // what is under test. Without it, `x y z` injects three arbitrary class
    // tokens onto editor DOM from a file that may not be the user's own.
    expect(cellAlignments(editor)).toEqual(["td:left", "td:-", "td:-", "td:center"]);
    expect(editor.view.dom.innerHTML).not.toContain("not-an-align");
    expect(editor.view.dom.innerHTML).not.toContain("x y z");
  });

  it("survives an unparseable attribute instead of throwing on open", () => {
    const editor = mount({
      content:
        `<table data-align='{"nope'><tbody>` + "<tr><td>A</td><td>B</td></tr>" + "</tbody></table>",
    });

    expect(cellAlignments(editor)).toEqual(["td:-", "td:-"]);
  });
});

describe("T7 — the decoration cannot leak into the document", () => {
  // The #1448 hazard, and the only invariant this change sits near: node
  // decorations add a `class` to the live <td>, and `readDOMChange` re-parses
  // that DOM. Asserted against a real decorated view, because the
  // `editorRoundTrip` harness never constructs an EditorView and therefore
  // cannot see a decoration at all.

  it("re-parsing the live decorated DOM gains no cell attribute", () => {
    const editor = mount({ content: fromMarkdown(ALIGNED_MD) });
    // Guard against asserting on an undecorated view by accident.
    expect(editor.view.dom.innerHTML).toContain("tandem-cell-align-center");

    const reparsed = PMDOMParser.fromSchema(editor.state.schema).parse(editor.view.dom);

    let cells = 0;
    reparsed.descendants((node) => {
      const role = node.type.spec.tableRole;
      if (role !== "cell" && role !== "header_cell") return true;
      cells++;
      expect(Object.keys(node.attrs).sort()).toEqual(["colspan", "colwidth", "rowspan"]);
      return true;
    });
    expect(cells).toBe(6);
  });

  it("an edit through a decorated table writes clean markdown back to the Y.Doc", () => {
    // The path that actually reaches disk: real Collaboration sync, real edit,
    // real `saveMarkdown`.
    const ydoc = new Y.Doc();
    loadMarkdown(ydoc, ALIGNED_MD);
    const editor = mount({ ydoc });
    expect(editor.view.dom.innerHTML).toContain("tandem-cell-align-right");

    editor.commands.setTextSelection(cellPositions(editor)[3] + 2);
    editor.commands.insertContent("X");

    const saved = saveMarkdown(ydoc);
    expect(saved).not.toContain("class");
    expect(saved).not.toContain("tandem-cell-align");
    // Alignment itself still round-trips through an edit made while decorated.
    expect(saved.split("\n")[1]).toBe("| :- | :-: | -: |");
    ydoc.destroy();
  });
});

describe("T8 — a ragged table must not decorate its rows", () => {
  it("skips TableMap's unfilled-slot sentinel", () => {
    // `computeMap` pre-fills its grid with 0 and leaves those zeros for a short
    // row. Zero is never a real cell offset, but `table.nodeAt(0)` returns the
    // first tableRow rather than null, and a node decoration spanning a <tr>
    // exactly is LEGAL — so an existence-only guard silently decorates the row,
    // and `text-align` on a <tr> inherits into every undecorated cell in it.
    //
    // Reachable: `mdast-ydoc.ts` does not pad short rows, and `fixTables` runs
    // from `tableEditing()`'s appendTransaction, which `EditorState.create`
    // never calls.
    //
    // Note the width guard does NOT cover this — width is 3 and align has 3
    // entries — so this is the only test that holds the sentinel skip.
    const editor = mount({
      content: fromMarkdown("| a | b | c |\n| :- | :-: | -: |\n| 1 |\n| 2 | 3 | 4 |\n"),
    });

    for (const row of Array.from(editor.view.dom.querySelectorAll("tr"))) {
      expect(alignOf(row), `<tr> must never carry an alignment class: ${row.outerHTML}`).toBeNull();
    }
    expect(cellAlignments(editor)).toEqual([
      "th:left",
      "th:center",
      "th:right",
      "td:left",
      "td:left",
      "td:center",
      "td:right",
    ]);
  });
});
