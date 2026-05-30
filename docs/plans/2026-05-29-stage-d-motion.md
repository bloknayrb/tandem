# Phase 3.5 Stage D — structural layout motion

> **STATUS: DEFERRED to #798 (Bryan, 2026-05-29).** Plan review (crdt-reviewer §3)
> killed the cheap CSS-transition approach for the margin mode steps — it detaches
> the leader from the text for ~190ms (up to ~130px) on every resize/toggle. The
> correct version (Choice B, §7 — a JS geometry-tween) is a non-trivial reactive
> lift that belongs in the #798 motion series, not a one-off Conflict #9 override
> bolted onto the umbrella. Phase 3.5's core (grid stage, continuum, density,
> leaders) is shipped and functionally complete WITHOUT motion. **No code was
> written for this stage.** This doc is preserved as the design record so the #798
> pickup inherits the analysis (the leader-detach math + Choice B design) rather
> than rediscovering it. The rest of this file is the as-analyzed plan.
>
> Would have landed on `feat/design-system-impl`, stacked after C-2 (#930, `fc17a5c`).
> Source plan: `docs/plans/the-current-way... ` (Stage D, §5 Motion + §9 D + §12 C1).

## 1. Goal

Animate the editor-stage layout changes that today snap instantly:
- **Margin track widths** stepping `full → narrow → stub → off` (viewport resize / rail toggle).
- **Margin on↔off** toggle (track 0 ↔ reserve).
- **Reading-measure** preset changes (`narrow/comfortable/wide/full`).

All three are driven by the SAME computed property — the stage's
`grid-template-columns` (track widths are `var(--margin-*-track)`, the content
track is `minmax(0, var(--editor-measure))`). So a single CSS `transition` on
`grid-template-columns` covers every case. ~190ms ease, matching the spec's
structural timings (cluster-3.10 precedent uses ~180–200ms).

## 2. Why this is a Conflict #9 OVERRIDE (not a violation)

`conflicts-resolved.md` #9 defers the bundle's 9 motion *scenes* to #798 and
tells Phase 1–3 sub-PRs not to introduce new animation choreography. Stage D
introduces new motion, so it trips that rule **on its face**. But structural
layout motion was **locked in scope with Bryan up front** (source plan §1:
"Structural motion is in scope — Bryan's intent is structural; Conflict #9's
'defer animation to #798' does not block animating layout track widths here").

Resolution: this is a **scoped override** — structural track/measure motion lands
here; the 9 bundle *scenes* (trayIn, ledpulse, anchor-pulse A6, etc.) stay
deferred to #798. Per the Override Protocol, Stage D MUST:
1. Add a "Conflict resolution override" header to the PR body (conflict id #9,
   new resolution, rationale).
2. Add an **Applied Overrides** entry to `conflicts-resolved.md` in this PR.
3. Get Bryan's explicit confirmation before merge (he pre-blessed the scope; the
   PR review is the confirmation step).

## 3. Mechanism — the leader-detach artifact (crdt-reviewer, 2026-05-29: Choice A is unsound for mode steps)

The original draft claimed Choice A (a CSS `transition` on `grid-template-columns`)
left leaders/bubbles attached "structurally." **Plan review falsified that.** The
correct decomposition:

- **leader ↔ bubble ↔ dot consistency IS structural** (the part the draft got
  right). `editorX`/`columnX`/`leaderStyle` and the bubble container all pin to the
  SAME cell edge using the SAME discrete `MARGIN_TRACK_GEOMETRY[mode]` geometry
  (`width`/`edgeInset`/`gap`), with no `getBoundingClientRect`. They never diverge
  from each other.
- **leader-dot ↔ TEXT-edge attachment is NOT structural.** The dot lands on the
  text iff `cellWidth === marginReservePx(mode)`. The dot/leader/bubble are pinned
  to the cell's **outer** edge; the text is at the cell's **inner** edge. A CSS
  transition eases `cellWidth` from the OLD reserve down to the new, while the
  geometry props **snap** to the new reserve at t=0. So during the ~190ms ease the
  whole margin apparatus sits `cellWidth − targetReserve` px off the text edge and
  slides in: **~80px for full→narrow, ~130px+ for full→stub**, with the leader
  visibly detached from the text. This fires on every rail-toggle / measure-preset
  change (clean ease) — i.e. exactly the "smooth degradation" path Stage D targets.

Conclusion: **Choice A (pure CSS transition) is rejected for the margin-track mode
steps.** It trades an instant snap for a 190ms visible detach — not an improvement.

`useMarginPositions` (vertical offsets) is genuinely safe — but via the
ResizeObserver-on-layer-HEIGHT path, NOT the draft's "gutters absorb so no reflow"
reason (wrong at the thresholds, where the content track is already at its floor and
DOES reflow). The layer's `top` is unmoved by a horizontal animation, and any height
change from reflow reschedules `recompute()` through the existing ResizeObserver. No
CRDT/anchor invariant is touched (pure pixel transition; `refreshRange`/RelativePosition
never enter this path). Those two conclusions hold.

**What stays safe to animate cheaply (the carve-out):** a reading-MEASURE preset
change leaves the margin geometry (`width`/`edgeInset`/`gap`) UNCHANGED — only the
content track (`--editor-measure`) resizes — so `cellWidth === reserve` holds
throughout and the leader stays attached. Measure-only motion has no detach artifact.

→ See §7. The decision (defer to #798 vs. build Choice B now vs. measure-only) is
Bryan's, surfaced before any code lands.

## 4. Edit set

1. **`src/client/App.svelte`** — add `class="editor-stage"` to the `marginLayerEl`
   div (currently only `data-testid` + inline `style`). In the scoped `<style>`,
   add the transition + dual reduced-motion guard (apply-then-neutralize, matching
   the shipped `editor.css` / `SidePanel` / `AnnotationCardActions` pattern — NOT
   the source-plan C11 "gate with no-preference" phrasing, which is the inverse of
   what every shipped surface does; same effect, codebase-consistent form):
   ```css
   .editor-stage {
     /* Structural track + measure motion (Stage D, Conflict #9 override).
        grid-template-columns carries both --margin-*-track and the
        minmax(0,var(--editor-measure)) content track, so one transition covers
        full↔narrow↔stub↔off AND measure-preset changes. docx uses this element
        too but never sets grid-template-columns, so the transition is a no-op
        there. */
     transition: grid-template-columns 190ms ease;
   }
   @media (prefers-reduced-motion: reduce) {
     .editor-stage { transition: none; }
   }
   :global(body.tandem-reduce-motion) .editor-stage { transition: none; }
   ```
   INVARIANT 3 (no padding/border on the stage) is untouched — `transition` does
   not affect the border-box top.
2. **`docs/design-system-impl/conflicts-resolved.md`** — add the Applied Overrides
   entry for #9 (scoped structural-motion override; scenes still deferred to #798).
3. **`CHANGELOG.md`** — `[Unreleased]` Added: smooth margin track-width + reading-
   measure transitions.

No `.svelte.ts` / model change — the model already emits the geometry; Stage D is
purely the CSS that eases the computed result. No new tokens.

## 5. Verification

- **E2E** (`tests/e2e/margin-view.spec.ts`): the transitions are presentational and
  hard to assert deterministically, but two cheap, non-flaky guards:
  1. **Transition is declared** — at a non-reduced-motion context, the stage's
     computed `transition-property` includes `grid-template-columns` (and
     `transition-duration` > 0). Proves the rule is wired.
  2. **Reduced-motion kills it** — with `body.tandem-reduce-motion` set (drive via
     the reduceMotion setting), the stage's computed `transition-duration` is `0s`.
     Dual-mechanism: also assert under emulated `prefers-reduced-motion: reduce`
     (Playwright `page.emulateMedia({ reducedMotion: 'reduce' })`).
  3. **No regression** — the existing C-1/C-2 track-width + density specs stay green
     (a `transition` must not change the *final* computed track width, only how it
     gets there; Playwright reads settle post-transition).
- **Unit:** none needed (no new pure logic; the model is unchanged).
- **Manual chrome pass:** resize across t1/t2/t3 and toggle margin view — confirm
  the track eases and the §3 residual (card intrinsic-width snap) reads acceptably;
  confirm leaders stay attached (no chase). Confirm `grid-template-columns`
  transitions actually fire in the Tauri WebView (Chromium ≥107 / WKWebView ≥16 —
  both satisfied; verify, since some engines historically no-op'd grid track
  interpolation). Confirm reduced-motion (OS + in-app toggle) freezes it.
- `npm run typecheck` + `svelte-check` + full `npm test`.

## 6. Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| WebView doesn't interpolate `grid-template-columns` (no-op transition) | MED | Manual-pass verify in the actual Tauri WebView; if it no-ops, fall back to Choice B (§7) or `@property`-registered length vars. Worst case = today's snap (no regression). |
| Card intrinsic-width snap during ease reads as jank | LOW | §3 residual; manual-pass gate; Choice B fallback. |
| Transition fires on initial mount (0→reserve flash on first paint) | LOW | The stage mounts with its first computed template; transitions don't run on the first style application for a freshly-inserted element (no prior value). Verify in manual pass; if it flashes, gate with a mounted flag. |
| reduced-motion guard misses one surface | LOW | Dual-mechanism (OS media + in-app class), both E2E-asserted. |

## 7. The decision (post-review) — three options for Bryan

Plan review killed the cheap path for the headline case. The real options:

- **Option 1 — DEFER Stage D to #798 (recommended).** Phase 3.5's CORE (grid stage,
  continuum, density, leaders) is shipped and works *without* motion. Structural
  margin-track motion is exactly what the #798 motion series exists to thread through
  animated surfaces, and Conflict #9 keeps the umbrella "no new choreography." The
  correct implementation (Option 2) is non-trivial and belongs alongside the other
  scenes, not bolted on as a one-off override. Net: no override, no jank, no
  speculative reactive lift; Phase 3.5 closes functionally complete.
- **Option 2 — Build Choice B now (the correct smooth version).** Drive the geometry
  NUMBER through a JS rAF tween in `EditorStageModel`: a single animated `column` value
  per side feeds BOTH the grid track var AND MarginColumn's `width`/`edgeInset`/`gap`
  props, so `cellWidth === reserve` every frame and the leader stays glued to the text.
  Heavier: a tween `$effect` + rAF with a reduced-motion guard AND a last-value guard
  (`effect_update_depth` risk per `feedback_svelte_effect_depth_guard`), plus the
  Conflict #9 override. Smooth and correct, but real work for polish on infrequent
  events.
- **Option 3 — Measure-only motion (cheap + safe subset).** Ship the CSS transition
  scoped so it only eases reading-MEASURE changes (no detach artifact, §3 carve-out),
  and leave the margin mode steps snapping. Small, honest, no jank — but delivers the
  *least* of the "smooth degradation" goal (the margin steps, the headline, stay
  instant). Still a (smaller) Conflict #9 override.

Recommendation: **Option 1.** It respects the locked Conflict #9 discipline, avoids
shipping a regression-flavored animation, and routes the correct implementation to the
series built for it. If Bryan wants the polish inside this phase, Option 2 is the only
one that delivers it correctly.
