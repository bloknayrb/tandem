import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import * as Y from "yjs";
import { AUTHORSHIP_TOGGLE_KEY, Y_MAP_AUTHORSHIP } from "../../../shared/constants";
import { toPmPos } from "../../../shared/positions/types";
import type { AuthorshipRange } from "../../../shared/types";
import { generateAuthorshipId } from "../../../shared/utils";
import { flatOffsetToPmPos, pmPosToFlatOffset, relRangeToPmPositions } from "../../positions";

export const authorshipPluginKey = new PluginKey("tandemAuthorship");

const GUTTER_NODE_TYPES = new Set(["paragraph", "heading"]);

/**
 * Resolve an AuthorshipRange to ProseMirror positions.
 * Prefers relRange (CRDT-anchored) with flat-offset fallback.
 */
function resolveAuthorshipRange(
  entry: AuthorshipRange,
  pmDoc: PmNode,
  ydoc: Y.Doc,
): { from: number; to: number } | null {
  if (entry.relRange) {
    const resolved = relRangeToPmPositions(ydoc, pmDoc, entry.relRange);
    if (resolved && resolved.from < resolved.to) return resolved;
  }
  if (entry.range) {
    console.warn("[authorship] Falling back to flat offsets for range", entry.id);
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
  type ResolvedEntry = { author: "user" | "claude"; from: number; to: number };
  const resolvedRanges: ResolvedEntry[] = [];

  authorshipMap.forEach((value) => {
    const entry = value as AuthorshipRange;
    if (!entry.author || !entry.range) return;
    if (entry.author !== "user" && entry.author !== "claude") return;

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

    resolvedRanges.push({ author: entry.author as "user" | "claude", from, to });
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
 * User attribution: onTransaction detects local (non-y-sync) text insertions
 * and records them as author="user" in the authorship Y.Map.
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
   * User attribution via onTransaction: detect local text insertions
   * (not y-sync remotes) and record them as author="user".
   */
  onTransaction({ transaction }) {
    const ydoc = this.options.ydoc;
    if (!ydoc) return;

    // Skip remote syncs -- y-sync$ meta is set by the collaboration extension
    if (transaction.getMeta("y-sync$")) return;
    // Skip our own rebuild/toggle transactions
    if (transaction.getMeta(authorshipPluginKey)) return;
    // Skip if doc didn't change
    if (!transaction.docChanged) return;

    const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
    const pmDoc = transaction.doc;

    transaction.steps.forEach((step) => {
      const stepMap = step.getMap();
      stepMap.forEach((oldStart, oldEnd, newStart, newEnd) => {
        const insertedLen = newEnd - newStart - (oldEnd - oldStart);
        if (insertedLen > 0) {
          try {
            const flatFrom = pmPosToFlatOffset(pmDoc, toPmPos(newStart));
            const flatTo = pmPosToFlatOffset(pmDoc, toPmPos(newEnd));
            if (flatTo <= flatFrom) return;

            const rangeId = generateAuthorshipId("user");
            const entry: AuthorshipRange = {
              id: rangeId,
              author: "user",
              range: { from: flatFrom, to: flatTo },
              timestamp: Date.now(),
            };
            authorshipMap.set(rangeId, entry);
          } catch (err) {
            console.warn("[authorship] Position conversion failed during user attribution", err);
          }
        }
      });
    });
  },
});
