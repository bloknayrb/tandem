# Stage C-2 — Density variants (clamp-until-active + stub pill)

> **Status:** review-hardened plan (agent-team coordinated 2026-05-28). **Stacks on
> [Stage C-1](2026-05-28-stage-c1-margin-mode-continuum.md)** — do NOT start until C-1
> merges (sequencing gate §0). Lands on `feat/design-system-impl`. **Locked decisions:**
> [stage-c-cleave-locks.md](2026-05-28-stage-c-cleave-locks.md). **Umbrella plan:** §5,
> C2/C13.
>
> Produced by the `stage-c-coordinate` agent team (svelte + annotation-model review →
> synthesis). Every `c2MustFix` is folded in and tagged `[MF-n]`.

## 0a. Implementation resolution (2026-05-28, after bundle-source + advisor review)

Reading the source-of-truth C4 bundle (`AnnotationBubble.svelte` / `MarginFrame.svelte`
in `tandem-design-impl`) + an advisor pass during implementation **superseded three
points of the reviewed design below.** Recorded here (not silently rewritten) so the
reviewed plan stays an honest artifact:

1. **`stub` now wins over `isActive` AND `isEditing`** (was: "active/editing always →
   full"). C-1 merged `stub` as a **~28px-wide** track (PR #927). A 28px track cannot
   hold a full card OR an edit form. In the bundle a collapsed pill never expands
   *itself* either — `isCollapsed` and `isActive` are orthogonal axes; clicking a pill
   swaps it for a full bubble in the *parent's* state, and the bundle's pills live in a
   **128px-wide** `narrow` column that holds that full bubble. Production's 28px track
   can't, so a stub stays a pip regardless of active/editing. **This fixes the clipping
   bug** (a full card spilling the 28px track) that motivated C-2. `cardDensity` order
   is now: `if (mode==='stub') return 'stub'` first; `AnnotationCard.resolvedDensity` is
   `density==='stub' ? 'stub' : isEditing ? 'full' : density`.
2. **`[F4]` import carve-out DROPPED as unreachable.** Imports are `.docx`-only and
   `.docx` uses the legacy `full|off` margin path — it never enters the narrow/stub
   continuum — so `author` is not an input to `cardDensity` at all (signature is now
   `{mode, isActive, isEditing}`).
3. **`[MF-2]` force-active-on-edit is unnecessary**, and **`[MF-1]`/§3 "KEEP the header
   visible in stub" was wrong** (advisor: the header's badge + name still overflow 28px).
   The stub recipe additionally hides `.ach-type` and collapses `.ach-author` text
   (`font-size:0`), leaving only the 6px `.ach-dot` as the pip. Acceptance gate is now a
   `scrollWidth ≤ clientWidth` E2E assertion (the card fits its column), not "header
   visible / body hidden". The editing-stub collision mismatch dissolves because a stub
   passes `height:undefined` regardless of editing.

4. **Active-full-at-narrow fit VERIFIED (advisor blocker, resolved empirically).** The
   stub-band `scrollWidth ≤ clientWidth` gate runs on a pip that trivially fits; the case
   that could still clip is the *active/full* card at narrow=160, where a richer card type
   renders its full body in the slimmest non-stub track. SuggestionCard is the worst case
   (its `suggestion-diff-{id}` box holds padded, background-filled old→new spans, wider
   min-content than a plain comment). Added a 4th C-2 E2E spec — a lone suggestion
   (auto-selected → active → `full` at narrow) with a realistic multi-word `suggestedText`
   — asserting the same `scrollWidth ≤ clientWidth + 1` gate plus a within-column box check.
   **It passes:** the diff-box spans wrap inside the 160px track, no horizontal spill. No
   recipe fix (`min-width:0` / `overflow-wrap`) was needed; if a future card type fails the
   gate, that's the documented fix.

**UX cut to bless (Bryan's call):** at the stub band (sub-~600px viewport) the margin
can no longer read or act on a comment in place — it's a navigation pip only. Clicking it
selects/scrolls but does not expand. Reading/acting requires widening the viewport (the
narrow band shows a full card) or the side rail. **Second-order consequence:** two
annotations anchored to the same text line produce overlapping stub pips (the documented
STUB-NON-PUSH behavior — stubs don't advance the collision cursor), so in dense same-line
clusters the pips intercept each other's clicks and you can't reliably select the intended
one. Edge case, not pervasive, but it strengthens the case for the follow-up. A stub-click
→ side-rail affordance is filed as a follow-up, NOT part of C-2.

## 0. Sequencing gate `[MF-8]`

C-1 must merge first — it lands the `mode: MarginMode` prop on `MarginColumn`, threads
it from App, and locks `MARGIN_TRACK_GEOMETRY`'s band thresholds. C-2 **designs against
C-1's contract now** but implements/lands after. Before coding, **re-verify the three
consumer identifiers against C-1's actual merged code** (not the seam prose):
`editorStage.mode`, the `MarginMode` export path, and the `AnnotationCard.density`
signature. C-2's E2E viewport widths are **derived from C-1's locked geometry** — read
the merged `MARGIN_TRACK_GEOMETRY` numbers, never the estimates.

## 1. Scope

Density variants on the **production `AnnotationCard` dispatcher**, keyed on the
`MarginMode` prop C-1 threads into `MarginColumn`:

- **`clamped`** (narrow band, inactive): single-line teaser; body/actions/replies hidden.
- **`stub`** (stub band, inactive): 22px anchor pill — author dot + status pip only.
- **`full`**: today's card, unchanged.

Implemented as **CSS density-modifier classes on the existing dispatcher + shared
chrome** (plan C2 — NOT a flat `data-kind` bundle bubble). Preserves the left=notes /
right=comments+imports side-split + `status==='pending'` filter (C3), `cardTint` at
**exactly 6 branches** (C13), stub **never `display:none`** on the bubble wrapper, and
ADR-027 (notes never reach Claude; collapse is display-only).

## 2. New pure module — `src/client/panels/cardDensity.ts`

Sibling pattern (mirrors `marginCollision.ts` / `marginLeaderGeometry.ts`) so density is
unit-testable without mounting (`feedback_extract_helper_over_mount`).

```ts
import type { Annotation } from "../../shared/types";
import type { MarginMode } from "../layout/editor-stage.svelte";

export type Density = "full" | "clamped" | "stub";

// Reads ONLY (mode, isActive, isEditing, author) — NEVER collision output
// (heights / adjustedPositions). One-way density → collision-INPUT; the
// height→density→height cycle is structurally impossible [MF-6, CRDT-F4, Svelte-F3].
export function cardDensity(args: {
  mode: MarginMode;
  isActive: boolean;
  isEditing: boolean;
  author: Annotation["author"];
}): Density {
  if (args.isEditing) return "full";                 // edit forces full (min density floor)
  if (args.isActive) return "full";                  // focused card always full
  if (args.author === "import" && args.mode === "stub") return "clamped"; // import never stub [F4]
  switch (args.mode) {
    case "narrow": return "clamped";
    case "stub":   return "stub";
    default:       return "full"; // full + off (off column unmounts anyway)
  }
}
```

`cardDensity.test.ts` — `it.each` equivalence table with a `why` column
(`feedback_iteach_equivalence_classes`): isEditing-override across every mode; off;
full active+inactive; narrow active(full)/inactive(clamped); stub active(full)/inactive(stub);
**import+stub+inactive → clamped** (never stub); import+active → full. Totality over
`MarginMode × {active,inactive} × {editing,not} × {user,claude,import}`.

## 3. AnnotationCard.svelte + the 5 variant files `[MF-1]`

**`[MF-1]` the `:global()` collapse needs concrete hooks — the variant body is an
unclassed `<div style=…>`.** Confirmed: `CommentCard.svelte:33`, `SuggestionCard.svelte:33`
etc. have no class/testid for the body, so `:global()` has nothing to target. **Add to
`filesToModify`** (the design draft omitted them):

- **CommentCard, NoteCard, SuggestionCard, HighlightCard, ImportedCard:** add a stable
  `aca-body` class to the body `<div>`.
- **ReplyThread.svelte:** add a stable root class.

In **AnnotationCard.svelte**:

- Add `density?: Density = 'full'` prop (introduction + behavior is C-2-owned).
- `const resolvedDensity = $derived(isEditing ? 'full' : density)` — the dispatcher is
  the only place `isEditing` is known; it forces `full`.
- Apply as classes on the root `.tandem-annotation-card`:
  `class:is-density-clamped={resolvedDensity === 'clamped'}`,
  `class:is-density-stub={resolvedDensity === 'stub'}`, plus `data-density={resolvedDensity}`
  for E2E. **Do NOT branch the dispatch** — variants stay mounted (Svelte-F2).
- `<style>`:
  - **`[MF-3]` line-clamp full recipe.** `-webkit-line-clamp:1` alone is a no-op and
    cannot span the snippet + body siblings. Pick ONE clamp target: **hide the snippet,
    clamp `.aca-body`'s first paragraph** with the full recipe
    `display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:1; overflow:clip;`
    (`overflow:clip`, not `hidden` — `feedback_overflow_hidden_vs_clip`). Hide the action
    row (`.aca-row`), reply thread, and expand button in `clamped`.
  - **`stub`:** KEEP `AnnotationCardHeader` (badge + 6px author dot) visible; HIDE the
    snippet, `.aca-body`, `.aca-row`, reply thread, expand button. Status pip via the
    stub surface below.
- **`[MF-5]` stub status pip — do NOT use `cardTint` as a border.** `cardTint` returns
  pale `-bg` fill tokens (verified `:80-88`, exactly 6 branches); a 3px border in a
  near-surface fill is invisible. Use the matching **`-fg-strong`** token for the pip
  only. **`cardTint` stays at 6 branches — no 7th `stub` branch** (C13).
- **`[MF-7]` ReplyThreadOverlay close-on-→stub** guarded `$effect` (last-value guard,
  `feedback_svelte_effect_depth_guard`):
  ```ts
  let prevDensity = resolvedDensity;
  $effect(() => {
    if (resolvedDensity === prevDensity) return;
    prevDensity = resolvedDensity;
    if (resolvedDensity === "stub") isThreadOverlayOpen = false;
  });
  ```
- Stub-pill click reuses the dispatcher's existing root `onclick={onClick}` → sets
  `activeAnnotationId` → density re-derives to `full` (Svelte-F6). No new handler.
- **`[svelte-LOW]`** Drop the redundant `:not(.is-review-target)` qualifier — a clamped/
  stub card is inactive by construction (active → `cardDensity` returns `full`, so neither
  class is applied). Use `.is-density-clamped .aca-row { display:none }`.

## 4. MarginColumn.svelte — density derivation + collision routing

- Add `mode: MarginMode` to `Props` *(landed by C-1; C-2 consumes)*. Import `cardDensity`.
- In the bubble `{#each placeable}` block: `{@const density = cardDensity({ mode, isActive: ann.id === activeAnnotationId, isEditing: false, author: ann.author })}` and pass `{density}` to `<AnnotationCard>`.
- **Stub ↔ collision:** in the `adjustedPositions` `$derived.by` input, set
  `height: density === 'stub' ? undefined : heights.get(a.id)` so a stub reuses the
  EXISTING "unknown height ⇒ don't advance cursor" path (`marginCollision.ts:56`). Re-derive
  density inside `adjustedPositions.by` over `placeable` (keyed on `mode` + `activeAnnotationId`
  — both reactive, neither collision output → **no cycle**).
- **`[MF-2]` editing-stub collision mismatch (annotation-MED, reachable).** A not-active
  card being edited renders full-height (`resolvedDensity` forces `full`) but
  `MarginColumn` computes density with `isEditing:false` → `stub` → `height:undefined` →
  excluded from collision → **overlaps neighbors**. **Fix = force-active-on-edit:**
  entering edit sets `activeAnnotationId`, so `(mode,isActive)` yields `full` in BOTH the
  collision input and the render. (Reviewer's "skip when height absent" alternative is
  flawed — a stub records a ~22px `clientHeight`, so absent-height can't identify stubs.)
  Lock the mechanism here.
- Keep the bubble wrapper `div` mounted with `pointer-events:auto` in stub mode (the CARD
  collapses; the wrapper persists so the pill is clickable — **stub ≠ display:none**).
- Leave the leader SVG block, the `status==='pending'` filter in `placeable`, and the
  `getVisibleReplies` ADR-027 lookup unchanged (C3 + ADR-027).

## 5. App.svelte

In the `<MarginColumn>` invocation add `mode={editorStage.mode}`. No other C-2 change —
the `marginNotes`/`marginComments` side-split and `effectivelyOn` gating stay exactly as
today (C3).

## 6. Correctness note the agent team flagged `[MF-4]`

**Stub-push prose was wrong.** `resolveCollisions` sets `next = Math.max(top, cursor)` for
EVERY bubble incl. `height:undefined` (line 54), so a stub **does not advance** the cursor
but **can still be pushed down** by a preceding full bubble. Code comments + the PR must
say: *"a stub never ADVANCES the cursor; it may still be displaced by a preceding full
bubble."* E2E spec 4 tests only **adjacent** stubs (both `undefined` → genuinely share raw
tops); do **not** strengthen it to assert raw-top in mixed full+stub stacks.

## 7. Test plan

- **UNIT** `cardDensity.test.ts` (`it.each` + `why`): the full equivalence table from §2
  incl. import-never-stub and isEditing-override.
- **UNIT** `marginCollision.test.ts` (add cases): `height:undefined` does not advance the
  cursor; mixed full(height)+stub(undefined) — stub doesn't push but can be pushed.
- **E2E** (`margin-view.spec.ts`, derive widths from C-1's locked geometry): (1) clamp-
  until-active — narrow band, inactive comment `data-density='clamped'` + action row
  hidden; click → `full` + actions visible + **assert the clamped element's rendered
  height** (not just visibility) `[MF-3]`; (2) stub mode — header visible, body/actions
  hidden, click → `full`; (3) stub wrapper persists (`[data-testid^='margin-bubble-']`
  count>0, attached); (4) two **adjacent** inactive stubs share raw tops; (5) ADR-027 —
  left-column note in stub keeps `data-margin-bubble-reply-count='0'`; (6) **no console
  error** across `full→narrow→stub→full→edit` (effect-depth guard); (7) editing-stub does
  not overlap (force-active-on-edit) `[MF-2]`.
- **E2E** active-full-at-narrow fit (§0a #4, advisor blocker): a lone suggestion →
  active → `full` at narrow=160; `scrollWidth ≤ clientWidth + 1` + within-column box. The
  diff box wraps; no spill. (Covers the *active/full* SuggestionCard — the clamped/stub
  cases hide or collapse the diff, so only this band renders it at the slim track.)
- **MANUAL** (claude-in-chrome): all 5 variants at `clamped` + `stub`; SuggestionCard
  diff-box clamp acceptable (inactive); **ImportedCard never stub**; stub pip color per
  type (`-fg-strong`) actually perceivable; reduced-motion unaffected (C-2 adds no motion).
- **REGRESSION:** existing `margin-view.spec.ts` suite stays green (C-2 adds a `full`-
  default prop reproducing today's behavior at `mode==='full'`).

## 8. Build sequence

0. **Gate:** C-1 merged; re-verify the 3 consumer identifiers against merged code.
1. `cardDensity.ts` + `Density` type.
2. `cardDensity.test.ts` `it.each` table FIRST (the equivalence classes are the spec); red→green.
3. The 5 variant files + ReplyThread: add `aca-body` / root classes.
4. AnnotationCard: `density` prop + `resolvedDensity` + classes/data-attr + clamp/stub `<style>` (full line-clamp recipe; `-fg-strong` pip; `cardTint` 6 branches) + guarded overlay-close `$effect`. svelte-check.
5. MarginColumn: derive density, thread `{density}`, route stubs to `height:undefined`, force-active-on-edit. svelte-check.
6. App.svelte: `mode={editorStage.mode}`.
7. `typecheck` + `test`; then read C-1's geometry numbers, write E2E density specs, `test:e2e -- margin-view`.
8. Manual chrome pass (5 variants × clamp/stub). `/simplify`, commit, PR.

## 9. Risks

| Risk | Sev | Mitigation |
|---|---|---|
| Editing-stub excluded from collision → overlap | MED | Force-active-on-edit `[MF-2]`; E2E spec 7 |
| `:global()` collapse has no selector hooks | MED | Add `aca-body` + ReplyThread root class to the 6 files `[MF-1]`; E2E header-visible/body-hidden turns a rename into a test failure |
| line-clamp no-op / can't span siblings | MED | Full `-webkit-box` recipe on a single named target (`.aca-body` first ¶); E2E asserts clamped height `[MF-3]` |
| Stub pip invisible | LOW | `-fg-strong` token, not `cardTint` border; manual pass per type `[MF-5]` |
| Density→collision cycle | — | `cardDensity` reads only inputs; one-way into collision input; documented `[MF-6]` |
| SuggestionCard multi-block body clamps to diff line only | LOW | Accept documented single-visible-line; verify in manual pass |
| Stub bubbles overlap leaders at dense clusters | LOW | Documented bundle behavior; light stub spacing deferred to Stage D / #916 |
