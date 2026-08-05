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

## Run 1 — 2026-08-05

| | |
|---|---|
| Commit | `653367f` + harness fixes (branch `feat/v10-performance-gate`) |
| Machine | Windows 11 Pro 26200, developer workstation |
| Build | production (`vite build` + `tsup`), served via `vite preview` |
| Fixture seed | `20260805` — 22,608 words, ~50.2 pages, 38 sections |
| Annotation load | 50 seeded, 50/50 anchored |

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

Open-to-interactive was stable across seven runs (563/600/610/823/845/882/957/
1064ms), so the ~900ms figure is representative rather than a lucky sample.

### The accept result needs its split read, not its total

The single number 8230ms hides the actual shape, which the harness reports
separately:

```
accept breakdown: click-dispatch 7851ms, post-click settle 379ms
```

The accept *operation* is fast. What takes ~7.9 seconds is the accept button
becoming **actionable** — Playwright waits for an element to be visible,
stable and hit-testable before dispatching, and under a 50-annotation margin
load that wait runs to nearly eight seconds.

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
