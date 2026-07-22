import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import * as Y from "yjs";
import {
  DECORATION_VISIBILITY_KEY,
  HIGHLIGHT_COLOR_VARS,
  normalizeHighlightColor,
  Y_MAP_ANNOTATIONS,
} from "../../../shared/constants";
import { sanitizeAnnotation } from "../../../shared/sanitize";
import type { Annotation } from "../../../shared/types";
import { agentLabelSource } from "../../hooks/useModels.svelte";
import { annotationToPmRange } from "../../positions";
import { resolveAgentLabel } from "../../utils/agentLabel";

export const annotationPluginKey = new PluginKey("tandemAnnotations");

/** Effective per-annotation-type decoration visibility (master mute folded in). */
export interface DecorationVisibility {
  comment: boolean;
  highlight: boolean;
  note: boolean;
}

/** Dispatched by App.svelte when any per-type decoration flag flips (#596 → 1.13). */
export interface AnnotationToggleMeta {
  type: "toggle-decorations";
  visible: DecorationVisibility;
}

const ALL_VISIBLE: DecorationVisibility = { comment: true, highlight: true, note: true };

/**
 * Parse the mirrored visibility blob; malformed/absent → all visible.
 *
 * Read at plugin construction. Correct cold-load behavior (no flash of marks
 * for a user who has decorations muted/off) depends on the settings hook's
 * `mirrorDecorationKeys` having seeded this key first — `createTandemSettings()`
 * runs in App.svelte's top-level script, strictly before the editor (and thus
 * this plugin) is constructed. See `useTandemSettings.svelte.ts`.
 */
export function parseStoredVisibility(): DecorationVisibility {
  try {
    const stored = localStorage.getItem(DECORATION_VISIBILITY_KEY);
    if (!stored) return { ...ALL_VISIBLE };
    const parsed = JSON.parse(stored) as Partial<DecorationVisibility>;
    return {
      comment: parsed.comment !== false,
      highlight: parsed.highlight !== false,
      note: parsed.note !== false,
    };
  } catch (err) {
    console.warn("[annotation] localStorage unavailable", err);
    return { ...ALL_VISIBLE };
  }
}

/**
 * Agent family label ("Claude"/"GPT"/…) for the agent-comment aria-label (#438).
 * Reads `agentLabelSource()` — the server-authoritative store when lit,
 * localStorage settings while dark — a subscription-free read on every
 * ProseMirror decoration pass (this runs outside the Svelte tree). Picked up on
 * the next rebuild after a model change; staleness on a screen-reader-only label
 * is acceptable given users pick one model and keep it. The dark branch keeps the
 * label byte-identical to pre-M2 for users who configured a model under v0.13.x.
 */
function readAgentFamilyLabel(): string {
  return resolveAgentLabel(agentLabelSource(), "family");
}

/**
 * Map a RAW annotation type to its rendered decoration bucket, mirroring
 * `sanitizeAnnotation`'s type normalization (highlight→highlight, note/flag→note,
 * everything else — comment/suggestion/question/unknown — →comment). Used by the
 * cheap visible-annotations walk, which reads raw Y.Map values (no sanitize, to
 * avoid O(n) allocation on every observer fire). Exported so a test can pin it
 * against `sanitizeAnnotation` — if sanitize's bucketing ever changes, this must
 * change in lockstep or the visibility gate silently disagrees with the build.
 */
export function renderedDecorationType(rawType: unknown): keyof DecorationVisibility {
  if (rawType === "highlight") return "highlight";
  if (rawType === "note" || rawType === "flag") return "note";
  return "comment";
}

/**
 * Build a DecorationSet from all pending annotations in the Y.Map.
 */
function buildDecorations(
  doc: PmNode,
  annotationsMap: Y.Map<unknown>,
  ydoc: Y.Doc | null,
  visible: DecorationVisibility,
  agentLabel: string,
): DecorationSet {
  const decorations: Decoration[] = [];
  const maxPos = doc.content.size;

  annotationsMap.forEach((value) => {
    const ann = sanitizeAnnotation(value as Annotation, (event) => {
      // Browser DevTools breadcrumb — only forensic trail client-side.
      console.warn("[sanitize]", event);
    });
    if (ann.status !== "pending") return;
    // Per-type display filter (1.13). Display-only — notes filtered here are
    // still present in the Y.Map and never read by Claude server-side (ADR-027).
    if (!visible[ann.type]) return;
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
          "data-annotation-type": ann.type,
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
            "data-annotation-type": ann.type,
            "data-annotation-author": ann.author,
            "aria-label": "Replacement annotation",
          };
        } else if (ann.author === "claude") {
          // Claude comment → solid underline (distinguishable from user's dashed)
          attrs = {
            class: "tandem-comment tandem-comment--claude",
            style: "border-bottom: 2px solid var(--tandem-author-claude); padding-bottom: 1px;",
            "data-annotation-id": ann.id,
            "data-annotation-type": ann.type,
            "data-annotation-author": ann.author,
            // #1123 M3: prefer the specific authoring model's name when the
            // local-model loop stamped one (survives sanitize via the allowlist
            // add); else the active-model family label. Dark ⇒ always the latter.
            "aria-label": `${ann.agentIdentity?.displayName ?? agentLabel} comment annotation`,
          };
        } else {
          // User/import comment → dashed blue underline
          attrs = {
            class: "tandem-comment",
            style: "border-bottom: 2px dashed var(--tandem-author-user); padding-bottom: 1px;",
            "data-annotation-id": ann.id,
            "data-annotation-type": ann.type,
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
          "data-annotation-type": ann.type,
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

    // Read initial per-type visibility from localStorage so the plugin stays
    // decoupled from the Svelte store.
    let visible = parseStoredVisibility();

    // #438: agent family label for the agent-comment aria-label, read the same
    // decoupled way. Refreshed on each rebuild (init / toggle / recovery).
    let agentFamily = readAgentFamilyLabel();

    /**
     * Does the map hold at least one pending annotation of a currently-visible
     * type? Drives both the cheap short-circuit and the docChanged recovery
     * guard. Recomputed only on visibility changes (toggle meta) and map
     * changes (observer) — NOT per keystroke — so the O(n) walk stays rare.
     * Using "visible" (not merely "present") is load-bearing: a doc of only
     * hidden-type annotations must NOT keep retrying the recovery rebuild,
     * which would re-run buildDecorations on every keystroke (the #610 perf
     * fix relies on the guard latching once a non-empty rebuild lands).
     *
     * Reads RAW Y.Map values via `renderedDecorationType` (no sanitize — that
     * would allocate O(n) on every observer fire). Iterates with an early
     * `break` so it stops at the first match instead of walking the whole map.
     */
    function computeHasVisibleAnnotations(): boolean {
      for (const value of annotationsMap.values()) {
        const ann = value as { status?: string; type?: unknown } | undefined;
        if (ann && ann.status === "pending" && visible[renderedDecorationType(ann.type)]) {
          return true;
        }
      }
      return false;
    }

    let hasVisibleAnnotations = computeHasVisibleAnnotations();
    let recoveryAttempted = false;

    return [
      new Plugin({
        key: annotationPluginKey,

        state: {
          init(_, state) {
            return hasVisibleAnnotations
              ? buildDecorations(state.doc, annotationsMap, ydoc, visible, agentFamily)
              : DecorationSet.empty;
          },
          apply(tr, decorationSet, _oldState, newState) {
            const meta = tr.getMeta(annotationPluginKey) as AnnotationToggleMeta | true | undefined;
            if (meta && typeof meta === "object" && meta.type === "toggle-decorations") {
              // A type toggle changes visibility without changing the map, so
              // recompute the visible-annotations quantity here too, and re-arm
              // recovery (a toggle that newly reveals a type whose annotations
              // failed to resolve should be allowed one rebuild attempt).
              visible = meta.visible;
              hasVisibleAnnotations = computeHasVisibleAnnotations();
              recoveryAttempted = false;
            }
            if (meta) {
              // Refresh the agent label on rebuild so a model change is reflected.
              agentFamily = readAgentFamilyLabel();
              return hasVisibleAnnotations
                ? buildDecorations(newState.doc, annotationsMap, ydoc, visible, agentFamily)
                : DecorationSet.empty;
            }
            if (!hasVisibleAnnotations) return DecorationSet.empty;
            if (tr.docChanged) {
              // Y.Map observer can fire before y-prosemirror populates the doc,
              // leaving decorationSet empty despite visible annotations in the
              // map. Gate retries so degraded state (all visible annotations
              // fail range validation) doesn't rebuild O(n) on every keystroke.
              if (
                !recoveryAttempted &&
                decorationSet === DecorationSet.empty &&
                hasVisibleAnnotations
              ) {
                const rebuilt = buildDecorations(
                  newState.doc,
                  annotationsMap,
                  ydoc,
                  visible,
                  agentFamily,
                );
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
            hasVisibleAnnotations = computeHasVisibleAnnotations();
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
