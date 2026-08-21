<script lang="ts">
import { untrack } from "svelte";
import type { Annotation, AnnotationReply } from "../../shared/types";
import { getVisibleReplies } from "../annotations/replies";
import { isTauriRuntime } from "../cowork/cowork-helpers";
import type { MarginMode } from "../layout/editor-stage.svelte";
import AnnotationCard from "./AnnotationCard.svelte";
import {
  canAccept,
  canDismiss,
  canEdit,
  canRemove,
  canReply,
  canSendToClaude,
} from "./annotation-context-menu";
import {
  openAnnotationContextMenu,
  runAnnotationAction,
  subscribeAnnotationActions,
} from "./annotation-context-menu-host";
import { cardDensity } from "./cardDensity";
import { cardFlyToMargin } from "./cardMotion";
import { pruneMissing, resolveCollisions } from "./marginCollision";
import { bezierLeaderPath, leaderColorForAuthor } from "./marginLeaderGeometry";
import { type CardModel, resolveCrowding } from "./marginPressure";

interface Props {
  /** Annotations destined for this side. Caller filters by type/author. */
  annotations: readonly Annotation[];
  /** Computed top offset in pixels (relative to the positioning layer), keyed by annotation id. */
  positions: ReadonlyMap<string, number>;
  side: "left" | "right";
  /** Resolved track mode for this side (`full` | `narrow` | `stub`). The width
   *  continuum. A column only mounts when its side is visible, so `off` never
   *  reaches here. C-2 derives bubble density from it (`cardDensity`):
   *  `narrow`→clamp-until-active, `stub`→anchor pip. */
  mode: MarginMode;
  /** Column width in pixels. Used for the `layer` sizing path (docx) and as the
   *  body-wrap basis for the vertical-pressure height estimate. In `track`
   *  sizing the rendered width comes from CSS (the grid track is elastic), so
   *  this is the track's MINIMUM there, not necessarily its resolved width. */
  width: number;
  /**
   * Which box the column's inline geometry is measured against.
   *
   * `track` (non-docx) — the column lives in a `.margin-track` grid cell whose
   * width is `column + inset + gap`, so percentage geometry resolves against
   * the track and the elastic `clamp()` in `stageLayerStyle` reaches the
   * bubbles for free.
   *
   * `layer` (docx) — the column is a DIRECT child of the stage layer, with no
   * `.margin-track` wrapper (App.svelte's docx branch). Its containing block is
   * the whole stage, so `100%` would balloon the column to the full page width
   * and throw the leader SVG to the opposite side. docx keeps today's exact
   * pixel arithmetic.
   */
  sizing?: "track" | "layer";
  /** Distance from the column edge to the nearest scroll-container edge. */
  edgeInset: number;
  /** Horizontal gap between the editor's text edge and the near edge of this
   *  column. Also defines the horizontal zone occupied by leader lines that
   *  visually connect anchor text in the editor to the corresponding bubble. */
  gap: number;
  activeAnnotationId: string | null;
  /** Raw replies grouped by annotation id. The component applies the
   *  `getVisibleReplies()` ADR-027 filter at the lookup site so notes /
   *  highlights never expose replies in the bubble. */
  repliesById: ReadonlyMap<string, AnnotationReply[]>;
  onClick: (annotation: Annotation) => void;
  onAccept?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onRemove?: (id: string) => void;
  onEdit?: (id: string, content: string) => void;
  onReply?: (id: string, text: string) => Promise<boolean>;
  onSendToClaude?: (id: string) => void;
  /** App `reduceMotion` setting, threaded to the A27 fly-to-margin transition. */
  reduceMotion?: boolean;
}

let {
  annotations,
  positions,
  side,
  // C-2: drives per-bubble density (`cardDensity`) for both the collision input
  // and the rendered card. `off` never reaches here (the column unmounts when a
  // side collapses), so only `full` | `narrow` | `stub` are live.
  mode,
  width,
  sizing = "track",
  edgeInset,
  gap,
  activeAnnotationId,
  repliesById,
  onClick,
  onAccept,
  onDismiss,
  onRemove,
  onEdit,
  onReply,
  onSendToClaude,
  reduceMotion = false,
}: Props = $props();

// Vertical inset from the bubble's top edge to its padded content row.
// Mirrors `--tandem-space-3` (AnnotationCard's `padding` token) at the default
// `cozy` density. Compact (10px) and spacious (16px) density modes shift the
// title row by ±2-4px from this constant; matching exactly would require
// reading `getComputedStyle(...).getPropertyValue("--tandem-space-3")` per
// render — accepted as a known minor misalignment for now.
const LEADER_BUBBLE_INSET_PX = 12;

// Component-level $derived values for the leader SVG. `side`, `edgeInset`,
// `gap`, `width` come from $props() and are themselves reactive, so these
// recompute precisely when a prop changes. Hoisting `editorX`/`columnX` out
// of the {#each} block avoids recomputing the same ternary per iteration.
// Per-element stroke/fill colors are resolved at render time from
// `leaderColorForAuthor` — the SVG root no longer carries an inherited color
// (side ≠ author after Stage C-3: imports render distinct from Claude even
// though both sit on the right side).
const editorX = $derived(side === "right" ? 0 : gap);
const columnX = $derived(side === "right" ? gap : 0);
// Leader-SVG placement. In `track` sizing the track is `column + inset + gap`
// wide, so the SVG's near edge sits at `100% - gap` from this side — identical
// to `inset + column` but independent of the elastic column width, which only
// CSS knows. `layer` sizing (docx) keeps the original pixel arithmetic because
// its containing block is the whole stage, not the track.
const leaderInset = $derived(
  sizing === "track" ? `calc(100% - ${gap}px)` : `${edgeInset + width}px`,
);
const leaderStyle = $derived(
  `position: absolute; top: 0; bottom: 0; ${side}: ${leaderInset}; width: ${gap}px; pointer-events: none;`,
);
// Column occupies the track minus the outer inset and the inner leader gap.
const columnWidth = $derived(
  sizing === "track" ? `calc(100% - ${edgeInset + gap}px)` : `${width}px`,
);

// MEASURED column width, fed to the vertical-pressure height estimate. The
// `width` prop is only the track's MINIMUM (the grid track is elastic to 400px),
// so budgeting the body-wrap estimate against it would compute ~40% too many
// lines whenever the track has grown — over-firing the crowding verdict and
// cancelling out the very relief the elastic width provides.
//
// Measuring a WIDTH does not reopen the density cycle: the column's width comes
// from the grid track, which depends on stage width / reading measure / mode and
// never on card heights (bubbles are absolutely positioned, so they cannot size
// their own track). The forbidden input is a density-DEPENDENT measurement.
// Falls back to the prop (the track's base/minimum width) before the first
// measurement lands. On a viewport with genuine elastic surplus this makes the
// pre-measurement estimate narrower than the eventual real width, so the very
// first crowding verdict can over-minimize before snapping to the correct,
// less-crowded verdict once `bind:clientWidth` reports in — a brief flash on
// mount, not a steady-state bug. Deliberately not "fixed" by seeding from the
// track's elastic maximum instead: that trades this flash for the reverse one
// (rendering full-size, then visibly shrinking once measured), which is not
// obviously the better direction and wasn't verified against a real browser.
let measuredColumnWidth = $state(0);
const estimateWidth = $derived(measuredColumnWidth > 0 ? measuredColumnWidth : width);

// Only render annotations whose position is known this frame; without a top
// offset there is nowhere to place the bubble.
const placeable = $derived(
  annotations.filter((a) => positions.has(a.id) && a.status === "pending"),
);

// Measured bubble heights, keyed by annotation id. Reassigned to a fresh Map
// on each update so Svelte 5 $state notices the change (Map mutation is
// invisible to identity tracking). Heights feed `adjustedPositions` (a
// SEPARATE $derived layer from `positions`) so the collision sweep never
// writes back into the `useMarginPositions` $state — that would re-enter
// the layout effect and trip the effect-depth guard
// (`feedback_svelte_effect_depth_guard`).
let heights = $state<Map<string, number>>(new Map());

// User-pinned bubbles — an explicit "stay expanded" override that survives the
// review target moving elsewhere. Reassigned to a fresh Set on every toggle:
// `$state(new Set())` is NOT deep-proxied in Svelte 5 (only plain objects and
// arrays are, and nothing here imports from `svelte/reactivity`), so `.add()` /
// `.delete()` are invisible to reactivity — same contract as `recordHeight`.
let pinnedIds = $state<Set<string>>(new Set());

function togglePin(id: string): void {
  const next = new Set(pinnedIds);
  if (!next.delete(id)) next.add(id);
  pinnedIds = next;
}

// Vertical-pressure verdict (#917). Reads RAW `positions` plus the annotation
// MODEL — never `heights` or `adjustedPositions`. That is what keeps the
// one-way flow intact:
//
//   positions → crowdedIds → densityById → render → heights → adjustedPositions
//
// Nothing downstream may flow back. Passing a measured height in here is the
// regression that reopens the cycle PR #909 rejected; see marginPressure.ts.
//
// `prevCrowded` is read through `untrack` so the hysteresis band's own output is
// not a tracked dependency — otherwise every verdict would re-trigger itself.
let prevCrowded = $state<ReadonlySet<string>>(new Set());
const crowdedIds = $derived.by(() => {
  const input = placeable.map((a) => ({
    id: a.id,
    top: positions.get(a.id) ?? 0,
    model: toCardModel(a),
  }));
  return resolveCrowding(
    input,
    untrack(() => prevCrowded),
    { columnWidthPx: estimateWidth },
  );
});
// Feed the verdict forward for the next evaluation's band. Guarded on a real
// membership change so a settled verdict cannot re-enter the effect
// (`feedback_svelte_effect_depth_guard`).
$effect(() => {
  const next = crowdedIds;
  untrack(() => {
    if (setsEqual(prevCrowded, next)) return;
    prevCrowded = next;
  });
});

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** Model-only projection for the height estimate — never a measurement. */
function toCardModel(a: Annotation): CardModel {
  return {
    contentLength: a.content?.length ?? 0,
    hasSnippet: Boolean(a.textSnapshot),
    hasSuggestion: a.suggestedText !== undefined,
    replyCount: getVisibleReplies(a, repliesById.get(a.id)).length,
    hasActions: canAccept(a) || canDismiss(a) || canRemove(a),
  };
}

// Per-annotation density — the SINGLE source of truth shared by the collision
// input below and the rendered card prop, so the two can't drift (`isEditing:
// false`; the dispatcher re-resolves editing→full internally for narrow/full,
// and at stub mode every card is a pip regardless — cardDensity's stub-geometry
// rule). Built from the same `placeable` the each-block iterates, all inputs
// reactive (mode + activeAnnotationId + crowdedIds + pinnedIds), no collision
// output read → no cycle.
const densityById = $derived(
  new Map(
    placeable.map((a) => [
      a.id,
      cardDensity({
        mode,
        isActive: a.id === activeAnnotationId,
        isEditing: false,
        crowded: crowdedIds.has(a.id),
        isPinned: pinnedIds.has(a.id),
      }),
    ]),
  ),
);

// Collision-resolved tops. Sweep input is built from `placeable` + `positions`
// + `heights`; the result is a brand-new Map. Reads from `positions` happen
// synchronously inside this $derived, so dependency tracking is automatic and
// we don't need `untrack` here.
const adjustedPositions = $derived.by(() => {
  const input = placeable.map((a) => ({
    id: a.id,
    top: positions.get(a.id) ?? 0,
    // A stub passes `height: undefined` so it lands in resolveCollisions'
    // unknown-height branch: it does not advance the cursor (the STUB-NON-PUSH
    // contract in marginCollision.ts), though a preceding full bubble can still
    // push it down.
    height: densityById.get(a.id) === "stub" ? undefined : heights.get(a.id),
  }));
  return resolveCollisions(input);
});

// Prune entries from `heights` whose annotation is no longer in `placeable`.
// Without this, every accepted/dismissed/removed annotation leaves a stale
// height entry behind — the Map grows unboundedly across a long session.
//
// The effect's TRACKED dependency is `placeable` only. We read `heights.keys()`
// and mutate `heights` inside `untrack(...)` so the prune step never re-enters
// itself when we reassign `heights = new Map(heights)` (which would otherwise
// risk an effect-depth loop documented in `feedback_svelte_effect_depth_guard`).
// Pruning safety: we only delete ids NOT in `placeable`, so a concurrent
// `recordHeight` write for a still-placeable id cannot be stranded.
// Pins prune against `annotations`, NOT `placeable`. `placeable` gates on
// `positions.has`, and `positions` empties WHOLESALE whenever `getEnabled()` is
// false or editor/layer/ydoc is null (every Y.Doc swap, generation-gate provider
// rebuild, source-view toggle) and drops individual ids on a transient
// `coordsAtPos` throw or a non-finite top (which heading-section collapse
// produces). A pruned height is harmless — the bubble remounts and
// `bind:clientHeight` re-measures it — but a pruned pin is destroyed user intent
// with nothing to re-read from. The column does NOT unmount in those cases
// either, because presence-collapse reads the ungated `has-pending` inputs, so
// `pinnedIds` survives and would then be wiped here.
//
// `annotations` is per-side and per-active-tab, so stale ids still drop on tab
// switch — which matters, since MarginColumn is not wrapped in
// `{#key activeTab.id}` and survives tab switches with `pinnedIds` intact.
$effect(() => {
  const placeableIds = new Set(placeable.map((a) => a.id));
  const knownIds = new Set(annotations.map((a) => a.id));
  untrack(() => {
    const removed = pruneMissing(heights, placeableIds);
    if (removed > 0) {
      // Reassign to a fresh Map so $state identity tracking matches the
      // contract established by `recordHeight`.
      heights = new Map(heights);
    }
    // Keep the `> 0` guard: an unconditional reassign would rebuild
    // `densityById` and re-run every bubble's block effect on every
    // `placeable` change for nothing.
    if (pruneMissing(pinnedIds, knownIds) > 0) {
      pinnedIds = new Set(pinnedIds);
    }
  });
});

/**
 * Record a measured height for `id`. Skips writes that would only move the
 * value by < 0.5px (subpixel jitter from layout reflow), mirroring the
 * tolerance check in `useMarginPositions` so the same kind of re-render
 * storm cannot start here either. Re-assigns to a fresh Map to trigger
 * $state reactivity.
 */
function recordHeight(id: string, h: number): void {
  if (!Number.isFinite(h) || h <= 0) return;
  const prev = heights.get(id);
  if (prev !== undefined && Math.abs(prev - h) < 0.5) return;
  const next = new Map(heights);
  next.set(id, h);
  heights = next;
}

// ---- Native annotation context menu (#999 / #923 Phase 3) ----------------
// Same shared host as SidePanel. The listener is bound to the bubble COLUMN
// container (not a shared ancestor of the pointer-events:none leader SVG, whose
// paths also carry data-annotation-id) so a right-click only ever resolves a
// card root. The id stays webview-side; the gesture's `run` re-reads the live
// annotation and re-validates before calling THIS column's handler props.
let columnEl: HTMLDivElement | undefined = $state();
let cardOpenRequest = $state<{ id: string; kind: "edit" | "reply"; nonce: number } | null>(null);
let nonceSeq = 0;

function liveAnnotation(id: string): Annotation | undefined {
  return annotations.find((a) => a.id === id);
}

// Route an emitted action through the shared re-validating dispatcher, bound to THIS
// column's handler props (so a margin right-click acts on margin handlers even though the
// listener is shared with the rail). reply/edit open the in-card composer/editor.
function dispatchAnnotationAction(
  id: string,
): (action: Parameters<typeof runAnnotationAction>[0]) => void {
  return (action) => {
    const ann = liveAnnotation(id);
    if (!ann) return; // deleted while the menu was open → no-op
    runAnnotationAction(action, ann, {
      accept: onAccept,
      dismiss: onDismiss,
      sendToClaude: onSendToClaude,
      remove: onRemove,
      openEdit: (i) => (cardOpenRequest = { id: i, kind: "edit", nonce: ++nonceSeq }),
      openReply: (i) => (cardOpenRequest = { id: i, kind: "reply", nonce: ++nonceSeq }),
    });
  };
}

async function handleAnnotationContextMenu(e: MouseEvent) {
  if (!isTauriRuntime()) return; // browser → native menu
  const el = (e.target as Element | null)?.closest("[data-annotation-id]");
  const id = el?.getAttribute("data-annotation-id");
  if (!id) return;
  const ann = liveAnnotation(id);
  if (!ann) return;

  e.preventDefault();
  e.stopPropagation();
  await openAnnotationContextMenu(ann, dispatchAnnotationAction(id));
}

$effect(() => {
  const el = columnEl;
  if (!el) return;
  el.addEventListener("contextmenu", handleAnnotationContextMenu);
  return () => el.removeEventListener("contextmenu", handleAnnotationContextMenu);
});

$effect(() => subscribeAnnotationActions());
</script>

<!-- Leader SVG sits in the gap zone between the editor's text edge and the
     column's near edge. Top/bottom stretch covers the full layer height so
     absolute Y coords (relative to the margin layer) line up with
     `useMarginPositions` output. SVG default user units = pixels (no viewBox),
     so we render at computed Y offsets directly. Decorative only:
     pointer-events: none, aria-hidden.

     Stroke + dot fill are PER-AUTHOR (ADR-026), not per-side: matches the C4
     bundle (MarginFrame.svelte:135-137 — claude / user / fg-subtle). Active
     review target ramps opacity + width so the focused annotation's connector
     reads as the dominant line on the page.

     `adjTop ?? rawTop` fallback handles a one-frame race where `placeable`
     updates (annotation added) before `adjustedPositions` `$derived.by`
     re-runs — without it, the leader+dot disappears for one tick. Consistent
     with the bubble's own fallback chain in the next block. -->
<svg data-testid="margin-leaders-{side}" aria-hidden="true" style={leaderStyle}>
  {#each placeable as ann (ann.id)}
    {@const rawTop = positions.get(ann.id)}
    {@const adjTopRaw = adjustedPositions.get(ann.id)}
    {#if rawTop !== undefined}
      {@const isActive = ann.id === activeAnnotationId}
      {@const adjTop = adjTopRaw ?? rawTop}
      {@const endY = adjTop + LEADER_BUBBLE_INSET_PX}
      {@const color = leaderColorForAuthor(ann.author, ann.agentIdentity)}
      {@const d = bezierLeaderPath({
        startX: editorX,
        startY: rawTop,
        endX: columnX,
        endY,
      })}
      <path
        data-annotation-id={ann.id}
        data-tandem-author={ann.author}
        {d}
        stroke={color}
        stroke-width={isActive ? 1.8 : 1.1}
        stroke-opacity={isActive ? 0.82 : 0.38}
        stroke-linecap="round"
        fill="none"
      />
      <circle
        data-testid="margin-anchor-dot"
        data-annotation-id={ann.id}
        data-tandem-author={ann.author}
        cx={editorX}
        cy={rawTop}
        r={isActive ? 3 : 2}
        fill={color}
        fill-opacity={isActive ? 0.72 : 0.42}
      />
    {/if}
  {/each}
</svg>

<div
  bind:this={columnEl}
  data-testid="margin-column-{side}"
  aria-label={side === "left" ? "Note bubbles" : "Comment bubbles"}
  style="position: absolute; top: 0; {side}: {edgeInset}px; width: {columnWidth}; pointer-events: none;"
  bind:clientWidth={measuredColumnWidth}
>
  {#each placeable as ann (ann.id)}
    {@const top = adjustedPositions.get(ann.id) ?? positions.get(ann.id) ?? 0}
    {@const visibleReplies = getVisibleReplies(ann, repliesById.get(ann.id))}
    <!-- Same `densityById` map the collision input reads — single source of
         truth, so the rendered density and the stub→undefined-height routing
         can never diverge. (`?? "full"` only satisfies the non-null type; the
         key is always present since the map is built from `placeable`.) -->
    {@const density = densityById.get(ann.id) ?? "full"}
    {@const isPinned = pinnedIds.has(ann.id)}
    <!-- Svelte 5 function-binding form on `bind:clientHeight` below
         (`bind:prop={getter, setter}`) — the only form that supports
         per-key dispatch into a Map. A plain `bind:clientHeight={x}`
         requires a scalar L-value; we have a Map<id, height>, so the
         setter routes each measurement through `recordHeight(ann.id, ...)`.
         We use Svelte's built-in `bind:clientHeight` instead of an ad-hoc
         ResizeObserver to avoid wiring one observer per bubble; Svelte
         already shares a single ResizeObserver internally.
         Docs: https://svelte.dev/docs/svelte/bind#Function-bindings
         and https://svelte.dev/docs/svelte/bind#dimensions -->
    <!-- A27 (#798): the just-submitted card flies from the closing selection
         popover's footprint into this slot. `in:cardFlyToMargin` is LOCAL (no
         `|global`) and gated by flySource Map-presence — every other mount
         (initial load, tab switch, scroll/filter re-render) has no source and
         no-ops, so only the just-submitted card animates. Coexists with the
         `bind:clientHeight` below: the fly is transform-only, which never
         perturbs the measured layout height the collision sweep reads. -->
    <div
      data-testid="margin-bubble-{ann.id}"
      data-margin-bubble-reply-count={visibleReplies.length}
      class="margin-bubble"
      style="position: absolute; top: {top}px; {side}: 0; width: 100%; pointer-events: auto;"
      in:cardFlyToMargin={{ id: ann.id, reduceMotion }}
      bind:clientHeight={
        () => heights.get(ann.id) ?? 0,
        (h: number) => recordHeight(ann.id, h)
      }
    >
      <!-- Pin toggle. Lives on the WRAPPER, not in the card header, on purpose:
           AnnotationCard never renders the header (the five variants do), so a
           header-mounted control would need props threaded through four
           presentational components documented as never owning state, would
           render in the always-mounted side rail too, and would be clipped by
           `.is-density-stub`'s `overflow: clip`. Here it costs zero card changes.

           `stopPropagation` is mandatory: the card root carries `onclick`, which
           sets `activeAnnotationId` and scrolls the document. Without it,
           clicking to UN-pin would also focus the card, `isActive` would force
           `full`, and the card would stay visibly open while `aria-expanded`
           flipped to false — the button would read as broken.

           Deliberately NOT gated on `!isReviewTarget` (unlike the header's edit
           button): that would hide the chevron on the focused card, which is
           exactly the card the user is looking at when they decide to pin it. -->
      <!-- Only where the toggle does something: a minimized card (expand it) or
           an already-pinned one (so it can be un-pinned). An uncrowded `full`
           card has nothing to reveal, and a `stub` pip has no room. -->
      {#if density !== "stub" && (density !== "full" || isPinned)}
        <button
          type="button"
          class="margin-pin-btn"
          class:is-pinned={isPinned}
          data-testid="margin-pin-btn-{ann.id}"
          aria-expanded={isPinned}
          aria-label={isPinned ? "Collapse annotation" : "Expand annotation"}
          title={isPinned ? "Collapse annotation" : "Keep annotation expanded"}
          onclick={(e) => {
            e.stopPropagation();
            togglePin(ann.id);
          }}
        >
          <!-- Same geometry as every other chevron in the app (DecorationsMenu,
               FindReplaceBar, ActivityTray, Toolbar): a 24-unit viewBox with
               stroke-width 2. A 12-unit box at width 1.6 renders ~60% heavier at
               the same 10px size, which reads as a different icon set. -->
          <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
            <path
              d="M6 9l6 6 6-6"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      {/if}
      <AnnotationCard
        annotation={ann}
        replies={visibleReplies}
        isReviewTarget={ann.id === activeAnnotationId}
        {density}
        {reduceMotion}
        onClick={() => onClick(ann)}
        onAccept={canAccept(ann) ? onAccept : undefined}
        onDismiss={canDismiss(ann) ? onDismiss : undefined}
        onRemove={canRemove(ann) ? onRemove : undefined}
        onSendToClaude={canSendToClaude(ann) ? onSendToClaude : undefined}
        onEdit={canEdit(ann) ? onEdit : undefined}
        onReply={canReply(ann) ? onReply : undefined}
        openRequest={cardOpenRequest?.id === ann.id ? cardOpenRequest : null}
      />
    </div>
  {/each}
</div>

<style>
  /* Wave F #4: hover affordance for margin bubbles. The inner AnnotationCard
     already shows ✎ Edit for pending cards, but the affordance was too
     subtle in margin view. A faint outline halo on hover signals "this is
     interactive" without competing with the card's own border. */
  .margin-bubble:hover :global([data-testid^="annotation-card-"]) {
    box-shadow: 0 0 8px 2px var(--tandem-accent-border) !important;
  }
  /* Make the inner edit-button reveal on hover of the bubble, even when
     the cursor is not directly on the button. `:global()` so the
     selector pierces the AnnotationCard child component boundary. */
  .margin-bubble :global([data-testid^="edit-btn-"]) {
    opacity: 0.55;
    transition: opacity 140ms ease;
  }
  /* The reveal ramp is hover feedback — under reduced motion the button just
     appears. Both halves repeat the target selector verbatim, `:global()` and
     all: the guard has to keep the same specificity to win on source order,
     and the inner selector must stay global to keep piercing AnnotationCard. */
  :global(body.tandem-reduce-motion) .margin-bubble :global([data-testid^="edit-btn-"]) {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .margin-bubble :global([data-testid^="edit-btn-"]) {
      transition: none;
    }
  }
  .margin-bubble:hover :global([data-testid^="edit-btn-"]) {
    opacity: 1;
  }

  /* Pin chevron. Same reveal-on-bubble-hover ramp as the edit button, so it
     doesn't compete with the card's own chrome at rest. A pinned card keeps it
     visible — that's the only affordance for un-pinning. Positioned over the
     card's top corner, outside the header's flow. It is absolutely positioned,
     so it contributes nothing to the wrapper's `clientHeight` — the measurement
     the collision sweep reads stays exactly the card's own height. (The wrapper
     is already `position: absolute` via its inline style, so it is the
     containing block; no extra rule needed here.) */
  .margin-pin-btn {
    position: absolute;
    /* BOTTOM-right, not top-right: the header's right group already renders the
       author dot + label + relative timestamp out to the card's right edge, so a
       top-right control lands on top of "just now". The action row is
       left-aligned (and Reply likewise), leaving the bottom-right corner free at
       every density. */
    bottom: 3px;
    inset-inline-end: 4px;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    border-radius: var(--tandem-r-2);
    background: transparent;
    color: var(--tandem-fg-faint);
    cursor: pointer;
    /* Visible at rest. On a minimized card this chevron is the primary "there is
       more here" affordance, so hiding it until hover would make the expand
       gesture undiscoverable.

       NO `opacity` here. This used to be `--tandem-fg-subtle` at `opacity: 0.55`,
       which composites to 2.54:1 against --tandem-surface — under SC 1.4.11's
       3:1 for a control's identifying graphic. A token's AA guarantee is a
       property of the COLOUR, and alpha silently spends it; a composite is also
       invisible to tests/e2e/token-contrast.spec.ts by construction, so nothing
       can catch the regression. The de-emphasis is expressed as three colour
       rungs instead — faint at rest (6.01 light / 5.05 dark / 5.58 warm over
       --tandem-surface, and 4.43 over the darkest card tint), subtle on
       bubble-hover, full fg on direct hover / pinned. Same argument as
       App.svelte's `.app-*` note. */
    /* `transform` + `transition`, never an `animation`: scoped @keyframes
       referenced from a component style is fine, but the rotation here has no
       need for one. Rotation uses the shared easing token, matching the app's
       other rotating chevrons (`.cs-chevron` in CollapsibleSection, ActivityTray). */
    transition:
      color 140ms ease,
      transform 180ms var(--tandem-ease-out);
  }
  /* Dual-mechanism reduced motion, same as the other chevrons. */
  :global(body.tandem-reduce-motion) .margin-pin-btn {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .margin-pin-btn {
      transition: none;
    }
  }
  /* Mid rung. The `:not()`s are load-bearing: `.margin-bubble:hover
     .margin-pin-btn` is specificity (0,3,0) and would otherwise shadow the
     (0,2,0) direct-hover/pinned rule below — and hovering the button always
     hovers the bubble, so the firm `--tandem-fg` state would be unreachable in
     exactly the two states it exists for. Harmless while this was an `opacity`
     ramp (0.9 vs 1 is imperceptible); not harmless for a whole colour rung. */
  .margin-bubble:hover .margin-pin-btn:not(:hover):not(.is-pinned),
  .margin-pin-btn:focus-visible:not(:hover):not(.is-pinned) {
    color: var(--tandem-fg-subtle);
  }
  .margin-pin-btn:hover,
  .margin-pin-btn.is-pinned {
    color: var(--tandem-fg);
  }
  /* Chevron points down when collapsed (click to expand), up when pinned open. */
  .margin-pin-btn.is-pinned {
    transform: rotate(180deg);
  }
</style>
