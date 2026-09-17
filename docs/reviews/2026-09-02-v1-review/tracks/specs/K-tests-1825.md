# K-tests — #1825 Tests section (Refs only — issue stays open)

Branch `fix/test-suite-integrity-silent-greens-fragile-assertions-and-an-unimplemented-perf-decision-1861`.
**Refs #1825, not Closes** — only the Tests section is this group's scope (CI/build done via
#1955, Tauri via #1968, Infra via #1944), and bullet 9 below is deliberately left undone, so the
issue cannot close. Ledger: `docs/plans/2026-09-06-open-issues-sweep.md:459`; area row
`docs/reviews/2026-09-02-v1-review/areas/tests.md:20`. Probe:
`npx vitest run tests/server/launcher/cwd-preview.test.ts tests/server/annotation-remove-seam.test.ts`
before and after. **No fixture deletion** — bullet 5's orphan claim is refuted; see below.

## Nine bullets, re-verified against current master

**Already done (waves 1-7), recorded with evidence, not re-touched:**

1. `tests/hooks/test_workflow_state.sh` — run by `tests/scripts/workflow-state-hook.test.ts`
   (#1783), which `spawnSync`s it and asserts exit 0.
2. Four "does not throw" specs — `grep -n "does not throw"` across `awareness.test.ts`,
   `changelog-path.test.ts`, `file-watcher.test.ts`, `integrations/apply.test.ts` returns nothing;
   all four now assert real behavior (landed via #1783).
3. Two permanently-skipped E2E specs — `keyboard-a11y.spec.ts:266-271` now asserts
   `toHaveCount(1)`; `settings-modal.spec.ts:147-152` replaced the empty `test.skip` with a
   historical-note comment pointing at real coverage elsewhere.
4. Solo HOLD contract on the pull path — `tests/e2e/inbox-pull-path.spec.ts` exists (#1783) and
   drives both the annotate-then-poll and Solo-holds/Tandem-releases sequences.

**Refuted (stale bullets), recorded, not fixed:**

5. **`tests/fixtures/mcp-config-sample.json` is not an orphan.**
   `src-tauri/src/integrations_probe.rs:381-386` builds `fixture_path()` from it, and `:420-431` is
   an unconditional `#[test] fn rewrite_preserves_unrelated_servers_and_replaces_stale_tandem()`
   whose first line reads the fixture and asserts against its pre-seeded token. Module wired in via
   `src-tauri/src/lib.rs:60`. Deleting it would break `cargo test` on all three required
   `rust-test` legs. This group's orphan sweep was scoped to `tests/ src/ scripts/`, which never
   looks at `src-tauri/` — the actual reader. No deletion; fixture has exactly one reader and does
   real work there.
6. **`tests/helpers/css-source.test.ts` is not orphaned.** `tests/helpers/css-source.ts` is
   imported by 8 `tests/design-system-impl/*.test.ts` gates plus itself; the test file (320 lines,
   ~25 assertions) runs under vitest's `node` project (`vitest.config.ts:67`), auto-discovered.
   Whatever made this read as "orphan" when filed no longer holds.

**Real, fixed here:**

7. **`cwd-preview.test.ts:248-258` silently green on symlink-creation failure.** The "normalizes
   Claude's side too" test does `try { fs.symlinkSync(...) } catch { return; }` — a bare `return`
   inside `it()` with no assertion run reports PASSED in every reporter. Fix: use the test-context
   `skip()` (Vitest 4.1, pinned in `package.json`) so an environment that cannot create the fixture
   reports SKIPPED instead:
   ```ts
   it("normalizes Claude's side too, so a symlinked home is not a permanent nudge", async (ctx) => {
     const link = path.join(home, "alpha-link");
     try {
       fs.symlinkSync(projA, link, "junction");
     } catch {
       ctx.skip(); // unprivileged Windows without Developer Mode: report SKIPPED, not passed (#1825)
       return;
     }
     expect(await previewCwdDrift(base({ candidate: projA, claudeCwd: link }))).toEqual({ drifted: false });
   });
   ```
   Measured on this machine: `-t "symlinked home"` → `1 passed` (a regular account can create
   directory junctions without Developer Mode) — so this catch is not exercised here today; it is a
   real, narrower condition (a locked-down GPO) than the comment implies.
8. **`annotation-remove-seam.test.ts` pins only an occurrence count.** Add the same two alias/
   re-export regex guards `annotation-reply-seam.test.ts:96-108` has, symbol swapped, with a comment
   noting the redundancy: for `removeAnnotationRecord` (defined directly, not a wrapper over a
   deeper private fn) any alias line already repeats the literal token and would already fail the
   existing `toHaveLength(2)` check — added for a clearer, symbol-specific failure message.

**Deliberately deferred, not fixed:**

9. **`perf:gate` has no CI runner.** Adding one means a new CI gate; per ADR-051 that requires a
   wiring test inside `check`, a materially larger addition than either #1734 or #1825 asks for by
   name. Left open — tracked by #1825 itself (`Refs`, not `Closes`), no separate issue needed.

## Fix

`tests/server/launcher/cwd-preview.test.ts`: `ctx.skip()` replaces the bare `return` (shown above).
`tests/server/annotation-remove-seam.test.ts`, after the existing `toHaveLength(2)` (`:428-432`):

```ts
expect(lifecycle, "no alias binding of the unguarded entry").not.toMatch(
  /export\s+(?:const|let|var|function)\s+\w+\s*=?\s*removeAnnotationRecord\b/,
);
expect(lifecycle, "no aliased re-export of the unguarded entry").not.toMatch(
  /export\s*\{[^}]*\bremoveAnnotationRecord\b[^}]*\bas\b/,
);
```

No edit to `tests/fixtures/mcp-config-sample.json` (bullet 5, refuted), `dangling-citations.ts`
(owned by `K-tests-1584.md`), or `tests/helpers/css-source.test.ts` (bullet 6, evidence-only).

## Tests

Bullet 7: temporarily mock `fs.symlinkSync` to throw, confirm the reporter shows SKIPPED not
PASSED, revert the mock (never committed). Bullet 8: add one scratch alias line to a **file copy**
of `lifecycle.ts` (never `git checkout`), confirm the new assertion fails, restore.

## Done when

Bullet 5 recorded as refuted with the `integrations_probe.rs:422` evidence, not deleted;
`ctx.skip()` lands; the two parity assertions land and pass; both mutation checks are run;
`npm run typecheck:tests` green; bullets 1-4 cited with evidence in the PR body rather than
re-touched; bullet 9 named explicitly as deferred-and-tracked-by-#1825.

## Not in scope

A `perf:gate` CI runner or its ADR-051 wiring test. Deleting the fixture. Any change to
`dangling-citations.ts` for #1825's own bullets (owned by `K-tests-1584.md`) or to
`tests/helpers/css-source.test.ts`. Re-touching CI/build, Tauri, or Infra sections — done
elsewhere.

## Review corrections (scope cut)

- Kept the direct fix to the blocking finding: bullet 5 is refuted with the Rust-reader evidence,
  no `git rm`, no orphan-sweep re-grep instruction added.
- Trimmed the per-bullet evidence to one paragraph each (was several, with elaborate quoting) —
  the citations above are sufficient to verify each claim without re-narrating history.
- Removed the "in-file redundancy comment" as a several-line block; kept as a one-line comment
  inline with the code.
