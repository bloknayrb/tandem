# Stage C cleave locks — Phase 3.5 (post-review)

> **Status:** scoping crystallized. Per-stage detailed plans (C-3 first) follow this doc.
> **Branch:** `feat/design-system-impl` umbrella → Stage C sub-PRs.
> **Inputs that produced these locks:**
> - PR #909 (Stages A+B shipped) — 2 review rounds, all findings addressed.
> - 4-agent adversarial review of the original Stage C scoping note (CRDT, Svelte, annotation-model, architecture).
> - advisor() reconcile call — locked the synthesis, added 3 cheap pre-C-3 checks (all executed: see "Pre-C-3 checks" below).
> - Plan §12 review-hardened constraints C1–C14.
>
> The original plan at `~/.claude/plans/the-current-way-we-compiled-thimble.md` §9 specified A / B / C / D as four sub-PRs. The "C" envelope is too big for one PR; this doc locks the C-internal split.

## Reordered stage envelopes

C is split into three independently-shippable sub-PRs. **Order: C-3 → C-1 → C-2.**
The original C-1 → C-2 → C-3 sequence was rejected because:

- C-3 (bezier leaders + anchor dots) is the highest-visibility win and couples to NOTHING downstream — it ships against today's `effectivelyOn` boolean.
- C-1's proposed "throwaway single-track render path" is unnecessary: `MarginColumn.svelte:207` already calls the dispatcher today. C-1 just threads `density` as a prop with default `'full'` matching today's behavior.
- C-2 is the largest review surface and benefits from landing AFTER mode + leader infrastructure are stable.

### C-3 — Bezier leaders + anchor dots + atomic X/Y reads (smallest, first)

**Scope:**

- Replace `MarginColumn.svelte:153-177`'s straight `<line>` leaders with cubic-bezier `<path>` elements.
- Add `<circle>` anchor dots at the text-edge endpoint.
- Extend `useMarginPositions` to return `{byId: ReadonlyMap<id, {top: number, anchorX: number}>}` written from ONE `recompute()` body — replaces the existing vertical-only return shape. Sibling `useMarginAnchorsX` hook is REJECTED (one-frame X/Y desync, violates §10 anchor-jitter rule).
- ~~Anchor dot color is **per-side, not per-bubble** (per advisor): one stroke color per SVG, matches the leader stroke.~~ **REVERSED 2026-05-28 during C-3 plan review.** Bundle source (`MarginFrame.svelte:135-137`) is per-AUTHOR (`claude` / `user` / `fg-subtle`), not per-side. Per `feedback_bundle_vs_production` — stroke color is decoration AND carries authorship information per ADR-026 → bundle-faithful is correct. C-3 V2 plan uses per-element `data-tandem-author` + per-element color. Imports render with `--tandem-fg-subtle` (bundle's "other" branch), not as Claude orange.
- The leader endpoint reads (text-track + margin-track `getBoundingClientRect()`) must execute on the SAME rAF tick as the vertical `layerTop` recompute (Plan §12 C9 — same-frame requirement).

**Touch surface:**

- `src/client/panels/MarginColumn.svelte` — bezier path generation + dot circles + SVG `overflow: visible`.
- `src/client/hooks/useMarginPositions.svelte.ts` — return-shape extension + horizontal reads inside the existing `recompute()`.
- `tests/client/marginPositions.test.ts` — anchor-x atomicity test (X+Y in same map entry).
- Possibly `editor-stage.svelte.ts` — `bind:this` refs for text-track + margin-track if not already available (today the stage element is bound; the inner cells may need their own refs).

**Estimated:** ~150–200 LOC, 2 core files + 1 test.

**Why first:** zero coupling to Mode state. Ships visual delight (bezier curves are the dominant bundle aesthetic upgrade) without touching any of the downstream cleave decisions.

### C-1 — Global Mode continuum + geometry table + density prop wire-up

**Scope:**

- Replace `effectivelyOn: boolean` with `Mode: 'full' | 'narrow' | 'stub' | 'off'` (single global, NOT per-side — fork-lock resolution, see "Resolved forks" below).
- Pure helper `nextMode(prev, viewport, thresholds, hysteresis) → Mode` mirroring `nextNarrowSticky` (`editor-stage.svelte.ts:67-76`). Single `$state<Mode>`, single `$effect`, single helper.
- Effect MUST include explicit last-value guard: `if (next === prev) return;` (Plan §12 C10 — `effect_update_depth_exceeded` prevention under `ResizeObserver` chatter).
- Export `MARGIN_TRACK_GEOMETRY: Record<Mode, {column, inset, gap, reserve}>` (Plan §12 / CRDT review F3). Geometry invariant test: `column + inset + gap === reserve` per mode.
- Grid template reads track widths from `MARGIN_TRACK_GEOMETRY[mode]`. MarginColumn's `width` / `edgeInset` / `gap` props read from the same constant. The constant is the single source of truth — drift impossible.
- Thread `density?: Density = 'full'` as optional prop into `AnnotationCard.svelte` (backwards-compatible: 3 call sites verified at `MarginColumn.svelte:207`, `SidePanel.svelte:456`, `SidePanel.svelte:481`). C-1 itself does NOT change density behavior — `'full'` default matches today. C-2 implements the variants.
- `MIN_EDITOR_WIDTH_PX` → ch-based stub→off floor (Plan §12 C6). The unit conversion happens OUTSIDE `narrowThresholdPx` — the pure helper stays numeric-in/numeric-out (CRDT review F6).
- Restate the no-padding/no-border invariant in C-1 scope; extend the off→on→narrow→stub→off matrix E2E test (CRDT review F5).

**Touch surface:**

- `src/client/layout/editor-stage.svelte.ts` — Mode state + helper + `MARGIN_TRACK_GEOMETRY` + extended `stageLayerStyle`.
- `src/client/panels/AnnotationCard.svelte` — `density?: Density = 'full'` prop (passes through unused in C-1).
- `tests/client/editor-stage.test.ts` — `nextMode` pure-function tests + geometry-invariant test.
- `tests/e2e/margin-view.spec.ts` — extended mode-cycle remount test.

**Estimated:** ~250 LOC, 4 files.

**Why second:** establishes the mode + geometry vocabulary that C-2 builds on. Behaviorally invisible by default (Mode 'full' = today's `effectivelyOn === true`); only the narrow-threshold split into narrow/stub bands is user-visible.

### C-2 — Density variants on dispatcher

**Scope:**

- `density: Density` as a CLASS on the AnnotationCard root (`is-density-clamped` / `is-density-stub`), NOT a dispatch branch. Variants stay mounted (annotation review F2). CSS hides body / actions / etc. in stub/clamped modes.
- Variant Svelte files (`CommentCard`, `NoteCard`, `SuggestionCard`, `HighlightCard`, `ImportedCard`) gain author-appropriate stub-label markup in a header slot. Per Plan §12 C13 stub-pill metadata surface: 6px author dot retained, per-row border-color from `cardTint` for status pip, hover/focus expands to full card before accept/dismiss.
- `cardTint` keeps EXACTLY 6 branches (Plan §12 C13 — no 7th "stub" branch).
- MarginColumn derives `density` per-bubble from `(mode, isActive, isEditing)`:
  - `isEditing` ⇒ `'full'` (forces minimum density — Svelte review F2 + ReplyThreadOverlay must close on density→stub transition per annotation review F5).
  - Otherwise: lookup in static table keyed on `(mode, isActive)`. NEVER reads `adjustedPositions` or `heights` (the density↔collision cycle is structurally rejected — CRDT F4 + Svelte F3).
  - `ImportedCard` is never `'stub'` (annotation review F4 — batch-promote needs the body).
- Stub-pill click uses the SAME `onClick` path that the dispatcher already forwards (Svelte review F6) → sets `activeAnnotationId` → density re-derives.
- Keep `status === "pending"` filter at the dispatcher level (annotation review F3).

**Touch surface:**

- `AnnotationCard.svelte` + 5 variant cards + `MarginColumn.svelte` (density derivation) + `cardTint` definition + CSS.

**Estimated:** ~250 LOC, 7+ files.

**Why last:** largest review surface, fully unblocked once C-1 lands.

## Resolved forks

### Global Mode, not per-side (architecture F1)

Decision 3 — "stub triggered by viewport width alone, not collision pressure" — is GLOBAL by nature. With no per-side asymmetry source, `leftMode === rightMode` always holds. The only proposed per-side asymmetry was "density → collision pressure → mode," which was independently rejected on cycle grounds. Therefore: `Mode` is global; `leftMode` / `rightMode` enum is YAGNI.

Future Stage E (issue #917) is the durable home for re-splitting if a real per-side asymmetry need ever surfaces.

### Single $effect, not two (CRDT F2 + Svelte F1 converge)

Mode transitions: ONE `$state<Mode>`, ONE `$effect`, ONE pure helper. Mirrors today's `nextNarrowSticky` pattern. Two independent per-side `$effect`s would multiply `effect_update_depth_exceeded` surface area and gain nothing (global mode renders per-side redundant anyway).

### Extend `useMarginPositions`, don't sibling-hook (CRDT F1)

> **REVERSED 2026-05-28 during C-3 plan review.** Primary source (`docs/design-system-impl/bundle/extracted/c4-margin-column/MarginFrame.svelte:97`) shows the bundle's leader endpoints derive X from `doc.getBoundingClientRect().right` — the text-container's right edge, a GEOMETRIC column-X, not a glyph-X from `coordsAtPos`. With column-X endpoints, neither hook-extension nor sibling-hook is needed: leader X is a per-side geometric constant (already today's `editorX` at `MarginColumn.svelte:68`). `anchorX` deferred to whichever future stage actually consumes it. See `docs/plans/2026-05-28-stage-c3-bezier-leaders-anchor-dots.md` V2 for the reduced scope.

X and Y reads atomic in ONE map entry, written from ONE `recompute()` body. Sibling `useMarginAnchorsX` causes one-frame chase between bubble Y (existing hook) and leader X (new hook) — exactly the "anchor jitter during transitions" §10 forbids. Vertical-only minimalism loses to atomicity.

### Density decoupled from collision output (CRDT F4 + Svelte F3)

`density = isEditing ? 'full' : table[(mode, isActive)]`. Period. No reads of `adjustedPositions`. No reads of `heights`. The 0.5px tolerance in `mapsEqual` damps but does not break the density → height → collision → density cycle if it's ever closed; the only safe answer is to never close it.

### Density on card root, not at dispatch (Svelte F2 + annotation F2)

Variants stay mounted. `density` is a CSS class on the root + a header-slot stub-label. Dispatch logic unchanged — preserves the 5-file split's per-type label discipline (the variants are still what decide what a "stub label" looks like for each author/type pair).

## Cross-cutting locks (no controversy)

- `isEditing` forces minimum density `'full'`.
- `ImportedCard` never renders as `'stub'`.
- `ReplyThreadOverlay` closes on density→stub transition.
- `status === "pending"` filter remains at dispatcher level.
- `±32px` hysteresis for ALL three bands as starting point; per-boundary tuning deferred to issue #916.
- Reduced-motion guard for Stage D motion is dual-mechanism (`@media (prefers-reduced-motion: no-preference)` AND `body:not(.tandem-reduce-motion)`) per Plan §12 C11.

## Pre-C-3 checks (advisor 2026-05-28 — all executed)

1. **Hysteresis band spacing computed with concrete numbers.** Estimated boundaries: T1 (full→narrow) ≈ 1044px, T2 (narrow→stub) ≈ 864px, T3 (stub→off) ≈ 528px. Gaps T1−T2 ≈ 180, T2−T3 ≈ 336. Both well over the 64px (= 2·hysteresis) overlap floor. 32px-everywhere is safe; per-boundary tuning is taste, not correctness. The T2 number is sensitive to chosen narrow-column width (currently estimated at 160px; lock the actual value in the C-1 detailed plan with `MARGIN_TRACK_GEOMETRY[narrow]`).
2. **Deferred items filed as GitHub issues.** #916 (per-boundary hysteresis tuning), #917 (hypothetical Stage E collision-pressure asymmetry placeholder). Both cite this doc + PR #909.
3. **Per-side anchor dot color.** Locked above in C-3 scope.
4. **AnnotationCard caller backwards-compat.** Verified: 3 production call sites (`MarginColumn.svelte:207`, `SidePanel.svelte:456` and `:481`) — all accept an optional new prop without modification.

## Out of scope (Stage D and beyond)

- Animated track-width transitions live in Stage D, NOT any of C-1/C-2/C-3.
- Conflict #9's Applied-Overrides entry in `conflicts-resolved.md` is Stage D's deliverable (Plan §12 C1).

## Next step

Write `docs/plans/2026-05-28-stage-c3-bezier-leaders-anchor-dots.md` — the detailed Stage C-3 implementation plan — then run an adversarial agent review against THAT plan (per `feedback_multi_round_plan_review` + Plan §12 C-architectural-review-F5), then code.
