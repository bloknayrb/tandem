import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { HIGHLIGHT_COLORS } from '../../../shared/constants';
import type { Annotation } from '../../../shared/types';
import { headingPrefixLength } from '../../../shared/offsets';

const annotationPluginKey = new PluginKey('tandemAnnotations');

/**
 * Convert a flat character offset (from the server's extractText format) to a
 * ProseMirror document position.
 *
 * extractText() joins element texts with '\n' and prepends heading prefixes
 * like "# ", "## ". ProseMirror doesn't have those prefixes in its content,
 * so we need to account for them when mapping.
 */
export function flatOffsetToPmPos(doc: PmNode, flatOffset: number): number {
  let accumulated = 0;
  let pmOffset = 0; // Running ProseMirror position

  const nodeCount = doc.childCount;
  for (let i = 0; i < nodeCount; i++) {
    const child = doc.child(i);
    // In PM, each block node adds 1 for its opening tag
    const childStart = pmOffset + 1;

    // Heading prefix chars exist in flat text but not in PM
    const prefixLen = child.type.name === 'heading'
      ? headingPrefixLength((child.attrs.level as number) || 1)
      : 0;

    const textLen = child.textContent.length;
    const fullFlatLen = prefixLen + textLen;

    if (accumulated + fullFlatLen > flatOffset) {
      // Target is within this node
      const offsetInFlat = flatOffset - accumulated;
      const textOffset = Math.max(0, offsetInFlat - prefixLen);
      // Clamp to actual text length
      return childStart + Math.min(textOffset, textLen);
    }

    accumulated += fullFlatLen;
    pmOffset += child.nodeSize; // nodeSize includes open tag + content + close tag

    // Account for '\n' separator between elements in flat text
    if (i < nodeCount - 1) {
      accumulated += 1;
      if (accumulated > flatOffset) {
        // Offset falls on the newline — treat as end of this node
        return childStart + textLen;
      }
    }
  }

  // Past end of doc
  return doc.content.size;
}

/**
 * Build a DecorationSet from all pending annotations in the Y.Map.
 */
function buildDecorations(doc: PmNode, annotationsMap: Y.Map<unknown>): DecorationSet {
  const decorations: Decoration[] = [];
  const maxPos = doc.content.size;

  annotationsMap.forEach((value) => {
    const ann = value as Annotation;
    if (ann.status !== 'pending') return;
    if (!ann.range) return;

    const from = flatOffsetToPmPos(doc, ann.range.from);
    const to = flatOffsetToPmPos(doc, ann.range.to);

    // Skip invalid ranges
    if (from >= to || from < 0 || to > maxPos) return;

    let attrs: Record<string, string> = {};

    switch (ann.type) {
      case 'highlight': {
        const color = ann.color || 'yellow';
        const bg = HIGHLIGHT_COLORS[color] || HIGHLIGHT_COLORS.yellow;
        attrs = {
          class: `tandem-highlight tandem-highlight--${color}`,
          style: `background: ${bg}; border-radius: 2px; padding: 1px 0;`,
          'data-annotation-id': ann.id,
        };
        break;
      }
      case 'comment':
        attrs = {
          class: 'tandem-comment',
          style: 'border-bottom: 2px dashed #3b82f6; padding-bottom: 1px;',
          'data-annotation-id': ann.id,
        };
        break;
      case 'suggestion':
        attrs = {
          class: 'tandem-suggestion',
          style: 'background: rgba(139, 92, 246, 0.15); text-decoration: underline wavy #8b5cf6; text-underline-offset: 3px;',
          'data-annotation-id': ann.id,
        };
        break;
      case 'question':
        attrs = {
          class: 'tandem-question',
          style: 'background: rgba(99, 102, 241, 0.12); border-bottom: 2px solid #6366f1; padding-bottom: 1px;',
          'data-annotation-id': ann.id,
        };
        break;
      case 'flag':
        attrs = {
          class: 'tandem-flag',
          style: 'background: rgba(239, 68, 68, 0.12); border-bottom: 2px solid #ef4444; padding-bottom: 1px;',
          'data-annotation-id': ann.id,
        };
        break;
      default:
        return; // Unknown type, skip
    }

    try {
      decorations.push(Decoration.inline(from, to, attrs));
    } catch {
      // Range might be invalid after doc changes — skip silently
    }
  });

  return DecorationSet.create(doc, decorations);
}

/**
 * Tiptap extension that renders annotations stored in Y.Map('annotations')
 * as ProseMirror inline decorations in the editor.
 */
export const AnnotationExtension = Extension.create<{ ydoc: Y.Doc | null }>({
  name: 'tandemAnnotations',

  addOptions() {
    return { ydoc: null };
  },

  addProseMirrorPlugins() {
    const ydoc = this.options.ydoc;
    if (!ydoc) return [];

    const annotationsMap = ydoc.getMap('annotations');

    return [
      new Plugin({
        key: annotationPluginKey,

        state: {
          init(_, state) {
            return buildDecorations(state.doc, annotationsMap);
          },
          apply(tr, decorationSet, _oldState, newState) {
            // If annotations were explicitly updated, full rebuild
            if (tr.getMeta(annotationPluginKey)) {
              return buildDecorations(newState.doc, annotationsMap);
            }
            // If doc changed, map existing decorations forward
            if (tr.docChanged) {
              return decorationSet.map(tr.mapping, tr.doc);
            }
            return decorationSet;
          },
        },

        props: {
          decorations(state) {
            return annotationPluginKey.getState(state);
          },
        },

        view(editorView) {
          // Observe Y.Map changes and trigger decoration rebuild
          const observer = () => {
            // Dispatch a no-op transaction with metadata to trigger rebuild
            const tr = editorView.state.tr.setMeta(annotationPluginKey, true);
            editorView.dispatch(tr);
          };
          annotationsMap.observe(observer);

          return {
            destroy() {
              annotationsMap.unobserve(observer);
            },
          };
        },
      }),
    ];
  },
});
