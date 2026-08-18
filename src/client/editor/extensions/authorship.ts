import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "y-prosemirror";
import * as Y from "yjs";
import { AUTHORSHIP_TOGGLE_KEY, Y_MAP_AUTHORSHIP } from "../../../shared/constants";
import { withBrowser } from "../../../shared/origins";
import { toPmPos } from "../../../shared/positions/types";
import { anchorFlatRange } from "../../../shared/positions/ydoc";
import type { AuthorshipRange } from "../../../shared/types";
import { isAuthorshipAuthor } from "../../../shared/types";
import { generateAuthorshipId } from "../../../shared/utils";
import { flatOffsetToPmPos, pmSelectionToFlat, relRangeToPmPositions } from "../../positions";

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
 * **AND THE OPPOSITE DIRECTION, which matters more now that entries are
 * anchored.** This scan reads only the frozen `range`, never `relRange`. So a
 * coincidental containment between a deleted span and some entry's stale offsets
 * deletes that entry outright — even when its anchor was live and pointing at
 * text nobody touched. Always possible, but previously it only cost a drifted
 * entry that was already mis-painting; now it discards the very durability the
 * anchor was minted for. Deleting is also less recoverable than mis-painting.
 * The fix is to replace this scan with an anchor-aware liveness sweep rather
 * than to patch it, which is the next piece of #1471 and deliberately not
 * bundled here — it changes what drives the sweep, not just its predicate.
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
    const { from, to } = entry.range;
    if (deletedSpans.some((span) => from >= span.from && to <= span.to)) ids.push(key);
  });
  return ids;
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

  // Per-block dominant-author gutter decoration — descendants() visits nested blocks too
  doc.descendants((node, offset) => {
    if (!GUTTER_NODE_TYPES.has(node.type.name)) return;

    const blockFrom = offset;
    const blockTo = offset + node.nodeSize;

    let userChars = 0;
    let claudeChars = 0;

    for (const r of resolvedRanges) {
      const overlapFrom = Math.max(r.from, blockFrom);
      const overlapTo = Math.min(r.to, blockTo);
      if (overlapTo <= overlapFrom) continue;
      const chars = overlapTo - overlapFrom;
      if (r.author === "user") userChars += chars;
      else claudeChars += chars;
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
export const AuthorshipExtension = Extension.create<AuthorshipOptions>({
  name: "tandemAuthorship",

  addOptions() {
    return { ydoc: null };
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
    if (transaction.getMeta(ySyncPluginKey)) return;
    // Skip our own rebuild/toggle transactions
    if (transaction.getMeta(authorshipPluginKey)) return;
    // Skip if doc didn't change
    if (!transaction.docChanged) return;

    const author = readAuthorshipOrigin(transaction);
    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    const pmDoc = transaction.doc;
    const beforeDoc = transaction.before;

    const additions: AuthorshipRange[] = [];
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
            const range = pmSelectionToFlat(pmDoc, {
              from: toPmPos(toFinal.map(newStart, 1)),
              to: toPmPos(toFinal.map(newEnd, -1)),
            });
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
    if (additions.length === 0 && removals.length === 0) return;
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
      for (const entry of additions) authorshipMap.set(entry.id, entry);
    });
  },
});
