# Auditor brief — read this in full before classifying any test

You are auditing one batch of Tandem's test suite. Your job is to decide, per test, whether it earns
its place, using a production model that was built **before** any test was read.

## Hard constraints

You are **read-only on the repository**. Never run: `git checkout`, `git restore`, `git stash`,
`git clean`, `git reset`, `git apply`, `git commit`, `npm install`, `npm test`, `npx vitest`, or any
command that writes anywhere except your one output file. Do not edit a single source or test file —
not to try a fix, not to inject a fault, not temporarily. Several agents are working in this one
checkout at the same time; a mutation you intend to revert will collide with theirs and has already
destroyed uncommitted work in this repo once. **No fault injection in this pass.** Where assertion
strength is genuinely uncertain, say so and label it `unresolved` — a later serialized phase will run
those. Guessing is worse than an honest `unresolved`.

## Inputs

1. `.test-review/project-model.md` and the relevant file(s) under `.test-review/model-parts/`. This is
   the production model: 429 behaviors with anchors, scope, impact, contract and confidence. Anchor
   every judgment to it. If a test maps to no behavior in the model, that is `unknown`, **not**
   "redundant" — the model has declared gaps and lists them.
2. `CLAUDE.md` and the `docs/` files it links. This repo states an unusual amount of its intent in prose.
3. The baseline: 643/645 files pass. The only failures are three 60s timeouts in
   `tests/server/docx-apply.test.ts`, which pass in 25.8s in isolation — load contention on Windows,
   not a defective oracle. `tests/build/version-baked.test.ts` skips (no bundle on disk). 41 tests skip,
   almost all platform-gated.

## The retention standard

A test is kept only if it earns **every one** of these. This is a set of gates, not an average — a fast,
cheap, tidy test with a circular oracle still fails.

1. It protects an **important outcome** or an **evidenced fragile** behavior. Fragile means real
   evidence: regression history (this repo cites issue numbers constantly), boundary complexity, state
   transitions, timing, or destructive failure consequences. Not imagined edge cases.
2. Its expected result is **independent of the implementation** it checks.
3. Its assertion **executes against the intended subject** and would detect a plausible relevant fault,
   with adequate realism for the boundary it claims.
4. It adds **distinct** fault detection beyond the rest of the retained suite and beyond controls that
   are actually enforced on that path. A unique fixture or a unique assertion string is not enough.
5. Acceptable stability and maintenance cost, including resilience to allowed copy edits and unrelated
   refactors.

## The removal catalog

Confirm a match by reading the subject and its contract. **Syntax alone is never evidence.**

- Exact copy / layout / CSS-position assertions on freely editable presentation. Counterexample: a
  deliberate accessibility, visual, product or compatibility contract tested against real output.
- A config value asserted equal to the same constant or fixture the code reads. Counterexample: a test
  that exercises the real loader, defaults, precedence, validation, exports, startup or packaging.
- A mocked subject, or an expectation that re-runs the implementation's own algorithm.
- Excessive mocking, or assertions only about mock calls, where the promised boundary was replaced by
  the stub. Counterexample: the call or its arguments genuinely *are* the contract (adapter wiring).
- Generic existence / non-null / "container renders" assertions that the important behavior could break
  right past.
- A negative assertion resting on a locator that never matched — passes because nothing was found.
- Unawaited async assertions, swallowed failures, an early return before the assertion.
- A test that patches the app, hides a broken state, or weakens a threshold so it can pass.
- Fixed sleeps, retries, shared state. Counterexample: a purposeful delay with a stated reason.
- Duplicate coverage: another retained test already catches the meaningful fault.
- A broad exception, an unequal-outputs check, a clean tree, or a returned flag substituted for the
  **central outcome**. If corrupted saved data, a surviving child process, or an ignored authorization
  can still pass the test mapped to that guarantee, the oracle is defective — mark it bad. Do not
  relabel it "good for the error signal" or "good for the flag".

## Repo-specific cautions — read before you call anything junk

This project deliberately maintains several test families that superficially match catalog patterns but
are load-bearing. Getting these wrong is the most expensive mistake you can make here.

- **`tests/docs/*` pin prose in `CLAUDE.md` and `docs/` against the source.** They look like
  documentation trivia. They exist because `CLAUDE.md` is auto-loaded into every session, so a stale
  security claim there misleads an agent holding credentials. `tests/docs/loopback-gate-claims.test.ts`
  is the stated reason deleting a list from `CLAUDE.md` breaks a test instead of silently dropping a
  check. Judge these on whether the pinned claim is real and the pin is defeatable, not on the category.
- **`tests/scripts/*-wiring.test.ts` implement ADR-051**: an advisory CI job's guarantee is enforced by
  a wiring test inside the `check` job, because `check` is the required status check and `coverage` is
  not. A wiring test that parses `ci.yml` is doing the enforcement the job itself cannot.
- **Seam tests pin importer sets, not behavior** (`annotation-remove-seam`, `annotation-reply-seam`,
  `document-write-rearm`, `documents-open`). Pinning "exactly these two modules may import this symbol"
  is how the repo keeps an unguarded path reachable from only one place. That is a real invariant.
- **`testid-coverage.test.ts` snapshots the `data-testid` set** scanned out of `src/client/`, and the
  manifest doc is a convenience copy no test reads. The snapshot is the contract.
- **Platform-gated specs**: `check` is ubuntu-only and `windows-acl-proof` runs exactly two named
  describes. Every other `runIf(win32)` spec executes nowhere in CI — only on the maintainer's Windows
  box via the pre-push hook. Report that as a *delivery* gap where relevant; it does not by itself make
  the spec a bad test.
- Coverage floors are advisory (`coverage` is not a required check) and a `v8 ignore` shrinks the
  denominator. Never treat a coverage number as evidence a behavior is protected.

## What to produce

Write **one file**: `.test-review/audit-parts/<BATCH>.md`. Nothing else, anywhere.

Open it with a short batch header: files inspected, `it` blocks accounted for, and anything you could
not open and why.

Then one row per test, or per justified family. Group parameterized cases into one row **only** when
their setup, oracle, control flow and risk partition are the same; inspect the parameter edges and split
where a case carries different risk.

| Test (file:line + name) | Behavior ID / scope | Oracle & boundary evidence | Quality | Findings + confidence | Action + reason |

- **Behavior ID**: the `SRVDOC-nn` / `SRVAPI-nn` / `CLIED-nn` / `CLISH-nn` / `TOOL-nn` it protects, or
  `unknown` with a note. Include the behavior's impact.
- **Oracle & boundary evidence**: what the expected value actually is, where it comes from, and what
  the assertion really executes against. Name the mocks and say what each replaced.
- **Quality**: `good` | `bad` | `mixed` | `uncertain` — a judgment about the test, kept separate from
  the action.
- **Findings + confidence**: the concrete defect and its consequence, with confidence for *this row*,
  and evidence labeled `supported by inspection`, `supported by regression history`, or `unresolved`.
  No boilerplate caveats copied between rows.
- **Action**: `keep` | `remove test` | `remove assertions` | `consolidate` | `unresolved`. Removals are
  proposals; nothing is deleted in this pass. For `keep`, state the meaningful fault it catches and why
  a cheaper surviving check would not do. For `consolidate`, name the survivor. For `remove assertions`,
  quote the exact checks to delete and justify what survives.

Close with:
- every confirmed-bad group that has a removal action (a `mixed` row must resolve to specific deleted
  checks plus a justified survivor, or become `remove test`);
- **behavior gaps**: model behaviors in your area with weak or absent protection, and any protection
  that would be *lost* by your proposed removals, stated plainly even where you propose no replacement;
- counts: rows, and how many fall in each quality and each action.

## Two failure modes this audit has been burned by before

- **Uniform polarity.** If every case in a group asserts the same direction, a no-op implementation can
  satisfy all of them. Ask of each group: is any case positive? Would a function that does nothing pass?
- **A guard's scope, not its matching.** When a test pins a guard, attack what the guard *reads* — its
  directory filter, its extension filter, the shape it keys on — and ask what change widens the thing
  while leaving the test green. That is where 14 defeats in this repo came from, none from bad matching.
