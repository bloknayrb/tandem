import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
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
 * NOT COVERED: a block-splitting insertion (Enter, `splitListItem`). y-prosemirror
 * implements the split by deleting the tail out of the original `Y.XmlText` and
 * re-inserting it into a new one, which destroys the covering entry's `toRel`
 * before this function ever resolves it — the entry has already collapsed to
 * the split point, so there is nothing left to cut and the tail ends up
 * unattributed. That is pre-existing rather than introduced here, and fixing it
 * needs a different mechanism (re-anchor across the split inside the step loop,
 * where the before-frame still exists). Filed as #1512 and pinned in
 * `authorship-split.test.ts`; stated here so this does not read as complete
 * coverage of insertions.
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

    const countTo = Math.min(blockTo, authorAt.length);
    for (let at = blockFrom; at < countTo; at++) {
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
            };
          },
          apply(
            tr,
            pluginState: AuthorshipPluginState,
            _oldState,
            newState,
          ): AuthorshipPluginState {
            const meta = tr.getMeta(authorshipPluginKey);

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
              };
            }

            if (tr.docChanged && pluginState.visible) {
              return {
                visible: pluginState.visible,
                decorations: pluginState.decorations.map(tr.mapping, tr.doc),
              };
            }

            return pluginState;
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
  onTransaction({ transaction }) {
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
            // UNSTATED INVARIANT, now stated: no `appendTransaction` plugin may
            // insert or delete TEXT. `EditorState.apply` folds appended steps
            // into the state handed to `updateState`, and y-prosemirror writes
            // from `view.state.doc` — but the transaction Tiptap emits is the
            // ROOT one, so `transaction.doc` does not include them. A text-moving
            // append would therefore put `range` and the Y.Doc in different
            // frames. This binds the flat `range` exactly as much as the anchor,
            // so it is a property of the whole handler rather than of the mint.
            // True today: `@tiptap/extension-link` is the only extension in the
            // stack defining `appendTransaction` and it only adds/removes marks.
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

    // Coalescing, and only for a transaction that produced EXACTLY ONE stamp.
    // Typing is exactly that; a multi-insertion transaction (find-replace-all)
    // produces several non-adjacent stamps, is not repeated per keystroke, and
    // has no single "the stamp" to extend.
    const merged =
      additions.length === 1 && insertedSpans.length === 1
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

    if (additions.length === 0 && removals.length === 0 && splitPieces.length === 0) return;
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
      for (const entry of additions) authorshipMap.set(entry.id, entry);
    });
  },
});
