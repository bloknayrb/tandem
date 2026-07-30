/**
 * Margin-bubble density resolution — pure helper extracted from the card
 * dispatcher so the density rule is unit-testable without mounting Svelte
 * (`feedback_extract_helper_over_mount`). Sibling to `marginCollision.ts` /
 * `marginLeaderGeometry.ts`.
 *
 * Density is a CSS-modifier concern layered over the EXISTING `AnnotationCard`
 * dispatcher and its five variants (plan C2 — NOT a flat `data-kind` bubble).
 *
 *   full    — today's card, every section visible.
 *   compact — VERTICAL pressure (crowded anchors), any band with room: header +
 *             a single-line body teaser + THE ACTION ROW; snippet and replies
 *             hidden. Distinct from `clamped` on purpose: `clamped` is a WIDTH
 *             concession (a 160px column cannot fit accept/dismiss), `compact`
 *             is a HEIGHT concession at full width, where there IS room — so
 *             minimizing never costs an extra click to reach Accept/Reject.
 *   clamped — narrow band, inactive: header + a single-line body teaser; the
 *             snippet, action row, replies, and expand button are hidden.
 *   stub    — stub band: a ~22px anchor pip (author dot only); the whole card
 *             body AND the header's text chrome collapse.
 *
 * One-way dependency: density reads ONLY (mode, isActive, isEditing, crowded,
 * isPinned) — NEVER collision output (heights / adjustedPositions). `crowded`
 * comes from `marginPressure.resolveCrowding`, which is itself derived from RAW
 * anchor tops plus the annotation MODEL and never from a measured height, so the
 * height → density → height cycle remains structurally impossible
 * (`feedback_svelte_effect_depth_guard`, plan [MF-6]). Passing measured heights
 * into the pressure pass is the regression that reopens it — see
 * `marginPressure.ts`'s header.
 *
 * Stub geometry note (divergence from plan §5 "stub click → full in place" and
 * bundle `AnnotationBubble`): the C-1 stub track is ~28px wide (merged in PR
 * #927), which cannot hold a full card. In the C4 bundle a collapsed pill never
 * expands *itself* either — `isCollapsed` and `isActive` are orthogonal axes;
 * clicking a pill swaps it for a full bubble in the *parent's* state, and the
 * bundle's pills live in a 128px-wide `narrow` column that can hold that full
 * bubble. Production's 28px track can't, so here `stub` wins over `isActive` /
 * `isEditing`: a stub stays a pip. Reading/acting on a stubbed annotation happens
 * after the viewport widens (the narrow band shows a full card) or via the side
 * rail. A click-to-side-rail affordance for the pip is a tracked follow-up, NOT
 * part of C-2's density scope. Imports (which would lose their byline in a pip)
 * are unaffected: imports are .docx-only and .docx uses the legacy full|off
 * margin path — it never enters the narrow/stub continuum — so `author` is not
 * an input here (plan [F4] import carve-out dropped as unreachable).
 */
import type { MarginMode } from "../layout/editor-stage.svelte";

export type Density = "full" | "compact" | "clamped" | "stub";

export function cardDensity(args: {
  mode: MarginMode;
  isActive: boolean;
  isEditing: boolean;
  /**
   * Vertical-pressure verdict from `resolveCrowding` — this card's neighbours
   * would push it off its anchor if every card rendered full. Defaults false so
   * every pre-existing call site is behaviourally identical.
   */
  crowded?: boolean;
  /**
   * User pinned this card open via the margin bubble's chevron. Overrides both
   * `clamped` and `compact`, loses to `stub` (no room to expand a pip).
   */
  isPinned?: boolean;
}): Density {
  // Stub track (~28px) fits only an anchor pip — for everyone, active or
  // editing. See the stub-geometry note above: there is no room to expand in
  // place, so stub wins over active/editing.
  if (args.mode === "stub") return "stub";
  // Narrow/full bands have room: a focused, editing, or pinned card expands to
  // full (bundle: `-webkit-line-clamp:1` → `unset` on `.is-active`).
  if (args.isEditing || args.isActive || args.isPinned) return "full";
  // Inactive narrow → a single-line teaser, action row dropped (the 160px
  // column cannot fit it). Width beats height here: a narrow card is already
  // minimal, so there is nothing for `crowded` to add.
  if (args.mode === "narrow") return "clamped";
  // `full` band (and `off`, which never reaches here — the column unmounts —
  // but falls through safely): crowded anchors minimize vertically while
  // keeping the action row.
  return args.crowded ? "compact" : "full";
}
