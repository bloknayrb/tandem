import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "y-prosemirror";
import * as Y from "yjs";
import {
  TYPING_DEBOUNCE,
  Y_MAP_ACTIVITY,
  Y_MAP_AWARENESS,
  Y_MAP_CLAUDE,
  Y_MAP_SELECTION,
  Y_MAP_USER_AWARENESS,
} from "../../../shared/constants";
import { withBrowser } from "../../../shared/origins";
import { toFlatOffset, toPmPos } from "../../../shared/positions/types";
import type { ClaudeAwareness } from "../../../shared/types";
import { flatOffsetToPmPos, pmSelectionToFlat } from "../../positions";

/** Exported so a test can read the decoration set back; see #1669. */
export const awarenessPluginKey = new PluginKey("tandemAwareness");

/**
 * Build decorations for Claude's awareness state:
 * - Paragraph gutter highlight when focusParagraph is set
 * - Character-level cursor widget when focusOffset is set
 *
 * Falls back to paragraph-only gutter if cursor decoration fails.
 */
export function buildAwarenessDecorations(
  doc: PmNode,
  awareness: ClaudeAwareness | null,
): DecorationSet {
  if (!awareness) return DecorationSet.empty;

  const decorations: Decoration[] = [];
  const { focusParagraph, focusOffset, active } = awareness;

  // Paragraph gutter decoration
  if (focusParagraph !== null && focusParagraph >= 0) {
    let blockIndex = 0;
    doc.forEach((node, offset) => {
      if (blockIndex === focusParagraph) {
        decorations.push(
          // Class only, no `style`. The tint, rail and their 300ms cross-fade
          // now live on `.tandem-claude-focus` in `editor.css` — every value
          // here was static, and an inline `transition` is unreachable by the
          // reduced-motion guards that file already carries for this element's
          // `::before` (#1530).
          Decoration.node(offset, offset + node.nodeSize, {
            class: "tandem-claude-focus",
          }),
        );
      }
      blockIndex++;
    });
  }

  // Character-level cursor decoration
  if (focusOffset !== null && focusOffset >= 0) {
    try {
      const pmPos = flatOffsetToPmPos(doc, toFlatOffset(focusOffset));

      const idleClass = active === false ? " tandem-claude-cursor-idle" : "";
      decorations.push(
        Decoration.widget(pmPos, () => {
          const cursor = document.createElement("span");
          cursor.className = `tandem-claude-cursor${idleClass}`;
          cursor.setAttribute("aria-hidden", "true");

          const label = document.createElement("span");
          label.className = "tandem-claude-cursor-label";
          label.textContent = "AI";
          cursor.appendChild(label);

          return cursor;
        }),
      );
    } catch (err) {
      // Fallback: skip cursor decoration, paragraph gutter still renders
      console.warn("[awareness] cursor decoration failed, falling back to gutter-only:", err);
    }
  }

  if (decorations.length === 0) return DecorationSet.empty;
  return DecorationSet.create(doc, decorations);
}

/**
 * Tiptap extension that:
 * 1. Renders Claude's presence (focus paragraph highlight, gutter indicator, character cursor)
 * 2. Writes user's selection and activity to Y.Map('userAwareness') for the server to read
 */
export const AwarenessExtension = Extension.create<{ ydoc: Y.Doc | null }>({
  name: "tandemAwareness",

  addOptions() {
    return { ydoc: null };
  },

  addProseMirrorPlugins() {
    const ydoc = this.options.ydoc;
    if (!ydoc) return [];

    const awarenessMap = ydoc.getMap(Y_MAP_AWARENESS);
    const userAwareness = ydoc.getMap(Y_MAP_USER_AWARENESS);

    return [
      // Plugin 1: Claude presence rendering
      new Plugin({
        key: awarenessPluginKey,

        state: {
          init(_, state) {
            const claude = awarenessMap.get(Y_MAP_CLAUDE) as ClaudeAwareness | undefined;
            return buildAwarenessDecorations(state.doc, claude ?? null);
          },
          apply(tr, decorationSet, _oldState, newState) {
            if (tr.getMeta(awarenessPluginKey)) {
              const claude = awarenessMap.get(Y_MAP_CLAUDE) as ClaudeAwareness | undefined;
              return buildAwarenessDecorations(newState.doc, claude ?? null);
            }
            // #1669, the third plugin with this defect and the one where it is
            // most self-defeating: this decoration exists to show where Claude
            // is WHILE Claude writes, and a remote sync replaces the doc, so
            // every write Claude makes erased the marker pointing at it. The
            // mechanism is in docs/gotchas.md, "A remote sync REPLACES the doc".
            //
            // No perf gate is needed the way `annotation.ts` needs one: the
            // awareness map holds a single entry, and `buildAwarenessDecorations`
            // returns the empty set immediately when it is absent — which is the
            // common case, since it is only populated while Claude is active.
            if (tr.getMeta(ySyncPluginKey)) {
              const claude = awarenessMap.get(Y_MAP_CLAUDE) as ClaudeAwareness | undefined;
              return buildAwarenessDecorations(newState.doc, claude ?? null);
            }
            if (tr.docChanged) {
              return decorationSet.map(tr.mapping, tr.doc);
            }
            return decorationSet;
          },
        },

        props: {
          decorations(state) {
            return awarenessPluginKey.getState(state);
          },
        },

        view(editorView) {
          const observer = () => {
            const tr = editorView.state.tr.setMeta(awarenessPluginKey, true);
            editorView.dispatch(tr);
          };
          awarenessMap.observe(observer);

          return {
            destroy() {
              awarenessMap.unobserve(observer);
            },
          };
        },
      }),

      // Plugin 2: User awareness broadcast (selection + typing activity)
      new Plugin({
        key: new PluginKey("tandemUserAwareness"),

        view() {
          let typingTimeout: ReturnType<typeof setTimeout> | null = null;
          let activityWriteTimeout: ReturnType<typeof setTimeout> | null = null;
          let selectionDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
          let pendingActivity = false;
          let lastCursor = -1;
          return {
            update(view, prevState) {
              const { state } = view;

              // Broadcast selection changes (convert PM positions to flat text offsets)
              // Only when selection actually moved, not on every transaction
              if (!state.selection.eq(prevState.selection)) {
                const flat = pmSelectionToFlat(state.doc, {
                  from: toPmPos(state.selection.from),
                  to: toPmPos(state.selection.to),
                });

                if (state.selection.from === state.selection.to) {
                  // Cursor click (deselect) — write immediately and cancel any pending selection
                  if (selectionDebounceTimeout) {
                    clearTimeout(selectionDebounceTimeout);
                    selectionDebounceTimeout = null;
                  }
                  withBrowser(ydoc, () =>
                    userAwareness.set(Y_MAP_SELECTION, {
                      ...flat,
                      timestamp: Date.now(),
                    }),
                  );
                } else {
                  // Real text selection — debounce to reduce Y.Map churn during drag
                  const selectedText = state.doc.textBetween(
                    state.selection.from,
                    state.selection.to,
                    "\n",
                  );
                  const truncated =
                    selectedText.length > 200 ? selectedText.slice(0, 197) + "..." : selectedText;

                  if (selectionDebounceTimeout) clearTimeout(selectionDebounceTimeout);
                  selectionDebounceTimeout = setTimeout(() => {
                    selectionDebounceTimeout = null;
                    withBrowser(ydoc, () =>
                      userAwareness.set(Y_MAP_SELECTION, {
                        ...flat,
                        selectedText: truncated,
                        timestamp: Date.now(),
                      }),
                    );
                  }, 150);
                }
              }

              // Broadcast typing activity — debounce the Y.Map write to avoid
              // network sync on every keystroke. Batch rapid edits into one write.
              if (state.doc !== prevState.doc) {
                lastCursor = state.selection.from;
                pendingActivity = true;

                // Debounce the "typing" write (200ms to batch rapid keystrokes)
                if (!activityWriteTimeout) {
                  activityWriteTimeout = setTimeout(() => {
                    activityWriteTimeout = null;
                    if (pendingActivity) {
                      withBrowser(ydoc, () =>
                        userAwareness.set(Y_MAP_ACTIVITY, {
                          isTyping: true,
                          cursor: lastCursor,
                          lastEdit: Date.now(),
                        }),
                      );
                    }
                  }, 200);
                }

                // Clear typing flag after longer debounce
                if (typingTimeout) clearTimeout(typingTimeout);
                typingTimeout = setTimeout(() => {
                  pendingActivity = false;
                  withBrowser(ydoc, () =>
                    userAwareness.set(Y_MAP_ACTIVITY, {
                      isTyping: false,
                      cursor: view.state.selection.from,
                      lastEdit: Date.now(),
                    }),
                  );
                }, TYPING_DEBOUNCE);
              }
            },
            destroy() {
              if (typingTimeout) clearTimeout(typingTimeout);
              if (activityWriteTimeout) clearTimeout(activityWriteTimeout);
              if (selectionDebounceTimeout) clearTimeout(selectionDebounceTimeout);
            },
          };
        },
      }),
    ];
  },
});
