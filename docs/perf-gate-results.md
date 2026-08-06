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

Condition 1 (open-to-interactive) is still measured with the margin column
**not** mounted, and cannot be otherwise: margin sides presence-collapse, so
with zero annotations in the freshly-opened document the column is absent from
the DOM regardless of the setting. The spec asserts that rather than assuming
it.

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

## Run 2 — pending

The harness changed materially (see "Harness configuration" above), so run 1's
numbers are not a baseline and there is currently **no valid recorded run**.
The v1.0 performance gate therefore remains **open**.

Re-recording requires the same Windows 11 workstation run 1 used — comparing a
new machine against a superseded run would confound two changes at once. Until
that run exists, this document records a harness, not a result.
