# Performance Baseline Procedure

Phase 0j of the design-system-impl umbrella. **This is a methodology doc, not a numbers doc.**

## Why not commit numbers in Phase 0

Performance measurements drift across machines, OS versions, Chrome versions, background load, and even time-of-day on a single machine. A number committed now from a single contributor's Windows laptop is not a useful comparison point for Phase 5 numbers from a different machine, a different OS, or a different Chrome version. Worse, it gives a false sense of rigor — "we have a baseline" — when the comparison is unreliable.

The Phase 5 gate works as long as **before-and-after numbers come from the same machine in the same session**. Phase 0 commits the procedure; Phase 5 runs it twice.

## Scenarios

These are the four scenarios the Phase 5 gate evaluates:

1. **Cold start** — kill all `node` processes; spawn `tandem` or launch the Tauri app; first paint to interactive editor.
2. **First document open** — from a warm app state, `tandem_open` a stable test document (use `sample/welcome.md`); selection-to-render of editor content.
3. **Five-tab open** — from a warm app state with welcome.md already open, open four additional docs sequentially. Measure cumulative time + steady-state interaction latency on the last tab.
4. **Theme switch** — from a warm app with welcome.md open, toggle the theme. Measure time-to-stable-paint after the toggle.

## Metrics

For each scenario, record:

- **TTI (Time To Interactive)** — Lighthouse field if available, otherwise wall-clock from action trigger to first responsive UI event.
- **LCP (Largest Contentful Paint)** — Lighthouse, when applicable (cold start + first document open).
- **CLS (Cumulative Layout Shift)** — Lighthouse, when applicable.
- **Total Blocking Time** — Lighthouse.
- **Wall-clock duration** for the action itself (e.g. cold-start to interactive: total seconds).
- **DevTools paint count** (`Performance` panel → record → count `Paint` events under the recorded window).
- **DevTools composite count** (same panel → count `Composite Layers` events).

## Tooling

- **Lighthouse**: Chrome DevTools → Lighthouse tab → "Performance" category, "Desktop" form factor. Run three times per scenario, take the median.
- **DevTools Performance panel**: paint + composite counts captured by recording the scenario window and using the Bottom-Up summary filtered by "Painting" / "Compositing" categories.
- **Wall-clock**: stopwatch or `performance.now()` instrumented at the trigger event.

If the Tauri WebView is the measurement target instead of the browser dev server, use the WebView's DevTools (Tauri exposes them in dev builds via `Ctrl+Shift+I`). Tauri WebView is Chromium-based but not identical to Chrome — keep the measurement source consistent between baseline and re-run.

## Regression gate

Phase 5 step 9 fails the umbrella → master merge if any metric regresses by more than **10%** compared to the baseline measurements taken at the start of Phase 5.

Critically: the baseline + re-run must be from the SAME machine, SAME chrome version, SAME OS. The "before" is taken on the umbrella branch's start commit; the "after" is taken on the umbrella's HEAD just before merge. Do not compare against numbers from any other context.

If a regression is real and unavoidable (e.g. a design recipe inherently costs paint cycles), it must be explicitly justified in the umbrella PR body with the tradeoff stated.

## Recording the numbers

When Phase 5 runs the comparison, append a results table to this document under a `## Phase 5 results — <date>` section. Format:

| Scenario | Metric | Baseline | Re-run | Δ% | Notes |
|---|---|---:|---:|---:|---|
| Cold start | TTI | 1.8s | 1.9s | +5.5% | within budget |
| Cold start | LCP | 0.6s | 0.6s | 0.0% | |
| Cold start | Paint count | 14 | 17 | +21% | **regression — investigate** |
| … | | | | | |

Numbers stay in the repo as historical record. Future umbrella efforts can compare against the prior umbrella's "after" as a long-term trend signal even though absolute comparison is unreliable.

## Out of scope

- **Bundle size** is covered by existing CI (build output is reported in `npm run build`). The umbrella's typography/font changes WILL increase bundle size; Phase 0c's token-audit doc tracks token additions. If bundle size grows by more than 10% over the umbrella, address in a per-phase gate, not at Phase 5.
- **Memory** is not gated. Document any obvious memory regressions Phase 5 surfaces in the same results table but don't block merge on it.
- **Network** is not gated — Tandem is local-first; no remote dependencies that would surface in network metrics.
