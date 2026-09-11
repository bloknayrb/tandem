# K-tests — #1734 The #1334 perf decision (exit 1) was never implemented

Branch `fix/test-suite-integrity-silent-greens-fragile-assertions-and-an-unimplemented-perf-decision-1861`.
Closes #1734. Ledger: `docs/plans/2026-09-06-open-issues-sweep.md:459`. Probe:
`npx playwright test tests/perf/performance.spec.ts -g "annotation lifecycle"` (or `npm run
perf:gate`) before and after, on the reserved E2E ports (`e2e=true` for this group) — record both
numbers in the PR body regardless of outcome.

## Problem

#1334 (closed, decision recorded 2026-08-09) measured that `annotation-accept`'s ~520ms mostly
came from waiting for the accept BUTTON to leave the DOM, which only happens after the resolved
card finishes its #798 entrance/settle motion (`cardMotion.ts`, `ENTER_MS = 260`) — i.e. the gate
was measuring an animation duration against a latency budget. The decision, quoted verbatim:

> Re-point the probe's wait condition at the annotation's accepted state (status attribute / text)
> instead of the accept button's detachment. Keep the 500 ms budget. Re-record the baseline.

`tests/perf/performance.spec.ts:470-477` still does exactly what was rejected:

```ts
await expect(page.getByTestId(`accept-btn-${annotationId}`)).toHaveCount(0, { timeout: 30_000 });
const acceptMs = Date.now() - acceptStart;
...
report("annotation-accept", acceptMs, THRESHOLD_ANNOTATION_MS);
```

`npm run perf:gate` on `origin/master` reads `annotation-accept: 773ms (threshold 500ms) [FAIL]`,
unchanged since #1734 was filed — the redness carries no information, because it is the known,
accepted-as-motion cost the decision exists to stop measuring, not a new regression.

## Fix

Re-point the wait condition, and ONLY the wait condition — #1334 decided nothing about the
click-dispatch half (the time from click to Playwright's actionability check succeeding), and this
issue is scoped to "the motion #1334 decided to stop measuring," which is specifically the
post-click "reflected" wait. `AnnotationCardHeader.svelte:116-122` already renders the signal
#1334 asked for, with no new selector needed:

```svelte
{#if !isPending}
  <span class="ach-status" class:is-accepted={annotation.status === "accepted"} ...>
    {annotation.status}
  </span>
{/if}
```

This is a plain conditional render — no `transition:`/`in:`/`out:` directive anywhere on it or its
`{#if}` block (checked: `grep -n "transition:\|in:\|out:\|animate:"
src/client/panels/AnnotationCardHeader.svelte` finds nothing) — so it reflects `annotation.status`
flipping as soon as the CRDT write lands, decoupled from the card's own entrance/exit motion. No
`src/client/` edit needed to get there — this group owns no `src/` behaviour, and none is required:
the class already exists and ships today.

`tests/perf/performance.spec.ts:453-477`, replace the settle wait and its stale comment (which
currently argues FOR the rejected shape — "the disappearance of the accept control ... counting the
accept control to zero ACROSS BOTH surfaces is still exactly 'the accept was reflected'"):

```ts
// Measure to the accept being REFLECTED. #1334 decided this is the annotation's
// status changing to "accepted", not the accept control's disappearance — the
// control only leaves once the resolved card finishes its #798 entrance motion,
// so the old wait measured an animation duration under a latency budget (#1734).
// `.ach-status` is a plain conditional render on `annotation.status` with no
// `transition:`/`in:`/`out:` of its own, so this reflects the write landing.
await expect(rail.locator(".ach-status.is-accepted")).toBeVisible({ timeout: 30_000 });
const acceptMs = Date.now() - acceptStart;
```

The click-half comment two paragraphs above (the RAIL-button rationale, `#1288`) is unchanged —
#1334 did not question it. Narrowing from BOTH surfaces (`page.getByTestId(...)`, matching rail +
margin) to the rail only (`rail.locator(...)`) is deliberate, mirroring the click measurement's
own already-established "measured on the RAIL button, deliberately" precedent two lines above it —
see "Not in scope" for why this does not reduce correctness coverage.

## Tests

The changed assertion IS the fix; there is no separate unit to add. The discriminating check is
the re-recorded baseline itself: run the probe before touching anything (773ms FAIL, matching
#1334's own measurement of ~520-880ms split roughly 450-535ms click-dispatch / 150-420ms settle),
apply the fix, run it again, and record whatever number comes back — a pass or a fail — in the PR
body. **Do not adjust the threshold or the fix to force a pass**: #1334's own decision text
rejects "raise the threshold" explicitly ("a threshold that cannot fail for the reason it exists is
not a threshold"), and the point of implementing exit 1 is that the gate becomes able to say
something true again, whichever way that number lands. If the re-recorded number still exceeds
500ms after this fix, that is new, real information the redefined gate can now report for the
first time (the old one couldn't, being permanently saturated by the removed motion) — file a
fresh issue for it rather than folding a second, unrelated fix into this one.

## Done when

`.ach-status.is-accepted` visibility replaces the accept-button-count-zero wait; the stale comment
arguing for the old shape is rewritten; `npm run perf:gate` (or the targeted Playwright run) is
executed and its output — pass or fail — is in the PR body alongside the pre-fix `773ms FAIL` for
comparison; `npm run typecheck` green (the `.spec.ts` change is plain TS, no new imports needed
beyond what `rail`/`page` already provide in scope).

## Not in scope

Cutting or shortening the #798 card motion (explicitly rejected as exit 3 in #1334's decision, "a
design decision, not a perf one"). Raising `THRESHOLD_ANNOTATION_MS` (explicitly rejected as exit
2). The click-dispatch half of the measurement (`clickMs`) and its own possible residual motion
coupling from the CREATE step's entrance animation — #1334's decision text is scoped to the
post-click "reflected" wait only; if the click-dispatch half is itself still materially
motion-coupled after this fix, that is a separate finding, not silently rolled into this PR. The
`perf:gate` CI-runner question ("`perf:gate` has no CI runner (may extend #1333/#1734)", #1825's
Tests bullet) — deliberately deferred, see the K-tests-1825 spec for the reasoning (adding a CI
gate is out of the smallest-change budget this issue asks for, and ADR-051 requires a wiring test
inside `check` for any new gate to be real rather than decorative — a nontrivial addition #1734's
own body never requests). Measuring on the margin-column surface instead of / in addition to the
rail — the click half already established rail-only measurement as this gate's convention; a
margin-side accept regression is a correctness concern for E2E specs, not this perf gate.
