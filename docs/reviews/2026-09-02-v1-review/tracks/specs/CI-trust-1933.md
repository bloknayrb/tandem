# CI-trust — #1933 search-worker terminate test runs on a ~1 s margin, not the ~20 s its comment claims

Branch `fix/ci-reds-that-say-nothing-about-the-diff-under-test-1673`. Closes #1933. Track: `docs/reviews/2026-09-02-v1-review/tracks/K-tests-and-lows.md`. Probe: `npx tsx` driving `searchRegexInWorker` directly — measurements below were re-run on this machine (Windows 11, Node v24.2.0) and confirm the issue's numbers.

## Problem

`tests/server/search-worker.test.ts:85-96`, *"keeps the batches that arrived before a terminate, and loses the tail"*, asserts `result.truncated === "timeout"` and `matches.length === 256`. It failed once on a **docs-only** PR (#1932, run 34425689896) with `expected undefined to be 'timeout'` — `handleMessage` (`search-worker.ts:229-247`) clears the hard timer and resolves with **no** `truncated` field when the worker's `done` wins, which is that `undefined`.

The test's comment says the blowup `exec` "spins for 20-35 s — far past any deadline check … so this is the hard timer + terminate path by construction". It is not:

| what | measured |
|---|---|
| worker spawn + the 300 cheap `x` matches, cold | **26-28 ms** (3 runs) |
| `x\|(a+)+$` over `"x"*300 + "a"*28 + "!"`, main thread | **3298 ms** |
| main-thread `DEFAULT_HARD_TIMEOUT_MS` (`pump()` arms it at dispatch, `:288`) | **2000 ms** |
| **upper margin** | **~1.3 s**, i.e. **1.65×**, not the ~20 s claimed |

The V8-experimental-engine hypothesis is refuted in the issue (`--regexp-backtracks-before-fallback=100` changes the timing not at all). This is a plain margin. Two ways it closes, both live on a loaded 2-core runner: the main thread stalls past the margin and `done` lands first (the observed flake), or the `exec` drops under 2000 ms and the test fails **deterministically**, reading as an `undefined` regression in `truncated` rather than as an obsolete assumption.

**The margin has two sides.** `pump()` (`:287-296`) calls `ensureWorker()`, arms `setTimeout(onHardTimeout, job.hardTimeoutMs)`, and only then `postMessage`s — and `ensureWorker()` returns a `Worker` whose thread has not yet evaluated `WORKER_SOURCE`. So the budget covers isolate creation, worker-source evaluation, the 300 cheap matches and the round-trip. The preceding spec terminates the worker (`onHardTimeout` nulls it at `:256`), so this spec always pays a **cold** boot. If that lower side closes, `onHardTimeout` fires with an empty accumulator and `toHaveLength(256)` fails with 0 — a new flake shape on the spec being de-flaked.

The comment is not merely stale, it is load-bearing: it is the reason a reader would not look here.

## Fix

`tests/server/search-worker.test.ts` only. No production change — `SearchWorkerOptions.hardTimeoutMs` already exists (`search-worker.ts:59`, defaulted at `:321`).

Do **not** raise a timeout: the assertion is about *which of two paths ran*, so widening either side moves the coin-flip. Take both of the issue's structural options, because each fixes a different side:

- **`hardTimeoutMs: 1000`** alongside the existing `batchSize: 256`. Passing the option at all is what removes the dependence on `DEFAULT_HARD_TIMEOUT_MS` staying at 2000 — the issue's preferred shape — and 1000 buys an order of magnitude on both sides at once. Lower: cold boot + 300 cheap matches, measured at **26 / 27 / 28 ms** against 1000 ms ≈ **36×**. Upper: 22 937 ms against 1000 ms ≈ **23×**. 500 would shrink the side that actually closes under CI contention; 2000 mirrors the error onto the upper side (11.5×) and gives back the wall-clock win.
- **a-run 28 → 30** in the text. This is the **upper** margin, the side no timeout choice protects: if V8 ever gets faster on this alternation the test fails deterministically at any hard timeout above ~1 ms. Measured `x|(a+)+$` by a-run: 28 → 3298 ms, **30 → 22 937 ms**, 31 → 50 312 ms. At 30 the comment's own "20-35 s" premise becomes true again, and it costs nothing in wall clock: `onHardTimeout` terminates mid-`exec`, so the test finishes at ~1 s — **faster** than today's ~2 s.

**Verified end to end at the shipping values** (`hardTimeoutMs: 1000`, a-run 30, `batchSize: 256`), three consecutive cold runs with a forced fresh worker each (`shutdownSearchWorker()` first, since `onHardTimeout` nulls the worker and `ensureWorker()` respawns): **1012 / 1005 / 1007 ms, `truncated="timeout"`, `matches=256`** every time. Three further runs behind a warm-up measured 1008 / 1006 / 1011 ms with the same verdict, confirming the cold boot is not what the budget is spent on.

**No elapsed-time assertion is added.** The file's first sibling spec (`:44-46`) already declined one on this exact reasoning — *"No upper bound on `elapsed`: 2,033-2,304 ms has been measured on a loaded box, so any ceiling near 2 s is noise"* — and a wall-clock ceiling here would be duration-as-proxy, which this repo routes through `expectWithinMs` and a declared coverage-manifest site. Neither the bound nor that registry entry is in this issue's scope.

**Rewrite the comment** to state the measured numbers (the `## Problem` table is the content), both margins, that the hard timer is armed at dispatch **before** the worker thread boots (so the lower margin is cold boot + 300 cheap matches, not just the matches), and which of the two paths is under test. Two statements it must carry and must not overstate:

- **The lower-margin symptom, by name**: *if this spec ever fails with `matches` length 0 rather than 256, the cold worker boot exceeded `hardTimeoutMs` — raise the option, do not touch the a-run.* The 36× is measured on an idle Windows box while #1932 failed on a loaded 2-core ubuntu runner, so a lower-margin collapse must not read as a new flake and invite the wrong repair.
- **`hardTimeoutMs` is a margin widener, not a correctness knob, and nothing in this file detects its deletion.** `search-worker.ts:321` is `opts.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS` and `:66` is 2000, so deleting the option still fires ~11× before the 22.9 s blowup ends: `truncated` is still `"timeout"` and `matches` is still 256 (the flushed count is a function of `batchSize` 256 and the 300 cheap `x` matches, not of the timer). The spec passes unchanged at ~2 s. Do not write the comment as though the option is pinned by anything here.

Leave `deadlineMs` at its default: 1000 ms is below 1800, so the hard timer wins by construction and setting it would add a knob the assertion does not depend on.

Nothing else in the file changes. `DEFAULT_HARD_TIMEOUT_MS` stays imported — `:281` asserts it is 2000, and that spec is now the only thing tying this file to the default, which is the point.

## Tests

The change **is** the test; these are the properties it must have, each named against the wrong fix it kills:

1. `truncated === "timeout"` with `hardTimeoutMs: 1000` against a 22.9 s blowup. Kills "raise the vitest `testTimeout`" and "raise `DEFAULT_HARD_TIMEOUT_MS`", both of which leave the ratio where it is.
2. `matches).toHaveLength(256)` — unchanged, and it pins the contract the spec exists for: the 44 matches still in the worker's accumulator are lost on terminate. Kills a "fix" that drops it or relaxes it to `toBeGreaterThan(0)`, which would pass on the deadline-flush path the *next* spec already owns. It is also the assertion that catches a lower-margin collapse (length **0**, not a wrong `truncated`), which is why the 36× is measured rather than assumed.
3. The comment's numbers must match the code's constants, must state both margins, and must carry the two statements above without overstating what is pinned. A reader re-deriving the margin from the comment is what did not happen for #1932; it is not testable, so it is stated here and belongs in the PR body.

Run the file ten times consecutively before pushing and record the spread in the PR body. **`--repeat` is not a vitest 4 flag** — verified against `npx vitest --help` on this tree (vitest 4.1.11); passing it is a cac parse error before any test runs. Use a loop:

```sh
for i in $(seq 1 10); do npx vitest run tests/server/search-worker.test.ts || break; done
```

Note in the PR body that these ran on an idle Windows box, not the loaded 2-core ubuntu runner where #1932 failed — ten green local runs are evidence about determinism, not about the margin under contention. The margins are what argue for the latter.

## Done when

The spec passes with `hardTimeoutMs: 1000`, a-run 30, and a comment carrying the measured table, both margins, the lower-margin symptom and the margin-widener caveat; ten consecutive runs green via the loop above; the file's other five specs untouched and green; `npm run typecheck:tests` clean.

## Files touched

`tests/server/search-worker.test.ts`.

## Not in scope

`src/server/mcp/search-worker.ts` — no production behaviour is wrong here. The two sibling blowup specs (`:40`, `:76`), measured at 78.3 s and 21.9 s standalone: genuinely safe, leave them. `DEFAULT_HARD_TIMEOUT_MS`'s value. Any general "measure every regex-timing test" sweep. Any elapsed-time bound and the `SUSPENDED_TIMING_SITES` registry that one would force.

## Review corrections (scope cut)

The round-1 and round-2 correction logs are dropped as superseded. Removed in this pass:

- **The `expectWithinMs(Date.now() - t0, 5_000, …)` upper-bound assertion**, and with it the mandatory fourth entry in `SUSPENDED_TIMING_SITES` in `scripts/ci/coverage-manifest.mjs`. The issue asks for a margin that is an order of magnitude again and a comment that is true; it does not ask for a new timing assertion. Dropping the bound is the alternative the round-2 finding itself offered and the one the file's own first sibling spec already took (`:44-46`), and it moots that finding entirely — no raw wall-clock ceiling, no registry entry, no interaction with the `git grep -l expectWithinMs` drift guard at `coverage-manifest-wiring.test.ts:262-274`, and no collision with `CI-trust-1862.md`'s "no change to `coverage-manifest.mjs`". **Files touched** is now the one file the issue names.
- **Tests item 3** (the bound and its three-way coverage enumeration) and the parallel enumeration in the Fix section. What survives is the single true statement they were wrapped around, which is the one a reader can be misled by.

Fixed directly rather than removed: the round-2 finding that the spec instructed the implementer to write a false comment claim — deleting `hardTimeoutMs: 1000` does **not** surface as a 15 s timeout, it falls back to `DEFAULT_HARD_TIMEOUT_MS` (2000 ms) and every assertion passes unchanged at ~2 s. The required comment now says exactly that: the option is a margin widener and nothing in this file detects its deletion.

## Review corrections (post-cut)

No findings against this spec in the post-cut review. The two sibling specs in this group each took corrections (`CI-trust-1673.md` reinstates its ADR-051 wiring test; `CI-trust-1862.md` makes every cannot-evaluate exit end on the shared literal and pins the two new `ci.yml` step lines by exact equality); this one is unchanged. Implementation order is unaffected: #1673 → #1862 → #1933.
