import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../../shared/constants";
import type { Annotation } from "../../../shared/types";
import { loadSettings } from "../../hooks/useTandemSettings";
import { annotationToPmRange } from "../../positions";
import {
  type DecorationVisibility,
  parseStoredVisibility,
  renderedDecorationType,
} from "./annotation";

/**
 * A4 (#798) — editor-side gutter ping on annotation arrival.
 *
 * The rail-card slot-in half ships in `cardMotion.ts` (PR #958); this is the
 * editor half: when a new annotation lands, its anchored paragraph gets a brief
 * gutter ping (a one-shot `.tandem-annotation-ping` node decoration, auto-removed
 * after ~700ms) so "a card slid into the rail" and "here's where it lives in the
 * text" read as one event.
 *
 * Deliberately a SEPARATE plugin from `AnnotationExtension`: that plugin is
 * perf-tuned (the #610 fix latches rebuilds, a RAF coalesces the hundreds of
 * observer fires per tick on bulk load). An ephemeral fire→remove lifecycle has
 * no business inside that state machine, so this owns its own tiny DecorationSet.
 *
 * The hard part is NOT misfiring on bulk load (force-reload, session restore,
 * docx import, first-run tutorial seeding — all of which stamp fresh timestamps
 * and add every annotation in one tick). The defense is a LIVENESS GATE, not
 * timestamp freshness. Go-live is a QUIET-WINDOW debounce: while still settling,
 * every Y.Map sync fire re-arms the timer, so go-live only happens after the sync
 * burst quiets (SETTLE_MS of no map activity) — not at a fixed offset that a cold
 * or heavy sync could straggle past. At go-live everything synced so far is folded
 * into `seenIds`, so it can never ping retroactively; after that, only genuinely-
 * new keys are candidates. See `shouldPing`.
 */

export const annotationPingPluginKey = new PluginKey<DecorationSet>("tandemAnnotationPing");

const PING_MS = 700;
/** Settling window before pings are allowed — mirrors annotation.ts syncRebuild. */
const SETTLE_MS = 500;

const PING_CLASS = "tandem-annotation-ping";

interface PingAddMeta {
  type: "add";
  // No id field: the add branch only needs `deco`, and removal keys off the
  // decoration's own `{ pingId }` spec, not the meta.
  deco: Decoration;
}
interface PingRemoveMeta {
  type: "remove";
  id: string;
}
type PingMeta = PingAddMeta | PingRemoveMeta;

/**
 * Pure arrival predicate — unit-tested without mounting ProseMirror. Mirrors the
 * gates `buildDecorations` applies before it would render the annotation at all,
 * plus the liveness gate:
 *   - not live yet (settling window / bulk load) → no ping
 *   - already seen (a live observer re-fire, e.g. refreshRange relRange re-attach
 *     on an existing id) → no ping
 *   - missing (a delete/clear surfaced the id) → no ping
 *   - not pending (arrived already accepted/dismissed → no inline anchor) → no ping
 *   - muted type (user hid this type via the decorations menu) → no ping
 */
export function shouldPing(
  ann: Annotation | undefined,
  ctx: { isLive: boolean; alreadySeen: boolean; visible: DecorationVisibility },
): boolean {
  if (!ctx.isLive) return false;
  if (ctx.alreadySeen) return false;
  if (!ann) return false;
  if (ann.status !== "pending") return false;
  if (!ctx.visible[renderedDecorationType(ann.type)]) return false;
  return true;
}

/** True when motion should be skipped — in-app setting OR the OS preference. */
function motionOff(): boolean {
  try {
    if (loadSettings().reduceMotion) return true;
  } catch {
    // loadSettings can throw if localStorage is unavailable; fall through to OS.
  }
  return (
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export const AnnotationPingExtension = Extension.create<{ ydoc: Y.Doc | null }>({
  name: "tandemAnnotationPing",

  addOptions() {
    return { ydoc: null };
  },

  addProseMirrorPlugins() {
    const ydoc = this.options.ydoc;
    if (!ydoc) return [];

    const annotationsMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const seenIds = new Set<string>();
    let isLive = false;

    return [
      new Plugin<DecorationSet>({
        key: annotationPingPluginKey,

        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            // Keep live pings positioned across edits during their brief life.
            let next = set.map(tr.mapping, tr.doc);
            const meta = tr.getMeta(annotationPingPluginKey) as PingMeta | undefined;
            if (meta?.type === "add") {
              next = next.add(tr.doc, [meta.deco]);
            } else if (meta?.type === "remove") {
              const stale = next.find(
                undefined,
                undefined,
                (spec) => (spec as { pingId?: string }).pingId === meta.id,
              );
              if (stale.length) next = next.remove(stale);
            }
            return next;
          },
        },

        props: {
          decorations(state) {
            return annotationPingPluginKey.getState(state);
          },
        },

        view(editorView) {
          const pingTimers = new Map<string, ReturnType<typeof setTimeout>>();
          let destroyed = false;

          function schedulePing(id: string, ann: Annotation) {
            // Reduced motion: skip the ping entirely (the id is still recorded in
            // seenIds by the observer, so motion-on later won't retro-ping it).
            if (motionOff()) return;
            const range = annotationToPmRange(ann, editorView.state.doc, ydoc);
            if (!range) return;
            try {
              const $from = editorView.state.doc.resolve(range.from);
              const depth = $from.depth;
              if (depth < 1) return; // top-level position has no enclosing block
              const blockStart = $from.before(depth);
              const blockEnd = $from.after(depth);
              const deco = Decoration.node(
                blockStart,
                blockEnd,
                { class: PING_CLASS },
                { pingId: id },
              );
              editorView.dispatch(
                editorView.state.tr.setMeta(annotationPingPluginKey, { type: "add", deco }),
              );
              const timer = setTimeout(() => {
                pingTimers.delete(id);
                if (destroyed) return;
                editorView.dispatch(
                  editorView.state.tr.setMeta(annotationPingPluginKey, { type: "remove", id }),
                );
              }, PING_MS);
              pingTimers.set(id, timer);
            } catch (err) {
              // Decoration.node throws RangeError on a stale/invalid block range
              // (e.g. annotation resolved past the doc after a concurrent edit).
              if (!(err instanceof RangeError)) throw err;
            }
          }

          // Go live after the sync burst QUIETS, not at a fixed offset from mount.
          // Bulk load (force-reload, session restore, docx import) syncs the map
          // in a burst-then-quiet pattern, but a heavy/cold sync can straggle past
          // any fixed window — a fixed timer would flip isLive mid-burst and let
          // the late arrivals ping (the storm relocated, not removed). So this is a
          // quiet-window debounce: every observer fire while still settling re-arms
          // the timer, and go-live only happens after SETTLE_MS of no map activity.
          let settleTimer: ReturnType<typeof setTimeout>;
          const goLive = () => {
            // Fold everything synced during the window into seenIds (incl. keys that
            // synced before the observer attached) so none can ping retroactively.
            for (const id of annotationsMap.keys()) seenIds.add(id);
            isLive = true;
          };
          const armGoLive = () => {
            clearTimeout(settleTimer);
            settleTimer = setTimeout(goLive, SETTLE_MS);
          };

          const observer = (event: Y.YMapEvent<unknown>) => {
            // Still settling: defer go-live until the sync burst quiets. (Keys are
            // also folded into seenIds below, so this window can never ping.)
            if (!isLive) armGoLive();
            // Read visibility fresh each fire so a decorations-menu mute toggle is
            // reflected for the next arrival (toggles aren't arrivals → no retro-ping).
            const visible: DecorationVisibility = parseStoredVisibility();
            for (const id of event.keysChanged) {
              const ann = annotationsMap.get(id) as Annotation | undefined;
              const ping = shouldPing(ann, { isLive, alreadySeen: seenIds.has(id), visible });
              seenIds.add(id);
              if (ping && ann) schedulePing(id, ann);
            }
          };
          annotationsMap.observe(observer);
          armGoLive(); // also covers the no-annotations / no-observer-fire case

          return {
            destroy() {
              destroyed = true;
              clearTimeout(settleTimer);
              for (const timer of pingTimers.values()) clearTimeout(timer);
              pingTimers.clear();
              annotationsMap.unobserve(observer);
            },
          };
        },
      }),
    ];
  },
});
