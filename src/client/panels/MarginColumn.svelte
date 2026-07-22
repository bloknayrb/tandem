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
import { prunePlaceableHeights, resolveCollisions } from "./marginCollision";
import { bezierLeaderPath, leaderColorForAuthor } from "./marginLeaderGeometry";

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
  /** Column width in pixels. */
  width: number;
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
const leaderStyle = $derived(
  `position: absolute; top: 0; bottom: 0; ${side}: ${edgeInset + width}px; width: ${gap}px; pointer-events: none;`,
);

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

// Per-annotation density — the SINGLE source of truth shared by the collision
// input below and the rendered card prop, so the two can't drift (`isEditing:
// false`; the dispatcher re-resolves editing→full internally for narrow/full,
// and at stub mode every card is a pip regardless — cardDensity's stub-geometry
// rule). Built from the same `placeable` the each-block iterates, both inputs
// reactive (mode + activeAnnotationId), no collision output read → no cycle.
const densityById = $derived(
  new Map(
    placeable.map((a) => [
      a.id,
      cardDensity({ mode, isActive: a.id === activeAnnotationId, isEditing: false }),
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
$effect(() => {
  const placeableIds = new Set(placeable.map((a) => a.id));
  untrack(() => {
    const removed = prunePlaceableHeights(heights, placeableIds);
    if (removed > 0) {
      // Reassign to a fresh Map so $state identity tracking matches the
      // contract established by `recordHeight`.
      heights = new Map(heights);
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
  style="position: absolute; top: 0; {side}: {edgeInset}px; width: {width}px; pointer-events: none;"
>
  {#each placeable as ann (ann.id)}
    {@const top = adjustedPositions.get(ann.id) ?? positions.get(ann.id) ?? 0}
    {@const visibleReplies = getVisibleReplies(ann, repliesById.get(ann.id))}
    <!-- Same `densityById` map the collision input reads — single source of
         truth, so the rendered density and the stub→undefined-height routing
         can never diverge. (`?? "full"` only satisfies the non-null type; the
         key is always present since the map is built from `placeable`.) -->
    {@const density = densityById.get(ann.id) ?? "full"}
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
      style="position: absolute; top: {top}px; {side}: 0; width: {width}px; pointer-events: auto;"
      in:cardFlyToMargin={{ id: ann.id, reduceMotion }}
      bind:clientHeight={
        () => heights.get(ann.id) ?? 0,
        (h: number) => recordHeight(ann.id, h)
      }
    >
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
  .margin-bubble:hover :global([data-testid^="edit-btn-"]) {
    opacity: 1;
  }
</style>
