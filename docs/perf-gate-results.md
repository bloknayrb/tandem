# Performance gate — recorded runs

The v1.0 performance gate (see [roadmap.md](roadmap.md) §"Performance gate") is
a measurement, not a boolean, so its output is recorded here rather than inline
in the roadmap the way the security gate's one-line verdict is. Numbers only
mean something compared against other numbers, and that needs a table.

Run it with `npm run perf:gate` (builds first, then measures a production
build). Close any running Tandem before starting: the server calls `freePort()`
on every start, so the harness will take ports 3478/3479 from whatever holds
them.

---

## Harness configuration (from run 2 onward)

A number from this gate is only readable against the premises that produced it,
and several of those premises are not defaults. Recorded here so a future
comparison knows what changed:

| Premise | Value | Where it is set |
|---|---|---|
| Margin view | **forced ON** (default is off) | seeded into `tandem:settings` by the spec |
| Right rail tab | **Annotations**, seeded explicitly as `primaryTab` — see below | seeded into `tandem:settings` by the spec |
| Right rail | shipped default, 300px (`PANEL_DEFAULT_WIDTH`) | not overridden |
| Viewport | **1600 × 900** | `use.viewport` in `tests/perf/playwright.config.ts` |
| Annotation load | `DEFAULT_ANNOTATIONS` = **50** pending comments: 49 seeded + 1 measured | `scripts/fixtures/make-perf-doc.mjs`, pinned by `EXPECTED_ANNOTATION_COUNT` in the spec |
| Measured accept surface | the **side-panel rail** button (not the margin bubble) | `tests/perf/performance.spec.ts` |
| Scroll cadence | continuous, **60px per rAF frame**, top to bottom | `measureScroll` |
| App-data | wiped at **server start** | `tests/perf/perf-server.mjs` |
| Spec timeout | 420s | `tests/perf/playwright.config.ts` |

The viewport is pinned because margin mode is width-derived: below
`t1 = 2·272 + railsWidth + 480` (1324px with the default rail) the margins
render `narrow` → `clamped` cards, which have no action row at all. Margin view
is forced on because it is opt-in and off by default — see run 1 for what
happens otherwise.

`primaryTab` is seeded explicitly and is **not** redundant with the shipped
default. A hand-written settings blob does not inherit `DEFAULTS` for the keys
it omits: `loadSettings` clamps it field by field through
`normalizeKnownFields`, and `primaryTab`'s absent-key branch reads a missing
key as `"chat"`, the opposite of `DEFAULTS.primaryTab`. (No user is affected:
`updateSettings` persists the full merged object, and a first run with no blob
at all returns `DEFAULTS` (with `reduceMotion` resolved) without entering the validator. Only a partial blob
like the spec's hits it.) Left unset, the rail opens on Chat, the Annotations panel is
`display: none` — `PanelSlot` toggles with CSS, so its cards stay in the DOM at
zero size — and every rail-scoped measurement below fails against an element
that is present and correct.

Condition 1 (open-to-interactive) is still measured with the margin column
**not** mounted, and cannot be otherwise: margin sides presence-collapse, so
with zero annotations in the freshly-opened document the column is absent from
the DOM regardless of the setting. The spec asserts that rather than assuming
it.

The premise that the margin *is* mounted for conditions 2–3 is asserted as
**attached, with a column at least 240px wide** — deliberately not
`toBeVisible`. The column element is a pure positioning context (`position:
absolute; top: 0`, with every bubble inside it absolutely positioned too), so
it has no in-flow content and its border box measures 243 × 0 even with a full
card stack rendering correctly beside it. Playwright reads an empty bounding
box as hidden, so `toBeVisible` on that element fails identically whether the
margin renders or not — a check that cannot pass is not a premise check. The
width bound is what carries the meaning: 240 is `MARGIN_TRACK_GEOMETRY.full`,
and `narrow` (160) or `stub` (28) would fail it, so the assertion pins the
width ladder at the rung the recorded numbers assume. Painted-ness is asserted
separately, on a margin *bubble*, which is a real 243 × 168 box.

---

## Run 1 — 2026-08-05 — SUPERSEDED: harness defects, numbers not valid

> **Do not read these numbers as current.** Reviewing this PR found four
> defects in the harness that produced them. They are kept because two
> observations survive — #1288 is real, and it happened under conditions worth
> knowing — but every figure below was measured by an instrument that has since
> changed.
>
> 1. **Margin view was off.** The whole annotation load exists to exercise the
>    margin pipeline, and the margin pipeline never mounted: `marginView`
>    defaults to `false` and the spec never turned it on. The 50 comments
>    rendered as side-panel rows only. This invalidates the *attribution* of
>    every number, most sharply the 7851ms time-to-clickable.
> 2. **App-data was wiped too late.** Playwright starts its `webServer`s before
>    it runs `globalSetup`, so the wipe landed under a server that had already
>    restored the previous run's session. A second consecutive run did not start
>    from 50 annotations.
> 3. **The interactivity probe was vacuous.** It typed `"x"` and asserted the
>    editor contained `"x"` — into a fixture containing 418 of them. The
>    assertion passed before the keystroke arrived, so `open-to-interactive`
>    excluded the round-trip it claimed to include.
> 4. **The seed count was unverifiable.** `mcpError` returns `{error: true}`
>    without setting `isError`, and the test client only throws on `isError`, so
>    a failed `tandem_comment` incremented the success counter. The "50/50
>    anchored" row below is not something this run established.

| | |
|---|---|
| Commit | `653367f` + harness fixes (branch `feat/v10-performance-gate`) |
| Machine | Windows 11 Pro 26200, developer workstation |
| Build | production (`vite build` + `tsup`), served via `vite preview` |
| Fixture seed | `20260805` — 22,608 words, ~50.2 pages, 38 sections |
| Annotation load | 50 requested; ≥45 rendered (the render poll's floor). Exact anchored count **unverified** — seeding swallowed MCP error envelopes |
| Margin pipeline | **not mounted** (`marginView` default off) |

| Condition | Threshold | Measured | Verdict |
|---|---|---|---|
| open-to-interactive | < 3000ms | **882ms** | PASS |
| annotation create | < 500ms | **159ms** | PASS |
| annotation accept — *reflect after dispatch* | < 500ms | **379ms** | PASS |
| annotation accept — *total, including time-to-clickable* | < 500ms | **8230ms** | **FAIL** |
| worst frame gap during full scroll | < 100ms | **21.8ms** (973 frames) | PASS |

Long tasks ≥50ms during the scroll: **0**. Note that a clean long-task reading
does not by itself clear the frame condition — it cannot see compositor or
raster stalls. The 21.8ms worst rAF gap is what clears it, and that is the
ground-truth signal.

Open-to-interactive was sampled eight times: 563/600/610/823/845/882/957/1064ms
— a range of 563–1064ms, a factor of 1.9. That is a spread, not a stable
figure, and the 882ms in the table is one draw from it. (It was previously
described here as "stable across seven runs" and "representative"; there are
eight values and they are not tightly clustered.) All eight also predate fix 3
above, so none of them include the keystroke round-trip.

### The accept result needs its split read, not its total

The single number 8230ms hides the actual shape, which the harness reports
separately:

```
accept breakdown: click-dispatch 7851ms, post-click settle 379ms
```

The accept *operation* is fast. What takes ~7.9 seconds is the accept button
becoming **actionable** — Playwright waits for an element to be visible,
stable and hit-testable before dispatching, and under a 50-annotation load that
wait runs to nearly eight seconds.

**Read that as: with the margin pipeline NOT mounted.** The button that took
almost eight seconds to become hit-testable was the side-panel rail card, under
50 annotations rendered as list rows. That makes #1288 *more* surprising, not
less — the subsystem everyone would reach for first was not running. Anyone
profiling `resolveCrowding` on the strength of this number is profiling code
that did not execute.

This was verified not to be instrumentation:

- Switching `expect.poll` (which backs off 100/250/500/1000ms) for a
  tight-cadence `toHaveCount` changed the total by ~1% (8018 → 7943ms), so
  polling granularity is not the cause.
- Force-clicking (`click({ force: true })`, which skips the actionability wait)
  dispatches instantly — and the accept then **never takes effect at all**. The
  button is genuinely not hit-testable during that window; the wait is not
  Playwright being conservative.

Filed as an issue. Recorded here as a **FAIL of the gate's intent** even though
the criterion's literal words ("reflects in the editor < 500ms") are satisfied
by the 379ms figure: a control a user cannot click for eight seconds is the
problem the criterion exists to catch, and reading the pass out of the split
would be exactly the "relax the numbers" move the roadmap forbids.

## What this run does NOT establish

The gate's pass conditions are scoped to "the smoke-checklist machines" — §1–§3
of [release-smoke-checklist.md](release-smoke-checklist.md), i.e. **Windows,
macOS and Linux**. This run covers Windows only.

Following the same honesty pattern the install matrix uses for its partial
macOS evidence: this de-risks the Windows row and closes nothing else. macOS
and Linux are **unobserved**. The harness is portable and should run unchanged
on both when hardware exists.

It also does not establish anything about the **shipped engine**. The harness
drives headless Chromium against `vite preview`; the desktop app runs WebView2
(Windows), WKWebView (macOS) and WebKitGTK (Linux). Condition 3 is the
engine-sensitive one precisely because rAF-delta was chosen over `longtask` to
catch compositor and raster cost — the layer where those engines differ most.
So running this harness on a Mac would *not* close the macOS row of the smoke
checklist; it would characterise Chromium on a Mac.

---

## Run 2 — 2026-08-07 — Windows 11 workstation

| | |
|---|---|
| Commit | `13b0300` (master), measured from a worktree |
| Machine | Windows 11 Pro 26200, developer workstation — the same one run 1 used |
| Build | production (`vite build` + `tsup`), served via `vite preview` |
| Fixture seed | `20260805` — 22,608 words, ~50.2 pages, 38 sections |
| Annotation load | 50 pending comments: 49 seeded + 1 measured, all 50 verified anchored |
| Margin pipeline | **mounted** (`marginView` forced on, column asserted ≥240px / `full`) |

Three clean samples. No row is an average; each column is one run.

| Condition | Threshold | A | B | C | Verdict |
|---|---|---|---|---|---|
| open-to-interactive | < 3000ms | 1325ms | 1634ms | 1017ms | PASS |
| annotation create | < 500ms | 145ms | 130ms | 39ms | PASS |
| annotation accept — *click-dispatch* | — | 460ms | 534ms | 485ms | — |
| annotation accept — *post-click settle* | — | 419ms | 147ms | 396ms | — |
| annotation accept — **total** | < 500ms | **879ms** | **681ms** | **881ms** | **FAIL** |
| worst frame gap during full scroll | < 100ms | **2483ms** | **2550ms** | **317ms** | **FAIL** |

Condition 1 and the create half of condition 2 pass with room. The accept half
of condition 2 and condition 3 fail. Read each failure with the section it gets
below — they are unrelated, and only one of them is understood.

### #1288 does not reproduce, and its proposed mechanism is refuted

Run 1 recorded `click-dispatch 7851ms`, and #1288 was filed on that number. On
this harness, on the same workstation, the same measurement is **460–534ms in
every sample taken** — including one at a fifth of the annotation load. Run 1's
instrument no longer exists, and two of its four defects bear directly on this
figure: the margin pipeline never mounted, and the app-data wipe landed under an
already-restored server, so the load the 7851ms was measured against is not a
number anyone knows. Nothing in `src/client/` between the two runs plausibly
moves an eight-second wait. The honest reading is that 8s was an artifact of the
superseded harness, not a regression that has since been fixed.

The issue's suspected area — `marginPressure.resolveCrowding` and the margin
card stack — is refuted twice, on independent evidence:

1. **It does not scale with annotation count.** The issue asked for exactly this
   check. Measured in one browser session so machine state is held constant: at
   5 pending annotations the accept splits `click-dispatch 511ms / settle 394ms`,
   statistically the same as the 49-annotation reading beside it. A cost that is
   flat from 5 to 49 is not the cost of simulating a card stack.
2. **It vanishes under `reduceMotion`, which `resolveCrowding` never reads.**
   Same spec, same load, one settings key changed:

   | | click-dispatch | settle | total |
   |---|---|---|---|
   | shipped default | 460–534ms | 147–419ms | 681–881ms — FAIL |
   | `reduceMotion: true` | **169ms** | **6ms** | **175ms** — PASS |

   The crowding pass has no motion input at all, so a flag that only disables
   transitions cannot change its cost. It changes this one by a factor of four.

   Note the limit of this experiment. `reduceMotion` is a GLOBAL kill switch: it
   zeroes every transition in `cardMotion.ts`, the `cardFlyToMargin` entrance on
   the margin bubble, the annotation ping, and every
   `@media (prefers-reduced-motion)` rule via the `tandem-reduce-motion` body
   class. That makes it conclusive against `resolveCrowding` — which it cannot
   reach — and conclusive that the remaining cost is motion. It does NOT
   apportion that cost among individual transitions. `AnnotationCard`'s
   `lifecycleMotion` prop is the narrower knob and was not used.

### What the accept measurement actually spends

The button is not blocked, starved, or overlaid. An in-page sampler run across
the click window — rAF gaps, `getBoundingClientRect` per frame,
`elementFromPoint` at the button's centre, mutation counts, long tasks — found
the page essentially at rest: **0 long tasks** and 3 DOM mutations over a 12s
idle window, worst rAF gap 17–33ms, the button's box moving twice by 1px.
Clicking after that idle costs **203ms**, against 460–534ms for the same click
issued immediately after the create. The difference is not contention; it is the
app still finishing its entrance.

Both halves are motion, and the card's own lifecycle transitions
(`src/client/panels/cardMotion.ts`, wired at `SidePanel.svelte`'s
`lifecycleMotion={true}`) are the leading candidate for each. Read the two
bullets below as candidates, not as findings — the durations fit, but only the
click half fits cleanly:

- **`cardEnter` (A4, `ENTER_MS = 260`)** runs on the freshly created card. It
  animates `height: 0 → h` under `overflow: clip`, plus a `translateY`, so for
  260ms the accept control inside it is neither stably positioned nor painted
  where a hit-test would find it. Playwright's actionability wait is measuring
  that entrance. This also explains run 1's `click({ force: true })` probe
  dispatching instantly and the accept then never taking effect: a forced click
  computes its point from a box that is still moving.
- **`cardExit` (A1, `EXIT_MS = 260`)** runs on accept. Motion off drops the
  settle from 147–419ms to **6ms**, so the settle is motion — but the specific
  attribution to `cardExit` is NOT established, and one of the three recorded
  samples contradicts it. The proposed mechanism is that Svelte keeps an
  outroing block's content mounted for the duration, so the accept control —
  whose disappearance is the spec's definition of "reflected" — survives the
  whole outro. That mechanism has a floor of `EXIT_MS = 260ms`, and sample B
  settled in **147ms**. A 260ms outro cannot produce a 147ms settle, so either
  the rail control is leaving before the outro finishes (the margin bubble
  carries no `out:` transition at all and drops its control on the status flip,
  and `toHaveCount` counts both surfaces) or the outro is not what is being
  waited on. Do not build on this bullet: it needs a `lifecycleMotion`-only
  toggle and a DOM-level observation of when each of the two controls actually
  unmounts. The click half is on firmer ground — 460–534ms minus the measured
  ~170–200ms floor lands on `ENTER_MS = 260` — but it is the same class of
  arithmetic-fit argument and deserves the same direct check.

What remains after both is ~170–200ms of fixed cost present even against a fully
settled page: selector resolution, scroll-into-view and actionability
round-trips over CDP. That is the floor this harness can measure, not app cost.

**This is therefore a scoping question, not an optimization target.** The
`reduceMotion` delta puts ~510–710ms of the total in deliberate #798 motion —
that figure comes straight from the measurement and does not depend on which
transitions above turn out to be the ones — and no human experiences it
as an eight-second wait — they experience a card that animates in over a quarter
of a second. There are three ways out and none of them should be chosen by
whoever is holding the profiler: measure the annotation's status flip rather
than the control's disappearance (drops the outro, keeps the intro honest);
state the threshold as covering motion and raise it; or decide the motion on
this path costs more than it is worth. The first two are gate-wording changes
and belong to the roadmap; the third is a design decision.

### Condition 3 fails on Windows and is NOT characterised

Worst frame gap during the scripted scroll: **2483 / 2550 / 317ms** across the
three samples, with a further 66.6ms and 250.0ms from two instrumented runs. The
worst long task in each run tracks the worst gap almost exactly (2470 / 2535 /
305ms), so this is main-thread script — not compositor, not raster.

Two things are worth saying and nothing more:

- It is **not stable**. The spread is a factor of 38 across five runs on one
  machine, and the two worst readings came from the two runs that immediately
  followed a build. Machine contention is not ruled out.
- The Linux container verification below measured 33ms on the same code. Either
  the platforms genuinely differ here, or one of the two environments is noise.
- These numbers are already **stale against the scroll path they measure**.
  Master gained ~950 lines of scroll-path code after `13b0300` — the proximity-
  faded scroll pill and its controller (`src/client/editor/scroll-pill*`,
  merged in #1323 on 2026-08-07), plus a wheel-handling fix and keyboard
  scrolling for read-only documents. Condition 3 is "worst frame gap during a
  scripted top-to-bottom scroll". Re-measure on current master BEFORE profiling;
  a mechanism derived from the numbers above would be derived from code that no
  longer runs the scroll.

Nobody should read a cause into these numbers yet. They need their own profile,
on a quiet machine, before an issue describes a mechanism.

### Harness verification — 2026-08-06, Linux container — NOT a recorded run

The fixed harness was exercised end to end on a headless Linux container to
confirm it produces every number rather than dying at a premise check. **These
figures are not run 2 and are not a baseline**: different machine, different
class of machine (a container, not a workstation), so they are comparable to
nothing in this document. They are recorded only because "the harness now runs"
is a claim that should carry its evidence, and because one of them is a FAIL
that a future run on the real hardware should expect to see again.

Two consecutive runs, same build:

| Condition | Threshold | Run A | Run B | Verdict |
|---|---|---|---|---|
| open-to-interactive | < 3000ms | 1147ms | 1027ms | PASS |
| annotation create | < 500ms | 93ms | 142ms | PASS |
| annotation accept (total) | < 500ms | **917ms** | **837ms** | **FAIL** |
| worst frame gap during full scroll | < 100ms | 33.4ms | 33.3ms | PASS |

Accept splits as `click-dispatch 531ms / settle 386ms` (A) and
`463ms / 374ms` (B) — 1324 frames of scroll, 0 long tasks ≥50ms, full 79,297px
travelled in both.

The accept failure is a real measurement, not a harness artifact, and the
thresholds were left alone. Note what has changed since run 1: with the margin
pipeline now actually mounted, time-to-clickable is ~0.5s rather than ~7.9s, so
this is not the same magnitude of defect #1288 recorded — but it is still over
budget, and now both halves of the split contribute. Whether it reproduces on
the Windows workstation is exactly what run 2 has to establish.
