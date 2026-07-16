# Visual Baseline Procedure

The capture script lives at `scripts/design-baselines/capture.spec.ts`. Running it writes a single self-contained HTML gallery to `docs/design-system-impl/preview/baselines/baselines.html`.

**That gallery is generated on demand and is not committed** (it's gitignored). Capture it when you want to look at something; let it go stale when you don't. See "Why it isn't committed" below — that changed in #1190, and the reasoning is recorded here so it doesn't get re-litigated.

## What this is

A **visual reference library** for Tandem's cross-cutting surfaces, captured into one self-contained HTML file (markup + inlined CSS). Each surface × theme is embedded in an `<iframe srcdoc>` so its inlined `<html data-theme>` + stylesheet stay isolated. Opens in any browser — no dev server, no network.

It is a **reference you generate when you have a question**, not a gate. The capture spec says so itself: no assertions, no regression detection. Nothing in CI depends on it.

## How to capture

From the repo root:

```
npm run capture:design-baselines
```

It spawns the dev server + Hocuspocus, drives Playwright through each surface in both themes, and writes `baselines.html` — several megabytes, a couple of minutes. Then open the file directly, or point OpenDesign at the directory.

The left surface picker jumps between surfaces; the Both/Light/Dark filter narrows themes.

## Scope (9 surfaces × 2 themes = 18 scenes)

Cross-cutting / shared-recipe surfaces. The original plan called for ~30 surfaces × 2 viewports; that was too much maintenance for the signal. Most surfaces consume shared recipes (floating-pill, card chrome, modal frame), so covering the recipes covers their consumers.

Listed in capture order (`capture.spec.ts`):

1. **title-bar** — type, color, chrome density expectations.
2. **editor-body** — typography + authorship gutter + decoration colors.
3. **outline-panel** — left-rail chrome.
4. **side-panel-annotations** — right-rail chrome + filter bar + card list.
5. **annotation-card-comment** — card chrome recipe.
6. **formatting-bar** — floating-pill recipe.
7. **command-palette** — the floating-pill recipe in a different surface.
8. **settings-modal** — modal frame recipe.
9. **toast-container** — status color tokens + transient animation surface. This one self-skips if the toast doesn't render in time, so a capture can legitimately produce 17 scenes rather than 18.

## Why HTML, not PNG

The iteration before this one used Playwright `toHaveScreenshot()` pixel diffs. HTML is better here:

- **OS-portable.** PNGs differ across Windows / macOS / Linux (font rendering, anti-aliasing, sub-pixel layout). No platform gates or CI-only seeding needed.
- **Inspectable markup.** The captured markup + classes live in the file, so an oddity can be traced to a class added / testid renamed / attribute changed.
- **Self-contained.** Inlined CSS makes it portable — open it, share it, archive it.
- **No CI cost.** On-demand only.

## Why it isn't committed (#1190)

It was committed, from the umbrella's merge (v0.13.5, 2026-05-29) until #1190. The rule was a ritual: *any sub-PR touching a covered surface regenerates the gallery and commits it.*

**The ritual ran zero times.** Between the last capture and its removal, ~33 commits touched the nine covered surfaces and not one regenerated the file. By the end it contradicted master in 32 places — it still showed a `backdrop-filter` that #1189 had removed. Seven weeks stale, and nothing anywhere reported that.

How far it drifted is easiest to see by size: the committed file was 3.1 MB; a capture from the same script the day it was removed produced 4.8 MB. The surfaces changed a lot. The gallery just didn't notice.

Three things made the ritual unkeepable, and they'd all come back if it were reinstated:

- **The output is non-deterministic.** Both `capture.spec.ts` and `combine.ts` embed `new Date()` at capture time, so *every* regeneration dirties a multi-megabyte file even when nothing visually changed. The signal-to-noise ratio of "the gallery changed" is zero.
- **It isn't diffable.** Megabytes of inlined CSS in one file. Review had to happen by eye, in a browser, on an artifact whose accuracy you'd have to independently verify first — at which point you're just looking at the app.
- **Nothing enforced it.** No CI job, no hook, no test. The contrast is sitting in this same directory: `testid-manifest.md` has an automated gate and is current. This file had none and rotted.

The counter-argument worth naming, because it looks strong: the stale gallery *did* produce a signal during #1189 — it disagreed with master about `backdrop-filter`. True, and it was correctly declined. But the disagreement was about **the gallery's own staleness**, not a product defect. Drift detection detecting its own drift is an argument for retiring it, not keeping it; it cost review cycles and produced this issue.

The other alternative — regenerate once, freeze it, relabel it "historical snapshot" — recreates exactly what #1190 was filed about: a file that reads authoritative while contradicting master a week later.

**The honest cost of removal:** you lose a double-click visual reference. Regenerating needs Playwright and two servers. That's the trade, and it's worth it: an unmaintained reference whose accuracy you must independently verify isn't a reference.

**What removal does not buy:** repo size. The three historical blobs are still in git history. This is about the working tree and the review surface, not bytes.

## Known caveat: the seed has drifted

`seedAnnotations()` hardcodes character offsets into `sample/welcome.md`, but `welcome.md` was rewritten in `1aa852a` (2026-05-31) — *after* the last commit of the gallery. A capture today still succeeds, but the demo annotations anchor to different text than the ones you'd see in the old committed gallery. Cosmetic for chrome review; fix the offsets if you ever need the annotation text itself to make sense.

## What the captured HTML contains

- Full page body markup at the moment of capture.
- All inlined CSS reachable from the page (own-origin stylesheets).
- A banner naming which surface the scene focuses on (the page captures full context; the banner tells you what to look at).
- `data-theme` on `<html>` so the file renders in the correct theme.

What it does NOT contain:

- Runtime-only framework IDs (radix-*, headlessui-*) — stripped.
- The live dev server — the file is self-contained.
- Annotation UUIDs are kept (the seed produces stable IDs across runs).

## Related

The Phase 0 procedure docs (this file, `derived-spec.md`, `conflicts-resolved.md`) stay in `docs/design-system-impl/` as the historical record of the umbrella's design decisions.
