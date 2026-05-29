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
 *   clamped — narrow band, inactive: header + a single-line body teaser; the
 *             snippet, action row, replies, and expand button are hidden.
 *   stub    — stub band: a ~22px anchor pip (author dot only); the whole card
 *             body AND the header's text chrome collapse.
 *
 * One-way dependency: density reads ONLY (mode, isActive, isEditing) — NEVER
 * collision output (heights / adjustedPositions). The height → density → height
 * cycle is therefore structurally impossible (`feedback_svelte_effect_depth_guard`,
 * plan [MF-6]).
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

export type Density = "full" | "clamped" | "stub";

export function cardDensity(args: {
  mode: MarginMode;
  isActive: boolean;
  isEditing: boolean;
}): Density {
  // Stub track (~28px) fits only an anchor pip — for everyone, active or
  // editing. See the stub-geometry note above: there is no room to expand in
  // place, so stub wins over active/editing.
  if (args.mode === "stub") return "stub";
  // Narrow/full bands have room: a focused or editing card expands to full
  // (bundle: `-webkit-line-clamp:1` → `unset` on `.is-active`).
  if (args.isEditing || args.isActive) return "full";
  // Inactive narrow → a single-line teaser; `full` band keeps full density;
  // `off` never reaches here (the column unmounts) but falls through safely.
  return args.mode === "narrow" ? "clamped" : "full";
}
