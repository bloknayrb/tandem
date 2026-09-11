# K-tests — #1825 Tests section (Refs only — issue stays open)

Branch `fix/test-suite-integrity-silent-greens-fragile-assertions-and-an-unimplemented-perf-decision-1861`.
**Refs #1825, not Closes** — only the Tests section is this group's scope (CI/build is done via
#1955, Tauri via #1968, Infra 2-of-3 via #1944, per the issue's own comments), and even within
Tests one bullet (`perf:gate` CI runner) is deliberately left undone below, so the issue cannot
close. Ledger: `docs/plans/2026-09-06-open-issues-sweep.md:459`; area row
`docs/reviews/2026-09-02-v1-review/areas/tests.md:20`. Probe:
`npx vitest run tests/server/launcher/cwd-preview.test.ts tests/server/annotation-remove-seam.test.ts`
before and after. **No fixture deletion in this PR** — round-1 review refuted bullet 5's orphan
claim; see below.

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

Three bullets remain genuinely open and are this PR's actual work (bullet 5 below is now REFUTED,
not fixed — see round-1 correction):

5. **`mcp-config-sample.json` — REFUTED, not an orphan; the bullet is stale (round-1 correction,
   was "real, fixed here (delete)" in round 0).** Round 0's orphan claim was scoped to a grep over
   `tests/ src/ scripts/` and missed the one real reader, which is in Rust: verified directly
   (round-1 review) that `src-tauri/src/integrations_probe.rs:381-386` builds `fixture_path()` as
   `<CARGO_MANIFEST_DIR>/../tests/fixtures/mcp-config-sample.json`, and `:420-431` is an
   UNCONDITIONAL `#[test] fn rewrite_preserves_unrelated_servers_and_replaces_stale_tandem()`
   (no `#[ignore]`) whose first line is `let raw = std::fs::read_to_string(fixture_path())
   .expect("read fixture");` and which asserts against the fixture's pre-seeded
   `test-token-do-not-use-tandem` marker. The module is real and wired in
   (`src-tauri/src/lib.rs:60`, `#[cfg(test)] mod integrations_probe;`). Deleting the fixture would
   break `cargo test` on all three `rust-test` legs, which CLAUDE.md records as required status
   checks (`enforce_admins: true`, no bypass) — this group's `rust=false` flag means it would not
   even be caught locally before landing red in CI. **No deletion in this PR.** The fixture has
   exactly one reader (`integrations_probe.rs:422`), which this group cannot touch (`rust=false`,
   not owned by K-tests) and has no reason to: the fixture is doing real work there, it is not
   orphaned. `docs/spikes/sidecar-launcher-spike.md`'s prose reference is a second, non-code
   reader, also fine as-is.
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
   *measurement*, which K-tests-1734.md does). **Left open here, and it IS tracked**: this spec
   keeps #1825 as `Refs`, not `Closes`, specifically so this bullet stays a live, open item under
   #1825 itself rather than reading as an unfiled deferral — no separate issue number is needed
   because #1825 is that tracked home and this PR deliberately does not close it.

## Fix

- **No fixture deletion.** Bullet 5 is refuted (see above) — `tests/fixtures/mcp-config-sample.json`
  stays, untouched, because `src-tauri/src/integrations_probe.rs` reads it in a real, unconditional
  Rust test.
- `tests/server/launcher/cwd-preview.test.ts`: give the "normalizes Claude's side too..." test a
  context parameter and call `ctx.skip()` on the catch path instead of a bare `return`, so an
  environment that cannot create the fixture reports SKIPPED — visible in every vitest reporter
  (JSON, default, etc.) — rather than an indistinguishable PASSED. (Round-1 correction: this does
  **not** additionally become visible in `windows-acl-proof`'s own per-describe accounting — that
  job runs only the three specs named in `WINDOWS_ACL_PROOF_SPECS`
  (`scripts/ci/windows-acl-proof.mjs:63-81`), and `cwd-preview.test.ts` is not one of them, so that
  job never sees this file. The reporter-visibility argument stands on its own without it.)
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
  `annotation-reply-seam.test.ts:96-108`, symbol swapped), **with the redundancy note living in the
  test's own comment (round-1: was PR-body-only) so the next reader of this file sees it in place**:
  ```ts
  // Parity with annotation-reply-seam.test.ts's two-layer guard (:96-108), added for a
  // clearer, symbol-specific failure message. Note: for THIS symbol (removeAnnotationRecord
  // is defined directly here, not a thin wrapper over a deeper private fn the way
  // addUserReply is over writeReply), any alias or re-export line necessarily repeats the
  // literal token and would already be caught by the toHaveLength(2) check above — so this
  // is message parity, not a live coverage hole the way it is for reply-seam's structure.
  expect(lifecycle, "no alias binding of the unguarded entry").not.toMatch(
    /export\s+(?:const|let|var|function)\s+\w+\s*=?\s*removeAnnotationRecord\b/,
  );
  expect(lifecycle, "no aliased re-export of the unguarded entry").not.toMatch(
    /export\s*\{[^}]*\bremoveAnnotationRecord\b[^}]*\bas\b/,
  );
  ```
- `tests/build/dangling-citations.ts`: no edit for #1825's bullets — the #1584 spec (K-tests-1584.md)
  owns that file's docblock edit (a different citation-family decision, not this issue's scope);
  this is not a repo-wide prohibition on ever touching the file, only a scope boundary between the
  two specs in this same PR. `tests/helpers/css-source.test.ts`: no edit — bullets 2, 3, 6 above are
  evidence-only, no code change.

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
  for this single-layer symbol the two checks are redundant on this exact defeat — the test's own
  comment above the new assertions already records this, per round-1, so the PR body only needs
  to point at it). Restore the file copy.

## Done when

Bullet 5 (`mcp-config-sample.json`) is recorded as REFUTED with the `integrations_probe.rs:422`
evidence, not deleted; `ctx.skip()` replaces the bare `return` in `cwd-preview.test.ts`; the two
remove-seam parity assertions (with their in-file redundancy comment) are added and pass; both
mutation tests above are run and their outcomes recorded in the PR body; `npm run typecheck:tests`
green; the four already-done bullets (1, 2, 3, 4) are cited with the evidence above in the PR body
rather than re-touched; the `perf:gate` CI-runner bullet is named explicitly as deferred with the
ADR-051 reasoning AND as tracked by #1825 itself (not an unfiled deferral), so the next reader does
not assume this PR silently dropped it.

## Not in scope

Building a `perf:gate` CI runner or its ADR-051 wiring test (bullet 9 — deliberately deferred, see
above; tracked by #1825 itself, which this PR deliberately does not close for that reason, rather
than needing a separate issue number). Deleting `tests/fixtures/mcp-config-sample.json` (bullet 5
— refuted; it has a real Rust reader, see above; deleting it is a `src-tauri/` / `rust=false`
concern this group does not own even if Bryan later decides the Rust test itself should stop using
it). Any change to `tests/build/dangling-citations.ts` FOR #1825's bullets (the #1584 spec owns
that file's docblock edit for its own, unrelated citation-family decision) or to
`tests/helpers/css-source.test.ts` (both bullets are evidence-only here). Re-touching the CI/build,
Tauri, or Infra sections of #1825 — done by other groups per the issue's own comments. Promoting
`scan-zero-assert.mjs` or `find_no_expect.py` to `scripts/ci/` (the K-tests-and-lows track file
already marks this a "consider," not a requirement, and #1783's spec explicitly ruled it out of
scope for the same reason).

## Review corrections (round 1)

**Adopted:**
- Bullet 5's orphan claim was refuted: `src-tauri/src/integrations_probe.rs:422` reads
  `tests/fixtures/mcp-config-sample.json` in a real, unconditional Rust test, and deleting it would
  break all three required `rust-test` CI legs. Round-0's grep (`tests/ src/ scripts/`) never
  looked at `src-tauri/`. Removed the `git rm` from Fix, removed the pre/post `ls` from the header
  probe, and rewrote bullet 5 as REFUTED-with-evidence, matching bullet 6's existing shape.
- Bullet 7's `ctx.skip()` justification claimed visibility in `windows-acl-proof`'s own per-describe
  accounting; that job runs only three specs and `cwd-preview.test.ts` is not one of them. Dropped
  that clause; the reporter-visibility argument (JSON/default reporters distinguish skipped from
  passed) stands alone.
- Bullet 8's redundancy note ("message parity, not new coverage for this symbol") was PR-body-only.
  Moved into the test's own comment above the new assertions so the next reader of
  `annotation-remove-seam.test.ts` sees it in place.
- Bullet 9's deferral read like an unfiled deferral. Made explicit: it is tracked by #1825 itself,
  which this PR deliberately keeps open (`Refs`, not `Closes`) for exactly that reason — no separate
  issue number needed. Removed the "file a dedicated issue" line from "Not in scope" since it
  implied otherwise.
- The `dangling-citations.ts` "Not in scope" line read as a repo-wide prohibition, contradicting the
  #1584 spec's own Done-when (which edits that file's docblock). Reworded to scope the prohibition
  to #1825's bullets specifically.

**Not adopted:** none — all findings touching this spec were adopted as described above.
