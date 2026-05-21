# Visual Baseline Procedure

Phase 0i of the design-system-impl umbrella. The capture script lives at `scripts/design-baselines/capture.spec.ts`; baselines land in `docs/design-system-impl/preview/baselines/`.

## What this is

A **visual reference library** for the eight cross-cutting surfaces of Tandem, captured as self-contained HTML files (markup + inlined CSS). Each file opens in OpenDesign and any browser without needing the dev server.

The role is reference + drift detection at PR review time, **not** automated CI assertion. When a sub-PR re-skins a surface, the HTML for that surface regenerates, the git diff shows the markup/class change to reviewers, and OpenDesign renders the visual change for visual review.

## Why HTML, not PNG

Previous iteration of this gate used Playwright `toHaveScreenshot()` pixel diffs. HTML is strictly better for this use case:

- **OS-portable.** PNGs differ between Windows / macOS / Linux because of font rendering, anti-aliasing, sub-pixel layout. HTML renders consistently. No platform gates or CI-only seeding needed.
- **Viewable in OpenDesign.** OD watches `docs/design-system-impl/`. HTML files render there directly; PNG files are just images.
- **Human-readable diffs.** A git diff on HTML shows the class added, the testid renamed, the attribute changed — actionable feedback. A pixel diff is opaque ("12% of pixels differ" — where? why?).
- **Self-contained.** Inlined CSS means the file is portable — share via OD, drop in a Slack message, archive, whatever.
- **No CI cost.** The capture spec is on-demand only; routine CI doesn't run it.

## Scope (8 surfaces × 2 themes = 16 files)

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

The command spawns the dev server, runs the capture spec, and writes 16 HTML files to `docs/design-system-impl/preview/baselines/`. Takes a couple of minutes.

After capture:
- Open the files in OpenDesign (auto-detected) or directly in any browser.
- `git status` shows which baselines changed since last capture.
- `git diff` on any HTML file shows the markup/class change.

## Sub-PR ritual

When a sub-PR re-skins a surface covered by this set:

1. After implementing the change, run `npm run capture:design-baselines`.
2. `git status` will show updated HTML files for the surface (and possibly cross-cutting surfaces that consume the same recipe).
3. Commit ONLY the HTML files for surfaces the sub-PR intentionally touched. If unexpected files changed, that IS the drift signal — investigate before committing.
4. PR description lists which baselines updated and why.
5. Reviewer opens the updated HTML in OD to confirm the visual matches intent; the git diff confirms the markup/class change is minimal.

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

The capture script and committed baselines stay in master after the umbrella merges, as an ongoing visual reference. Sub-PRs touching any of the 8 surfaces refresh the relevant baseline as a discipline.

The Phase 0 procedure docs (this file, derived-spec.md, conflicts-resolved.md) stay in `docs/design-system-impl/` as historical record of the umbrella's design decisions.
