import { Extension } from "@tiptap/core";
import type { Node as PmNode, Slice as PmSlice } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "y-prosemirror";
import * as Y from "yjs";
import { AUTHORSHIP_TOGGLE_KEY, Y_MAP_AUTHORSHIP } from "../../../shared/constants";
import { withBrowser } from "../../../shared/origins";
import { type DocumentRange, type PmPos, toPmPos } from "../../../shared/positions/types";
import { anchorFlatRange } from "../../../shared/positions/ydoc";
import type { AuthorshipRange } from "../../../shared/types";
import { isAuthorshipAuthor } from "../../../shared/types";
import { generateAuthorshipId } from "../../../shared/utils";
import {
  flatOffsetToPmPos,
  pmPosToFlatOffset,
  pmSelectionToFlat,
  relRangeToPmPositions,
} from "../../positions";

export const authorshipPluginKey = new PluginKey("tandemAuthorship");

/**
 * Transaction meta naming who authored the content a transaction inserts.
 *
 * Set it on any dispatch that puts Claude's words into the document —
 * accepting a suggestion, inserting a Claude chat message — or the insertion
 * is attributed to the user, which is worse than leaving it unattributed
 * (#1388).
 *
 * A `PluginKey` rather than a bare string, matching every other meta key in
 * the codebase, and deliberately NOT `authorshipPluginKey`: `onTransaction`
 * early-returns on that one, because it marks the plugin's own rebuild/toggle
 * transactions. Overloading it would make the stamp path skip the very
 * transactions it exists to label.
 */
export const AUTHORSHIP_ORIGIN_META = new PluginKey("tandemAuthorshipOrigin");

/**
 * Read {@link AUTHORSHIP_ORIGIN_META}, narrowed to the two authors the schema
 * allows.
 *
 * `getMeta` is typed `any`, and this value reaches a Y.Map that
 * `buildAuthorshipDecorations` switches on — an unvalidated read would put an
 * off-schema author into a CRDT the decoration builder then switches on. An
 * unrecognised value falls back to `"user"` rather than throwing: the caller
 * is a keystroke handler, and refusing to attribute is a smaller failure than
 * refusing to record the edit. Note the read path makes the opposite call —
 * `buildAuthorshipDecorations` DROPS an off-schema entry rather than coercing
 * it — which is right for each side: coercing on read would paint a lie.
 */
function readAuthorshipOrigin(transaction: Transaction): AuthorshipRange["author"] {
  const origin: unknown = transaction.getMeta(AUTHORSHIP_ORIGIN_META);
  return isAuthorshipAuthor(origin) ? origin : "user";
}

/**
 * Ids of authorship entries lying entirely inside one of `deletedSpans`.
 *
 * Without this, accepting a suggestion leaves the replaced text's `"user"`
 * entry sitting at flat offsets the new `"claude"` text now occupies, and the
 * decoration builder paints both — which is the same wrong-author render #1388
 * is about, arrived at from the other side.
 *
 * **One pass over the map for the whole transaction, not one per deleted
 * span.** The map grows by one entry per doc-changing transaction and is never
 * compacted, so it reaches five figures in an afternoon's typing; a per-span
 * scan would multiply that by the match count on a replace-all. Duplicate ids
 * across spans are harmless — `Y.Map.delete` of an absent key is a no-op.
 *
 * **Fully contained only.** A partially overlapping entry needs its stored
 * range rewritten, not dropped, and rewriting it correctly means giving client
 * stamps a `relRange` they do not have today (#1471). Half a remap would turn
 * a drifted entry into a confidently wrong one.
 *
 * **Known limitation, measured, same root cause (#1471).** Stored client
 * ranges are frozen flat offsets that nothing remaps, so an entry that has
 * drifted since it was written no longer lies inside the span that deletes its
 * text, and escapes the reap. One unrelated keystroke above the span is enough.
 * Pinned executably in `authorship-stamp.test.ts` so the fix has a test waiting
 * for it rather than a comment.
 *
 * **Both limitations above apply only to UNANCHORED entries now.** An entry
 * carrying a `relRange` is skipped entirely — see the comment at the skip. The
 * escape direction stops mattering for those (a collapsed anchor paints
 * nothing), and the opposite direction — deleting an entry whose anchor was
 * still live, on a coincidental overlap of stale offsets — stops being possible.
 *
 * What remains, and is deliberately NOT fixed here: anchored entries are never
 * removed, so the map still grows without bound. It always did; the real fix is
 * coalescing consecutive same-author stamps, which is a separate issue. Trading
 * unbounded growth for correct undo attribution is the right way round —
 * growth costs memory, and deleting costs attribution permanently.
 */
function reapableEntryIds(
  authorshipMap: Y.Map<unknown>,
  deletedSpans: readonly { from: number; to: number }[],
): string[] {
  if (deletedSpans.length === 0 || authorshipMap.size === 0) return [];
  const ids: string[] = [];
  authorshipMap.forEach((value, key) => {
    const entry = value as AuthorshipRange;
    if (!entry?.range) return;
    // ANCHORED ENTRIES ARE GOVERNED BY THEIR ANCHOR, NOT BY THIS SCAN.
    //
    // Measured (`authorship-undo-redo.test.ts`): a Yjs anchor resolves BACK
    // after an undo, because resolution runs through `followRedone`. So an
    // anchored entry whose text is deleted does not need deleting — it collapses,
    // the resolver paints nothing for it, and if the user undoes, it resolves
    // again and paints correctly. Deleting it is not merely unnecessary, it is
    // destructive: nothing restores a Y.Map entry on undo, so the attribution is
    // gone permanently. That is the whole of #1480's redo symptom.
    //
    // It also closes the false-positive direction. This scan compares FROZEN
    // offsets, so a coincidental containment could delete an entry whose anchor
    // was live and pointing at text nobody touched — discarding exactly the
    // durability the anchor was minted for.
    //
    // Unanchored entries still reap. They cannot self-heal (a frozen range is
    // all they have), so leaving them is the drift this scan exists to limit.
    if (entry.relRange) return;
    const { from, to } = entry.range;
    if (deletedSpans.some((span) => from >= span.from && to <= span.to)) ids.push(key);
  });
  return ids;
}

/**
 * One insertion from the transaction, in both coordinate systems.
 *
 * The PM pair is what containment is tested against, and the flat pair is what
 * the resulting pieces are cut and anchored with. Both are already computed on
 * the stamp path, so carrying the pair costs nothing and saves two O(document)
 * walks per entry examined.
 */
interface InsertedSpan {
  pm: { from: PmPos; to: PmPos };
  flat: DocumentRange;
}

/**
 * Split any entry that an insertion landed *strictly inside* (#1471 gap 3).
 *
 * THE DEFECT THIS EXISTS FOR. A range's two endpoints are independent CRDT
 * anchors, which is what makes a deletion self-healing — clip either side and
 * the entry resolves to exactly the sub-span it still owns, with no arithmetic.
 * An insertion in the MIDDLE is the one case that property does not cover:
 * neither endpoint's item is touched, the new items simply arrive between them,
 * so a `"user"` entry silently stretches over text it did not author. The
 * insertion is stamped as `"claude"` at the same time, and
 * `buildAuthorshipDecorations` then paints two inline decorations with
 * conflicting `data-tandem-author` over the same characters while the gutter
 * counts them for both authors, skewing `dominant`. Measured before this
 * landed: typing `CLAUDE` into the middle of a user-authored `USERTEXT` left
 * `user="USERCLAUDETEXT"` and `claude="CLAUDE"`. That is #1388's render.
 *
 * Note that anchoring made this *worse* in the sense that matters. With frozen
 * offsets the stretch was unreliable — the entry drifted and half-healed into a
 * different wrong. Anchored, it is stable, reproducible and permanent, so it
 * has to be handled rather than tolerated.
 *
 * THE SPLIT. The covering entry becomes the sub-spans it still owns: the first
 * keeps the original id, author and timestamp, the rest inherit author and
 * timestamp under ids DERIVED from the original (`{id}#1`, `{id}#2`). No
 * character ends up covered by two different authors, and the new author's own
 * stamps are written unchanged.
 *
 * The derived ids are not cosmetic. `stampClaudeAuthorshipWholeDoc` keys server
 * entries as `claude-block-{i}` precisely so a re-open, session restore or
 * `tandem_appendContent` re-`set`s the same key instead of accumulating
 * duplicates. Freshly generated ids would put every piece but the first beyond
 * the reach of that mechanism: the re-stamp would rewrite `claude-block-3`,
 * silently undo the split, AND leave the orphaned right-hand pieces painting
 * underneath it — durably, since the authorship map is persisted wholesale into
 * the session file. A derived id keeps the whole family findable by prefix, and
 * the re-stamp drops the siblings before re-setting the base key.
 *
 * DIFFERENT AUTHOR ONLY, and this is a performance gate on the keystroke path
 * rather than a semantic one. Splitting a same-author entry changes no inline
 * render — the union of the pieces is the original span, painted the same
 * colour — so the only thing it ever fixed was the gutter's per-character
 * counts, and those are now deduplicated at the point they are counted. Two
 * independent reviews measured what the ungated version costs: it resolves
 * every anchored entry through two document walks before testing containment,
 * on every keystroke, against a map whose own comment above says it "reaches
 * five figures in an afternoon's typing". Measured at 42-51x slower per
 * keystroke at 1,500 entries — including at the end of the document, where
 * nothing splits at all. The author check is the one filter that costs nothing
 * and removes the dominant case: a user typing inside their own text.
 *
 * ONE PASS OVER ALL OF THE TRANSACTION'S INSERTIONS, not one pass per
 * insertion, and that is a correctness requirement rather than a saving. A
 * per-insertion pass has to skip any entry it already cut — the pieces are not
 * in the map yet, so a second pass would measure the pre-split span and emit
 * overlapping ones — and skipping means the second cut degrades to the very
 * double-coverage this function exists to remove. Find-replace-all is exactly
 * that shape: several `"claude"` insertions into one `"user"` entry in a single
 * transaction. Cutting by the whole sorted set at once has no such case.
 *
 * WHY DELETING-AND-REPLACING IS SAFE HERE WHEN THE REAP'S DELETE WAS NOT.
 * Nothing restores a Y.Map entry on undo, which is why the reap stopped
 * deleting anchored entries. The split does not have that problem: if the user
 * undoes the insertion, the pieces stay split but their anchors resolve back
 * ADJACENT — `[a,m)` and `[m,b)` — which renders identically to the single
 * `[a,b)` it came from, both as inline decorations and in the gutter's
 * per-character counts. The split is lossy in identity, not in attribution.
 *
 * The containment test is STRICT, but be precise about what that buys, because
 * it is less than it looks and a future reader will otherwise trust it too far.
 * What keeps a boundary insertion from splitting anything is the ASSOC PAIR
 * (`from` sticks right, `to` sticks left): text inserted at either edge lands
 * outside the resolved span, so the entry never covers it and the filter
 * rejects on the far endpoint regardless. Mutation-tested — relaxing `<` to
 * `<=` here fails nothing. It stays strict as a guard on an invariant held
 * elsewhere, not as the mechanism.
 *
 * All-or-nothing on the anchors. If any piece declines to mint we leave the
 * entry alone rather than writing a partly-anchored set — an unanchored piece
 * would be a frozen range with no way back, which is the exact shape #1471 is
 * about. Unanchored entries are skipped for the same reason: their stored
 * offsets are not trustworthy enough to cut on.
 *
 * THE TWO OUTER ANCHORS ARE REUSED, NOT RE-MINTED. `spans[0].from` is the
 * entry's existing `fromRel` and the last span's `to` is its existing `toRel` —
 * re-deriving them would push two known-good CRDT anchors back through the
 * PM↔Y model seam (the correspondence that drifted silently in #1450/#1459) for
 * no gain, and then overwrite the originals with the result. The all-or-nothing
 * guard would not catch a bad outcome either: `flatOffsetToRelPos` has an
 * assoc-directed ±1 retry whose whole purpose is to return a NON-null anchor at
 * a different offset than asked for. Only the interior boundaries are new, so
 * only they are minted.
 *
 * NOT THIS FUNCTION'S JOB, and it took a different mechanism: a block-structure
 * change (Enter, `splitListItem`, a backspace join, a heading toggle, a list or
 * blockquote wrap). y-prosemirror implements those by deleting the affected text
 * out of its `Y.XmlText` and re-inserting it, or rebuilding the `Y.XmlElement`
 * outright, which destroys the covering entry's anchor before this function ever
 * resolves it — the entry has already collapsed, so there is nothing left to cut.
 * `reanchorCaptured` handles it instead, from a position snapshot taken while the
 * pre-change Y.Doc was still readable (#1512). Stated here because the two run in
 * the same handler and the division between them is not obvious from either one:
 * this function cuts an entry a same-frame insertion widened, that one rebuilds an
 * entry a structural step destroyed.
 */
function splitCoveringEntries(
  ydoc: Y.Doc,
  authorshipMap: Y.Map<unknown>,
  pmDoc: PmNode,
  insertions: readonly InsertedSpan[],
  author: AuthorshipRange["author"],
): AuthorshipRange[] {
  if (authorshipMap.size === 0 || insertions.length === 0) return [];
  // Sorted once for the whole map — the cut set is the same for every entry.
  const ordered = [...insertions].sort((a, b) => a.flat.from - b.flat.from);
  const pieces: AuthorshipRange[] = [];
  authorshipMap.forEach((value) => {
    const entry = value as AuthorshipRange;
    // Both gates BEFORE any document walk — see the performance note above.
    // Every insertion in one transaction shares a single author (it is read
    // once, from the transaction meta), so this also disposes of the
    // nested-insertion case: an insertion landing inside another insertion from
    // the same transaction is always same-author.
    if (!entry?.relRange || entry.author === author) return;
    const at = relRangeToPmPositions(ydoc, pmDoc, entry.relRange);
    if (!at || at.from >= at.to) return;

    // Containment is tested in PM POSITIONS, and the flat conversion happens
    // only for the entries that survive it. Both coordinate systems are
    // monotonic in document order so the test is equivalent, but `pmSelectionToFlat`
    // is two more O(document) walks and almost every entry fails this filter.
    const inside = ordered.filter((cut) => at.from < cut.pm.from && at.to > cut.pm.to);
    if (inside.length === 0) return;

    const flat = pmSelectionToFlat(pmDoc, at);

    // The gaps between the cuts, in order. A zero-width gap — two insertions
    // that ended up adjacent — is dropped rather than stored: a zero-width
    // entry paints nothing and would only ever be a puzzle in the map.
    const spans: DocumentRange[] = [];
    let cursor = flat.from;
    for (const cut of inside) {
      if (cut.flat.from > cursor) spans.push({ from: cursor, to: cut.flat.from });
      if (cut.flat.to > cursor) cursor = cut.flat.to;
    }
    if (flat.to > cursor) spans.push({ from: cursor, to: flat.to });

    // Built aside and published only once every piece has anchored — the
    // all-or-nothing rule above.
    const split: AuthorshipRange[] = [];
    for (const [index, span] of spans.entries()) {
      const minted = anchorFlatRange(ydoc, span.from, span.to);
      if (!minted) {
        warnOnce(
          "split-declined",
          "[authorship] Could not anchor every piece of a split; the entry keeps covering the insertion (#1471)",
        );
        return;
      }
      // Reuse the endpoints that already exist rather than the re-minted ones.
      const relRange = {
        fromRel: index === 0 ? entry.relRange.fromRel : minted.fromRel,
        toRel: index === spans.length - 1 ? entry.relRange.toRel : minted.toRel,
      };
      split.push(
        index === 0
          ? { ...entry, range: span, relRange }
          : {
              id: `${entry.id}#${index}`,
              author: entry.author,
              range: span,
              relRange,
              timestamp: entry.timestamp,
            },
      );
    }
    pieces.push(...split);
  });
  return pieces;
}

/**
 * Extend the previous stamp instead of adding a new one, when the new text
 * carries straight on from it.
 *
 * WHY. The map gains one entry per doc-changing transaction and is never
 * compacted — `reapableEntryIds`'s comment above says five figures in an
 * afternoon, and since anchored entries stopped being reaped (#1480, because
 * nothing restores a Y.Map entry on undo) there is no removal path left at all.
 * It is visible rather than theoretical: `tests/e2e/authorship-attribution.spec.ts`
 * types 24 characters and gets 24 entries, 24 inline decorations and 24
 * one-character spans in the DOM.
 *
 * Measured, `Y.encodeStateAsUpdate` over 500 writes: 500 distinct keys is
 * 136,290 bytes, 500 re-sets of ONE key is 310. A 440x reduction in the session
 * file — but that number is a property of `doc.gc`, not of this function. Every
 * `new Y.Doc(` in `src/` takes the default (gc on) today; setting `gc: false`
 * anywhere to preserve history would silently take the saving away, because the
 * overwritten values stop being collected.
 *
 * NOTHING IS RE-MINTED. The merged anchor is the candidate's existing `fromRel`
 * plus the new stamp's `toRel`; the two interior anchors are dropped. Same
 * principle as the split's outer anchors, and for the same reason — re-deriving
 * a known-good CRDT anchor pushes it back through the PM-Y model seam that
 * drifted silently in #1450/#1459, and `flatOffsetToRelPos`'s assoc-directed
 * plus-or-minus-one retry means a bad outcome comes back non-null rather than
 * failing. The two endpoints need not share a `Y.XmlText`:
 * `createAbsolutePositionFromRelativePosition` derives the type from the
 * anchored item's own parent, so they resolve independently. Measured across a
 * hardBreak, where they genuinely differ.
 *
 * ADJACENCY IS TESTED IN PM POSITIONS, not flat offsets — equally injective
 * across block boundaries and two document walks cheaper, the same trade
 * `splitCoveringEntries` makes. Both are safe against the cases that look
 * dangerous: every block separator costs exactly one flat character, so two
 * stamps either side of a paragraph break differ by one and never merge; a
 * heading prefix is charged identically on both sides of the comparison and
 * cancels; and a hardBreak breaks the chain on its own, because the break's own
 * stamp cannot anchor at all.
 *
 * The `to` endpoint is `assoc: -1` (sticks left), which is what makes this work:
 * it does not move when the next character is typed at exactly that boundary.
 *
 * THE COST BEING BOUGHT, and it is real. Per-character entries made an insertion
 * landing strictly inside one almost impossible; long entries make
 * `splitCoveringEntries` routine. Its all-or-nothing decline leaves the entry
 * covering the other author's insertion — one character before this, a whole run
 * after. Runs stay bounded by block boundaries, hardBreaks, author changes,
 * non-adjacency and multi-stamp transactions, and interior offsets inside one
 * paragraph mint reliably, so this is accepted rather than mitigated.
 */
function coalesceIntoPrevious(
  ydoc: Y.Doc,
  authorshipMap: Y.Map<unknown>,
  pmDoc: PmNode,
  candidateId: string | null,
  stamp: AuthorshipRange,
  insertion: InsertedSpan,
): AuthorshipRange | null {
  if (!candidateId || !stamp.relRange) return null;
  const candidate = authorshipMap.get(candidateId) as AuthorshipRange | undefined;
  if (!candidate?.relRange || candidate.author !== stamp.author) return null;

  const at = relRangeToPmPositions(ydoc, pmDoc, candidate.relRange);
  if (!at) return null;
  // NOTE THE MISSING `at.from >= at.to` GUARD, which `splitCoveringEntries`
  // does have and which plan review recommended adding here for symmetry. It is
  // deliberately absent, and the reasoning is measured rather than argued.
  //
  // A COLLAPSED candidate is one whose text has been deleted, and the case is
  // not exotic — it is delete-a-word-and-retype. Merging into it cannot
  // mis-attribute: the merge already requires the same author, and `from == to`
  // means there is no live content between the endpoints, so the merged span
  // covers only the newly typed text. Measured both ways on that scenario, and
  // on undoing back through it: the render is `user="XY"` and then `user="abc"`
  // either way. The only difference is the entry count — 2 with the guard, 1
  // without — because the guard leaves the collapsed entry behind, permanently,
  // since anchored entries are never reaped. That is precisely the accumulation
  // this function exists to stop, manufactured by the guard meant to protect it.
  if (at.to !== insertion.pm.from) return null;

  return {
    ...candidate,
    // Both ends are FLAT offsets. `at` is in PM positions and mixing the two
    // is the drift class of #1450/#1459 — the conversion is why this walk is
    // paid only for a candidate that has already passed every other test.
    range: { from: pmPosToFlatOffset(pmDoc, at.from), to: stamp.range.to },
    relRange: { fromRel: candidate.relRange.fromRel, toRel: stamp.relRange.toRel },
  };
}

const GUTTER_NODE_TYPES = new Set(["paragraph", "heading"]);

/**
 * Warn once per key per session.
 *
 * Both call sites below sit on hot paths — one runs per fallback entry per
 * decoration rebuild, the other inside a keystroke handler. An unlatched
 * `console.warn` there is not a diagnostic, it is a way of making the console
 * useless and getting the warning deleted. This change also INCREASES the
 * fallback count (entries that used to paint stale offsets now decline), so the
 * latch is a precondition for the resolver fix rather than a tidy-up.
 */
/** Where an anchored entry sat before this transaction reached Y. */
interface CapturedPosition {
  id: string;
  from: PmPos;
  to: PmPos;
}

/** A capture is valid for exactly one transaction — see {@link capturePositions}. */
export interface StructuralCapture {
  transaction: Transaction;
  positions: CapturedPosition[];
}

/**
 * Does this transaction change block structure?
 *
 * `structure` is the flag `prosemirror-transform` sets on the steps that move
 * or replace whole nodes — split, join, `setBlockType`, `wrap`, `lift`. It is
 * **not in the typings** (a constructor parameter only), so this reads an
 * undeclared runtime field; if it ever stops being stored, the repair below
 * becomes a silent no-op, which is what the positive half of the perf test
 * exists to catch.
 *
 * The second clause is not redundant. A two-paragraph paste is a plain
 * `ReplaceStep` with `structure: false` and a slice of `{openStart: 1,
 * openEnd: 1, childCount: 2}` — it destroys a covering entry's anchor exactly
 * like a split, and a gate keyed on the flag alone would miss it. It also fires
 * on some purely inline replacements (a DOM diff spanning a mark boundary
 * produces `childCount > 1`), which costs a resolve pass that then declines to
 * act; that is the trade for not missing the paste door.
 */
function changesBlockStructure(transaction: Transaction): boolean {
  for (const step of transaction.steps) {
    if ((step as unknown as { structure?: boolean }).structure === true) return true;
    const slice = (step as unknown as { slice?: PmSlice }).slice;
    if (!slice) continue;
    if (slice.openStart > 0 || slice.openEnd > 0 || slice.content.childCount > 1) return true;
  }
  return false;
}

/**
 * Every anchored entry's position, resolved against the document as it stood
 * BEFORE this transaction — the one frame in which a block-structure change's
 * victims can still be found.
 *
 * y-prosemirror writes to Y from its plugin **view**'s `update()`, which
 * `view.updateState` runs after `EditorState.apply` has finished. So a plugin's
 * own `apply` still sees the pre-change Y.Doc, while `onTransaction` — which
 * fires after `updateState` — does not. Measured: during `apply` of a split
 * round the fragment still reads one paragraph and the entry still resolves to
 * its full span; by `onTransaction` the entry has collapsed to its head.
 */
function capturePositions(
  ydoc: Y.Doc,
  authorshipMap: Y.Map<unknown>,
  oldDoc: PmNode,
): CapturedPosition[] {
  const positions: CapturedPosition[] = [];
  authorshipMap.forEach((value) => {
    const entry = value as AuthorshipRange;
    if (!entry?.relRange) return;
    const at = relRangeToPmPositions(ydoc, oldDoc, entry.relRange);
    if (!at || at.from >= at.to) return;
    positions.push({ id: entry.id, from: at.from, to: at.to });
  });
  return positions;
}

/**
 * Put back the attribution a block-structure change destroyed (#1512).
 *
 * y-prosemirror implements such a change by DELETING the affected text out of
 * its `Y.XmlText` — or rebuilding the `Y.XmlElement` outright — and inserting
 * fresh items. Nothing links the new items to the old, so the entry's anchor
 * cannot follow: a split leaves it resolving to the head alone, and a heading
 * toggle, a list or blockquote wrap, or a backspace-join leave it resolving to
 * nothing at all. An anchored entry never falls back to its flat range (#1471
 * §1.5), so those four lose the colouring silently.
 *
 * The ProseMirror mapping is the only witness to where the text went, and it
 * exists only for the duration of the transaction. So: compare where the anchor
 * says the entry is against where the mapping says its text went, and when they
 * disagree, believe the mapping — it is derived from the steps that just
 * applied.
 */
function reanchorCaptured(
  ydoc: Y.Doc,
  authorshipMap: Y.Map<unknown>,
  pmDoc: PmNode,
  mapping: Mapping,
  captured: readonly CapturedPosition[],
  insertions: readonly InsertedSpan[],
  author: AuthorshipRange["author"],
  alreadyWritten: ReadonlySet<string>,
): AuthorshipRange[] {
  const repaired: AuthorshipRange[] = [];
  const ordered = [...insertions].sort((a, b) => a.flat.from - b.flat.from);

  for (const position of captured) {
    // An entry this transaction already rewrote — a gap-3 split or a coalesce —
    // is not ours to touch. Two passes writing one id in one transaction would
    // be decided by loop order inside the `withBrowser` block below.
    if (alreadyWritten.has(position.id)) continue;
    const entry = authorshipMap.get(position.id) as AuthorshipRange | undefined;
    if (!entry?.relRange) continue;

    // The same bias pair the anchors themselves carry: `from` assoc 0 so text
    // inserted at the start lands outside, `to` assoc -1 so text appended at the
    // end lands outside.
    const mapped = {
      from: toPmPos(mapping.map(position.from, 1)),
      to: toPmPos(mapping.map(position.to, -1)),
    };
    // The entry's text is gone, not moved. Minting here would produce a
    // zero-width anchor — which paints nothing, because it resolves INVERTED
    // rather than expanding — but which nothing can ever reap, since the reap
    // skips anchored entries by design (#1480). Leave the corpse recognisable.
    if (mapped.from >= mapped.to) continue;

    const resolvedNow = relRangeToPmPositions(ydoc, pmDoc, entry.relRange);
    // Both ends, not just `to`. A door that kills `from` while `to` survives
    // would otherwise be skipped and never repaired — and this is the same
    // information the endpoint reuse below consumes, so the two are one test.
    if (resolvedNow && resolvedNow.from === mapped.from && resolvedNow.to === mapped.to) continue;

    let flat: DocumentRange;
    try {
      flat = pmSelectionToFlat(pmDoc, mapped);
    } catch (err) {
      warnOnce("reanchor-convert", "[authorship] Could not convert a repaired range (#1512)", err);
      continue;
    }
    if (flat.to <= flat.from) continue;

    // Subtract this transaction's insertions when they belong to someone else,
    // or the repair re-creates the double-coverage defect `splitCoveringEntries`
    // exists to remove: a transaction that both inserts Claude's text and splits
    // inside a user run leaves that split declining, and a whole-span re-mint
    // would then cover Claude's words as the user's. Every insertion in one
    // transaction shares an author, so one comparison settles it. Separator-only
    // insertions never reach `insertions` at all, which matters — subtracting a
    // block boundary would cut the repair in two at exactly the seam it is
    // supposed to bridge.
    const spans: DocumentRange[] = [];
    if (entry.author === author) {
      spans.push(flat);
    } else {
      let cursor = flat.from;
      for (const cut of ordered) {
        if (cut.flat.to <= flat.from || cut.flat.from >= flat.to) continue;
        if (cut.flat.from > cursor) spans.push({ from: cursor, to: cut.flat.from });
        if (cut.flat.to > cursor) cursor = cut.flat.to;
      }
      if (flat.to > cursor) spans.push({ from: cursor, to: flat.to });
    }
    if (spans.length === 0) continue;

    // Reuse an endpoint only when it BOTH survived and still bounds the piece.
    // `flatOffsetToRelPos`'s assoc-directed retry returns a non-null anchor at a
    // different offset rather than failing, so a re-mint of a known-good
    // endpoint is how a silently-wrong anchor gets made. But an other-author
    // insertion sitting exactly at `flat.from` drops the leading gap, and then
    // `spans[0]` no longer starts where the entry did — reusing there would
    // pin the surviving anchor to the wrong text.
    const keepFrom =
      resolvedNow?.from === mapped.from && spans[0].from === flat.from
        ? entry.relRange.fromRel
        : null;
    const keepTo =
      resolvedNow?.to === mapped.to && spans[spans.length - 1].to === flat.to
        ? entry.relRange.toRel
        : null;

    const pieces: AuthorshipRange[] = [];
    let declined = false;
    for (const [index, span] of spans.entries()) {
      const minted = anchorFlatRange(ydoc, span.from, span.to);
      if (!minted) {
        declined = true;
        break;
      }
      const relRange = {
        fromRel: index === 0 && keepFrom ? keepFrom : minted.fromRel,
        toRel: index === spans.length - 1 && keepTo ? keepTo : minted.toRel,
      };
      pieces.push(
        index === 0
          ? { ...entry, range: span, relRange }
          : {
              id: freshSiblingId(authorshipMap, entry.id, index),
              author: entry.author,
              range: span,
              relRange,
              timestamp: entry.timestamp,
            },
      );
    }
    // All or nothing, as in `splitCoveringEntries`: a half-repaired entry is
    // worse than an unrepaired one, because the half that did anchor looks
    // authoritative.
    if (declined) {
      warnOnce(
        "reanchor-declined",
        "[authorship] Could not re-anchor an entry a structural change moved (#1512)",
      );
      continue;
    }
    repaired.push(...pieces);
  }

  return repaired;
}

/**
 * A sibling id that is unique in the map, and still a `${base}#…` sibling.
 *
 * Both halves are load-bearing. The PREFIX cannot be dropped for a fresh random
 * id: `stampClaudeAuthorshipWholeDoc` sweeps stale siblings by scanning for
 * `key.startsWith(`${base}#`)` (`src/server/mcp/document.ts`), so a repaired
 * piece of `claude-block-3` that did not carry the prefix would survive a
 * re-open as an orphan under the restored whole-block range.
 *
 * The UNIQUENESS cannot be assumed from the loop index, which is what an
 * earlier version did. `capturePositions` walks every anchored entry including
 * siblings an earlier repair created, so a second multi-span repair of the same
 * base regenerates `#r1` and `Y.Map.set` silently overwrites a live entry
 * covering unrelated text. Nothing warns on that path — `warnOnce` fires only
 * on a decline — so the guard is cheap next to a loss no one would ever see.
 */
function freshSiblingId(authorshipMap: Y.Map<unknown>, baseId: string, index: number): string {
  let candidate = `${baseId}#r${index}`;
  for (let bump = 2; authorshipMap.has(candidate); bump++) {
    candidate = `${baseId}#r${index}_${bump}`;
  }
  return candidate;
}

/**
 * Does an inserted span carry anything a reader would call authored content?
 *
 * A block-structure change (Enter, `splitListItem`) inserts a boundary, and the
 * flat coordinate system charges that boundary one character — so the insertion
 * branch below mints an entry covering a separator and no text at all.
 *
 * `textBetween` alone would be the wrong test: an inline atom renders as no
 * text, so a hardBreak or an image insertion would stop being attributed. The
 * atom scan is deliberately conservative — `nodesBetween` visits nodes merely
 * OVERLAPPING the range, so a false positive keeps a stamp rather than dropping
 * one, which is the safe direction for an attribution feature.
 */
function spanCarriesContent(doc: PmNode, from: PmPos, to: PmPos): boolean {
  if (doc.textBetween(from, to).length > 0) return true;
  let atom = false;
  doc.nodesBetween(from, to, (node) => {
    if (atom) return false;
    if (node.isInline && node.isAtom) atom = true;
    return !atom;
  });
  return atom;
}

const warnedKeys = new Set<string>();
function warnOnce(key: string, ...args: unknown[]): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(...args);
}

/** Test seam — the latch is module state and would leak between test cases. */
export function _resetAuthorshipWarnLatch(): void {
  warnedKeys.clear();
}

/**
 * Index of the first map in `mapping` that has a mirror partner, or `null` when
 * none has one. The runtime half of #1481's mirror-free assumption — see the
 * survey at the reap's `toBefore` construction for what that assumption is.
 *
 * `getMirror` rather than the `mirror` array itself: the array is `@internal`
 * and declared only as a constructor parameter in the published typings, so
 * reading it back needs a cast — and a cast is what would turn a later rename
 * of the field into a silent `undefined` here. The accessor is public.
 *
 * Exported for the test, which is the only caller that can hand this a mapping
 * WITH a mirror. Nothing in this stack produces one, so a test driving a real
 * editor can only ever observe the `null` answer, and would pass just as well
 * against a function that returned `null` unconditionally.
 */
export function firstMirroredMapIndex(mapping: Mapping): number | null {
  for (let i = 0; i < mapping.maps.length; i++) {
    if (mapping.getMirror(i) !== undefined) return i;
  }
  return null;
}

/**
 * DEV-only companion to the above. Call sites guard with `import.meta.env.DEV`
 * so this is dead code in a production build, and `warnOnce` holds it to one
 * line per session rather than one per transaction.
 */
function warnOnMirroredMapping(mapping: Mapping): void {
  const index = firstMirroredMapIndex(mapping);
  if (index === null) return;
  warnOnce(
    "mapping-mirror",
    `[authorship] Transaction mapping carries a mirror (map ${index} <-> ${mapping.getMirror(index)}). ` +
      "The reap's before-frame mapping drops it, which #1481 established was safe only because " +
      "nothing in this stack sets one. Re-open #1481 rather than silencing this.",
  );
}

/**
 * Resolve an AuthorshipRange to ProseMirror positions.
 *
 * THE FALLBACK ORDERING IS THE WHOLE POINT, and it used to be wrong. An entry
 * that HAS a `relRange` never falls back to flat offsets — if its anchor
 * resolves collapsed or dead, the entry has no live text and the answer is
 * `null`, not "try the frozen numbers instead".
 *
 * Previously the anchored result was accepted only when `from < to`, so a
 * COLLAPSED anchor — the normal state of an entry whose text was deleted or
 * replaced — fell straight through to `entry.range`. That is the orphan-paint
 * symptom itself, and it is worse than it sounds: `flatOffsetToPmPos` CLAMPS
 * rather than failing (`client/positions.ts`, which returns the end of the last
 * block for any out-of-range offset), so a stale flat range never degrades to
 * "no decoration". It degrades to a confident decoration on the wrong text —
 * precisely what the authorship overlay exists to prevent (#1388).
 *
 * The flat branch is correct only for an entry that never had an anchor at all:
 * a legacy in-session stamp, a server entry with `fullyAnchored: false`, or a
 * mint that declined (heading prefix, empty block, no Collaboration binding).
 *
 * DO NOT MIRROR THIS INTO `annotationToPmRange` — it would break annotations,
 * and the asymmetry is deliberate. That function accepts `from <= to`, so a
 * collapsed annotation anchor returns as `method: "rel"` and never reaches its
 * flat branch; the flat branch fires only on null-or-inverted, which is the
 * lazy re-attachment recovery path CLAUDE.md warns about breaking. Annotations
 * survive the shape because the SERVER refreshes their flat range on every read.
 * Authorship has no `refreshRange` analogue, so nothing ever repairs a stale
 * flat offset here — which is exactly why the same shape is safe there and
 * unsafe here.
 */
function resolveAuthorshipRange(
  entry: AuthorshipRange,
  pmDoc: PmNode,
  ydoc: Y.Doc,
): { from: number; to: number } | null {
  if (entry.relRange) {
    const resolved = relRangeToPmPositions(ydoc, pmDoc, entry.relRange);
    return resolved && resolved.from < resolved.to ? resolved : null;
  }
  if (entry.range) {
    warnOnce("flat-fallback", "[authorship] Falling back to flat offsets for range", entry.id);
    const from = flatOffsetToPmPos(pmDoc, entry.range.from);
    const to = flatOffsetToPmPos(pmDoc, entry.range.to);
    if (from < to) return { from, to };
  }
  return null;
}

/**
 * Build decorations from authorship Y.Map entries.
 */
export function buildAuthorshipDecorations(
  doc: PmNode,
  authorshipMap: Y.Map<unknown>,
  ydoc: Y.Doc,
  visible: boolean,
): DecorationSet {
  if (!visible) return DecorationSet.empty;

  const decorations: Decoration[] = [];
  const maxPos = doc.content.size;

  // Single pass: build inline spans and collect resolved ranges for the block gutter pass.
  type ResolvedEntry = { author: AuthorshipRange["author"]; from: number; to: number };
  const resolvedRanges: ResolvedEntry[] = [];

  authorshipMap.forEach((value) => {
    const entry = value as AuthorshipRange;
    if (!isAuthorshipAuthor(entry.author) || !entry.range) return;

    const r = resolveAuthorshipRange(entry, doc, ydoc);
    if (!r) return;

    const { from, to } = r;
    if (from >= to || from < 0 || to > maxPos) return;

    try {
      decorations.push(Decoration.inline(from, to, { "data-tandem-author": entry.author }));
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      console.warn("[authorship] Decoration RangeError for entry", entry.id, err);
    }

    resolvedRanges.push({ author: entry.author, from, to });
  });

  // Author per character, resolved ONCE for the whole document.
  //
  // This used to sum `overlapTo - overlapFrom` per entry per block, which
  // counts a character once for every entry covering it. Overlap is normal:
  // consecutive same-author stamps abut and can overlap, and an entry that an
  // insertion landed inside deliberately keeps covering it when the insertion
  // is the same author (splitting it there would change no inline render, and
  // paying two document walks per entry per keystroke to fix a number nobody
  // can see is what made the split 42-51x slower than the path it sits on).
  // Summing turned that harmless overlap into inflated `charCount`s that can
  // flip `dominant` in a mixed-author block — a real skew, and the second half
  // of the defect the split's comment describes.
  //
  // Last writer wins on a genuine two-author conflict, which after the split
  // should not occur. Cheaper than the old form too: O(covered chars) once,
  // rather than O(blocks x entries).
  const AUTHOR_NONE = 0;
  const AUTHOR_USER = 1;
  const AUTHOR_CLAUDE = 2;
  // Every resolved range was bounds-checked (`from >= 0`, `to <= maxPos`)
  // before it was pushed, so the fill needs no clamping of its own.
  const authorAt = new Uint8Array(maxPos + 1);
  for (const r of resolvedRanges) {
    const code = r.author === "user" ? AUTHOR_USER : AUTHOR_CLAUDE;
    for (let at = r.from; at < r.to; at++) authorAt[at] = code;
  }

  // Per-block dominant-author gutter decoration — descendants() visits nested blocks too
  doc.descendants((node, offset) => {
    if (!GUTTER_NODE_TYPES.has(node.type.name)) return;

    const blockFrom = offset;
    const blockTo = offset + node.nodeSize;

    let userChars = 0;
    let claudeChars = 0;

    // Content positions only. `blockFrom` is the block's own open token and
    // `blockTo - 1` its close token — neither is a character anybody authored,
    // and a within-block entry can never mark them, since its endpoints are
    // content positions. An entry SPANNING the boundary does mark both, so each
    // block adjacent to it used to gain one phantom authored character. That is
    // enough to flip `dominant` in a near-tied block: measured on a tail block
    // where the user really owns one character and Claude owns two, the bar
    // came out `user`. Cross-block entries already arrive today from a
    // multi-block paste, and #1512's repair will make them the ordinary shape
    // of a run that crossed an Enter.
    const countTo = Math.min(blockTo - 1, authorAt.length);
    for (let at = blockFrom + 1; at < countTo; at++) {
      const code = authorAt[at];
      if (code === AUTHOR_NONE) continue;
      if (code === AUTHOR_USER) userChars++;
      else claudeChars++;
    }

    if (userChars === 0 && claudeChars === 0) return;

    // Skip blocks whose content is empty. Authorship ranges can drift past
    // the end of a paragraph after edits leave its content empty (the CRDT
    // range still spans valid offsets but the block has no rendered
    // content). A trailing gutter bar on an empty paragraph reads as a bug.
    //
    // `content.size === 0` covers truly-empty blocks. Inline atoms like
    // `hardBreak` and `image` produce non-zero `content.size`, so paragraphs
    // that exist to render a line break or embed still get attributed.
    if (node.content.size === 0) return;

    const dominant: "user" | "claude" = userChars >= claudeChars ? "user" : "claude";

    try {
      decorations.push(
        Decoration.node(blockFrom, blockTo, { "data-tandem-author-block": dominant }),
      );
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      console.warn("[authorship] node Decoration RangeError at offset", offset, err);
    }
  });

  return DecorationSet.create(doc, decorations);
}

interface AuthorshipPluginState {
  visible: boolean;
  decorations: DecorationSet;
  /**
   * Pre-change positions for the transaction being applied, or `null`.
   *
   * Set on EVERY return path rather than carried forward — three of the four
   * paths below return `pluginState` unchanged, so a consumed capture would
   * survive into the next round and be mapped through a transaction that knows
   * nothing about the structural change it came from. `onTransaction` checks
   * the transaction identity as well, which makes that a belt as well as braces.
   */
  capture: StructuralCapture | null;
}

interface AuthorshipOptions {
  ydoc: Y.Doc | null;
}

interface AuthorshipStorage {
  lastStampId: string | null;
}

/**
 * Tiptap extension that renders authorship tracking stored in Y.Map('authorship')
 * as ProseMirror inline decorations. Uses the Y.Map overlay strategy (not inline
 * marks) to avoid CRDT size overhead -- see tests/crdt/authorship-marks-size.test.ts.
 *
 * Attribution: onTransaction records local (non-y-sync) text insertions in the
 * authorship Y.Map, against `"user"` unless the dispatch tagged itself with
 * {@link AUTHORSHIP_ORIGIN_META}, and drops entries whose text the same
 * transaction deleted.
 */
export const AuthorshipExtension = Extension.create<AuthorshipOptions, AuthorshipStorage>({
  name: "tandemAuthorship",

  addOptions() {
    return { ydoc: null };
  },

  /**
   * Per-editor state for stamp coalescing.
   *
   * `lastStampId` names the entry the previous transaction stamped, so a run of
   * typing can extend one entry instead of adding one per keystroke. Storage
   * rather than module scope because the app rebuilds the editor per tab and
   * tests run several in one process — a module-level id would leak a candidate
   * from one document into another.
   *
   * The editor is rebuilt whenever the Y.Doc identity changes (`Editor.svelte`
   * keys on it), so a tab switch or document swap resets this for free.
   * `setOptions` does not recreate the extension manager, so the readOnly and
   * spellcheck effects cannot wipe it.
   */
  addStorage() {
    return { lastStampId: null };
  },

  addProseMirrorPlugins() {
    const ydoc = this.options.ydoc;
    if (!ydoc) return [];

    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);

    let visible = false;
    try {
      visible = localStorage.getItem(AUTHORSHIP_TOGGLE_KEY) === "true";
    } catch (err) {
      console.warn("[authorship] localStorage unavailable", err);
    }

    return [
      new Plugin({
        key: authorshipPluginKey,

        state: {
          init(_, state): AuthorshipPluginState {
            return {
              visible,
              decorations: buildAuthorshipDecorations(state.doc, authorshipMap, ydoc, visible),
              capture: null,
            };
          },
          apply(tr, pluginState: AuthorshipPluginState, oldState, newState): AuthorshipPluginState {
            const meta = tr.getMeta(authorshipPluginKey);

            // THE CAPTURE, and it is computed here because this is the last
            // place the pre-change Y.Doc is readable — see `capturePositions`.
            //
            // Deliberately outside the `visible` branch below. Stamping runs
            // whether or not the overlay is on, and the toggle defaults to OFF,
            // so a capture gated on visibility would make the whole repair a
            // no-op for anyone who has not turned the colouring on.
            let capture: StructuralCapture | null = null;
            if (tr.getMeta("appendedTransaction")) {
              // An appended transaction is invisible to the ROOT transaction's
              // mapping, which is what `onTransaction` maps through — but its
              // steps are in the Y.Doc the repair reads. Mapping across that
              // gap would place an anchor one frame behind. So any appended
              // change invalidates the round, structural or not: `@tiptap/core`
              // appends TEXT-moving steps on every paste that matches a paste
              // rule, and `prosemirror-tables` appends structural ones.
              capture = tr.docChanged ? null : pluginState.capture;
            } else if (
              authorshipMap.size > 0 &&
              !tr.getMeta(ySyncPluginKey) &&
              !meta &&
              tr.docChanged &&
              changesBlockStructure(tr)
            ) {
              // y-sync is excluded because for a remote or MCP change Y is
              // written BEFORE ProseMirror applies, so there is no pre-change
              // frame left to capture and the positions would be garbage.
              capture = {
                transaction: tr,
                positions: capturePositions(ydoc, authorshipMap, oldState.doc),
              };
            }

            if (meta?.type === "toggle") {
              const newVisible = meta.visible as boolean;
              return {
                visible: newVisible,
                decorations: buildAuthorshipDecorations(
                  newState.doc,
                  authorshipMap,
                  ydoc,
                  newVisible,
                ),
                capture,
              };
            }

            if (meta?.type === "rebuild") {
              return {
                visible: pluginState.visible,
                decorations: buildAuthorshipDecorations(
                  newState.doc,
                  authorshipMap,
                  ydoc,
                  pluginState.visible,
                ),
                capture,
              };
            }

            // #1669, the same defect as `annotation.ts` and with NO recovery path
            // here at all: the branch above only ever `.map()`s, and mapping is
            // what loses the marks. The mechanism is in docs/gotchas.md, "A
            // remote sync REPLACES the doc" — deliberately not re-derived here,
            // because the two in-code copies had already drifted apart once.
            //
            // The overlay survives today only by coincidence: every MCP content
            // write also stamps `Y_MAP_AUTHORSHIP`, so this plugin's own Y.Map
            // observer rebuilds it. That is a property of the current write
            // paths, not of the design — a content-only path added later makes
            // the overlay go dark by the identical mechanism, silently.
            //
            // Gated on `visible` for the same reason the branch below is: with
            // the overlay off there is nothing to draw, and the toggle defaults
            // to OFF, so the common case pays nothing. `buildAuthorshipDecorations`
            // ALSO short-circuits on `!visible`, so the guard is not what makes
            // the result empty — it is what stops the call happening at all. A
            // spec asserting the empty result therefore cannot see this guard
            // disappear; the one that can asserts the plugin state object comes
            // back by IDENTITY, which only the fall-through return produces.
            if (tr.getMeta(ySyncPluginKey) && pluginState.visible) {
              return {
                visible: pluginState.visible,
                decorations: buildAuthorshipDecorations(
                  newState.doc,
                  authorshipMap,
                  ydoc,
                  pluginState.visible,
                ),
                capture,
              };
            }

            if (tr.docChanged && pluginState.visible) {
              return {
                visible: pluginState.visible,
                decorations: pluginState.decorations.map(tr.mapping, tr.doc),
                capture,
              };
            }

            return capture === pluginState.capture ? pluginState : { ...pluginState, capture };
          },
        },

        props: {
          decorations(state) {
            return (
              (authorshipPluginKey.getState(state) as AuthorshipPluginState | undefined)
                ?.decorations ?? DecorationSet.empty
            );
          },
        },

        view(editorView) {
          // Observe Y.Map changes and trigger decoration rebuild
          const observer = () => {
            // `buildAuthorshipDecorations` short-circuits to an empty set while
            // the overlay is hidden, so a rebuild dispatched now is a whole
            // ProseMirror transaction for a discarded result. Nothing is lost
            // by skipping: the `toggle` branch rebuilds from scratch when the
            // overlay comes back on. This matters because the reap made map
            // writes fire on DELETIONS too — backspacing over your own recent
            // text hits this on nearly every keypress.
            const current = authorshipPluginKey.getState(editorView.state) as
              | AuthorshipPluginState
              | undefined;
            if (!current?.visible) return;
            const tr = editorView.state.tr.setMeta(authorshipPluginKey, { type: "rebuild" });
            editorView.dispatch(tr);
          };
          authorshipMap.observe(observer);

          // Rebuild after initial sync — data may arrive before the observer is attached
          const syncRebuild = setTimeout(() => {
            if (authorshipMap.size > 0) observer();
          }, 500);

          return {
            destroy() {
              clearTimeout(syncRebuild);
              authorshipMap.unobserve(observer);
            },
          };
        },
      }),
    ];
  },

  /**
   * Attribution via onTransaction: record local text insertions (not y-sync
   * remotes) against an author, and drop the entries the same transaction
   * deleted out from under.
   *
   * The author is `"user"` unless the dispatcher set
   * {@link AUTHORSHIP_ORIGIN_META}. That default is deliberate and must stay:
   * find-replace, drag-drop and context-menu paste are genuine user authorship
   * with no obvious place to hang an explicit tag, and an opt-in default would
   * silently leave them unattributed instead of correctly attributed. It is
   * the *insertions Claude owns* that carry the tag — see #1388, which was
   * filed because accepting a Claude suggestion rendered the words as the
   * user's own.
   */
  onTransaction({ transaction, editor }) {
    const ydoc = this.options.ydoc;
    if (!ydoc) return;

    // Skip remote syncs — y-prosemirror tags its own applies with this key.
    if (transaction.getMeta(ySyncPluginKey)) {
      // But drop the coalescing candidate on the way out, and note that this
      // has to happen BEFORE the return rather than after it. A remote edit, an
      // MCP edit or a force-reload arrives here and changes the document under
      // a candidate the next keystroke would otherwise still extend. Re-resolving
      // catches a candidate whose OFFSETS moved; it does not catch one that
      // should no longer be a candidate at all. One line, and it removes the
      // whole class rather than the instance.
      if (transaction.docChanged) this.storage.lastStampId = null;
      return;
    }
    // Skip our own rebuild/toggle transactions
    if (transaction.getMeta(authorshipPluginKey)) return;
    // Skip if doc didn't change
    if (!transaction.docChanged) return;

    const author = readAuthorshipOrigin(transaction);
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    const pmDoc = transaction.doc;
    const beforeDoc = transaction.before;

    const additions: AuthorshipRange[] = [];
    /** This transaction's insertions in the FINAL frame — see {@link splitCoveringEntries}. */
    const insertedSpans: InsertedSpan[] = [];
    /** Deleted spans as flat offsets in the whole-transaction BEFORE frame. */
    const deletedSpans: { from: number; to: number }[] = [];

    // `mapping.maps`, not `steps`. They are pushed in lockstep by
    // `Transform.addStep` so they align today, but `i` is what `mapping.slice`
    // is keyed on — and `src/client/editor/slash-menu/extension.ts` already
    // carries that warning about this exact idiom. Iterating one and indexing
    // the other is how the two copies would drift apart.
    transaction.mapping.maps.forEach((stepMap, i) => {
      // Step i's `new*` positions address the doc as it stood immediately
      // after step i, NOT `transaction.doc`. Reading them against the final
      // doc silently mis-attributes any multi-step transaction whose later
      // steps shift earlier ones — find-and-replace-all applies its matches in
      // reverse document order, so every step but the last is affected.
      // `slice` shares the maps array and just sets bounds, so this is free.
      const toFinal = transaction.mapping.slice(i + 1);
      // The mirror image, built lazily because most transactions delete
      // nothing: step i's `old*` positions address the doc BEFORE step i,
      // while stored entries are in whole-transaction before-frame coordinates.
      let toBefore: Mapping | null = null;

      stepMap.forEach((oldStart, oldEnd, newStart, newEnd) => {
        const insertedLen = newEnd - newStart - (oldEnd - oldStart);

        if (oldEnd > oldStart) {
          try {
            // Built from a real `maps` slice rather than `mapping.slice(0, i)`,
            // because `Mapping.invert()` does NOT honour a slice's bounds: it
            // calls `appendMappingInverted`, which walks the whole `maps` array
            // and ignores `from`/`to` (prosemirror-transform, `invert` → line
            // 282). `mapping.slice(0, 0).invert()` is therefore the inverse of
            // EVERY step, not of none — which silently collapsed every reap
            // range to zero width and made the reap a no-op that nothing threw
            // over.
            //
            // THE `mirror` ARRAY GOES WITH IT, DELIBERATELY (#1481). The fix
            // suggested there — `new Mapping(maps, mirror?.filter(...))` — is
            // wrong twice over, quite apart from being unreachable.
            //
            // 1. `mirror` is a FLAT ARRAY OF PAIRS read by parity:
            //    `this.mirror[i + (i % 2 ? -1 : 1)]` (prosemirror-transform,
            //    `getMirror`). Filtering it element-wise desynchronises every
            //    pair after the first drop — keep index n, drop its partner m,
            //    and `getMirror` starts answering with a neighbouring pair's
            //    map index. That is a confidently WRONG answer, not a missing
            //    one, which is worse than the approximation it set out to fix.
            // 2. `mirror` is `@internal`. The published typings declare it as a
            //    constructor parameter only, never as a property, so reading it
            //    back needs a cast — and a cast is exactly what turns a later
            //    rename of the field into a silent `undefined` here.
            //
            // Neither matters today, because nothing in this stack has a mirror
            // to lose. `Transform.addStep` is the only writer to a
            // transaction's mapping and calls `appendMap(step.getMap())` with
            // no `mirrors` argument, so every editor command appends
            // mirror-free by construction. The structural five — list wrap,
            // `liftListItem`, `sinkListItem`, blockquote, heading toggle — are
            // each driven through a real editor in
            // `tests/client/authorship-stamp.test.ts`, which reads each
            // dispatched mapping back through `getMirror`. Those five are the
            // evidence for this paragraph — do not restate it as a measurement
            // without them, since a claim no test reproduces is exactly what
            // rots here.
            //
            // UNDO IS NOT ON THAT LIST, and its absence is not an omission.
            // There is no prosemirror-history plugin in this editor to undo
            // through — `editor-extensions.ts` builds
            // `StarterKit.configure({ history: false })` because Yjs owns
            // undo — and the Yjs UndoManager's replay arrives as a transaction
            // y-prosemirror tags with `ySyncPluginKey`, which returns at the
            // guard near the top of this handler and never reaches this line.
            // (`tests/client/authorship-undo-redo.test.ts` drives that path.)
            //
            // The two packages that do pass `mirrors` never reach a dispatched
            // transaction's mapping. `prosemirror-history` mirrors only its own
            // local `remap` (in `popEvent`, `remapping` and `compress`) and
            // dispatches through `transform.maybeStep` → `addStep` — and, per
            // the paragraph above, is not registered here at all.
            // `prosemirror-collab`'s `rebaseSteps` is the one real producer,
            // and it is INSTALLED but unimported — it ships as a dependency of
            // `@tiptap/pm`, so it is one import away, not one `npm install`
            // away. Tandem syncs through y-prosemirror, which never constructs
            // a `Mapping` at all.
            //
            // WHAT WOULD INVALIDATE THIS, AND WHAT WATCHES FOR IT. Two guards,
            // because neither covers the other's route:
            //
            //  - The static import walk in
            //    `tests/client/authorship-stamp.test.ts` asserts that nothing
            //    under `src/` imports either collab specifier. It is a CI gate,
            //    and it catches the obvious route: someone adds a collab plugin
            //    here. It is also the NARROWER guard, because it matches a
            //    literal specifier. A collab plugin arriving transitively — a
            //    third-party Tiptap collaboration extension, a Hocuspocus
            //    ProseMirror adapter; `@tiptap/pm/collab` is itself only a
            //    re-export wrapper, so one more wrapper layer is the
            //    ecosystem's ordinary idiom — or a specifier assembled by
            //    concatenation, leaves zero matches under `src/` while
            //    `transaction.mapping.mirror` becomes populated, and the walk
            //    stays green forever.
            //  - The DEV-only `warnOnce` on the next line is
            //    route-independent: it reads the mapping actually in hand, so
            //    it speaks however the mirror arrived. It is the weaker guard
            //    in the other direction — it only speaks when someone runs this
            //    path in a dev build — which is why both are here rather than
            //    either alone.
            //
            // Note the asymmetry with `toFinal` above, which DOES carry a
            // mirror through (`Mapping.slice` preserves it): that difference is
            // invisible only for as long as the field stays empty, which is
            // what the two guards are for.
            if (import.meta.env.DEV) warnOnMirroredMapping(transaction.mapping);
            toBefore ??= new Mapping(transaction.mapping.maps.slice(0, i)).invert();
            const span = pmSelectionToFlat(beforeDoc, {
              from: toPmPos(toBefore.map(oldStart, 1)),
              to: toPmPos(toBefore.map(oldEnd, -1)),
            });
            // Node-boundary steps (heading toggle, list wrap) report a deleted
            // range that carries no TEXT, so it collapses to zero flat width.
            // Correctness does not need this guard — a zero-width span contains
            // no entry, since a zero-width entry is never stored. It is an
            // early-out: dropping the span leaves `deletedSpans` empty, which
            // skips the whole map scan. Formatting keystrokes are common enough
            // to be worth not charging them an O(entries) walk. Verified by
            // mutation: removing this line fails no test, which is the point.
            if (span.to > span.from) deletedSpans.push(span);
          } catch (err) {
            console.warn("[authorship] Position conversion failed reaping a deleted span", err);
          }
        }

        // Its own try/catch: a reap that cannot resolve its span must not also
        // cost the transaction its attribution. These are independent failures.
        if (insertedLen > 0) {
          try {
            const pm = {
              from: toPmPos(toFinal.map(newStart, 1)),
              to: toPmPos(toFinal.map(newEnd, -1)),
            };
            const range = pmSelectionToFlat(pmDoc, pm);
            if (range.to <= range.from) return;
            // An Enter inserts a block boundary and nothing else, and the flat
            // system charges that boundary one character — so this branch used
            // to mint an entry covering a separator and no text.
            //
            // Usually coalescing swallowed it, which is why #1512 calls it
            // harmless. It is not harmless when the split lands at the END of a
            // block: the separator offset sits between two texts, so
            // `flatOffsetToRelPos` declines, the entry is stored with frozen
            // flat offsets and no anchor, and it paints through the flat
            // fallback — "a confident decoration on the wrong text", on an
            // authorship-tagged split. Measured via `splitListItem`.
            if (!spanCarriesContent(pmDoc, pm.from, pm.to)) return;
            // Anchor against the LIVE ydoc, which y-prosemirror has already
            // written: Tiptap's `dispatchTransaction` calls `view.updateState`
            // and emits `transaction` on the very next line, both synchronously,
            // and the sync plugin's `update()` writes to Y inside that — no
            // debounce, no microtask. So the Y.Doc is current when we stamp.
            //
            // Anchored from `range` — the FINAL-frame offsets out of
            // `toFinal.map(...)` — and never from raw `newStart`/`newEnd`. Y
            // holds only the transaction's final state, never a per-step
            // intermediate, so anchoring the raw positions would mint a
            // confidently wrong anchor on any multi-step transaction. That is
            // the same failure `toFinal` was added to prevent on the flat side.
            //
            // Declining is safe and expected: no Collaboration extension, an
            // offset inside a heading prefix, or either endpoint adjacent to an
            // empty block. The entry then behaves exactly as it does today.
            //
            // A LIVE ASSUMPTION, not an invariant — an earlier version of this
            // comment claimed the latter and was wrong about both halves.
            //
            // The assumption: no `appendTransaction` plugin moves TEXT.
            // `EditorState.apply` folds appended steps into the state handed to
            // `updateState`, and y-prosemirror writes from `view.state.doc` — but
            // the transaction Tiptap emits is the ROOT one, so `transaction.doc`
            // does not include them. A text-moving append puts `range` and the
            // Y.Doc in different frames, which binds the flat `range` exactly as
            // much as the anchor: it is a property of the whole handler.
            //
            // Four plugins in this stack define `appendTransaction`, not one.
            // `clearDocument` and `prosemirror-tables`' `tableEditing` do not
            // move text, and `@tiptap/extension-link`'s autolink only adds and
            // removes marks. `@tiptap/core`'s PasteRules DOES move text, so the
            // assumption is already false on a rule-matching paste — it fires
            // only on a `uiEvent` of paste or drop, so ordinary typing is not
            // exposed. Filed rather than smuggled in here.
            //
            // The exposure is this mint, NOT the structural repair below: that
            // one invalidates its capture whenever an appended transaction
            // changes the doc, so it declines instead of repairing from a
            // mapping it cannot trust.
            const relRange = anchorFlatRange(ydoc, range.from, range.to) ?? undefined;
            if (!relRange) {
              warnOnce(
                "mint-declined",
                "[authorship] Could not anchor a stamp; it will drift as before (#1471)",
              );
            }
            insertedSpans.push({ pm, flat: range });
            additions.push({
              id: generateAuthorshipId(author),
              author,
              range,
              ...(relRange ? { relRange } : {}),
              timestamp: Date.now(),
            });
          } catch (err) {
            console.warn("[authorship] Position conversion failed stamping an insertion", err);
          }
        }
      });
    });

    const removals = reapableEntryIds(authorshipMap, deletedSpans);
    // Gap 3, and it runs after the whole step loop rather than inside it. Both
    // operands must be FINAL-frame flat offsets — the only frame in which
    // "strictly inside" is a meaningful question — and the scan reads the live
    // ydoc, which already holds every one of this transaction's insertions.
    const splitPieces = splitCoveringEntries(ydoc, authorshipMap, pmDoc, insertedSpans, author);

    // #1512: put back what a block-structure change destroyed. The capture was
    // taken during `apply`, the last point at which the pre-change Y.Doc was
    // readable, and it is valid for THIS transaction only — an appended
    // transaction invalidates the round, so a mismatch means "do not map".
    //
    // Read before the map write below, never after: that write drives an
    // observer which dispatches a ProseMirror rebuild. Read before COALESCING
    // too, for the reason in the next comment.
    const pluginCapture = (
      authorshipPluginKey.getState(editor.state) as AuthorshipPluginState | undefined
    )?.capture;
    const structuralCapture = pluginCapture?.transaction === transaction ? pluginCapture : null;

    // Coalescing, and only for a transaction that produced EXACTLY ONE stamp.
    // Typing is exactly that; a multi-insertion transaction (find-replace-all)
    // produces several non-adjacent stamps, is not repeated per keystroke, and
    // has no single "the stamp" to extend.
    // NEVER COALESCE ON A STRUCTURAL TRANSACTION (#1512). Measured, because the
    // failure is silent and survives every other guard in this file: one
    // transaction that both types same-author text and splits the block ends
    // up attributing `USERCC` and losing `TEXT` entirely.
    //
    // The mechanism is a coincidence, not a bug in the adjacency test. A split
    // destroys the candidate's `toRel`, and Yjs resolves the destroyed anchor
    // to the LEFT EDGE of the deletion — which for a mid-run split is exactly
    // the insertion's start. So `at.to === insertion.pm.from` passes, the merge
    // looks legitimate, and it rewrites the candidate's `toRel` to the split
    // boundary. Everything past the split is then unreachable forever, since
    // anchored entries are never reaped.
    //
    // Worse, the merge keeps the candidate's id, which puts it in
    // `alreadyWritten` and makes `reanchorCaptured` skip the very entry it
    // exists to rebuild. This predates the repair — measured identical on
    // master — but the repair cannot land without it, because the repair is
    // what claims this case is fixed.
    const merged =
      !structuralCapture && additions.length === 1 && insertedSpans.length === 1
        ? coalesceIntoPrevious(
            ydoc,
            authorshipMap,
            pmDoc,
            this.storage.lastStampId,
            additions[0],
            insertedSpans[0],
          )
        : null;
    if (merged) additions[0] = merged;

    // What the NEXT transaction may extend. Deliberately three-valued:
    //
    //  - exactly one stamp   -> that stamp (or the entry it merged into)
    //  - several stamps      -> null; picking one of them would be arbitrary
    //  - NO stamp at all     -> left untouched, and this is the case that
    //    decides how much the change is worth. Backspace is a doc-changing
    //    transaction that stamps nothing, and backspace-then-retype is the
    //    commonest editing rhythm there is. Clearing here would start a fresh
    //    entry every time and gut the saving. It is safe to keep: the deletion
    //    clips the candidate's `toRel`, so the next typed character is still
    //    exactly adjacent to it and the adjacency test does the deciding.
    if (additions.length === 1) this.storage.lastStampId = additions[0].id;
    else if (additions.length > 1) this.storage.lastStampId = null;

    const repairs = structuralCapture
      ? reanchorCaptured(
          ydoc,
          authorshipMap,
          pmDoc,
          transaction.mapping,
          structuralCapture.positions,
          insertedSpans,
          author,
          // Ids this transaction has already rewritten. Both sets target
          // anchored entries by id, so without this the two passes could
          // write the same id and loop order would decide the winner.
          new Set([...splitPieces.map((p) => p.id), ...additions.map((a) => a.id)]),
        )
      : [];

    if (
      additions.length === 0 &&
      removals.length === 0 &&
      splitPieces.length === 0 &&
      repairs.length === 0
    )
      return;
    // One transaction for both halves, and removals first: the reap compares
    // BEFORE-frame offsets, while an addition's range is in final-frame
    // offsets, so an addition visible to the scan could be deleted by a
    // coincidental containment across the two frames. Collecting first makes
    // that structurally impossible rather than ordering-dependent.
    //
    // Critical Rule 2: every Y.Doc write is origin-tagged. `browser` is right
    // for all of them — this handler only ever runs for a local dispatch, the
    // remote and self-originated cases having returned above. No observer
    // filters on Y_MAP_AUTHORSHIP today, so the tag buys identity rather than
    // behaviour; that is the point of the universal rule.
    withBrowser(ydoc, () => {
      for (const id of removals) authorshipMap.delete(id);
      // Splits before additions only for readability — the two sets cannot
      // collide. A split targets an anchored entry already in the map, the reap
      // targets only unanchored ones, and an addition's id is freshly minted.
      for (const piece of splitPieces) authorshipMap.set(piece.id, piece);
      // Repairs before additions, and they cannot collide with either set: the
      // repair pass skips every id the other two produced.
      for (const piece of repairs) authorshipMap.set(piece.id, piece);
      for (const entry of additions) authorshipMap.set(entry.id, entry);
    });
  },
});
