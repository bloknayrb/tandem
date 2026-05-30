# Stage C-1 — Margin mode continuum + `MARGIN_TRACK_GEOMETRY` table

> **Status:** review-hardened plan (agent-team coordinated 2026-05-28; supersedes the
> pre-synthesis design draft). Lands on `feat/design-system-impl`, stacked on the
> merged C-3 (#919) + A+B (#909). **Sibling:**
> [Stage C-2 — density variants](2026-05-28-stage-c2-density-variants.md) stacks on
> THIS slice. **Locked decisions:** [stage-c-cleave-locks.md](2026-05-28-stage-c-cleave-locks.md).
> **Umbrella plan:** `~/.claude/plans/the-current-way-we-compiled-thimble.md` §5/§9/C1–C14.
>
> Produced by the `stage-c-coordinate` agent team (contract freeze → parallel
> blueprints → svelte + crdt + annotation-model review → synthesis). The synthesis
> caught a HIGH docx-regression and a stale per-side seam. Every `c1MustFix` is folded
> in and tagged `[MF-n]`. **Amended 2026-05-28 (Bryan):** the strict-global decision now
> carries one sanctioned per-side exception — a side with no pending annotations collapses
> to `off` (presence, not pressure; loop-safe). Tagged `[MF-10]` (comment rewrite) +
> `[MF-11]` (presence source + tests).

## 1. Scope

C-1 is the **foundation** the density variants (C-2) consume. It adds the per-mode
geometry table + the width-driven mode continuum to `EditorStageModel`, and threads
the resolved `mode` into `MarginColumn`. **Behaviorally invisible at the default
`full` mode** — the only user-visible delta is that the single `full ↔ off` cliff
(today's `narrowSticky`) becomes a `full → narrow → stub → off` ladder **for non-docx
documents only**. C-2 later renders narrow/stub differently; C-1 ships the mode + the
narrower track, and the existing C-3 bezier leaders + bubbles auto-fit it with no
render change.

## 2. Reconciled contract — what the agent team changed from the seam

Two corrections, both verified against current code (`editor-stage.svelte.ts`,
`App.svelte`):

- **Global width-mode + per-side empty-collapse `[authority: cleave-locks §"Resolved
  forks" F1 + Bryan 2026-05-28]`.** The seam mandated `marginLeftMode`/`marginRightMode`
  as independently *width-driven* modes; that is rejected. The **shrink continuum**
  (full → narrow → stub → off, driven by viewport width) is a **single global
  `widthMode`** on the merits: both grid tracks are symmetric, so a width-driven mode is
  inherently global, and the only proposed per-side *width* driver — density →
  collision-pressure → mode — was rejected on cycle grounds (the exact density↔collision
  feedback loop C-2 is built to avoid).
  - **The one sanctioned asymmetry: presence, not pressure (Bryan).** A side with **no
    rendered annotations** collapses to `off` regardless of `widthMode`; the other side
    keeps `widthMode`. This is *not* the rejected driver — presence is a stable binary
    input (collapsing an empty side cannot create or destroy annotations), so it adds **no
    feedback loop and no hysteresis need**. It also kills a residual phantom-reserve
    (umbrella defect #1 at side granularity): today a 0-annotation side still reserves a
    full track and pushes content off-center. Asymmetric centering when one side is `off`
    is already the intended grid behavior (umbrella §5), so this aligns rather than
    conflicts.
  - **Model shape `[MF-3]`:** keep **one** stateful `widthMode` (`$state` + the single
    guarded `$effect` — the only loop-prone part stays singular). Derive two **pure**
    per-side modes by clamping: `leftMode = leftHasPending ? widthMode : 'off'`,
    `rightMode = rightHasPending ? widthMode : 'off'` (no effect, no hysteresis). Drop the
    design draft's *independent* `leftMode`/`rightMode` width-state; the per-side getters
    return these clamped values. Per-side *width* re-split (genuinely different sizes per
    side) remains deferred to **Stage E / #917**.
  - **"Empty" = no pending annotations on that side `[MF-11]` — SOURCE FROM THE UNGATED
    UPSTREAM (CRITICAL, 3-reviewer + advisor converged).** The obvious wiring — "reuse the
    existing C3 split arrays `marginNotes`/`marginComments`" — **builds a reactive cycle
    and is forbidden.** Those arrays (`App.svelte:1032-1039`) are themselves gated on
    `editorStage.effectivelyOn`; since the new `effectivelyOn = leftVisible || rightVisible`
    depends on `leftMode → getLeftHasPending()`, sourcing presence off them closes
    `effectivelyOn → marginNotes → getLeftHasPending → leftMode → leftVisible →
    effectivelyOn` → cyclic `$derived` (crash, or latches "all-off" so margin view silently
    renders nothing despite being on). **Correct source:** the **ungated**
    `visibleAnnotations` (`App.svelte:193`, `= yjsSync.annotations`, declared upstream of
    `editorStage` at `:685`), with the type/author split + `status === "pending"` predicate
    applied **directly**. Share the *predicate*, never the gated *array*. Extract the
    side-split predicate into a shared helper so the column and the presence booleans apply
    identical logic (drift-prevention comes from one predicate, not one array).
  - **Presence is `status==="pending"` ONLY — do NOT match the full render gate `[MF-11]`.**
    `MarginColumn`'s actual render filter is `positions.has(a.id) && a.status === "pending"`
    (`MarginColumn.svelte:79-81`), not pending alone. Presence deliberately omits
    `positions.has`: that set comes from `createMarginPositions({getEnabled: () =>
    editorStage.effectivelyOn})` (`App.svelte:1040-1046`) — also `effectivelyOn`-gated, so
    adding it reintroduces the same cycle class. The resulting drift is **one-directional
    and benign**: presence can over-count by at most one frame (a pending-but-unpositioned
    annotation → side reserved-but-empty for ≤1 frame), but never under-counts (no pending
    → nothing renders → no "collapsed-but-rendering"). Accept pending-only; the residual
    is the deliberate price of loop-freedom. Do not claim exact render parity.
  - Left = private notes (`type === "note"`), right = outbound comments+imports
    (`author === "import" || type === "comment"`); `highlight` is inline → **neither side**,
    correctly excluded from both booleans (`App.svelte:1032-1039` C3 split). Count per this
    fixed assignment, never swapped. (Theoretical `author==="import" && type==="note"` would
    double-count, but docx imports are always `type:"comment"`, so it cannot occur today —
    pre-existing C3 property, noted not fixed.)
  - **Recompute trigger is the annotation-set `$effect`, not the layer ResizeObserver
    (document for future-proofing).** A presence flip (incl. pending→accepted, which removes
    the last *pending* item) reassigns `visibleAnnotations` → the `useMarginPositions`
    annotation-set effect re-runs → rAF recompute reads post-reflow `coordsAtPos`. Collapse
    and recompute share one trigger, so there is no stale frame. The layer RO does *not*
    fire on an interior track collapse (the container box is unchanged). State this so a
    later refactor decoupling presence from `visibleAnnotations` doesn't silently introduce
    a stale-anchor frame.
  - **Caveat — this REVERSES the shipped A+B comment.** `editor-stage.svelte.ts:195-199`
    explicitly says the per-side getters are retained because "Stage C re-splits them …
    based on collision pressure." That stated intent is superseded: the width continuum is
    global, and the per-side getters now carry *presence-collapse* (not pressure-split).
    Line 194's `leftVisible === rightVisible === effectivelyOn` invariant **no longer
    holds** under the empty-collapse rule. **[MF-10]:** C-1 must rewrite the 195-199
    comment to record (a) global `widthMode`, (b) per-side presence-collapse to `off`,
    (c) genuine per-side *width* re-split deferred to Stage E / #917 — otherwise the code
    decides "global+presence" next to a comment promising "pressure-split." Deliberate
    override of a prior cleave-lock — surfaced to Bryan, not folded silently.

- **docx carve-out `[MF-1, CRDT-HIGH]`.** The `marginColumn` snippet (`App.svelte:1528`)
  renders at **four** sites — docx `1585/1586` + non-docx `1615/1620` — and sources
  `width/edgeInset/gap` from the `MARGIN_VIEW_*` consts (`1533-1535`). Threading
  continuum geometry blindly rewrites docx margins at narrow/stub widths (violates the
  umbrella plan's "non-docx only" lock §1) and a blanket `effectivelyOn = mode !== 'off'`
  drops docx's auto-hide threshold to the stub→off floor. **Resolution:** continuum is
  **non-docx only**; docx keeps the legacy `narrowSticky` path verbatim; the model
  exposes one **format-clamped** `mode` getter (docx → `full|off`).

## 3. Stage-model changes (`src/client/layout/editor-stage.svelte.ts`)

### 3.1 Keep the legacy path intact `[MF-1, MF-7]`

**Do not touch** `narrowSticky`, `nextNarrowSticky`, `narrowThresholdPx`, or
`MIN_EDITOR_WIDTH_PX = 480`. This preserves `tests/client/editor-stage.test.ts:135-145`
(`narrowThresholdPx(0) === 2*272 + 480 = 1024`) **byte-for-byte**.

> **ch-floor REVERSED from the design draft.** The draft proposed replacing
> `MIN_EDITOR_WIDTH_PX` with a `STUB_OFF_FLOOR_CH` ch-based floor. The reviewers showed
> this (a) breaks the existing test, (b) makes the "narrowThresholdPx tests pass
> unchanged" claim false, and (c) introduces a reactive read that **never converges on
> font-load** (a font load fires no `resize`; only `{viewport,thresholds}` are tracked).
> The `t2–t3` gap (≈264px) dwarfs any ch error, so a fixed-px floor loses nothing.
> **Decision: keep `MIN_EDITOR_WIDTH_PX` as the floor for all three bands.** The
> ch-floor (C6) is explicitly deferred; if ever adopted, thresholds must key on a
> tracked `measureCh` signal, never `getComputedStyle` inside the effect.

### 3.2 The geometry table

```ts
export type MarginMode = "full" | "narrow" | "stub" | "off";

export const MARGIN_TRACK_GEOMETRY: Record<
  MarginMode,
  { column: number; inset: number; gap: number; reserve: number }
> = {
  full:   { column: 240, inset: 8, gap: 24, reserve: 272 }, // = today's MARGIN_VIEW_* scalars
  narrow: { column: 160, inset: 8, gap: 24, reserve: 192 }, // ESTIMATE — lock in review/dogfood
  stub:   { column: 28,  inset: 8, gap: 24, reserve: 60  }, // ESTIMATE — C13 anchor pill + zone
  off:    { column: 0,   inset: 0, gap: 0,  reserve: 0   }, // gutters reabsorb the track
};
```

- **Invariant (unit-tested):** `column + inset + gap === reserve` per non-off mode;
  `off` all-zero.
- **Single source of truth:** the grid template (via `stageLayerStyle`) and
  `MarginColumn`'s `width/edgeInset/gap` both read from this table.
- **Redefine the four `MARGIN_VIEW_*` exports off `MARGIN_TRACK_GEOMETRY.full`** — keep
  all four (App:80-82 import the three scalars for the shared snippet; the unit test
  imports `RESERVE_PER_SIDE_PX`). Values unchanged.
- **`[MF-5]` Freeze the SHAPE, not invented px.** `full`/`off` rows are locked. The
  estimates — `narrow.column` (160), `stub.column` (28), narrow/stub `reserve` — are
  finalized in plan review + the manual visual pass. Add
  `expect(GEOM.full.column).toBe(MARGIN_VIEW_COLUMN_WIDTH_PX)` so a future retune can't
  silently shift the default-mode C-3 leaders.

### 3.3 Thresholds + the pure mode helper

```ts
// Pure. Each boundary is derived from the geometry it gates; railsWidthPx + the
// MIN_EDITOR_WIDTH_PX floor are additive and cancel in inter-band differences, so
// band ordering is rails-independent.
export function marginModeThresholds(railsWidthPx: number): {
  t1: number; // full → narrow  = 2*GEOM.full.reserve   + rails + MIN_EDITOR_WIDTH_PX  (= narrowThresholdPx, delegate)
  t2: number; // narrow → stub  = 2*GEOM.narrow.reserve + rails + MIN_EDITOR_WIDTH_PX
  t3: number; // stub → off     = 2*GEOM.stub.reserve   + rails + MIN_EDITOR_WIDTH_PX
} { /* t1 delegates to narrowThresholdPx(rails) for full-band identity */ }
```

`t1` delegates to the **unchanged** `narrowThresholdPx` (full-band identity → existing
test stays valid). With locked reserves + rails=0: `t1 = 1024`, `t2 = 864`, `t3 = 600`.
Inter-band gaps `t1−t2 = 160`, `t2−t3 = 264` — both `> 2*MARGIN_VIEW_HYSTERESIS_PX (=64)`,
so 32px bands never overlap. **`[svelte-MED]`** Update the cleave-doc's stale `~180/~336`
estimates to these real `160/264` numbers so the ordering test asserts against matching
prose.

```ts
// Pure, numeric-in / MarginMode-out. Named `nextMarginMode` (a `nextMode` already lives
// in word-count-cycle.ts — avoid the grep collision).
//
// [MF-2] MUST CLAMP on multi-band jumps. Compute the target band from width via
// strict-< entry thresholds, apply per-boundary hysteresis ONLY against the boundary
// adjacent to `prev`, and NEVER hold a `prev` more than one band from the current width
// band. A multi-band jump (full → off in one frame) must SNAP, not stick.
export function nextMarginMode(
  prev: MarginMode,
  viewportWidth: number,
  thresholds: { t1: number; t2: number; t3: number },
  hysteresisPx: number,
): MarginMode { /* ... */ }
```

### 3.4 The width-driven mode `$state` + guarded `$effect`

Mirror the shipped `narrowSticky` effect (`:171-181`):

```ts
let widthMode = $state<MarginMode>("full");
$effect(() => {
  const w = opts.getViewportWidth();
  const th = thresholds;                  // tracked: {viewport, thresholds}
  const prev = untrack(() => widthMode);  // NOT a tracked dep
  const next = nextMarginMode(prev, w, th, MARGIN_VIEW_HYSTERESIS_PX);
  if (next === prev) return;              // [MF-2/C10] literal last-value guard
  widthMode = next;                       // one-way; never writes rail/settings
});
```

- **No `marginView` in the effect** — on/off intent stays a `$derived` gate (mirrors
  today's `effectivelyOn = getMarginView() && !narrowSticky`).
- **No per-side rail boolean** — rail enters only via `railsWidthPx` inside the
  threshold (the seam's "rail-closed-on-that-side" key is stale per #892).
- **No ResizeObserver, no `dispose()`** `[CRDT-confirmed]` — viewport arrives via the
  existing `getViewportWidth()` getter; the factory stays a getter-returning object
  invoked once in App's effect root (C14 satisfied; adding teardown would regress A+B).

### 3.5 Format-clamped `mode` getter + derived visibility `[MF-1, MF-3, MF-4, MF-10]`

**`[MF-10]` first, before adding modes:** rewrite the `leftVisible`/`rightVisible`
comment at `editor-stage.svelte.ts:195-199`. It currently promises Stage C "re-splits
them … based on collision pressure" — the rejected driver. Replace with: the shrink
continuum is a **global `widthMode`** (symmetric tracks, no per-side *width* asymmetry);
the per-side getters now carry **presence-collapse** — a side with no pending annotations
clamps to `off` while the other keeps `widthMode`; genuine per-side *width* re-split is
deferred to Stage E / #917. **The `leftVisible === rightVisible === effectivelyOn`
invariant (line 194) NO LONGER HOLDS** — empty-collapse is exactly what breaks it. Delete
that invariant line rather than preserve it; any A+B code or test asserting it must be
updated (grep for it before landing).


```ts
const isDocx = $derived(opts.getFormat() === "docx");

// Global on/off gate × the global width continuum (widthMode is the single
// $state written by the one guarded $effect in §3.4). docx keeps the legacy
// full|off path verbatim — NO continuum, NO presence-collapse (carve-out below).
const baseMode = $derived<MarginMode>(
  isDocx
    ? (opts.getMarginView() && !narrowSticky ? "full" : "off")
    : (opts.getMarginView() ? widthMode : "off"),
);

// Presence-collapse [Bryan 2026-05-28]: a side with no PENDING annotations
// clamps to off. Pure $derived — presence is a stable binary, no effect/loop.
// docx is exempt (legacy both-sides-together): clamp only applies non-docx.
const leftMode  = $derived<MarginMode>(
  !isDocx && !opts.getLeftHasPending()  ? "off" : baseMode,
);
const rightMode = $derived<MarginMode>(
  !isDocx && !opts.getRightHasPending() ? "off" : baseMode,
);

const leftVisible  = $derived(leftMode  !== "off");
const rightVisible = $derived(rightMode !== "off");
const effectivelyOn = $derived(leftVisible || rightVisible); // docx: == legacy gate
const leftGeometry  = $derived(MARGIN_TRACK_GEOMETRY[leftMode]);
const rightGeometry = $derived(MARGIN_TRACK_GEOMETRY[rightMode]);
```

- **Two new opts** `getLeftHasPending`/`getRightHasPending: () => boolean` — derive from
  the **ungated** `visibleAnnotations` (`App.svelte:193`), applying a shared side-split
  predicate + `status === "pending"`. **NOT** from the `effectivelyOn`-gated
  `marginNotes`/`marginComments` (`:1032-1039`) — that closes a `$derived` cycle (see §2
  `[MF-11]` CRITICAL). `positions.has` is deliberately excluded (also gated). `[MF-11]`
- **docx carve-out preserved:** presence-collapse is `!isDocx`-gated, so the docx path
  stays byte-identical to legacy (both sides share `baseMode`, no empty-side divergence).
  Empty-collapse for docx margins is out of scope (umbrella "non-docx only" lock); revisit
  with the docx-margin follow-up if ever wanted. **← assumption open for Bryan's veto.**
- Expose **per-side** `leftMode`/`rightMode` + `leftGeometry`/`rightGeometry` getters (App
  sources each call site's `width/edgeInset/gap` from its own side's geometry; an empty
  side's geometry is the `off` row `{0,0,0}` → 0 track, centering reabsorbs it). The old
  "one `mode`/`geometry`" surface from the pre-empty-collapse draft is replaced by the
  per-side pair. `[MF-3]`
- docx/non-docx App branches are mutually exclusive per active tab (`App.svelte:1581`).
  Within a tab, the left call site gets `leftMode`/`leftGeometry`, the right gets
  `rightMode`/`rightGeometry`; docx's two sides resolve equal (no presence-collapse), so
  the carve-out is invisible there.
- **`stageLayerStyle`** gains `leftReservePx`/`rightReservePx` for the non-docx branch,
  sourced from `leftGeometry`/`rightGeometry` totals (`column+inset+gap`) — an empty side
  is the `off` row → 0 reserve, which is the per-side empty-collapse landing in the grid.
  The **docx branch stays byte-identical** (reads `effectivelyOn` → `position:relative`
  | `display:contents`). Keep `effectivelyOn` in `StageLayerStyleInput` for docx; add
  the reserves alongside `[svelte-LOW]`. Update the unit matrix to the new shape and add
  the asymmetric cases (left-pending-only, right-pending-only); docx cases keep passing
  `effectivelyOn` unchanged.

## 4. App.svelte changes

In the `marginColumn` snippet (`1528-1549`): replace the three module-const props with
per-side geometry, and **add a `mode` prop**. The **left** call sites pass
`{...editorStage.leftGeometry}` + `mode={editorStage.leftMode}`; the **right** call sites
pass `{...editorStage.rightGeometry}` + `mode={editorStage.rightMode}`. Presence-collapse
+ format clamp both live in the getters, so docx still gets `full` geometry and an empty
non-docx side gets `off` (0) geometry automatically — App threads side-correct values
without branching. `createEditorStageModel` now also receives
`getLeftHasPending`/`getRightHasPending`, **wired from the ungated `visibleAnnotations`
(`:193`) through a shared side-split predicate** (extract the `type==="note"` /
`author==="import"||type==="comment"` split into a helper both the C3 render arrays and
these booleans call). **Do NOT wire them from `marginNotes`/`marginComments` (`:1032-1039`)
— those are `effectivelyOn`-gated and close a `$derived` cycle (§2 `[MF-11]`).**
`editor-stage.layerStyle` consumption and the `{#if leftVisible/rightVisible && activeTab}`
guards are otherwise unchanged (the guards now genuinely diverge per side under
empty-collapse — intended behavior, not a regression). **No track-width transition CSS**
(Stage D). Restate the no-padding/no-border INVARIANT 3/4 in the PR description.

## 5. MarginColumn.svelte — additive only `[shared-file: clean stack]`

Add `mode: MarginMode` to `Props` (import `type MarginMode` from
`../layout/editor-stage.svelte`). **Pure pass-through in C-1 — no template/render
change.** `width/edgeInset/gap` arrive mode-resolved from App, so the existing
`editorX`/`columnX`/`leaderStyle` `$derived` (lines 71-75) and the C-3 bezier leaders
auto-fit the narrower track.

> **`[MF-6]` REJECT** collapsing `width/edgeInset/gap` into an internal
> `$derived(MARGIN_TRACK_GEOMETRY[mode])` — it rewrites lines 71-75, the exact geometry
> the shipped C-3 leaders read, enlarging the shared diff into the C-3 surface. Keep the
> numeric props App-sourced; `mode` is purely additive. This is what keeps C-1↔C-2 a
> **clean stack** (C-1 edits only the Props interface; C-2 edits only the bubble
> each-block — no textual overlap, no merge conflict).

## 6. marginCollision.ts — documentation only `[MF-9]`

Add a comment on `resolveCollisions` recording the stub-non-push contract: a stub must
not advance the collision cursor; C-2 honors it by passing `height: undefined` for
stubs, which `resolveCollisions` **already** skips (line 56, confirmed). **No logic
change. NOT a shared file** (C-2 touches nothing there).

## 7. AnnotationCard.svelte — NOT touched in C-1 `[MF-8]`

The `density` prop introduction + behavior is **C-2-owned** (single owner; overrides
cleave-locks L52/L59 which had placed the inert prop in C-1).

## 8. Test plan

- **UNIT** `MARGIN_TRACK_GEOMETRY` invariant (`it.each`): non-off → `column+inset+gap===reserve`;
  off → all-zero; `GEOM.full.column === MARGIN_VIEW_COLUMN_WIDTH_PX`.
- **UNIT** `marginModeThresholds`: `t1>t2>t3` for rails ∈ {0,300,600}; each gap `>64`,
  asserted against locked reserves; `t1 === narrowThresholdPx(rails)`.
- **UNIT** `nextMarginMode` bands (`it.each` + `why`): `w<t3→off` regardless of prev;
  `[t3,t2)→stub`; `[t2,t1)→narrow`; `w≥t1→full`; deadband-wider holds prev;
  deadband-narrower holds prev; **multi-band jump** `prev='full', w<t3 → 'off'` `[MF-2]`.
- **UNIT** presence-collapse (`it.each` + `why`): non-docx, `widthMode='full'` —
  both-pending → `leftMode=rightMode='full'`; left-only → `leftMode='full',
  rightMode='off'`; right-only → mirror; neither → both `'off'`. **docx exempt:** same
  four presence combos all resolve `leftMode===rightMode` (carve-out). `[MF-11]`
- **UNIT** `stageLayerStyle` matrix (new input shape): docx on/off byte-identical;
  non-docx both reserves 0 → both tracks `0px`; **asymmetric** (left-pending-only →
  left `272px`, right `0px`) ; mixed; narrow → 192px; measure threading.
- **UNIT (regression)** `nextNarrowSticky` + `narrowThresholdPx` tests unchanged `[MF-1]`.
- **E2E** continuum sweep: `full → narrow → stub → off` viewport sweep; tracks narrow
  monotonically (272→192→60→0); stage element never re-binds (INVARIANT 1).
- **E2E** empty-collapse asymmetry: annotate one side only → that track holds
  `widthMode` geometry, the empty side's track is `0px`, content recenters; removing the
  last annotation collapses its track live (and adding the first re-expands it). `[MF-11]`
- **E2E (cycle regression — the converged blocker)** margin view on + pending annotations
  on a side **actually renders that column** (not silently empty). This is the assertion
  that fails loudly if presence is ever re-wired off the `effectivelyOn`-gated arrays and
  the `$derived` cycle latches "all-off". `[MF-11]`
- **E2E** off-mode renders nothing + **no rail open**: both columns count 0, both tracks
  `0px`, rail-visibility localStorage byte-identical before/after (reuse `:735` compare).
- **E2E (regression)** **docx stays full|off**: docx tab at an intermediate viewport keeps
  full-width margins — guards the CRDT-HIGH fix.
- Gates: `typecheck` + `test` + `svelte-check` + `test:e2e -- margin-view` + `check:tokens`.

## 9. Build sequence

1. `MarginMode` + `MARGIN_TRACK_GEOMETRY`; redefine `MARGIN_VIEW_*` off `GEOM.full`. Invariant test (red→green).
2. `marginModeThresholds` (keep `narrowThresholdPx`/`MIN_EDITOR_WIDTH_PX` untouched; `t1` delegates). Ordering test.
3. Pure `nextMarginMode` (clamping) + `it.each` incl. multi-band row.
4. `widthMode` `$state` + guarded `$effect`; add `getLeftHasPending`/`getRightHasPending` opts; `baseMode` + presence-clamped `leftMode`/`rightMode` + `leftVisible`/`rightVisible`/`effectivelyOn`/`leftGeometry`/`rightGeometry` getters; extend `stageLayerStyle` (per-side reserves); update matrix + presence-clamp test.
5. App.svelte: wire `getLeftHasPending`/`getRightHasPending` from the **ungated** `visibleAnnotations` (`:193`) via a shared side-split predicate + `status==="pending"` — NOT the gated `marginNotes`/`marginComments` (`:1032-1039`) and NOT `positions.has` (cycle, §2 `[MF-11]`); thread per-side geometry + per-side `mode`; confirm `layerStyle` consumers unchanged. typecheck + svelte-check.
6. MarginColumn: add `mode` prop (pass-through). marginCollision.ts comment.
7. E2E continuum sweep + docx-stays-full regression.
8. Full gate run.

## 10. Risks

| Risk | Sev | Mitigation |
|---|---|---|
| **Presence `$derived` cycle** (wiring off `effectivelyOn`-gated arrays) | **HIGH** | Source from ungated `visibleAnnotations` + shared predicate, exclude `positions.has`; cycle-regression E2E asserts a pending side renders `[MF-11]` |
| `effect_update_depth_exceeded` under ResizeObserver chatter | HIGH | Literal `if(next===widthMode)return;` + `untrack`; mirrors shipped effect `[MF-2]` |
| Hysteresis bands overlap → flicker | MED | Ordering test asserts each gap `>64` against locked reserves (160/264 with shipped estimates) |
| docx margin regression (4 call sites) | — | Format-clamped `mode` getter + docx-stays-full E2E `[MF-1]` |
| Redefining `MARGIN_VIEW_*` breaks a consumer | LOW | Keep all four exports `= GEOM.full.*`; grep-confirmed consumers App:80-82 + unit test |
| C-3 leader regression from threaded geometry | LOW | `GEOM.full` byte-identical to today at default; C-3 bezier spec + continuum sweep guard |

## 11. Open items for plan review / dogfood

- **`narrow.column` / `stub.column` actual px** — visual taste; estimates (160/28) pending
  the manual claude-in-chrome pass. `t2` is sensitive to `narrow.column`; re-assert the
  gap-`>64` test against whatever is locked.
- **Empty-side gutter — now RESOLVED by presence-collapse (Bryan 2026-05-28).** Previously
  noted as "an empty side still reserves a track"; the empty-collapse rule sends a
  no-pending side to `off` (0 track), so there is no longer a blank gutter. This also
  retires a residual slice of umbrella defect #1 at side granularity.
- **Both-empty at full width:** with margin view on but zero annotations anywhere, both
  sides collapse to `0` — the editor renders full-measure with no tracks. Confirm this
  reads as intended (no empty margins) and not as "margin view silently broke"; the
  setting toggle still reflects on/off independent of presence. Quick dogfood check.
