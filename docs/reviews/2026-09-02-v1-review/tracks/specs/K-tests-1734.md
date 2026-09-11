# K-tests — #1734 The #1334 perf decision (exit 1) was never implemented

Branch `fix/test-suite-integrity-silent-greens-fragile-assertions-and-an-unimplemented-perf-decision-1861`.
**Refs #1734 for now — moves to `## Closes` only if the re-recorded `perf:gate` number ends up
requiring no follow-up issue** (see "Tests" and "Not in scope": this spec still names two
possible deferrals against #1734 — a residual over-budget number, and residual click-dispatch
motion coupling — and the group's derived-`Closes` rule forbids `Closes` on an issue with named
remaining work or a carve-out. Build the PR's `## Closes` list LAST, after the actual run: if no
follow-up issue is filed, #1734 goes under `## Closes`; if one is, #1734 stays under
`## Refs (partial — issue stays open)` and the new issue is referenced there instead).
Ledger: `docs/plans/2026-09-06-open-issues-sweep.md:459`. Probe:
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

**Round-1 correction: `toBeVisible()` can never pass, and the pending-vs-resolved split matters.**
`.ach-status` is only rendered `{#if !isPending}` (`AnnotationCardHeader.svelte:116-123`), and the
only place the rail renders a non-pending card is `SidePanel.svelte:867-884`'s resolved list —
which is wrapped in a plain `<details style="margin-top: 12px;">` with no `open` attribute
(verified: `grep -n "details\|open="` on the file returns only the unrelated `open={filterBarOpen}`
for the filter bar). A closed `<details>`'s children have no layout box, so
`toBeVisible({ timeout: 30_000 })` times out at 30s every time, turning the gate into a hard
Playwright failure rather than a number. **The 300ms-ish settle the old wait measured is also
misattributed in the original draft of this fix**: `cardMotion.ts:20` states "Only the pending list
opts in; resolved/margin cards pass `false` → no-op" — so the motion the old wait was actually
waiting through is the OUTGOING pending card's own `cardExit` outro (`AnnotationCard.svelte:239-240`,
`EXIT_MS = 260`), not any entrance animation on a resolved card. **Second defect in the originally
proposed locator**: `rail.locator(".ach-status.is-accepted")` carries no `annotationId`, unlike
every other locator in this block (`:429`, `:441`, `:458`, `:470`) — the moment any other
annotation on the rail is non-pending (every prior test run leaves resolved annotations behind
within a spec file, and the seed step itself creates several), it resolves against a foreign card
and silently reports near-0ms instead of failing.

`tests/perf/performance.spec.ts:453-477`, replace the settle wait and its stale comment (which
currently argues FOR the rejected shape — "the disappearance of the accept control ... counting the
accept control to zero ACROSS BOTH surfaces is still exactly 'the accept was reflected'") with an
attachment check, scoped to this annotation, on the resolved-card's status span — visibility is not
obtainable (see above), so attachment is the signal:

```ts
// Measure to the accept being REFLECTED. #1334 decided this is the annotation's
// status changing to "accepted", not the accept control's disappearance — the
// control only leaves once the outgoing PENDING card finishes its own #798 exit
// motion (`cardExit`, EXIT_MS = 260 — NOT an entrance animation on a resolved
// card), so the old wait measured an animation duration under a latency budget
// (#1734). `.ach-status` is a plain conditional render on `annotation.status`
// with no `transition:`/`in:`/`out:` of its own, so its ATTACHMENT reflects the
// write landing. It cannot be asserted VISIBLE: the resolved card that carries
// it renders inside SidePanel's collapsed `<details>` (no `open` attribute), so
// a closed-details child has no layout box and `toBeVisible()` times out at 30s
// every time. Scoped to this annotation's own card — an unscoped selector would
// resolve against any other resolved card left on the rail by a prior test.
await expect(
  rail.locator(`[data-testid="annotation-card-${annotationId}"] .ach-status.is-accepted`),
).toHaveCount(1, { timeout: 30_000 });
const acceptMs = Date.now() - acceptStart;
```

**Keep the existing accept-control-count-zero assertion (`:470-472`), moved below the line above**
— it is the only check in this spec pinning that the accept control actually leaves BOTH surfaces
(rail and margin column), the partner of the deliberate double-count pin four lines above it
(`:436-443`, "it fails loudly if a future change silently drops one surface"). Deleting it, as the
original draft of this fix did, would leave the perf spec green even if the accept control never
left either surface — coverage the round-0 spec removed with no replacement. Move it below
`acceptMs`'s computation so it no longer contributes to the measured number but still fails if the
control persists:

```ts
await expect(
  rail.locator(`[data-testid="annotation-card-${annotationId}"] .ach-status.is-accepted`),
).toHaveCount(1, { timeout: 30_000 });
const acceptMs = Date.now() - acceptStart;
report("annotation-accept", acceptMs, THRESHOLD_ANNOTATION_MS);
// Retained from the pre-#1734 assertion: the accept control itself must still
// leave the DOM entirely (both rail and margin surfaces), independent of the
// timing measurement above — this is coverage, not part of the recorded number.
await expect(page.getByTestId(`accept-btn-${annotationId}`)).toHaveCount(0, { timeout: 30_000 });
```

`.ach-status` carries a CSS class, not a `data-testid` — it is outside the `data-testid` selector
contract CLAUDE.md's Critical Rule 7 pins via `tests/design-system-impl/__snapshots__/testid-set.snap.txt`.
State this explicitly in the PR body: a future rename of `.ach-status`/`is-accepted` will not be
caught by the testid snapshot and will silently convert this assertion into a 30s timeout (loud,
but untracked by the contract) rather than a clean failure. Adding a `data-testid` for this span is
a `src/client` change with a snapshot regeneration, out of the smallest-change budget for this fix
and not requested by #1734 — noted here rather than done.

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
something true again, whichever way that number lands. **Confirm by running the probe that the new
wait actually resolves in materially less than 30s** — do not accept a ~30000ms reading as "new,
real information"; a reading at or near the timeout means the wait condition itself is still wrong
(most likely the `<details>`/attachment issue above), not that the accept is genuinely slow. If the
re-recorded number still exceeds 500ms after confirming the wait resolves promptly, that is new,
real information the redefined gate can now report for the first time (the old one couldn't, being
permanently saturated by the removed motion) — **file a fresh issue for it** rather than folding a
second, unrelated fix into this one, and see the header note: filing that issue means #1734 goes
under `## Refs (partial — issue stays open)` in the PR, not `## Closes`.

## Done when

`.ach-status.is-accepted` attachment (scoped to the accepted annotation's own card, `toHaveCount(1)`
— not `toBeVisible()`, which can never pass against the collapsed `<details>` the resolved card
renders inside) replaces the accept-button-count-zero *timing* wait; the accept-button count-zero
assertion itself is RETAINED, moved below the timing read so it no longer contributes to the
measured number but still pins that the control leaves both surfaces; the stale comment arguing for
the old shape is rewritten; the probe is run and confirmed to resolve well under the 30s timeout
(not just "produced a number"); `npm run perf:gate` (or the targeted Playwright run) is executed
and its output — pass or fail — is in the PR body alongside the pre-fix `773ms FAIL` for
comparison; `docs/perf-gate-results.md` is updated (see below); `npm run typecheck:tests` green
(this is a `tests/perf/**` change — per CLAUDE.md, `tests/` is typechecked only by
`typecheck:tests`, not the plain `npm run typecheck` the original draft of this spec named).

**Doc half (round-1 addition — the group prompt named both the measurement and its doc/gate):**
`docs/perf-gate-results.md` currently defines "reflected" as exactly the accept-control's
disappearance this fix removes (`:279-281`: "the accept control — whose disappearance is the
spec's definition of 'reflected' — survives the whole outro") and records the measured surface and
rows under that old definition (`:28` measured-surface row; `:111-112` the two "annotation accept"
rows, "reflect after dispatch" / "total, including time-to-clickable"). After this fix the doc's
own stated definition contradicts the code it describes unless updated. Update it in the same PR:
restate the new definition of "reflected" (the rail card's own status span attaching/flipping to
`accepted`, not the accept control's disappearance), mark the superseded rows/section (`:111-112`,
`:251-295`) as historical against the OLD definition rather than deleting them, and append the
re-recorded number from this fix's own run.

## Not in scope

Cutting or shortening the #798 card motion (explicitly rejected as exit 3 in #1334's decision, "a
design decision, not a perf one"). Raising `THRESHOLD_ANNOTATION_MS` (explicitly rejected as exit
2). The click-dispatch half of the measurement (`clickMs`) and its own possible residual motion
coupling from the CREATE step's entrance animation — #1334's decision text is scoped to the
post-click "reflected" wait only; if the click-dispatch half is itself still materially
motion-coupled after this fix, that is a separate finding to file, not silently rolled into this
PR (and, per the header note, filing it is itself a reason #1734 stays `Refs` rather than
`Closes`). The `perf:gate` CI-runner question ("`perf:gate` has no CI runner (may extend
#1333/#1734)", #1825's Tests bullet) — deliberately deferred, see the K-tests-1825 spec for the
reasoning (adding a CI gate is out of the smallest-change budget this issue asks for, and ADR-051
requires a wiring test inside `check` for any new gate to be real rather than decorative — a
nontrivial addition #1734's own body never requests; #1825, not #1734, is the tracked home for
that deferral). Measuring on the margin-column surface instead of / in addition to the rail — the
click half already established rail-only measurement as this gate's convention; a margin-side
accept regression is a correctness concern for E2E specs, not this perf gate. Adding a
`data-testid` to `.ach-status` and regenerating the testid snapshot — a real improvement, but a
`src/client` change out of this fix's smallest-change budget; noted in the PR body instead.

## Review corrections (round 1)

**Adopted:**
- The proposed `toBeVisible()` wait could never pass: `.ach-status` renders only inside a
  `<details>` with no `open` attribute (`SidePanel.svelte:867-884`), so it has no layout box.
  Replaced with `toHaveCount(1)` on an annotation-scoped locator (also fixes an unscoped-locator
  defect: without `[data-testid="annotation-card-${annotationId}"]` the selector could resolve
  against any other resolved card left on the rail by a prior test). Corrected the misattribution
  of the old wait's ~300ms — it is the outgoing PENDING card's own `cardExit` outro, not any
  entrance animation on a resolved card.
- The accept-button count-zero assertion (`:470-472`) was going to be deleted outright with no
  replacement, silently removing the only check that the accept control leaves both surfaces.
  Retained, moved below the timing read so it no longer contributes to the measured number.
- `#1734` was `Closes` while the spec's own body named a conditional carve-out (a follow-up issue
  if the re-recorded number is still over budget) and a deferred concern (click-dispatch motion
  coupling). Changed header to `Refs #1734`, conditional on the actual run: it moves to `## Closes`
  only if no follow-up issue ends up filed.
- `docs/perf-gate-results.md` defines "reflected" as exactly the thing this fix removes and records
  measurements under that old definition; left untouched by the original draft. Added to the change
  set and to "Done when": restate the new definition, mark old rows historical, append the
  re-recorded number.
- "Done when" named `npm run typecheck` for a `tests/perf/**` change; per CLAUDE.md only
  `typecheck:tests` reaches `tests/`. Corrected.
- Noted explicitly that `.ach-status` is a CSS class, not a `data-testid`, and is therefore outside
  the testid snapshot contract — a future rename converts this assertion into an untracked 30s
  timeout. Left the actual testid addition out of scope (a `src/client` + snapshot change) per the
  group's coordination boundary, but recorded the risk in the PR body per the finding's guidance.

**Not adopted:** none — all findings touching this spec were adopted as described above.
