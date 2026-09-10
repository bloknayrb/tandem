# CI-trust — #1933 search-worker terminate test runs on a ~1 s margin, not the ~20 s its comment claims

Branch `fix/ci-reds-that-say-nothing-about-the-diff-under-test-1673`. Closes #1933. Track: `docs/reviews/2026-09-02-v1-review/tracks/K-tests-and-lows.md`. Probe: `npx tsx` driving `searchRegexInWorker` directly — measurements below were re-run on this machine (Windows 11, Node v24.2.0) and confirm the issue's numbers.

## Problem

`tests/server/search-worker.test.ts:85-96`, *"keeps the batches that arrived before a terminate, and loses the tail"*, asserts `result.truncated === "timeout"` and `matches.length === 256`. It failed once on a **docs-only** PR (#1932, run 34425689896) with `expected undefined to be 'timeout'` — `handleMessage` (`search-worker.ts:229-247`) clears the hard timer and resolves with **no** `truncated` field when the worker's `done` wins, which is that `undefined`.

The test's own comment says the blowup `exec` "spins for 20-35 s — far past any deadline check … so this is the hard timer + terminate path by construction". It is not. Re-measured here:

| what | measured |
|---|---|
| worker spawn + the 300 cheap `x` matches, cold | **43 ms** (warm: ≤1 ms) |
| `x\|(a+)+$` over `"x"*300 + "a"*28 + "!"`, main thread | **3298 ms** |
| main-thread `DEFAULT_HARD_TIMEOUT_MS` (`pump()` arms it at dispatch, `:288`) | **2000 ms** |
| **upper margin** | **~1.3 s**, i.e. **1.65×**, not the ~20 s claimed |

The V8-experimental-engine hypothesis is refuted in the issue (`--regexp-backtracks-before-fallback=100` changes the timing not at all). This is a plain margin. Two ways it closes, both live on a loaded 2-core runner: the main thread stalls past the margin and `done` lands first (the observed flake), or the `exec` drops under 2000 ms and the test fails **deterministically** — reading as an `undefined` regression in `truncated` rather than as an obsolete assumption.

The comment is not merely stale, it is load-bearing: it is the reason a reader would not look here.

## Fix

`tests/server/search-worker.test.ts` only. No production change — `SearchWorkerOptions.hardTimeoutMs` already exists (`search-worker.ts:59`, defaulted at `:321`).

Do **not** raise a timeout: the assertion is about *which of two paths ran*, so widening either side moves the coin-flip. Take both of the issue's structural options, because each fixes a different side and neither alone gets an order of magnitude on both:

- **`hardTimeoutMs: 500`** alongside the existing `batchSize: 256`. This removes the dependence on `DEFAULT_HARD_TIMEOUT_MS` staying at 2000 — the issue's preferred shape — and it is the **lower** margin: the batch must be flushed before the timer fires, and the only thing on that side is worker spawn plus 300 cheap matches, measured at 43 ms cold. 500/43 ≈ **11.6×**.
- **a-run 28 → 30** in the text. This is the **upper** margin, and it is the side no timeout choice can protect: if V8 ever gets faster on this alternation the test fails deterministically at any hard timeout above ~1 ms. Measured `x|(a+)+$` cost by a-run: 28 → 3298 ms, **30 → 22 937 ms**, 31 → 50 312 ms, 32 → 74 948 ms. At 30 the comment's own "20-35 s" premise becomes true again, and the margin is 22.9 s / 500 ms ≈ **46×**. It costs nothing in wall clock: `onHardTimeout` terminates the worker mid-`exec`, so the test finishes at ~500 ms — **faster** than today's ~2 s.

Verified end to end, three consecutive runs with a forced fresh worker each time (`shutdownSearchWorker()` first, since `onHardTimeout` nulls the worker and `ensureWorker()` respawns): **502 / 510 / 514 ms, `truncated="timeout"`, `matches=256`** every time.

Add one assertion, `expect(Date.now() - t0).toBeLessThan(5_000)`, mirroring the `elapsed` bounds the three sibling specs already carry. It kills the mutant `truncated` alone cannot: someone restoring `hardTimeoutMs` to 2000+ or deleting the option. It also converts the natural-completion failure into a named one — at a-run 30 a non-firing hard timer would otherwise blow the file's 15 s `testTimeout` and report a hang.

Rewrite the comment to state the measured numbers, both margins and which path is under test — the `## Problem` table above is the content. Leave `deadlineMs` at its default: 500 ms is below 1800, so the hard timer wins by construction and setting it would add a knob the assertion does not depend on.

Nothing else in the file changes. `DEFAULT_HARD_TIMEOUT_MS` stays imported — `:281` asserts it is 2000, and that spec is now the only thing tying this file to the default, which is the point.

## Tests

The change **is** the test; these are the discriminating properties it must have, each named against the wrong fix it kills:

1. `truncated === "timeout"` with `hardTimeoutMs: 500` against a 22.9 s blowup. Kills "raise the vitest `testTimeout`" and "raise `DEFAULT_HARD_TIMEOUT_MS`", both of which leave the ratio where it is.
2. `matches).toHaveLength(256)` — unchanged, and it is what pins the contract the spec exists for: the 44 matches still in the worker's accumulator are lost on terminate. Kills a "fix" that drops the assertion or relaxes it to `toBeGreaterThan(0)`, which would pass on the deadline-flush path the *next* spec in the file already owns.
3. `elapsed < 5_000`. Kills a hard timeout raised back above the blowup, and turns a silent path-swap into a named failure rather than a 15 s hang.
4. The comment's numbers must match the code's constants. A reader re-deriving the margin from the comment is what did not happen for #1932; this is the one thing that failed and it is not testable, so it is stated here and belongs in the PR body.

Run the file ten times consecutively before pushing (`npx vitest run tests/server/search-worker.test.ts --repeat=9`) and record the spread in the PR body. Three runs is what was measured; ten is what the flake's history deserves.

## Done when

The spec passes with `hardTimeoutMs: 500`, a-run 30, the elapsed bound, and a comment carrying the measured table; ten consecutive runs green; the file's other five specs untouched and green; `npm run typecheck:tests` clean.

## Not in scope

`src/server/mcp/search-worker.ts` — no production behaviour is wrong here. The two sibling blowup specs (`:40`, `:76`), measured at 78.3 s and 21.9 s standalone: genuinely safe, leave them. `DEFAULT_HARD_TIMEOUT_MS`'s value. Any general "measure every regex-timing test" sweep — one test has a wrong assumption, and the two neighbours were already measured in the issue.
