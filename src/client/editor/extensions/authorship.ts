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
    const from = flatOffsetToPmPos(pmDoc, entry.range.from);
    const to = flatOffsetToPmPos(pmDoc, entry.range.to);
    if (from < to) return { from, to };
  }
  return null;
}

/**
 * Build decorations from authorship Y.Map entries.
 */
function buildAuthorshipDecorations(
  doc: PmNode,
  authorshipMap: Y.Map<unknown>,
  ydoc: Y.Doc,
  visible: boolean,
): DecorationSet {
  if (!visible) return DecorationSet.empty;

  const decorations: Decoration[] = [];
  const maxPos = doc.content.size;

  authorshipMap.forEach((value) => {
    const entry = value as AuthorshipRange;
    if (!entry.author || !entry.range) return;

    const resolved = resolveAuthorshipRange(entry, doc, ydoc);
    if (!resolved) return;

    const { from, to } = resolved;
    if (from >= to || from < 0 || to > maxPos) return;

    const attrs: Record<string, string> = {
      class: `tandem-authorship tandem-authorship--${entry.author}`,
    };

    try {
      decorations.push(Decoration.inline(from, to, attrs));
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
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
    } catch {
      // localStorage unavailable
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

          return {
            destroy() {
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
            const flatTo = pmPosToFlatOffset(pmDoc, toPmPos(newStart + insertedLen));
            if (flatTo <= flatFrom) return;

            const rangeId = generateAuthorshipId("user");
            const entry: AuthorshipRange = {
              id: rangeId,
              author: "user",
              range: { from: flatFrom, to: flatTo },
              timestamp: Date.now(),
            };
            authorshipMap.set(rangeId, entry);
          } catch {
            // Position conversion can fail during complex edits; skip silently
          }
        }
      });
    });
  },
});
