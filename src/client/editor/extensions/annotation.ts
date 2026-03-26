import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PmNode } from "@tiptap/pm/model";
import * as Y from "yjs";
import { HIGHLIGHT_COLORS } from "../../../shared/constants";
import type { Annotation } from "../../../shared/types";
import { annotationToPmRange } from "../../positions";

const annotationPluginKey = new PluginKey("tandemAnnotations");

/**
 * Build a DecorationSet from all pending annotations in the Y.Map.
 */
function buildDecorations(
  doc: PmNode,
  annotationsMap: Y.Map<unknown>,
  ydoc: Y.Doc | null,
): DecorationSet {
  const decorations: Decoration[] = [];
  const maxPos = doc.content.size;

  annotationsMap.forEach((value) => {
    const ann = value as Annotation;
    if (ann.status !== "pending") return;
    if (!ann.range && !ann.relRange) return;

    const resolved = annotationToPmRange(ann, doc, ydoc);
    if (!resolved) return;
    const { from, to } = resolved;

    // Skip invalid ranges
    if (from >= to || from < 0 || to > maxPos) return;

    let attrs: Record<string, string> = {};

    switch (ann.type) {
      case "highlight": {
        const color = ann.color || "yellow";
        const bg = HIGHLIGHT_COLORS[color] || HIGHLIGHT_COLORS.yellow;
        attrs = {
          class: `tandem-highlight tandem-highlight--${color}`,
          style: `background: ${bg}; border-radius: 2px; padding: 1px 0;`,
          "data-annotation-id": ann.id,
        };
        break;
      }
      case "comment":
        attrs = {
          class: "tandem-comment",
          style: "border-bottom: 2px dashed #3b82f6; padding-bottom: 1px;",
          "data-annotation-id": ann.id,
        };
        break;
      case "suggestion":
        attrs = {
          class: "tandem-suggestion",
          style:
            "background: rgba(139, 92, 246, 0.15); text-decoration: underline wavy #8b5cf6; text-underline-offset: 3px;",
          "data-annotation-id": ann.id,
        };
        break;
      case "question":
        attrs = {
          class: "tandem-question",
          style:
            "background: rgba(99, 102, 241, 0.12); border-bottom: 2px solid #6366f1; padding-bottom: 1px;",
          "data-annotation-id": ann.id,
        };
        break;
      case "flag":
        attrs = {
          class: "tandem-flag",
          style:
            "background: rgba(239, 68, 68, 0.12); border-bottom: 2px solid #ef4444; padding-bottom: 1px;",
          "data-annotation-id": ann.id,
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
  name: "tandemAnnotations",

  addOptions() {
    return { ydoc: null };
  },

  addProseMirrorPlugins() {
    const ydoc = this.options.ydoc;
    if (!ydoc) return [];

    const annotationsMap = ydoc.getMap("annotations");

    return [
      new Plugin({
        key: annotationPluginKey,

        state: {
          init(_, state) {
            return buildDecorations(state.doc, annotationsMap, ydoc);
          },
          apply(tr, decorationSet, _oldState, newState) {
            // If annotations were explicitly updated, full rebuild
            if (tr.getMeta(annotationPluginKey)) {
              return buildDecorations(newState.doc, annotationsMap, ydoc);
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
