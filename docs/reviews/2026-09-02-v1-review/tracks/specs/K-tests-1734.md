# K-tests — #1734 The #1334 perf decision (exit 1) was never implemented

Branch `fix/test-suite-integrity-silent-greens-fragile-assertions-and-an-unimplemented-perf-decision-1861`.
**Refs #1734 for now.** Moves to `## Closes` only if the actual probe run needs no follow-up issue
(a residual over-budget number, or residual click-dispatch motion coupling, would each need one —
build the PR's `## Closes` list last, after running the probe). Ledger:
`docs/plans/2026-09-06-open-issues-sweep.md:459`. Probe:
`npx playwright test tests/perf/performance.spec.ts -g "annotation lifecycle"` (or `npm run
perf:gate`) before and after, on the reserved E2E ports — record both numbers in the PR body.

## Problem

#1334 (closed, decided 2026-08-09) found `annotation-accept`'s ~520-880ms was mostly the resolved
card's own #798 exit/settle motion (`cardMotion.ts`, `EXIT_MS = 260`), not real accept latency, and
decided: *"Re-point the probe's wait condition at the annotation's accepted state instead of the
accept button's detachment. Keep the 500ms budget."* `tests/perf/performance.spec.ts:470-477` still
waits on the accept button reaching count 0 — unchanged since #1334, still measuring the rejected
signal. `npm run perf:gate` on `origin/master` reads `annotation-accept: 773ms [FAIL]`, carrying no
new information.

## Fix

`AnnotationCardHeader.svelte:118-123` already renders the signal #1334 asked for — a plain
conditional `.ach-status.is-accepted` span, no `transition:`/`in:`/`out:` of its own — but it
renders only `{#if !isPending}`, and the only rail surface for a non-pending card is
`SidePanel.svelte:867-884`'s resolved list, wrapped in a `<details>` with **no `open` attribute**.
A closed `<details>`'s children have no layout box, so `toBeVisible()` would time out at 30s every
run. Use an attachment check instead, scoped to this annotation (an unscoped locator can resolve
against a resolved card left behind by a prior test):

```ts
// Measure to the accept being REFLECTED — #1334's decision. `.ach-status` is a
// plain conditional render with no transition of its own, so its ATTACHMENT
// reflects the CRDT write landing. Not asserted VISIBLE: the resolved card
// renders inside SidePanel's collapsed <details> (no `open`), so it has no
// layout box.
await expect(
  rail.locator(`[data-testid="annotation-card-${annotationId}"] .ach-status.is-accepted`),
).toHaveCount(1, { timeout: 30_000 });
const acceptMs = Date.now() - acceptStart;
report("annotation-accept", acceptMs, THRESHOLD_ANNOTATION_MS);
// Retained: the accept control must still leave the DOM on both surfaces,
// independent of the timing measurement above.
await expect(page.getByTestId(`accept-btn-${annotationId}`)).toHaveCount(0, { timeout: 30_000 });
```

The existing accept-button count-zero assertion (`:470-472`) is **kept**, moved below the timing
read — it is the only check that the control leaves both the rail and margin surfaces (partner of
the double-count pin at `:436-443`); dropping it would leave the spec unable to catch a future
change that silently keeps the button mounted. Rewrite the stale comment at `:453-469` that
currently argues for the rejected shape. The click-dispatch half (`clickMs`, `#1288`) is unchanged
— #1334's decision is scoped to the post-click "reflected" wait only.

**Doc half:** `docs/perf-gate-results.md:279-281` defines "reflected" as the accept control's
disappearance — exactly what this fix removes. Update it in the same PR: restate "reflected" as the
rail card's status span attaching/flipping to `accepted`, mark the old rows (`:111-112`,
`:251-295`) as historical against the prior definition, and append the re-recorded number from this
fix's own run.

## Tests

The changed assertion is the fix. Run the probe before (773ms FAIL, matching #1334's own split)
and after; do not adjust the threshold to force a pass (#1334 explicitly rejected that). Confirm by
running the probe that the new wait resolves well under the 30s timeout — a reading at or near
30000ms means the wait is still wrong, not that accept is genuinely slow. If the re-recorded number
still exceeds 500ms after confirming the wait resolves promptly, that is new, real information the
redefined gate can report for the first time — file a fresh issue for it rather than folding a
second fix in here, and #1734 then stays `Refs`, not `Closes`.

## Done when

`.ach-status.is-accepted` attachment (annotation-scoped `toHaveCount(1)`) replaces the old wait; the
accept-button count-zero check is retained below it; the stale comment is rewritten;
`docs/perf-gate-results.md` is updated; the probe is run and its output (pass or fail) is in the PR
body alongside the pre-fix `773ms FAIL`; `npm run typecheck:tests` green (this is `tests/perf/**`,
reached only by `typecheck:tests`, not plain `typecheck`).

## Not in scope

Cutting the #798 card motion or raising `THRESHOLD_ANNOTATION_MS` (both explicitly rejected by
#1334). The click-dispatch half and any residual motion coupling there — a separate finding if
found. A `perf:gate` CI runner (`#1825`'s own bullet; a new CI gate needs an ADR-051 wiring test,
which is a materially larger addition than this issue asks for — left to `K-tests-1825.md`).
Measuring on the margin-column surface. Adding a `data-testid` to `.ach-status` — noted as a real
improvement but a `src/client` + snapshot change outside this fix's budget.

## Review corrections (scope cut)

- Kept the direct fixes (annotation-scoped `toHaveCount`, retained count-zero assertion, doc update,
  `Refs`-not-`Closes` header) — these resolve the blocking findings directly, not via new scanners
  or gates.
- Removed the multi-paragraph misattribution history (which prior draft measured the wrong element,
  the exact ~300ms breakdown) — the corrected fix above is what ships; the history isn't needed to
  justify it.
- Removed the extended "Not in scope" essay on `perf:gate`/ADR-051 reasoning in favor of one line
  pointing at `K-tests-1825.md`, which is where that decision actually lives.
- Removed the paragraph explaining the `.ach-status` CSS-class-vs-`data-testid` contract boundary in
  detail — kept as a one-line "not in scope" item; the risk it described doesn't require this spec
  to carry an essay about it.
