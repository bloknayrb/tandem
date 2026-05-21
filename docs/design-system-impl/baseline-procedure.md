# Visual Snapshot Baseline Procedure

Phase 0i of the design-system-impl umbrella. The spec lives at `tests/e2e/design-system-impl-baseline.spec.ts`.

## What this gate catches

**Cross-surface unintended drift.** Each sub-PR intentionally regenerates baselines for the surface it touches — the value of the gate is firing when an unrelated surface also changed (e.g. PR 1.2 re-skins the toolbar and accidentally restyles the annotation card).

What it explicitly does NOT replace: visual review. A passing pixel diff means "no unintended drift since the last baseline." It says nothing about whether the new baseline is correct. Reviewers still look at the OD render (or the running app) to confirm intent.

## Scope rationale

Eight cross-cutting / shared-recipe surfaces, light + dark = **16 baselines total**. Not every surface in the plan.

The plan's "every surface (~30) × light/dark × two viewports = ~120 PNGs" mandate was sized for a hypothetical visual-only regression gate. In practice:
- Most surfaces consume shared recipes (the floating-pill, AnnotationCard chrome, modal frame). Covering the recipes covers their consumers.
- 120 PNGs is a maintenance tax that overwhelms the signal. Sub-PRs would routinely touch 5+ baselines and reviewer fatigue would normalize "yeah, update all of them."
- Narrow viewport coverage doubles fixture count and is better captured by the Phase 5 manual claude-in-chrome walkthrough (responsive behavior is structural, not pixel-perfect).

The eight surfaces:
1. **TitleBar** — sets type, color, and chrome density expectations for the rest of the app.
2. **Editor body** — typography + authorship gutter + decoration colors.
3. **SidePanel (annotations tab)** — rail chrome + filter bar + card list.
4. **AnnotationCard (CommentCard)** — covers the card chrome recipe; if Note/Suggestion/Imported drift independently from CommentCard, that surfaces in their respective sub-PRs.
5. **FormattingBar** — floating-pill recipe shared with command palette.
6. **CommandPalette** — exercises the same floating-pill recipe.
7. **SettingsModal** — modal frame recipe shared with help, file-open, integration wizard.
8. **ToastContainer** — status color tokens + transient animation surface.

## Linux-only

Playwright's `toHaveScreenshot()` is sensitive to font rendering, anti-aliasing, and sub-pixel layout. These differ between Windows/macOS/Linux. CI is `ubuntu-latest`; baselines are generated and asserted only on Linux. Local Windows/macOS dev runs auto-skip the spec.

If you want to run it locally on Linux: spec runs as part of `npm run test:e2e`. To regenerate baselines locally on Linux: `npx playwright test design-system-impl-baseline.spec.ts --update-snapshots`.

## Seeding baselines from CI

Baselines must be generated from the same OS image that runs the assertions. The repo does NOT ship pre-built PNG baselines from any contributor's local machine.

To seed baselines on a fresh umbrella branch (one-shot):

1. Push the spec to the umbrella branch (or its descendant). CI runs `npm run test:e2e`; the baseline spec fails because no PNGs exist yet. The `playwright-report` artifact contains the "actual" PNGs from the failing run.
2. Trigger the `seed-design-baselines` workflow_dispatch job (`.github/workflows/seed-design-baselines.yml`). The job re-runs ONLY this spec with `--update-snapshots`, commits the generated PNGs back to the branch, and pushes.
3. From that point on, sub-PRs that intentionally update a surface regenerate its baseline locally (Linux, Docker, or a fresh CI run) and commit the new PNG.

The seeding workflow is a one-time setup — not a routine maintenance tool. Sub-PRs update baselines surface-by-surface, not by re-running the seed.

## Sub-PR baseline updates

When a sub-PR intentionally re-skins a surface covered by this spec:

1. Run the spec on Linux with `--update-snapshots`:
   ```
   npx playwright test design-system-impl-baseline.spec.ts -g "surface-name" --update-snapshots
   ```
2. Commit ONLY the PNGs for the surfaces the sub-PR actually touched. If the diff includes unexpected PNGs (a surface the sub-PR didn't intend to touch), that IS the drift signal — investigate, don't blindly commit.
3. The PR description's verification section explicitly lists which baselines were updated and why.

## Excluding the spec from a CI run

If the baseline spec is blocking unrelated CI work (e.g. a hotfix PR that legitimately doesn't need to touch the design system), use Playwright's grep-invert:

```
npm run test:e2e -- --grep-invert "design-system-impl-baseline"
```

This should be an exception, not a norm. The default is "always run."

## When this gate is retired

The spec ships with the umbrella branch. When the umbrella merges to master:
- Keep the spec in master as ongoing protection against design regression on the merged-in surfaces.
- The seeding workflow can be removed (or kept as a tool for future redesigns).
- Phase 0 docs (this file, derived-spec.md, conflicts-resolved.md) stay in `docs/design-system-impl/` as historical record of the umbrella's design decisions.
