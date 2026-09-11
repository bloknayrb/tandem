# K-tests — #1825 Tests section (Refs only — issue stays open)

Branch `fix/test-suite-integrity-silent-greens-fragile-assertions-and-an-unimplemented-perf-decision-1861`.
**Refs #1825, not Closes** — only the Tests section is this group's scope (CI/build is done via
#1955, Tauri via #1968, Infra 2-of-3 via #1944, per the issue's own comments), and even within
Tests one bullet (`perf:gate` CI runner) is deliberately left undone below, so the issue cannot
close. Ledger: `docs/plans/2026-09-06-open-issues-sweep.md:459`; area row
`docs/reviews/2026-09-02-v1-review/areas/tests.md:20`. Probe:
`npx vitest run tests/server/launcher/cwd-preview.test.ts tests/server/annotation-remove-seam.test.ts`
before and after; `ls tests/fixtures/mcp-config-sample.json` before/after (absent, after).

## Problem — nine bullets, re-verified against current master rather than the issue body

Per the group's own coordination note, waves 1-7 already fixed most of this section without it
ever being marked as such on #1825. Recorded here WITH EVIDENCE rather than re-fixed, per the
group instructions:

1. **`tests/hooks/test_workflow_state.sh` invoked by nothing — ALREADY DONE.**
   `tests/scripts/workflow-state-hook.test.ts` (landed via #1783, wave 1, `K1-1783.md`) runs it
   via `spawnSync("bash", ["tests/hooks/test_workflow_state.sh"], ...)` and asserts
   `status === 0` plus a matching `OK: (\d+) assertions passed.` line. File exists on master
   today; confirmed by reading it.
2. **Four zero-assertion "does not throw" specs — ALREADY DONE (3 of 4 directly; see below).**
   `awareness.test.ts:130`'s `describe("surfacedIds deduplication")` body now asserts real dedup
   behavior through `processInboxAnnotations` (confirmed by reading the current body — no
   `does not throw` title remains anywhere in `awareness.test.ts`, `changelog-path.test.ts`,
   `file-watcher.test.ts` or `integrations/apply.test.ts`: `grep -n "does not throw"` on all four
   returns nothing). `changelog-path.test.ts:32`'s "returns undefined for a deeply nested
   temp-like dir" now asserts `toBeUndefined()` unconditionally against a fresh `mkdtempSync`
   tree. `integrations/apply.test.ts:335` and `file-watcher.test.ts:178`'s named lines have
   drifted (the file's own #1783 spec already found this: the real body was `:276`, not `:178`,
   a `suppressNextChange` case that now fires a real change through the mock watcher and asserts
   the callback still runs) — both landed via #1783.
3. **Two permanently-skipped E2E specs — ALREADY DONE, and Bryan's own 2026-09-08 issue comment
   already says so.** `keyboard-a11y.spec.ts:266-271` now asserts
   `await expect(annotations).toHaveCount(1)` with a comment recording the 2026-09-06 measurement
   that the old runtime skip never fired. `settings-modal.spec.ts:147-152` replaced the empty
   `test.skip` anchor with a historical-note comment pointing at the real coverage in
   `settings-and-filters.spec.ts`. Confirmed by reading both files on current master.
4. **No E2E asserts the Solo HOLD contract on the pull path — ALREADY DONE.**
   `tests/e2e/inbox-pull-path.spec.ts` exists on master (landed via #1783) and drives both halves:
   user-annotates-Claude-polls, and the Solo-holds/Tandem-releases sequence on
   `tandem_checkInbox`'s `userActions` bucket specifically (per `K1-1783.md`'s own scope note —
   it does not cover the reply hold, `tandem_getAnnotations`, the export filter, or the push
   hold, each a narrower predicate).

Four bullets remain genuinely open and are this PR's actual work:

5. **Orphan fixture `mcp-config-sample.json` — real, fixed here (delete).**
   `tests/fixtures/mcp-config-sample.json` is referenced by exactly one place in the whole
   repo: `docs/spikes/sidecar-launcher-spike.md` (a historical spike record, prose only). Zero
   `.ts`/`.js` files read it (`grep -rln "mcp-config-sample" tests/ src/ scripts/` returns only
   the spike doc). It was the fixture for spike-only config-rewrite probes that never landed as
   real tests; `tests/server/integrations/apply.test.ts` and friends build their own inline
   config JSON today.
6. **`helpers/css-source.test.ts` — verified NOT orphaned; the bullet is stale, recorded as
   refuted rather than fixed.** `tests/helpers/css-source.ts` (the helper this file tests) is
   imported by 8 `tests/design-system-impl/*.test.ts` gates plus itself
   (`grep -rln "css-source" tests/` → 10 files). The test file itself is a real, well-populated
   suite (320 lines, ~25 assertions across `cssRulesBySelector`, `neutralizeSvelteGlobal`,
   `markupOutsideStyleBlocks`, plus a corpus-sweep positive control) and it runs under vitest's
   `node` project (`vitest.config.ts:67`, `include: ["tests/**/*.test.ts"]`, no exclusion for
   `tests/helpers/`) — auto-discovered like every other `*.test.ts` file, no registration needed.
   Whatever made this read as "orphan" when the issue was filed no longer holds; no fix applied.
7. **`cwd-preview.test.ts:248-258` silently green on symlink-creation failure — real, fixed
   here.** `tests/server/launcher/cwd-preview.test.ts`'s "normalizes Claude's side too, so a
   symlinked home is not a permanent nudge" test:
   ```ts
   try {
     fs.symlinkSync(projA, link, "junction");
   } catch {
     return; // unprivileged Windows without Developer Mode — skip
   }
   ```
   A bare `return` inside `it(...)` with no assertion having run reports PASSED in every vitest
   reporter — indistinguishable from the assertion below actually having run and succeeded.
   Measured on this machine: `npx vitest run tests/server/launcher/cwd-preview.test.ts --project=node
   -t "symlinked home"` → `1 passed` (a regular Windows account CAN create directory junctions
   without Developer Mode — only true symbolic links need that privilege — so the catch branch is
   not exercised here; it is a real, narrower condition than the comment implies, e.g. a locked-down
   GPO disabling reparse-point creation entirely).
8. **`annotation-remove-seam.test.ts:428-432` pins only an occurrence count; `reply-seam:111-116`
   has alias/re-export regex guards it lacks — real, fixed here.** Confirmed by reading both:
   `annotation-remove-seam.test.ts` pins `lifecycle.match(/removeAnnotationRecord/g)` to length 2
   (declaration + `removeForClaude`'s call) and stops. `annotation-reply-seam.test.ts:96-108` pins
   the analogous count on `addUserReply` (length 1) AND adds two explicit regex assertions:
   `not.toMatch(/export\s+(?:const|let|var|function)\s+\w+\s*=?\s*addUserReply\b/)` and
   `not.toMatch(/export\s*\{[^}]*\baddUserReply\b[^}]*\bas\b/)`. Note: for THIS symbol
   (`removeAnnotationRecord`, defined directly in `lifecycle.ts:1177` — not, like `addUserReply`,
   a thin wrapper over a deeper private `writeReply`), any alias or re-export line necessarily
   repeats the literal token and would already be caught by the existing occurrence-count check —
   so the gap here is legibility/parity of failure message, not a live coverage hole the way it
   was for reply-seam's two-layer structure. Added anyway, for the stated reason (parity) and
   because a clearer, more specific failure message ("no alias binding of the unguarded entry")
   is strictly better than a generic length mismatch when this guard actually fires.

One bullet is deliberately left open:

9. **`perf:gate` has no CI runner (may extend #1333/#1734) — deliberately deferred, not fixed.**
   Adding a CI runner for `perf:gate` is a new CI gate. Per this group's MINIMALITY rule ("do not
   introduce ... new CI gates unless the issue body itself asks for one"), and per ADR-051 ("an
   advisory job's guarantee is only real if a wiring test inside `check` pins it" —
   `docs/decisions.md#adr-051`), a real fix here is not "add a step to `ci.yml`" but "add a step
   AND a `tests/scripts/*-wiring.test.ts` inside `check` that fails closed if the step is removed
   or neutered" — the same shape as `windows-acl-proof-wiring.test.ts` or
   `coverage-gate-wiring.test.ts`. That is a materially larger, ADR-051-governed addition that
   neither #1734's nor #1825's own body asks for by name (#1734 asks only to fix the
   *measurement*, which K-tests-1734.md does). Left open here rather than built speculatively.

## Fix

- `git rm tests/fixtures/mcp-config-sample.json`.
- `tests/server/launcher/cwd-preview.test.ts`: give the "normalizes Claude's side too..." test a
  context parameter and call `ctx.skip()` on the catch path instead of a bare `return`, so an
  environment that cannot create the fixture reports SKIPPED (visible in every reporter and in
  `windows-acl-proof`'s own per-describe pass/skip/fail accounting) rather than an indistinguishable
  PASSED:
  ```ts
  it("normalizes Claude's side too, so a symlinked home is not a permanent nudge", async (ctx) => {
    const link = path.join(home, "alpha-link");
    try {
      fs.symlinkSync(projA, link, "junction");
    } catch {
      // unprivileged Windows without Developer Mode: report SKIPPED, not passed —
      // a bare `return` here made an environment that cannot create the fixture
      // read as though the assertion below ran and succeeded (#1825).
      ctx.skip();
      return;
    }
    expect(await previewCwdDrift(base({ candidate: projA, claudeCwd: link }))).toEqual({
      drifted: false,
    });
  });
  ```
  (Vitest 4.1's test-context `skip()` — confirmed present via `package.json`'s pinned
  `"vitest": "^4.1.0"`; no other file in the repo currently uses this pattern, so this introduces
  it rather than following a local precedent, but it is the documented, correct API for exactly
  this "runtime-determined skip" shape, and is a smaller change than any alternative — e.g.
  gating with `it.skipIf` cannot work here since whether symlink/junction creation succeeds is
  only knowable by trying it, not by a synchronous predicate at collection time.)
- `tests/server/annotation-remove-seam.test.ts`, immediately after the existing
  `toHaveLength(2)` assertion (`:428-432`), add the two parity assertions (adapted from
  `annotation-reply-seam.test.ts:96-108`, symbol swapped):
  ```ts
  expect(lifecycle, "no alias binding of the unguarded entry").not.toMatch(
    /export\s+(?:const|let|var|function)\s+\w+\s*=?\s*removeAnnotationRecord\b/,
  );
  expect(lifecycle, "no aliased re-export of the unguarded entry").not.toMatch(
    /export\s*\{[^}]*\bremoveAnnotationRecord\b[^}]*\bas\b/,
  );
  ```
- `tests/build/dangling-citations.ts`, `tests/helpers/css-source.test.ts`: no edit — bullets 2, 3,
  6 above are evidence-only, no code change.

## Tests

The fix IS the discriminating test for bullets 7 and 8:

- **Bullet 7 mutation test**: temporarily `vi.spyOn(fs, "symlinkSync").mockImplementation(() => {
  throw new Error("simulated"); })` for the duration of one manual run (never committed), re-run
  the single test with `-t "symlinked home"`, confirm the reporter shows it SKIPPED rather than
  PASSED — this is the before/after the group's wave-7 lesson asks for, on the inverted axis (the
  test did NOT fail before the fix; it silently passed, and the fix makes that same non-exercise
  visibly a skip instead). Revert the spy before committing (it must not ship).
- **Bullet 8 mutation test**: add a scratch line to a FILE COPY of `lifecycle.ts` (never the real
  file, never `git checkout`) — `export const archiveDirect = removeAnnotationRecord;` — confirm
  the NEW regex assertion fails with "no alias binding of the unguarded entry" (and separately
  confirm the pre-existing `toHaveLength(2)` assertion ALSO already failed on this mutation, since
  for this single-layer symbol the two checks are redundant on this exact defeat — record that
  finding in the PR body rather than presenting the new assertions as closing a previously-open
  hole). Restore the file copy.

## Done when

The orphan fixture is deleted; `ctx.skip()` replaces the bare `return`; the two remove-seam parity
assertions are added and pass; both mutation tests above are run and their outcomes recorded in
the PR body (including the bullet-8 finding that the new checks are message-parity, not new
coverage, for this particular symbol); `npm run typecheck:tests` green; the four already-done
bullets (1, 2, 3, 4) are cited with the evidence above in the PR body rather than re-touched; the
`perf:gate` CI-runner bullet is named explicitly as deferred with the ADR-051 reasoning, so the
next reader does not assume this PR silently dropped it.

## Not in scope

Building a `perf:gate` CI runner or its ADR-051 wiring test (bullet 9 — deliberately deferred, see
above; file a dedicated issue if Bryan wants it built, rather than bundling it here). Any change to
`tests/build/dangling-citations.ts` or `tests/helpers/css-source.test.ts` (both bullets are
evidence-only). Re-touching the CI/build, Tauri, or Infra sections of #1825 — done by other groups
per the issue's own comments. Promoting `scan-zero-assert.mjs` or `find_no_expect.py` to
`scripts/ci/` (the K-tests-and-lows track file already marks this a "consider," not a requirement,
and #1783's spec explicitly ruled it out of scope for the same reason).
