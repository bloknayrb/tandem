# Margin annotations: vertical-pressure auto-minimize + elastic width

**Date:** 2026-07-30 · **Issues:** #917 (implements the deferred "Stage E"), #892 (fixes the collision-pressure degradation it names) · **Lineage:** #649 → C-1 (#927) → C-2 → here

## Problem

`resolveCollisions` pushes overlapping margin bubbles down by `previousHeight + 6px` with no upper bound. A cluster of tall cards therefore drifts hundreds of pixels from the text it annotates — the card and its anchor are no longer on screen together, which defeats the point of the margin view.

Separately, the margin column was a fixed width per mode (`full` = 240px). The stage grid is `[1fr gutter | margin | content | margin | 1fr gutter]`, so space reclaimed by collapsing or narrowing a rail all landed in the `1fr` gutters. At a 1600px viewport with both rails collapsed there was ~148px of dead gutter per side. Wider cards are also *shorter* cards, so this directly relieves the first problem.

## What shipped

**A fourth density, `compact`.** `Density` is now `full | compact | clamped | stub`. `compact` is a one-line body teaser with the snippet and replies hidden but **the action row kept**. The split from `clamped` is principled and worth preserving:

- `clamped` is a **width** concession — a 160px `narrow` column genuinely cannot fit Accept/Reject.
- `compact` is a **height** concession at full width, where there *is* room.

Consequence: minimizing never costs an extra click to act on a card. This is why docx needed no carve-out (see "docx" below).

**`marginPressure.resolveCrowding`.** Simulates the stack from raw anchor tops using model-derived height estimates, then runs a bounded greedy relief loop: while some card's drift exceeds the enter threshold, minimize the tallest un-minimized card at or above the violation and re-simulate. Halts at no-violation or all-minimized, capped at `bubbles.length` iterations.

**Elastic margin tracks.** `MarginTrackGeometry` gains `maxColumn` (`full` 240→400, `narrow` 160→240, `stub`/`off` inelastic). `stageLayerStyle` emits a surplus-limited `clamp()` track.

**Pin affordance.** A chevron on the `.margin-bubble` wrapper keeps a card expanded independently of focus.

## Decisions and the reasoning behind them

### Hysteresis is required (an earlier revision claimed it was not)

The first design argued no band was needed because `useMarginPositions`' `mapsEqual` already tolerates 0.5px. That was wrong twice over:

1. `mapsEqual` is an **equality guard, not a Schmitt trigger**. It suppresses sub-pixel updates; it neither quantizes nor damps.
2. Raw tops shift by a whole line-height (~24px) whenever a line rewraps — over half the intended 40px tolerance. Without a band, one keystroke near the threshold flips the verdict at full amplitude, and measured heights lag a frame, so every flip costs a visible settle.

`cleave-locks.md` §"Resolved forks" is explicit that presence-collapse is band-free *because* it is a stable binary input. A thresholded continuous metric fails that test by construction. Shipped with asymmetric bands: enter > 48px, exit < 24px, threaded purely as `prevCrowded` in / next set out.

### The height estimate is model-derived, not a constant

A single `ESTIMATED_FULL_CARD_PX = 120` was tried and is wrong. Real full cards run ≈115–260px: 24px padding + 2px border + header + a 28–45px snippet + body at 13px/1.45 (a 40-word comment in a 240px column is ~130px of body alone) + a ~30px action row + the card's 8px `margin-bottom`, which does **not** collapse out of `clientHeight` because the abs-positioned wrapper establishes a BFC. A floor-of-the-range constant computes zero drift for anchors ~130px apart while reality drifts ~50px per step — it under-fires on exactly the clustered-tall-cards case the feature targets. The density setting also swaps `--tandem-space-3` between 10/12/16px, so no single constant is right across settings.

`estimateHeightPx` therefore takes the annotation **model** (type, content length, snippet/suggestion presence, reply count, whether actions render) plus column width and the spacing scale. **Every input is model or geometry — never a measured height.** That is what keeps it acyclic.

### Relief is greedy and local, not run-wide

Marking the whole overlapping run was the first design. Drift is monotone within a run, so ten anchors 100px apart would mark all ten when minimizing the last three suffices — and in a normally-annotated document nearly everything lands in one run, so the column would collapse wholesale.

The relief loop also must **not stop at the first unsatisfiable violation**. Measured during implementation: five bubbles 40px apart minimized only the top two and left the remaining three rendering `full` while drifted **458px** — the exact failure the feature exists to prevent. Skipping to the next relievable violation compresses the rest as far as it can go (same case now: 5/5 minimized, 276px residual). Pinned by `does not abandon bubbles below an unsatisfiable violation`.

### The cycle, and why it is closed

Density changes a card's rendered height. If the verdict read *measured* heights we would have `density → height → collision → density` — the cycle PR #909 rejected. Closed structurally:

- `resolveCrowding` takes `{id, top, model}`. No height. A signature test enforces it, because declaration order in the component is documentation, not enforcement.
- Every margin bubble is `position: absolute` inside `.margin-track`, and abs-positioned children contribute nothing to their containing block's intrinsic size. The grid row's height is set by the content track alone, so card height cannot move the stage, `coordsAtPos`, or a raw top.

Note #917's own sketch — `pressure(positions, heights, columnHeight)` — **would have reopened the cycle**, since `heights` is measured density output; the issue's later bullet only forbids `adjustedPositions`, which is insufficient. This implementation is deliberately stricter than the issue it closes.

**One live feedback path exists and is closed by something unrelated.** Abs-positioned bubbles *do* contribute to `.editor-scroll`'s scrollable overflow, and it is `overflow: auto` on both axes. A vertical scrollbar appearing as the stack's extent changes would narrow the content box → rewrap → new raw tops → new verdict → new extent. That loop is dead only because `scroll-fade.css` sets `scrollbar-width: none` + `::-webkit-scrollbar { display: none }` — behind an `@supports (mask-image: …)` gate whose fallback restores the native scrollbar. So the honest invariant is: *no density-dependent input reaches `coordsAtPos`, provided the editor scroller never shows a classic scrollbar.* Under the fallback branch the hysteresis bands are what prevent oscillation.

**Forbidden future combination:** margin track width must never depend on crowding. Track width → content width → `coordsAtPos` → raw tops → crowding *is* a real cycle through raw positions, and it is precisely the "density → pressure → mode" idea `cleave-locks.md:93` records as rejected.

### The elastic track needs a `clamp()`, not a plain `minmax()`

A plain `minmax(base, max)` is **wrong**. CSS Grid's Maximize-Tracks step distributes free space among non-flexible growable tracks (the `1fr` gutters are frozen at their base for that step), so an unguarded max grows the margins at the **content** track's expense — its min is `0` by design so it can shrink.

Measured in Chromium via `getComputedStyle(stage).gridTemplateColumns` rather than reasoned from the spec (the repo's own lesson: measure the pipeline, don't read it):

| stage | mode | today | naive `minmax(base,max)` | shipped `clamp()` |
| --- | --- | --- | --- | --- |
| 1600px | full | margins 272, content 605 | margins 432, content 605 | margins **432**, content 605 |
| 1100px | full | margins 272, content 556 | margins 432, content **236** ❌ | margins 272, content 556 |
| 900px | narrow | margins 192, content 516 | margins 272, content **356** ❌ | margins 192, content 516 |
| 1600px | measure `100%` | content 1056 | content **736** ❌ | content 1056 |
| 700px | stub | 60/60 | unchanged | unchanged |

The shipped form:

```
minmax(var(--margin-left-track),
       clamp(var(--margin-left-track), (100% - var(--editor-measure)) / 2, var(--margin-left-track-max)))
```

Because the ceiling is *exactly* the surplus, the content track resolves to exactly the measure in the elastic regime and to exactly `100% - 2·base` in the degenerate one — **identical to today at every container width**. That content-width-neutrality is not a nicety; it is what keeps elasticity out of the reactive cycle. Never express the ceiling as anything other than the surplus.

Live end-to-end measurement at 1600px with both rails collapsed and three seeded comments: `cols = 210px 0px 680px 420px 210px` — the right track grew 272→420 while the content track kept its full 680px measure. Cards rendered 388px wide (up from 240), the two crowded ones at 93px tall instead of 206, worst anchor drift 37px.

**Still unverified: WebKitGTK (macOS/Linux) and WebView2 (Windows).** Tauri is the primary distribution. The engine-dependent risk is the *indefinite available width* case — during an ancestor's intrinsic-sizing pass, the spec resolves a percentage-based track sizing function to `auto` (intrinsic/content-sized), not to the literal fixed base-px value — so "falls back to today's fixed track" overstates what should actually happen; the real fallback is closer to "sizes to content," and `nested-in-calc()` behavior is inconsistent across engines on top of that. Likely benign in practice (`.editor-column-wrap` is `flex: 1; min-width: 0`, so the definite path — where this doesn't apply — is the normal one), but it should be measured on real WebKitGTK/WebView2 rather than assumed.

### docx: no carve-out

`resolveBaseMode` clamps docx to `full | off`, so docx **does** receive the pressure pass. The concern was that minimizing would hide the Promote/Dismiss row on imported Word comments — the format most likely to carry dozens of clustered comments. Resolved by making `compact` keep the action row for *every* format rather than special-casing docx (Bryan's call). The `[F4]` import carve-out stays retired.

`cardDensity.ts`'s original justification for omitting `author` ("imports are .docx-only and .docx never enters the narrow/stub continuum") is now only half true — docx lands on the *full* band, which does minimize. The comment there has been corrected rather than left misleading.

### The pin lives on the bubble wrapper, not the card header

The header looked natural and is wrong on three counts:

1. `AnnotationCard` never renders the header — the five variants do — so `isPinned`/`onTogglePin` would thread through `CommentCard`, `SuggestionCard`, `NoteCard` and `ImportedCard` (six files instead of one), through components documented as never owning state, and the button would render in the always-mounted side rail too.
2. The house style leaves `isReviewTarget` without a `$props()` default, so a copied `isPinned` would be `boolean | undefined`, and Svelte omits an attribute set to `undefined` — `aria-expanded` would appear only on pinned cards.
3. `.is-density-stub` sets `overflow: clip`, clipping a header-mounted control.

On the wrapper it costs zero card changes. Two details are load-bearing:

- **`stopPropagation` is mandatory.** The card root's `onclick` sets `activeAnnotationId` and scrolls the document. Without it, clicking to *un*-pin also focuses the card, `isActive` forces `full`, and the card stays visibly open while `aria-expanded` flips to `false` — the button reads as broken. The pin E2E test asserts this indirectly by checking focus stayed on the *other* card.
- **The render gate must not copy the edit button's `!isReviewTarget`**, which would hide the chevron on the focused card — exactly the card the user is looking at when they decide to pin it.

Placement is **bottom-right**, found by screenshotting: the header's right group renders the author dot, label and relative timestamp out to the card's right edge, so a top-right control lands on "just now". The action row and Reply are left-aligned, leaving bottom-right free at every density. Rest opacity is 0.55 (matching the margin edit-button precedent) rather than 0 — on a minimized card the chevron is the primary "there is more here" affordance.

### Pins prune against `annotations`, not `placeable`

The highest-severity defect the reviews caught. `placeable` gates on `positions.has`, and `positions` empties **wholesale** whenever `getEnabled()` is false or editor/layer/ydoc is null (every Y.Doc swap, generation-gate provider rebuild, source-view toggle), and drops individual ids on a transient `coordsAtPos` throw or a non-finite top (which heading-section collapse produces).

A pruned *height* is harmless — the bubble remounts and `bind:clientHeight` re-measures. A pruned *pin* is destroyed user intent with nothing to re-read from. And the column does **not** unmount in those cases, because presence-collapse reads the ungated has-pending inputs — so `pinnedIds` survives and would then be wiped.

Also: `$state(new Set())` is **not** deep-proxied in Svelte 5 (only plain objects/arrays are), so `.add()`/`.delete()` are invisible to reactivity. Every mutation reassigns a fresh `Set`, matching `recordHeight`'s contract.

## Shipped contract change

Two annotations anchored to the same line share a raw top and now minimize even at full width. That is the feature working, but it flips a shipped C-2 expectation: `seedTwoComments` anchors both comments inside the title line, so the density-sweep test's full-band assertion becomes `compact`. Updated, with a new `seedTwoDistantComments` fixture carrying the "uncrowded → full density" coverage that assertion used to provide.

## Tunables

All in `marginPressure.ts`, in the spirit of `MARGIN_TRACK_GEOMETRY`'s visual-taste estimates: `CROWD_ENTER_PX = 48`, `CROWD_EXIT_PX = 24` (keep EXIT < ENTER or the band inverts), and the card-anatomy constants feeding `estimateHeightPx`. Elastic ceilings live in `MARGIN_TRACK_GEOMETRY[*].maxColumn`.

## Known limits

**Minimizing reduces drift; it cannot eliminate it.** You cannot fit three 103px compact cards into 40px of anchor space — measured residual for that case is 276px. This fixes the common case (a few tall cards) and leaves the pathological case (many annotations on one line) improved but imperfect. Deliberately **not** escalating to `stub` as a second pass: a pip is unreadable, so it trades one failure for another. The escape hatch for extreme clusters is #928's stub-pip-to-rail path.

**`clamped` still hides the action row** at the `narrow` band. That is the pre-existing width tradeoff, unchanged.

## Post-review refinements

A four-angle cleanup pass (reuse / simplification / efficiency / altitude) found several things worth recording, because two were real defects rather than tidying:

**The elastic width wasn't reaching the verdict it was supposed to feed.** Three reviewers independently caught that `columnWidthPx` was passed `geom.column` — the track *minimum* (240) — while the track renders up to 400px. `estimateHeightPx` derives `charsPerLine` from that width, so in the elastic regime it computed ~40% too many body lines and the pass **over-fired**: cards minimized that had room to stay full, cancelling out the relief the elastic width exists to provide. The two halves of the change composed visually but not logically. Fixed by `bind:clientWidth` on the column element. Measuring a *width* is safe — the column's width comes from the grid track, which depends on stage width / reading measure / mode and never on card heights (bubbles are absolutely positioned, so they cannot size their own track). The invariant is therefore stated as "no **density-dependent** measurement reaches the pressure pass", not "never a measurement".

**The relief loop was O(n³).** `bestCandidate(v)` returns null for exactly `v < firstRelievable`, and the loop re-paid that provably-null scan on every iteration. A monotone watermark plus index-keyed `Float64Array`s instead of per-iteration `Map`s makes it O(n²) and behaviour-identical (verified by the existing tests plus a 400-trial randomized equivalence check during review). Measured: **n=200 from 15.5ms → 0.45ms; n=300 from 57.4ms → 0.47ms.** This matters because the pass runs on every frame of a rail- or window-resize drag via the layer `ResizeObserver`, so 15ms was a dropped frame per tick on a heavily-annotated document.

Also fixed: `bestCandidate` could pick a **zero-gain** card (marking it `compact` — a visible density change that relieves nothing); a tie-break comment said "lowest index" where the code keeps the highest (the parenthetical was right, the words wrong, and "fixing" `>=` to `>` would have inverted the tuned locality); `prunePins`/`prunePlaceableHeights` collapsed into one structurally-typed `pruneMissing` serving both the heights `Map` and the pins `Set`; the `compact` CSS block, which was a verbatim clone of `clamped`'s, now shares its selector list so the `-webkit-line-clamp` recipe exists once (two copies is exactly the drift class that produced #1189); the chevron adopted the app's standard 24-unit viewBox (a 12-unit box at stroke-width 1.6 rendered ~60% heavier than every other chevron) and the `--tandem-ease-out` token with a dual-mechanism reduced-motion guard; the chevron now renders only where it does something (`density !== "full" || isPinned`); the `densityById` invariant comment, which the diff had orphaned above `pinnedIds`, moved back to its declaration; `spaceScale` and the `clamped` arm of `estimateHeightPx` were removed as inert (no producer / no production caller), along with a dead `CardModel.type`.

**One new test earns special mention.** `estimateHeightPx` mirrors card anatomy in TS constants — a deliberate JS/CSS duplication, since reading measured heights would reopen the cycle. Nothing would have *detected* it drifting: retune a spacing token or add a header row and the only symptom is cards drifting off anchor, i.e. this feature's own bug silently returning. `pressure: the height estimate tracks the real rendered card height` seeds a known annotation, measures the rendered bubble, and bounds the relative error at 35%. Test-only measurement, so it never touches the runtime cycle.

### Deliberately skipped

- **Sharing the stack walk with `resolveCollisions`** (the ordering rule and cursor recurrence are duplicated, coupled only by a comment — a genuine silent-divergence risk). The perf fix makes the two walks structurally incompatible: `simulate` needs index-keyed typed arrays reused across n calls, `resolveCollisions` returns an id-keyed `Map` from one call. Sharing would re-impose the allocation the fix removed. Left duplicated with an explicit comment naming the coupling.
- **A `DENSITY_SECTIONS` table** unifying which sections each density renders (currently stated in three places: the CSS, `estimateHeightPx`'s branches, and `cardDensity`'s prose). The best structural idea in the review, but it restructures shipped `AnnotationCard` CSS into orthogonal modifier classes, touching the `stub` pip recipe and the `data-density` E2E contract. The CSS merge above captures most of the benefit. Worth a follow-up.
- **Unifying the docx path behind a `.margin-track`-equivalent wrapper**, which would delete the `sizing` prop entirely. Right altitude, feasible without changing docx pixels — but no docx bubble-geometry assertion exists to catch a mistake, so it needs that test first.
- **Hoisting `pinnedIds` to App level.** The column unmounts at the `off` band, so narrowing the window below ~600px and back destroys pins. Acceptable: at `off` the margin isn't rendering at all.
- **Wiring the density setting into the chrome estimate.** ~6px per card skew at compact/spacious, well inside the 24px hysteresis band; the dominant term (body wrapping) *is* parameterized. Documented as a cozy-scale assumption instead.

## Rejected alternative

A fifth `wide` ladder step (`column: 400`, `t0 = 1344`) instead of elastic tracks. Cleaner in several ways — keeps `mode` the single source of truth for width *and* density, keeps px geometry so docx and the `width` prop are untouched, reuses the existing hysteresis, and carries zero CSS-Grid risk (including the untested WebKitGTK/WebView2 question).

**It fails the actual requirement.** The ladder budgets from *persisted-at-mount* rail widths (#683), so it would not respond to collapsing a rail or dragging it narrower — which is exactly what was asked for. The `clamp()` reads the live `100%` and self-corrects for rail drags the ladder cannot see.
