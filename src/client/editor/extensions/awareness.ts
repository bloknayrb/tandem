import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { TYPING_DEBOUNCE } from '../../../shared/constants';
import type { ClaudeAwareness } from '../../../shared/types';
import { headingPrefixLength } from '../../../shared/offsets';

const awarenessPluginKey = new PluginKey('tandemAwareness');

/**
 * Convert a ProseMirror position to a flat text offset (matching the server's extractText format).
 * This is the inverse of flatOffsetToPmPos in annotation.ts.
 * Flat text includes heading prefixes ("## ") and "\n" between elements.
 */
export function pmPosToFlatOffset(doc: PmNode, pmPos: number): number {
  let flatOffset = 0;
  let pmOffset = 0;

  const nodeCount = doc.childCount;
  for (let i = 0; i < nodeCount; i++) {
    const child = doc.child(i);
    const nodeStart = pmOffset + 1; // +1 for block open tag

    // Heading prefix in flat text
    const prefixLen = child.type.name === 'heading'
      ? headingPrefixLength((child.attrs.level as number) || 1)
      : 0;

    const textLen = child.textContent.length;
    const nodeEnd = nodeStart + textLen;

    if (pmPos <= nodeEnd) {
      // Position is within this node (or before it)
      if (pmPos <= nodeStart) {
        return flatOffset + prefixLen; // At start of node text
      }
      const offsetInNode = pmPos - nodeStart;
      return flatOffset + prefixLen + Math.min(offsetInNode, textLen);
    }

    flatOffset += prefixLen + textLen;
    pmOffset += child.nodeSize;

    // \n separator
    if (i < nodeCount - 1) {
      flatOffset += 1;
    }
  }

  return flatOffset;
}

/**
 * Build a decoration for Claude's focus paragraph.
 * Applies a soft blue tint on the paragraph Claude is currently reading.
 */
function buildFocusDecoration(doc: PmNode, focusParagraph: number | null): DecorationSet {
  if (focusParagraph === null || focusParagraph < 0) {
    return DecorationSet.empty;
  }

  const decorations: Decoration[] = [];
  let blockIndex = 0;

  doc.forEach((node, offset) => {
    if (blockIndex === focusParagraph) {
      decorations.push(
        Decoration.node(offset, offset + node.nodeSize, {
          class: 'tandem-claude-focus',
          style: 'background: rgba(99, 102, 241, 0.1); border-left: 3px solid rgba(99, 102, 241, 0.4); padding-left: 8px; transition: background 0.3s ease, border-color 0.3s ease;',
        })
      );
    }
    blockIndex++;
  });

  return DecorationSet.create(doc, decorations);
}

/**
 * Tiptap extension that:
 * 1. Renders Claude's presence (focus paragraph highlight, gutter indicator)
 * 2. Writes user's selection and activity to Y.Map('userAwareness') for the server to read
 */
export const AwarenessExtension = Extension.create<{ ydoc: Y.Doc | null }>({
  name: 'tandemAwareness',

  addOptions() {
    return { ydoc: null };
  },

  addProseMirrorPlugins() {
    const ydoc = this.options.ydoc;
    if (!ydoc) return [];

    const awarenessMap = ydoc.getMap('awareness');
    const userAwareness = ydoc.getMap('userAwareness');

    return [
      // Plugin 1: Claude presence rendering
      new Plugin({
        key: awarenessPluginKey,

        state: {
          init(_, state) {
            const claude = awarenessMap.get('claude') as ClaudeAwareness | undefined;
            return buildFocusDecoration(state.doc, claude?.focusParagraph ?? null);
          },
          apply(tr, decorationSet, _oldState, newState) {
            if (tr.getMeta(awarenessPluginKey)) {
              const claude = awarenessMap.get('claude') as ClaudeAwareness | undefined;
              return buildFocusDecoration(newState.doc, claude?.focusParagraph ?? null);
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
        key: new PluginKey('tandemUserAwareness'),

        view() {
          let typingTimeout: ReturnType<typeof setTimeout> | null = null;
          let activityWriteTimeout: ReturnType<typeof setTimeout> | null = null;
          let pendingActivity = false;
          let lastCursor = -1;
          return {
            update(view, prevState) {
              const { state } = view;

              // Broadcast selection changes (convert PM positions to flat text offsets)
              // Only when selection actually moved, not on every transaction
              if (!state.selection.eq(prevState.selection)) {
                const { from, to } = state.selection;
                const flatFrom = pmPosToFlatOffset(state.doc, from);
                const flatTo = pmPosToFlatOffset(state.doc, to);
                userAwareness.set('selection', {
                  from: flatFrom,
                  to: flatTo,
                  timestamp: Date.now(),
                });
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
                      userAwareness.set('activity', {
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
                  userAwareness.set('activity', {
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
  const awarenessMap = ydoc.getMap('awareness');
  const claude = awarenessMap.get('claude') as ClaudeAwareness | undefined;
  return claude ?? null;
}
