import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { TableMap } from "@tiptap/pm/tables";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Render GFM column alignment on table cells (#995).
 *
 * #1462 made the alignment *survive*: the server writes mdast's per-column
 * `align` array as a JSON string on the table element (`mdast-ydoc.ts:232`) and
 * `TableWithAlignment` declares the attribute so `computeAttrs` stops discarding
 * it. Nothing rendered it — `editor.css` had no `text-align` at all — so a
 * document's alignment was invisible even though the data was intact.
 *
 * ## Why decorations, and not any of the obvious cheaper things
 *
 * Alignment is stored ONCE, on the table, indexed by column. `text-align` has to
 * be applied per CELL. Nothing bridges those shapes declaratively:
 *
 * - **CSS cannot.** A column's cells are not siblings — they are one cell from
 *   each row — so the only reach is `:nth-child`, which counts child index, and
 *   `colspan`/`rowspan` desynchronise child index from column index.
 * - **`<colgroup>`/`<col>` cannot.** Only `border`, `background`, `width` and
 *   `visibility` apply to a `col` element (CSS 2.1 §17.3); `text-align` on `col`
 *   is ignored by every browser. This is a live trap here because Tiptap's
 *   `TableView` ALREADY renders a colgroup for column resizing, so the wrong fix
 *   looks available and silently does nothing.
 * - **A per-cell attribute cannot** without writing to the document: it invents a
 *   cell attribute the server neither writes nor reads (the class of bug
 *   `tests/client/attribute-parity.test.ts` exists to police), and it makes a
 *   purely visual concern undoable and dirties the doc on open.
 *
 * So the column index is computed at view time and applied as a node decoration.
 * This is the first per-cell table decoration in the codebase.
 *
 * ## The cell → column mapping is `TableMap`'s, never ours
 *
 * `TableMap` is prosemirror-tables' own authority — the same structure
 * `addColumnBefore`, `deleteColumn`, `mergeCells` and `splitCell` operate on. It
 * expands `colspan`/`rowspan` into a dense `width × height` grid of cell
 * positions, so a cell that spans down from row 1 still occupies its column in
 * row 2 and every later cell in that row keeps its true column index.
 *
 * The naive alternative — `row.child(i)` is column `i` — is wrong for exactly
 * the tables the #923 context menu produces, and wrong SILENTLY: a single
 * `rowspan` shifts a whole table's alignment one column. `tests/client/
 * table-column-align.test.ts` pins both the rowspan and colspan cases.
 *
 * Structural edits cannot leave this stale because the set is rebuilt from
 * scratch on every `docChanged` rather than mapped forward. `TableMap.get` is
 * memoised per node instance, so an untouched table costs a WeakMap hit, and a
 * structural edit replaces the node and invalidates the cache for us.
 *
 * A merged cell spanning two differently-aligned columns takes its LEFTMOST
 * column's alignment. That is the only thing a single `text-align` allows, and it
 * matches how the cell is serialized back to GFM.
 *
 * ## Two independent guards, and neither covers the other's case
 *
 * 1. **The cell guard tests ROLE, not existence, because of a sentinel.**
 *    `computeMap` pre-fills the grid with `0`
 *    (`prosemirror-tables/dist/index.js:124`) and LEAVES those zeros for a short
 *    row, recording `{type:"missing"}` in `map.problems`. Zero is never a real
 *    cell offset — `pos` is incremented at `index.js:127`, before the first cell
 *    of every row — but `table.nodeAt(0)` returns the first `tableRow`, NOT
 *    null. So a bare existence check passes, and `Decoration.node` spanning a
 *    `<tr>` exactly is *legal* (`NodeType.valid()` only requires the range to
 *    span a non-text node exactly) and is accepted with no warning. `text-align`
 *    on a `<tr>` then inherits into every cell in that row without its own
 *    class, so one ragged row can centre an entire header. Ragged tables are
 *    reachable: `mdast-ydoc.ts:233-250` does not pad short rows, and `fixTables`
 *    runs from `tableEditing()`'s `appendTransaction`, which
 *    `EditorState.create` never calls.
 *
 *    An earlier revision also carried an explicit `if (relPos === 0) continue;`
 *    ahead of this check and described the two as independent. They are not:
 *    every sentinel resolves to a `tableRow`, so the role check already refuses
 *    it, and deleting the skip left the whole suite green. The skip is gone and
 *    the role check is the single cover — which is also the more durable of the
 *    two, since it states the invariant the code actually needs ("only decorate
 *    a cell") in schema terms, whereas `=== 0` hard-codes a private upstream
 *    detail that would silently stop matching if `computeMap` ever pre-filled
 *    with something other than zero. T8 pins it: weakening this line to a bare
 *    `!cell` fails that test.
 * 2. **`align.length !== map.width` bails out entirely.** A positional array of
 *    the wrong length describes a different table: every column from the
 *    mismatch would render one place off and the last would lose its alignment.
 *    The column commands themselves no longer produce that state — #1535
 *    (`table-align-commands.ts`) re-indexes the array inside the same
 *    transaction as the op — but this guard is NOT thereby redundant, because
 *    the desync has sources the commands do not control: a paste, a file
 *    written by a build older than #1535, or a hand-edited `align` attribute.
 *    Such a table is normalised on its next column op; until then, showing
 *    nothing is right. It is exactly the pre-#995 behaviour for that table,
 *    whereas showing a confident wrong answer has no user recourse while the
 *    alignment UI is unbuilt.
 *
 * The two guards are independent, and each has a case the other does not see.
 * A ragged table passes the width guard (`width === align.length`) and is
 * refused only by the cell guard's role check; a table whose `align` array
 * arrived the wrong length produces no sentinel at all and is refused only by
 * the width guard. T8 pins the first, T5-width the second.
 *
 * ## Registration and ordering
 *
 * Registered in `buildSchemaExtensions()` despite adding no schema, because that
 * builder is what the client tests build editors from — placing it in
 * `Editor.svelte` instead would let the whole suite pass with the extension
 * unwired in production. `getSchema()` resolves nodes and marks only and never
 * calls `addProseMirrorPlugins`, so the schema is byte-identical.
 *
 * That puts this plugin BEFORE annotation/authorship/heading-collapse in
 * decoration order (see `Editor.svelte`, #650), which is inert here — but for a
 * narrower reason than "class merges and style does not".
 *
 * `computeOuterDeco` (`prosemirror-view/dist/index.js:1663`) concatenates BOTH
 * `class` and `style`; neither replaces the other. The difference is what
 * concatenation MEANS. Two class tokens coexist and CSS specificity decides.
 * Two `style` strings are joined and applied via `dom.style.cssText +=`, so two
 * decorations setting `text-align` resolve LAST-DECLARATION-WINS — i.e.
 * registration order would silently pick the winner. So: do not convert this to
 * an inline `style`.
 *
 * Today no other `Decoration.node` in `src/client` (`annotationPing`,
 * `awareness`, `heading-collapse`, `authorship`) emits `text-align` at all —
 * they emit `class` or `data-*` — so there is nothing for this to race with.
 */

const CLASS_PREFIX = "tandem-cell-align-";

/** The only values that may reach a DOM class name. See `usableAlignment`. */
const ALIGNMENTS: ReadonlySet<string> = new Set(["left", "center", "right"]);

/**
 * Parse the table-level `align` attribute.
 *
 * The attribute is ALWAYS a JSON string in production: the server writes
 * `JSON.stringify(align)` and `TableWithAlignment.renderHTML` emits
 * `String(attrs.align)`, so an array would come back from a DOM re-read
 * comma-joined (`"left,center"`) rather than as JSON. There is deliberately no
 * already-parsed-array branch — it is unreachable outside a hand-built fixture,
 * which would then pass while exercising a shape production never produces.
 *
 * Tolerant of garbage on purpose: the JSON comes off disk, and a malformed
 * attribute must not take the editor down on open. Mirrors the server's own
 * posture at `mdast-ydoc.ts:626-634`.
 */
function parseColumnAlign(raw: unknown): unknown[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Allowlist a single column's value.
 *
 * Not defensive noise: the value is interpolated into a DOM `class`, and it comes
 * from a file that may have been authored by someone else. Without the
 * allowlist, a crafted `.md` injects arbitrary class tokens onto editor DOM.
 * `null` — GFM's "no alignment for this column" — falls through here too.
 */
function usableAlignment(value: unknown): string | null {
  return typeof value === "string" && ALIGNMENTS.has(value) ? value : null;
}

/** Append one table's cell decorations. `pos` is the table node's own position. */
function collectTableDecorations(table: PMNode, pos: number, out: Decoration[]): void {
  const align = parseColumnAlign(table.attrs.align);
  // Cheap exit for the overwhelmingly common case — an unaligned table, which is
  // every table Tandem's own `/table` command creates. Costs one JSON.parse and
  // never builds a TableMap.
  if (!align.some((value) => usableAlignment(value) !== null)) return;

  const map = TableMap.get(table);
  // Guard 2. See the header comment: bail rather than render a confident wrong
  // answer for a table whose column count has drifted from its align array.
  if (align.length !== map.width) return;

  // `map.map` holds cell positions relative to the table's CONTENT start, so the
  // absolute position of a cell is `pos + 1 + relPos` — the same convention
  // `fixTable` uses.
  const start = pos + 1;
  const seen = new Set<number>();

  for (let i = 0; i < map.map.length; i++) {
    const relPos = map.map[i];
    // A colspan/rowspan cell occupies several slots; the FIRST is its top-left,
    // which is why `i % map.width` is its leftmost column.
    if (seen.has(relPos)) continue;
    seen.add(relPos);

    // Guard 1. Role, not existence — see the sentinel note in the header. An
    // unfilled slot holds `0`, and `table.nodeAt(0)` returns the first
    // tableRow rather than null, so `!cell` alone would let a <tr> through.
    const cell = table.nodeAt(relPos);
    const role = cell?.type.spec.tableRole;
    if (!cell || (role !== "cell" && role !== "header_cell")) continue;

    const value = usableAlignment(align[i % map.width]);
    if (value === null) continue;

    out.push(
      Decoration.node(start + relPos, start + relPos + cell.nodeSize, {
        class: `${CLASS_PREFIX}${value}`,
      }),
    );
  }
}

/** Rebuild the whole decoration set from a document. */
function buildTableAlignDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    // Returning false stops descent into THIS node only — siblings are still
    // visited — so returning false at the textblock is exactly what keeps the
    // walk off inline content. `nodesBetween` does not descend when the callback
    // returns false, and without this cut every text node in the document would
    // be visited on every keystroke. Do not delete it.
    if (node.isTextblock) return false;
    if (node.type.spec.tableRole !== "table") return true;
    collectTableDecorations(node, pos, decorations);
    // A nested table is schema-legal (`tableCell` is `content: 'block+'` and
    // `table` is in group `block`, so pasted HTML can produce one) but is
    // unreachable from GFM and is not serialized back to markdown, so it has no
    // alignment to render. Deliberately undecorated, not assumed impossible.
    return false;
  });

  if (decorations.length === 0) return DecorationSet.empty;
  return DecorationSet.create(doc, decorations);
}

export const tableColumnAlignPluginKey = new PluginKey<DecorationSet>("tandemTableColumnAlign");

export const TableColumnAlignExtension = Extension.create({
  name: "tandemTableColumnAlign",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: tableColumnAlignPluginKey,
        state: {
          init: (_config, state) => buildTableAlignDecorations(state.doc),
          // Rebuilt rather than mapped forward: an `align` change arrives as a
          // step that sets the attribute, and a structural edit invalidates every
          // column index in the table anyway. `NodeType.eq` compares attrs by
          // value, so an identical rebuilt decoration does not redraw.
          apply: (tr, previous) => (tr.docChanged ? buildTableAlignDecorations(tr.doc) : previous),
        },
        props: {
          decorations(state) {
            return tableColumnAlignPluginKey.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
