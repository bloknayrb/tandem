import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import * as Y from "yjs";
import { TYPING_DEBOUNCE, Y_MAP_AWARENESS, Y_MAP_USER_AWARENESS } from "../../../shared/constants";
import { toFlatOffset, toPmPos } from "../../../shared/positions/types";
import type { ClaudeAwareness } from "../../../shared/types";
import { flatOffsetToPmPos, pmSelectionToFlat } from "../../positions";

const awarenessPluginKey = new PluginKey("tandemAwareness");

/**
 * Build decorations for Claude's awareness state:
 * - Paragraph gutter highlight when focusParagraph is set
 * - Character-level cursor widget when focusOffset is set
 *
 * Falls back to paragraph-only gutter if cursor decoration fails.
 */
function buildAwarenessDecorations(doc: PmNode, awareness: ClaudeAwareness | null): DecorationSet {
  if (!awareness) return DecorationSet.empty;

  const decorations: Decoration[] = [];
  const { focusParagraph, focusOffset, active } = awareness;

  // Paragraph gutter decoration
  if (focusParagraph !== null && focusParagraph >= 0) {
    let blockIndex = 0;
    doc.forEach((node, offset) => {
      if (blockIndex === focusParagraph) {
        decorations.push(
          Decoration.node(offset, offset + node.nodeSize, {
            class: "tandem-claude-focus",
            style:
              "background: rgba(99, 102, 241, 0.1); border-left: 3px solid rgba(99, 102, 241, 0.4); padding-left: 8px; transition: background 0.3s ease, border-color 0.3s ease;",
          }),
        );
      }
      blockIndex++;
    });
  }

  // Character-level cursor decoration
  if (focusOffset !== null && focusOffset >= 0) {
    try {
      // Bounds validation — warn on stale offsets that exceed document length
      const docSize = doc.content.size;
      if (focusOffset > docSize) {
        console.warn(
          `[awareness] focusOffset ${focusOffset} exceeds doc size ${docSize} — clamping (stale offset?)`,
        );
      }

      const pmPos = flatOffsetToPmPos(doc, toFlatOffset(focusOffset));

      const idleClass = active === false ? " tandem-claude-cursor-idle" : "";
      decorations.push(
        Decoration.widget(pmPos, () => {
          const cursor = document.createElement("span");
          cursor.className = `tandem-claude-cursor${idleClass}`;
          cursor.setAttribute("aria-hidden", "true");

          const label = document.createElement("span");
          label.className = "tandem-claude-cursor-label";
          label.textContent = "Claude";
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
            const claude = awarenessMap.get("claude") as ClaudeAwareness | undefined;
            return buildAwarenessDecorations(state.doc, claude ?? null);
          },
          apply(tr, decorationSet, _oldState, newState) {
            if (tr.getMeta(awarenessPluginKey)) {
              const claude = awarenessMap.get("claude") as ClaudeAwareness | undefined;
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
                  userAwareness.set("selection", {
                    ...flat,
                    timestamp: Date.now(),
                  });
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
                    userAwareness.set("selection", {
                      ...flat,
                      selectedText: truncated,
                      timestamp: Date.now(),
                    });
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
                      userAwareness.set("activity", {
                        isTyping: true,
                        cursor: lastCursor,
                        lastEdit: Date.now(),
                      });
                    }
                  }, 200);
                }

                // Clear typing flag after longer debounce
                if (typingTimeout) clearTimeout(typingTimeout);
                typingTimeout = setTimeout(() => {
                  pendingActivity = false;
                  userAwareness.set("activity", {
                    isTyping: false,
                    cursor: view.state.selection.from,
                    lastEdit: Date.now(),
                  });
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

/**
 * Helper to read Claude's current status from the awareness Y.Map.
 * Used by StatusBar component.
 */
export function getClaudeStatus(ydoc: Y.Doc): ClaudeAwareness | null {
  const awarenessMap = ydoc.getMap(Y_MAP_AWARENESS);
  const claude = awarenessMap.get("claude") as ClaudeAwareness | undefined;
  return claude ?? null;
}
