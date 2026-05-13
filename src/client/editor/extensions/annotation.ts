import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import * as Y from "yjs";
import {
  HIGHLIGHT_COLOR_VARS,
  normalizeHighlightColor,
  Y_MAP_ANNOTATIONS,
} from "../../../shared/constants";
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
    const ann = sanitizeAnnotation(value as Annotation, (event) => {
      // Browser DevTools breadcrumb — only forensic trail client-side.
      console.warn("[sanitize]", event);
    });
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
        const color = normalizeHighlightColor(ann.color);
        const bg = HIGHLIGHT_COLOR_VARS[color];
        attrs = {
          class: `tandem-highlight tandem-highlight--${color}`,
          style: `background: ${bg}; border-radius: var(--tandem-r-1); padding: 1px 0;`,
          "data-annotation-id": ann.id,
          "data-annotation-author": ann.author,
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
            "data-annotation-author": ann.author,
            "aria-label": "Replacement annotation",
          };
        } else if (ann.author === "claude") {
          // Claude comment → solid underline (distinguishable from user's dashed)
          attrs = {
            class: "tandem-comment tandem-comment--claude",
            style: "border-bottom: 2px solid var(--tandem-author-claude); padding-bottom: 1px;",
            "data-annotation-id": ann.id,
            "data-annotation-author": ann.author,
            "aria-label": "Claude comment annotation",
          };
        } else {
          // User/import comment → dashed blue underline
          attrs = {
            class: "tandem-comment",
            style: "border-bottom: 2px dashed var(--tandem-author-user); padding-bottom: 1px;",
            "data-annotation-id": ann.id,
            "data-annotation-author": ann.author,
            "aria-label": "Comment annotation",
          };
        }
        break;
      case "note":
        attrs = {
          class: "tandem-note",
          style: "border-bottom: 2px dotted var(--tandem-fg-muted); padding-bottom: 1px;",
          "data-annotation-id": ann.id,
          "data-annotation-author": ann.author,
          "aria-label": "Note annotation",
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
    // Y.Map.size is O(n) — avoid calling it on every transaction.
    let hasAnnotations = annotationsMap.size > 0;
    let recoveryAttempted = false;

    return [
      new Plugin({
        key: annotationPluginKey,

        state: {
          init(_, state) {
            return buildDecorations(state.doc, annotationsMap, ydoc);
          },
          apply(tr, decorationSet, _oldState, newState) {
            if (tr.getMeta(annotationPluginKey)) {
              return buildDecorations(newState.doc, annotationsMap, ydoc);
            }
            if (tr.docChanged) {
              // Y.Map observer can fire before y-prosemirror populates the doc,
              // leaving decorationSet empty despite annotations in the map.
              // Gate retries so degraded state (all annotations fail range
              // validation) doesn't rebuild O(n) on every keystroke.
              if (!recoveryAttempted && decorationSet === DecorationSet.empty && hasAnnotations) {
                const rebuilt = buildDecorations(newState.doc, annotationsMap, ydoc);
                if (rebuilt !== DecorationSet.empty) recoveryAttempted = true;
                return rebuilt;
              }
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
          // Coalesce bursts of Y.Map observer fires into a single rebuild —
          // initial sync (force-reload, session restore, docx import) can fire
          // the observer hundreds of times per tick, each rebuilding O(n).
          let rafId: number | null = null;
          let rebuiltSinceMount = false;
          function scheduleRebuild() {
            if (rafId !== null) return;
            rafId = requestAnimationFrame(() => {
              rafId = null;
              rebuiltSinceMount = true;
              const tr = editorView.state.tr.setMeta(annotationPluginKey, true);
              editorView.dispatch(tr);
            });
          }

          const observer = () => {
            hasAnnotations = annotationsMap.size > 0;
            recoveryAttempted = false;
            scheduleRebuild();
          };
          annotationsMap.observe(observer);

          // y-prosemirror can populate the editor doc after the Y.Map observer
          // attached and fired against an empty PM doc; rebuild once if the
          // observer never fired during the settling window.
          const syncRebuild = setTimeout(() => {
            if (!rebuiltSinceMount && rafId === null && annotationsMap.size > 0) observer();
          }, 500);

          return {
            destroy() {
              clearTimeout(syncRebuild);
              if (rafId !== null) cancelAnimationFrame(rafId);
              annotationsMap.unobserve(observer);
            },
          };
        },
      }),
    ];
  },
});
