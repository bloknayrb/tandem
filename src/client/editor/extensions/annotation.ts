import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import * as Y from "yjs";
import { HIGHLIGHT_COLORS, Y_MAP_ANNOTATIONS } from "../../../shared/constants";
import { sanitizeAnnotation } from "../../../shared/sanitize";
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
    const ann = sanitizeAnnotation(value as Annotation);
    if (ann.status !== "pending") return;
    if (!ann.range && !ann.relRange) return;

    const resolved = annotationToPmRange(ann, doc, ydoc);
    if (!resolved) return;

    if (ann.relRange && resolved.method === "flat") {
      console.warn(
        "[annotation] relRange-equipped annotation %s fell back to flat offsets",
        ann.id,
      );
    }

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
          "aria-label": `Highlight annotation (${color})`,
        };
        break;
      }
      case "comment":
        if (ann.suggestedText !== undefined) {
          // Comment with replacement → wavy purple underline (suggestion visual)
          attrs = {
            class: "tandem-suggestion",
            style:
              "background: var(--tandem-suggestion-bg); text-decoration: underline wavy var(--tandem-suggestion); text-underline-offset: 3px;",
            "data-annotation-id": ann.id,
            "aria-label": "Replacement annotation",
          };
        } else if (ann.directedAt === "claude") {
          // Comment directed at Claude → solid blue underline (question visual)
          attrs = {
            class: "tandem-question",
            style:
              "background: var(--tandem-accent-bg); border-bottom: 2px solid var(--tandem-accent); padding-bottom: 1px;",
            "data-annotation-id": ann.id,
            "aria-label": "Question annotation",
          };
        } else {
          // Plain comment → dashed blue underline (unchanged)
          attrs = {
            class: "tandem-comment",
            style: "border-bottom: 2px dashed var(--tandem-author-user); padding-bottom: 1px;",
            "data-annotation-id": ann.id,
            "aria-label": "Comment annotation",
          };
        }
        break;
      case "flag":
        attrs = {
          class: "tandem-flag",
          style:
            "background: var(--tandem-error-bg); border-bottom: 2px solid var(--tandem-error); padding-bottom: 1px;",
          "data-annotation-id": ann.id,
          "aria-label": "Flag annotation",
        };
        break;
      default: {
        const _exhaustive: never = ann;
        void _exhaustive;
        console.warn("[annotation] Unhandled annotation type in buildDecorations, skipping");
        return;
      }
    }

    try {
      decorations.push(Decoration.inline(from, to, attrs));
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      console.debug("[annotation] RangeError for %s (from=%d, to=%d), skipping", ann.id, from, to);
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

    const annotationsMap = ydoc.getMap(Y_MAP_ANNOTATIONS);

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
