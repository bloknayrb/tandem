# Visual Baseline Procedure

Phase 0i of the design-system-impl umbrella. The capture script lives at `scripts/design-baselines/capture.spec.ts`; baselines land in `docs/design-system-impl/preview/baselines/`.

## What this is

A **visual reference library** for the eight cross-cutting surfaces of Tandem, captured into a single self-contained HTML gallery (`baselines.html`, markup + inlined CSS). Each surface × theme is embedded in an `<iframe srcdoc>` so its inlined `<html data-theme>` + stylesheet stay isolated. Opens in OpenDesign and any browser without the dev server.

The role is reference + drift detection at PR review time, **not** automated CI assertion. When a sub-PR re-skins a surface, the gallery regenerates and OpenDesign renders the visual change for review.

One file rather than 16 because OpenDesign flattens every file under `docs/design-system-impl/` into one list — a single artifact keeps that view clean. The tradeoff: the per-surface git diff is gone (the combined file is ~12MB and not hand-diffable), so visual review happens in OD, not the diff.

## Why HTML, not PNG

Previous iteration of this gate used Playwright `toHaveScreenshot()` pixel diffs. HTML is strictly better for this use case:

- **OS-portable.** PNGs differ between Windows / macOS / Linux because of font rendering, anti-aliasing, sub-pixel layout. HTML renders consistently. No platform gates or CI-only seeding needed.
- **Viewable in OpenDesign.** OD watches `docs/design-system-impl/`. HTML files render there directly; PNG files are just images.
- **Inspectable markup.** The captured markup + classes live in the file, so a regression can be traced to a class added / testid renamed / attribute changed. (The combined gallery isn't cleanly git-diffable, so primary review is visual in OD — but the markup is still there to inspect.)
- **Self-contained.** Inlined CSS means the file is portable — share via OD, drop in a Slack message, archive, whatever.
- **No CI cost.** The capture spec is on-demand only; routine CI doesn't run it.

## Scope (8 surfaces × 2 themes = 16 scenes in one file)

Eight cross-cutting / shared-recipe surfaces. The plan called for ~30 surfaces × 2 viewports = ~120 captures; that's too much maintenance for the signal value. Most surfaces consume shared recipes (floating-pill, card chrome, modal frame), so covering the recipes covers their consumers.

1. **TitleBar** — type, color, chrome density expectations.
2. **Editor body** — typography + authorship gutter + decoration colors.
3. **SidePanel (annotations tab)** — rail chrome + filter bar + card list.
4. **AnnotationCard (CommentCard)** — card chrome recipe.
5. **FormattingBar** — floating-pill recipe.
6. **CommandPalette** — exercises the floating-pill recipe in a different surface.
7. **SettingsModal** — modal frame recipe.
8. **ToastContainer** — status color tokens + transient animation surface.

## How to capture

From the repo root:

```
npm run capture:design-baselines
```

The command spawns the dev server, runs the capture spec, and writes a single `baselines.html` to `docs/design-system-impl/preview/baselines/`. Takes a couple of minutes.

After capture:
- Open `baselines.html` in OpenDesign (auto-detected) or directly in any browser.
- The left surface picker jumps between surfaces; the Both/Light/Dark filter narrows themes.

## Sub-PR ritual

When a sub-PR re-skins a surface covered by this set:

1. After implementing the change, run `npm run capture:design-baselines`.
2. `git status` shows `baselines.html` changed.
3. Open `baselines.html` in OD and confirm the re-skinned surface matches intent (and that cross-cutting surfaces consuming the same recipe didn't drift unexpectedly).
4. PR description lists which surfaces changed and why.
5. Commit the regenerated `baselines.html`.

If a sub-PR doesn't touch any of the 8 surfaces, no baseline regeneration needed.

## What the captured HTML contains

- Full page body markup at the moment of capture.
- All inlined CSS reachable from the page (own-origin stylesheets).
- A banner at the top naming which surface the baseline focuses on (the page captures full context; the banner tells you what to look at).
- `data-theme` attribute on `<html>` so the file renders in the correct theme when opened.

What it does NOT contain:
- Runtime-only framework IDs (radix-*, headlessui-*) — stripped to avoid spurious diffs.
- The live dev server — files are self-contained.
- Annotation UUIDs are kept (the seed produces stable IDs across runs).

## Non-determinism handling

The capture is mostly deterministic because:
- The seed always opens the same `sample/welcome.md` content.
- The same three annotations are created at the same offsets with the same text.
- Annotation IDs depend on insertion order, which is stable.
- Timestamps render as "just now" / "3m ago" — these may drift between runs (the timestamp text DOES change between captures taken hours apart). Treat these as expected diff noise; focus reviewer attention on structural changes.

If a baseline shows changed timestamps but no other structural change, it's not a real drift signal — don't bother committing.

## When this work retires

The capture script and committed `baselines.html` stay in master after the umbrella merges, as an ongoing visual reference. Sub-PRs touching any of the 8 surfaces refresh the gallery as a discipline.

The Phase 0 procedure docs (this file, derived-spec.md, conflicts-resolved.md) stay in `docs/design-system-impl/` as historical record of the umbrella's design decisions.
