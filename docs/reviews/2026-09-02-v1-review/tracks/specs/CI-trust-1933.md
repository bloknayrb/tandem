# CI-trust — #1933 search-worker terminate test runs on a ~1 s margin, not the ~20 s its comment claims

Branch `fix/ci-reds-that-say-nothing-about-the-diff-under-test-1673`. Closes #1933. Track: `docs/reviews/2026-09-02-v1-review/tracks/K-tests-and-lows.md`. Probe: `npx tsx` driving `searchRegexInWorker` directly — measurements below were re-run on this machine (Windows 11, Node v24.2.0) and confirm the issue's numbers.

## Problem

`tests/server/search-worker.test.ts:85-96`, *"keeps the batches that arrived before a terminate, and loses the tail"*, asserts `result.truncated === "timeout"` and `matches.length === 256`. It failed once on a **docs-only** PR (#1932, run 34425689896) with `expected undefined to be 'timeout'` — `handleMessage` (`search-worker.ts:229-247`) clears the hard timer and resolves with **no** `truncated` field when the worker's `done` wins, which is that `undefined`.

The test's own comment says the blowup `exec` "spins for 20-35 s — far past any deadline check … so this is the hard timer + terminate path by construction". It is not. Re-measured here:

| what | measured |
|---|---|
| worker spawn + the 300 cheap `x` matches, cold | **26-28 ms** (3 runs) |
| `x\|(a+)+$` over `"x"*300 + "a"*28 + "!"`, main thread | **3298 ms** |
| main-thread `DEFAULT_HARD_TIMEOUT_MS` (`pump()` arms it at dispatch, `:288`) | **2000 ms** |
| **upper margin** | **~1.3 s**, i.e. **1.65×**, not the ~20 s claimed |

The V8-experimental-engine hypothesis is refuted in the issue (`--regexp-backtracks-before-fallback=100` changes the timing not at all). This is a plain margin. Two ways it closes, both live on a loaded 2-core runner: the main thread stalls past the margin and `done` lands first (the observed flake), or the `exec` drops under 2000 ms and the test fails **deterministically** — reading as an `undefined` regression in `truncated` rather than as an obsolete assumption.

**The margin has two sides and the spec must widen both.** `pump()` (`:287-296`) calls `ensureWorker()`, arms `setTimeout(onHardTimeout, job.hardTimeoutMs)`, and only then `postMessage`s — and `ensureWorker()` returns a `Worker` whose thread has not yet evaluated `WORKER_SOURCE`. So the hard-timeout budget covers isolate creation, evaluation of the worker source, the 300 cheap matches and the message round-trip. The preceding spec in the file terminates the worker (`onHardTimeout` nulls it at `:256`), so this spec always pays a **cold** boot. If that lower side ever closes, `onHardTimeout` fires with an empty accumulator and `toHaveLength(256)` fails with 0 — a *new* flake shape on the very spec being de-flaked. Choosing the hard timeout is therefore a two-sided problem, not a matter of making the timer small.

The comment is not merely stale, it is load-bearing: it is the reason a reader would not look here.

## Fix

`tests/server/search-worker.test.ts` only. No production change — `SearchWorkerOptions.hardTimeoutMs` already exists (`search-worker.ts:59`, defaulted at `:321`).

Do **not** raise a timeout: the assertion is about *which of two paths ran*, so widening either side moves the coin-flip. Take both of the issue's structural options, because each fixes a different side and neither alone gets an order of magnitude on both:

- **`hardTimeoutMs: 1000`** alongside the existing `batchSize: 256`. Passing the option at all is what removes the dependence on `DEFAULT_HARD_TIMEOUT_MS` staying at 2000 — the issue's preferred shape — and **1000 is the value that buys an order of magnitude on both sides at once**. Lower margin: cold worker boot plus the 300 cheap matches, measured here at **26 / 27 / 28 ms** across three cold runs, against 1000 ms ≈ **36×**. Upper margin: 22 937 ms against 1000 ms ≈ **23×**. An earlier draft said 500; that is 18× lower and 46× upper, i.e. it *shrinks* the side that actually closes under CI contention (worker spawn on a descheduled 2-core runner) to buy headroom on the side that only moves when V8 changes. 2000 is the mirror error at 11.5× upper, and also leaves the wall clock where it is today.
- **a-run 28 → 30** in the text. This is the **upper** margin, and it is the side no timeout choice can protect: if V8 ever gets faster on this alternation the test fails deterministically at any hard timeout above ~1 ms. Measured `x|(a+)+$` cost by a-run: 28 → 3298 ms, **30 → 22 937 ms**, 31 → 50 312 ms, 32 → 74 948 ms. At 30 the comment's own "20-35 s" premise becomes true again. It costs nothing in wall clock: `onHardTimeout` terminates the worker mid-`exec`, so the test finishes at ~1 s — still **faster** than today's ~2 s.

**Verified end to end at the shipping values** (`hardTimeoutMs: 1000`, a-run 30, `batchSize: 256`), three consecutive cold runs with a forced fresh worker each time (`shutdownSearchWorker()` first, since `onHardTimeout` nulls the worker and `ensureWorker()` respawns): **1012 / 1005 / 1007 ms, `truncated="timeout"`, `matches=256`** every time. Three further runs behind a warm-up call measured 1008 / 1006 / 1011 ms with the same verdict, confirming the cold boot is not what the budget is spent on.

Add one assertion, `expect(Date.now() - t0).toBeLessThan(5_000)`, mirroring the `elapsed` bounds the three sibling specs already carry. It names the failure when the hard timer fires **late** — someone restoring `hardTimeoutMs` to a value between ~1 s and the file's 15 s `testTimeout`. It does **not** cover a deleted option or a timer that never fires: at a-run 30 the blowup is 22.9 s, so the promise never settles inside the 15 s per-test timeout, vitest times the test out, and the bound is never reached. That case surfaces as a 15 s hang, and the comment must say so rather than implying the bound covers it.

Rewrite the comment to state the measured numbers, **both** margins, that the hard timer is armed at dispatch before the worker thread boots (so the lower margin is cold boot + 300 cheap matches, not just the matches), and which of the two paths is under test — the `## Problem` table above is the content. Leave `deadlineMs` at its default: 1000 ms is below 1800, so the hard timer wins by construction and setting it would add a knob the assertion does not depend on.

Nothing else in the file changes. `DEFAULT_HARD_TIMEOUT_MS` stays imported — `:281` asserts it is 2000, and that spec is now the only thing tying this file to the default, which is the point.

## Tests

The change **is** the test; these are the discriminating properties it must have, each named against the wrong fix it kills:

1. `truncated === "timeout"` with `hardTimeoutMs: 1000` against a 22.9 s blowup. Kills "raise the vitest `testTimeout`" and "raise `DEFAULT_HARD_TIMEOUT_MS`", both of which leave the ratio where it is.
2. `matches).toHaveLength(256)` — unchanged, and it is what pins the contract the spec exists for: the 44 matches still in the worker's accumulator are lost on terminate. Kills a "fix" that drops the assertion or relaxes it to `toBeGreaterThan(0)`, which would pass on the deadline-flush path the *next* spec in the file already owns. It is also the assertion that would catch a lower-margin collapse, which is why the 36× is measured rather than assumed.
3. `elapsed < 5_000`. Kills a hard timeout raised back above the blowup but below the test timeout, and turns that silent path-swap into a named failure. Explicitly not a full guard: a deleted option or a non-firing timer still surfaces as a 15 s test timeout.
4. The comment's numbers must match the code's constants, and must state both margins. A reader re-deriving the margin from the comment is what did not happen for #1932; this is the one thing that failed and it is not testable, so it is stated here and belongs in the PR body.

Run the file ten times consecutively before pushing and record the spread in the PR body. **`--repeat` is not a vitest 4 flag** — verified against `npx vitest --help` on this tree (vitest 4.1.11), where the only `repeat` string is prose inside `--project`; passing it is a cac parse error before any test runs, which would silently reduce the evidence to nothing. Use a loop:

```sh
for i in $(seq 1 10); do npx vitest run tests/server/search-worker.test.ts || break; done
```

Note in the PR body that these ran on an idle Windows box, not the loaded 2-core ubuntu runner where #1932 failed — ten green local runs are evidence about determinism, not about the margin under contention. The margins are what argue for the latter.

## Done when

The spec passes with `hardTimeoutMs: 1000`, a-run 30, the elapsed bound, and a comment carrying the measured table and both margins; ten consecutive runs green via the loop above; the file's other five specs untouched and green; `npm run typecheck:tests` clean.

## Files touched

`tests/server/search-worker.test.ts`. Unchanged by round 1.

## Not in scope

`src/server/mcp/search-worker.ts` — no production behaviour is wrong here. The two sibling blowup specs (`:40`, `:76`), measured at 78.3 s and 21.9 s standalone: genuinely safe, leave them. `DEFAULT_HARD_TIMEOUT_MS`'s value. Any general "measure every regex-timing test" sweep — one test has a wrong assumption, and the two neighbours were already measured in the issue.

## Review corrections (round 1)

**Adopted**

- *`hardTimeoutMs: 500` shrinks the margin on the side that actually closes under CI contention* (blocking, plus a non-blocking restatement). Adopted, at **1000** — the value the blocking finding itself names as the balanced alternative and the non-blocking one recommends outright. Re-measured here rather than taken on arithmetic: the lower side (cold worker boot + 300 cheap matches) is 26-28 ms, so 1000 gives ~36× lower and ~23× upper, both an order of magnitude, and the whole spec still runs in ~1 s. The blocking finding's own suggestion of 2000 was not taken because it mirrors the error onto the upper side (11.5×) and gives back the wall-clock win; 1000 satisfies its stated requirement — an order of magnitude on both sides — and 2000 does not.
- *The lower-margin arithmetic omits that the hard timer is armed BEFORE the worker thread boots.* Adopted: the mechanism is now stated in `## Problem` with the `pump()` line references, the rewritten comment is required to carry it, and the lower margin is expressed as "cold boot + 300 cheap matches" with the measured 26-28 ms rather than the earlier draft's 43 ms.
- *`npx vitest run … --repeat=9` is not a valid vitest 4 invocation* (raised twice). Adopted and verified against `npx vitest --help` on this tree: replaced with a shell loop, with the reason recorded so it is not re-introduced.
- *The elapsed bound's claimed coverage is only half true.* Adopted: the claim is restated in both the Fix and Tests sections — the bound names a **late** timer, while a deleted option or a non-firing timer surfaces as a 15 s test timeout, since the 22.9 s blowup exceeds the file's per-test timeout.
- *Ten green local runs are not evidence about the margin under contention.* Adopted as an explicit caveat on what the PR body may claim.

**Not adopted**

- *Optionally remove the lower margin outright with a pre-warm call (`await searchRegexInWorker("x", "x")`) before the assertion under test.* Not adopted: at `hardTimeoutMs: 1000` the cold lower margin is already ~36× (measured 26-28 ms), so the pre-warm buys nothing the numbers need, and it adds a call the assertion does not depend on — the same reason `deadlineMs` is left at its default. Measured both ways to be sure the choice is not hiding anything: cold 1012 / 1005 / 1007 ms and warm 1008 / 1006 / 1011 ms, `truncated="timeout"` and `matches=256` in all six.
