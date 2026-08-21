import type { RawCommands } from "@tiptap/core";
import { isInTable, selectedRect } from "@tiptap/pm/tables";

/**
 * Keep `table.align` positionally aligned with the columns (#1535).
 *
 * A table's GFM column alignment is persisted as a JSON-string `align`
 * attribute at the TABLE level (#1462), mirroring mdast's own shape. Nothing in
 * `prosemirror-tables` knows that attribute exists, so its column commands
 * changed the column count and left the array alone: it kept its old length and
 * its old positional meaning, every entry after the change point described the
 * wrong column, and the next save wrote that to disk.
 *
 * The filed repro, reproduced against the real editor before writing any of
 * this: `| L | C | R |` / `| :- | :-: | -: |`, cursor in column 1,
 * `addColumnBefore` saved as
 *
 *     | L | | C | R |
 *     | :- | :-: | -: | - |
 *
 * — the new empty column acquired `center`, the original centre became `right`,
 * and the original right column lost its alignment. On disk.
 *
 * Why the delimiter row grows a bare `-` rather than truncating: `markdown-table`
 * sizes it from the row width, not from `align.length`
 * (`node_modules/markdown-table/index.js:224-234`), and `toAlignment(undefined)`
 * yields `-`. The corollary matters for the repair below — **a too-LONG array is
 * invisible on disk, a too-SHORT one corrupts the file**, so where this code has
 * to choose, it errs long.
 *
 * ## Why this lives in the COMMAND, not in an `appendTransaction`
 *
 * Three properties an appended repair cannot have:
 *
 * 1. **One undo step.** Tiptap's chain hands every command a shared `tr`, so by
 *    the time the wrapper resumes, the parent's steps are already on it.
 *    Appending `setNodeMarkup` to that same `tr` gives one ProseMirror
 *    transaction, hence one `y.transact`, hence one UndoManager stack item. An
 *    appended transaction is a second one and depends on `captureTimeout`
 *    merging to stay atomic under undo.
 * 2. **`authorship.ts` is not perturbed.** It discards its structural capture
 *    for any round in which an appended transaction changed the doc
 *    (`capture = tr.docChanged ? null : pluginState.capture`). Every column op
 *    would land in that bucket.
 * 3. **The index is knowable.** An appended repair sees only that the length no
 *    longer matches the width; it cannot know WHERE the column went, so it could
 *    only pad or truncate — restoring `align.length === map.width` and thereby
 *    re-opening #995's render guard onto a confidently wrong alignment. Showing
 *    nothing is honest; showing a guess is not.
 *
 * ## Why there is no origin helper here (CLAUDE.md Critical Rule 2)
 *
 * This module calls no Yjs API. It appends a step to a ProseMirror transaction;
 * y-prosemirror performs the Y.Doc write and already tags it with
 * `ySyncPluginKey` as the origin, so `installUntaggedWriteWarning` (which fires
 * only on a null origin) is correctly silent and `audit:origins` sees no
 * `.transact` call site. Every `withBrowser` call in `src/client` is a Y.Map
 * write; there is no precedent for tagging document content, because the content
 * path is not ours to tag.
 *
 * **Do not "fix" the missing helper by writing the attribute straight onto the
 * `Y.XmlElement`.** That would need `withBrowser` and would also be wrong: it
 * fights `updateYFragment`'s attribute diff, lands outside the undo stack item,
 * and re-introduces the class of bug `attribute-parity.test.ts` polices.
 */

/** What a column command did, in terms the align array cares about. */
export type ColumnOp = "before" | "after" | "delete";

/**
 * Parse the `align` attribute, returning `null` to mean **leave it alone**.
 *
 * Deliberately as tolerant as the server's reader
 * (`src/server/file-io/mdast-ydoc.ts:623-634`): a table with no alignment, a
 * `.docx`-imported table (the importer writes no `align`), and a `/table`
 * slash-command table all arrive here as absent or empty, and must come out the
 * other side with the attribute still absent. Minting `["null","null"]` on a
 * table that never had alignment would be a new attribute where there was none.
 */
export function parseAlignAttribute(raw: unknown): (string | null)[] | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  return parsed as (string | null)[];
}

/**
 * Pad or trim the array to exactly `width` entries.
 *
 * This is the self-healing step, and it is why `align.length === width` is a
 * post-condition of every column op rather than a hope: a table that arrives
 * already desynchronised (from a paste, or from a file edited by an older
 * build) is normalised on the next column op instead of drifting further.
 *
 * `Array.from` rather than `new Array(width)`: a sparse array JSON-stringifies
 * its holes to `null` anyway, but `align[i] ?? null` also folds an explicit
 * `undefined` — which mdast's own `AlignType | null | undefined` permits — into
 * the `null` the server round-trips.
 */
export function normalizeAlignToWidth(
  align: readonly (string | null)[],
  width: number,
): (string | null)[] {
  return Array.from({ length: width }, (_, i) => align[i] ?? null);
}

/**
 * The whole arithmetic, in one place.
 *
 * `rect.left` is inclusive and `rect.right` is EXCLUSIVE — `TableMap.findCell`
 * expands a colspan cell to its full extent and `rectBetween` unions the two
 * corner cells. `addColumn` is called once with a single index whatever the
 * selection's width, so an insert adds exactly one entry; `deleteColumn` loops
 * from `rect.right - 1` down to `rect.left`, so a delete removes one entry per
 * selected column.
 *
 * `width` is the table's width BEFORE the parent command ran.
 */
export function reindexAlign(
  align: readonly (string | null)[],
  width: number,
  op: ColumnOp,
  left: number,
  right: number,
): (string | null)[] {
  const next = normalizeAlignToWidth(align, width);
  if (op === "delete") next.splice(left, right - left);
  else next.splice(op === "before" ? left : right, 0, null);
  return next;
}

/** The subset of Tiptap's command props this wrapper touches. */
type ColumnCommandProps = Parameters<ReturnType<RawCommands["addColumnBefore"]>>[0];

/** A plain ProseMirror command, which is what `parent.addColumnBefore()` returns. */
type ParentCommand = ((props: ColumnCommandProps) => boolean) | undefined;

/**
 * Run a prosemirror-tables column command and re-index `align` in the SAME
 * transaction.
 *
 * The ordering is the whole trick, and three of its four steps are load-bearing
 * in a way that is invisible from the code:
 *
 * 1. **Capture the rect BEFORE the parent runs**, and note that verifying this
 *    by experiment is booby-trapped. Re-reading `selectedRect(props.state)`
 *    after the parent returns yields the IDENTICAL rect, so the capture looks
 *    pointless: `createChainableState` freezes `doc`/`selection` and refreshes
 *    them only when `.tr` is read, and the parent's last `.tr` read happened
 *    before its own steps went on. Measure against what the parent actually
 *    produced (`props.state.apply(tr)`) and the rect has moved — for the
 *    `ALIGNED` fixture with the cursor in column 1, `addColumnBefore` gives
 *    `left` 1 -> 2 and `map.width` 3 -> 4. Re-deriving the index from the
 *    post-op geometry double-counts the parent's own insert; the repro test and
 *    seven others fail on it.
 * 2. **Gate the write on the parent's RETURN VALUE, not on `dispatch`.**
 *    `deleteColumn` returns `false` from inside its `if (dispatch)` branch when
 *    the selection spans every column — after touching `state.tr`. So
 *    `editor.can().deleteColumn()` says `true` while `run()` says `false`, and a
 *    wrapper that assumed success would empty the align array while leaving the
 *    columns intact.
 * 3. **Re-read the table from `tr.doc`, never from `props.state.doc`.**
 *    `createChainableState` caches `doc`/`selection` at construction and only
 *    refreshes them when `.tr` is read, so after the parent returns
 *    `props.state.doc` is stale. Reading it would look right and resolve the
 *    wrong node.
 *
 * The position mapping is free and correct, but note that no test can
 * distinguish it: every step `addColumn`/`removeColumn` produces lands strictly
 * inside the table, so the table's own position never moves. Do not invent a
 * test that pretends to cover it.
 */
export function runColumnCommandWithReindex(
  props: ColumnCommandProps,
  parent: ParentCommand,
  op: ColumnOp,
): boolean {
  if (!parent) return false;

  const { state, tr, dispatch } = props;

  // Capture before, because the parent moves the selection.
  let captured: { tablePos: number; width: number; left: number; right: number } | null = null;
  if (dispatch && isInTable(state)) {
    const rect = selectedRect(state);
    captured = {
      // `tableStart` is the position INSIDE the table node; the node itself
      // begins one token earlier.
      tablePos: rect.tableStart - 1,
      width: rect.map.width,
      left: rect.left,
      right: rect.right,
    };
  }
  const mapFrom = tr.mapping.maps.length;

  const ok = parent(props);
  if (!ok || !dispatch || !captured) return ok;

  const tablePos = tr.mapping.slice(mapFrom).map(captured.tablePos);
  const table = tr.doc.nodeAt(tablePos);
  if (!table || table.type.spec.tableRole !== "table") return ok;

  const align = parseAlignAttribute(table.attrs.align);
  // A table with no alignment stays a table with no alignment.
  if (!align) return ok;

  const next = reindexAlign(align, captured.width, op, captured.left, captured.right);
  // Exactly `JSON.stringify` with no spacing, matching what the server writes
  // (`mdast-ydoc.ts:232`). `updateYFragment` compares attributes with `!==`, so a
  // differently formatted but semantically identical string would force a
  // spurious Y write on every column op.
  tr.setNodeMarkup(tablePos, undefined, { ...table.attrs, align: JSON.stringify(next) });
  return ok;
}
