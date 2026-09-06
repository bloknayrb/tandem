# F-runtime — #1804 monitor and channel shim exit after 5 SSE retries; Claude Code never respawns them, so the "restart Tandem" remedy cannot work

Branch `fix/push-paths-runtime-1759`. Closes #1804. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/shared-cli.md:16`. Probe: `tests/monitor/retry.test.ts`,
`tests/monitor/index.test.ts:446` and `tests/channel/event-bridge.test.ts:540` — three suites that
today assert the exit this issue calls a bug. Evidence for "never respawned": spike F9,
`docs/spikes/plugin-monitor-tty-activation.md`, and the measurement quoted at
`src/monitor/run.ts:257-265` (`scripts/spikes/probe-monitor-respawn.py`, CC 2.1.226 — exit code
made no difference).

## Problem

`runEventConsumer` (`src/shared/sse-consumer.ts`, currently `:157-224`) loops
`while (retries < CHANNEL_MAX_RETRIES)` (5) and, on the fifth consecutive failure, POSTs
`/api/channel-error`, calls `opts.onExhaustion`, and `process.exit(1)`. Both hosts of that consumer
— the plugin monitor (`src/monitor/run.ts:193`) and the channel shim
(`src/channel/event-bridge.ts:20`) — are launched once per Claude Code session and are not
respawned on exit. With `CHANNEL_RETRY_DELAY_MS` 2 s doubling to a 30 s cap, exhaustion arrives
about 30 s in, so any Tandem restart slower than that (a desktop update, `perform_install`, a cold
start, laptop sleep) permanently kills the push path for that session. The monitor's visible notice
(`run.ts:175-177`) then says `restart Tandem to restore real-time events`, which restarts the wrong
process — and per that file's own comment it is "the last thing this process ever says: a claim
that stays in context after it stops being true". Pull (`tandem_checkInbox`) keeps working, so the
failure reads as "wakes just stopped".

Same class as #1805, fixed the same way: keep the process alive, keep retrying with the capped
backoff that is already there. No supervisor, no new abstraction, no new constant.

## Fix

- `src/shared/sse-consumer.ts` — `runEventConsumer` becomes `while (true)`. The catch keeps the
  `retries++`, the existing
  `Math.min(CHANNEL_RETRY_DELAY_MS * 2 ** (retries - 1), RETRY_MAX_DELAY_MS)` delay and the
  `await new Promise(r => setTimeout(r, delay))`. Both `process.exit(1)` calls go, and with them the
  post-loop "retry loop exited unexpectedly" fallback (now unreachable by construction).
- **Report exactly once per outage, at the same threshold — and the comparison must be `>=`.** A
  module-level `let reportedExhaustion = false`. When
  `retries >= CHANNEL_MAX_RETRIES && !reportedExhaustion`, set it, POST `/api/channel-error` with
  `opts.errorCode` as today, and call `opts.onExhaustion?.({ everConnected })` — then **continue
  looping**. **The `>=` is load-bearing, not style.** `retries` is reset only by `onStable`
  (`src/shared/sse-consumer.ts:173-175`, armed 60 s after a handshake at `:278`), and the bullet
  below deliberately does not reset it on reconnect — so after the first outage carries `retries` to
  5, any recovery shorter than `STABLE_CONNECTION_MS` leaves it at 5, the next failure makes it 6,
  and a `===` test would never be true again for the life of the process: no report, no
  `onExhaustion`, no stdout notice, ever again, and the latch-clear below would be dead code. The
  `!reportedExhaustion` latch is what makes the report once-per-outage; the threshold comparison is
  not. `CHANNEL_MAX_RETRIES` keeps its name and value and becomes "how many failures before we say
  something out loud", which the log line must reflect:
  `SSE connection lost after ${CHANNEL_MAX_RETRIES} retries; still retrying` replaces
  `SSE connection exhausted, reporting error and exiting`.
- **Fix the two per-failure log lines, which an unbounded loop turns into nonsense.**
  `:177-181` writes `SSE connection failed (${retries}/${CHANNEL_MAX_RETRIES})` and `:210-213`
  writes `Retrying in ${delay}ms (attempt ${retries}/${CHANNEL_MAX_RETRIES})` — with `retries` now
  unbounded those read "(47/5)", and at the 30 s cap they are two stderr lines every 30 s forever
  for a session whose Tandem is simply not running. Drop the `/${CHANNEL_MAX_RETRIES}` denominator
  from both (they are an attempt counter now, not a budget), and **suppress both while
  `reportedExhaustion` is set**, re-enabling them when the recovery line clears it. A long outage
  then costs a bounded five failure lines, one "still retrying" line, and one "restored" line —
  which is the wave-table's "single legible log line", not a flood.
- **Say so on recovery.** In `connectAndStreamOnce`, at the existing `everConnected = true` line
  (immediately after a successful handshake): if `reportedExhaustion`, clear it and
  `console.error(\`${opts.logPrefix} SSE connection restored\`)`. Putting it here rather than in the
  retry loop is deliberate — `connectAndStreamOnce` resolves only when the *stream ends*, so a
  recovery line driven from the loop would print at the wrong moment. Reset `retries = 0` there too
  is **not** wanted: `onStable` (60 s of uptime) already owns the retry-budget reset and a flapping
  server must keep escalating.
- Add `reportedExhaustion = false` to `_resetSseConsumerStateForTests` (currently `:684`), whose
  doc comment promises it "clears every byte of state below in one call".
- `src/monitor/run.ts` — rewrite the `onExhaustion` stdout notice. Keep the `if (!everConnected)
  return` guard and its whole rationale comment unchanged (a never-connected run still says
  nothing). The line becomes:
  `Tandem monitor lost its connection and is retrying in the background — tandem_checkInbox still works and is authoritative\n`.
  It is now true when it is read, which is what the old comment said the old line was not. Delete
  the third bullet of that comment ("a monitor that exits is never respawned, so this line would be
  the last thing this process ever says") — it stops being the reason for silence once the process
  survives; the first two bullets still carry it.
- **`process.stdout.write` stays the delivery for that one line, and nothing else moves to stdout**
  — Critical Rule 3, and `src/monitor/run.ts`'s header names its exactly-two stdout writers. The
  `onStdoutError` EPIPE exit is untouched and stays an exit: a monitor that cannot write cannot
  deliver, and the file's comment already explains why that one is a clean shutdown rather than a
  bid for a respawn.
- `src/channel/event-bridge.ts` needs no change — it passes no `onExhaustion` and inherits the loop.
- **Two tracked docs become false and are corrected in the same PR.** This PR also closes #1794,
  whose entire content is "a doc describes behaviour that does not exist", so leaving these is not
  an option. `docs/architecture.md:530-535` currently enumerates "On exhaustion
  (`CHANNEL_MAX_RETRIES`), the monitor: 1. POSTs `/api/channel-error` … 2. Writes … 3. Calls
  `process.exit(1)`" — all three clauses change. Rewrite as: after `CHANNEL_MAX_RETRIES` consecutive
  failures the consumer reports once to `/api/channel-error`, writes the retrying notice to stdout,
  and keeps retrying at the 30 s cap; it does not exit, and it reports again after a recovery
  followed by a fresh outage. `docs/mcp-tools.md:1408` reads "The shim gives this best-effort report
  a 3-second deadline before exiting after retry exhaustion" — drop "before exiting after retry
  exhaustion", keeping the 3-second deadline, which is unchanged. The sample body at `:1403`
  (`"Lost connection after 5 retries"`) stays: the code still sends that string.
- Not engaged: Y.Doc writes, Y.Map keys, `/api` routes (`/api/channel-error` is unchanged and
  already in `NON_LOOPBACK_ALLOWED`), MCP tools, `data-testid`, the shipped skill.

## Tests

**Read this preamble first — the blast radius is ~17 existing specs, not three.** Every suite that
drives the consumer today terminates the same way: the promise settles only because the mocked
`process.exit` *throws* out of the retry loop (`tests/monitor/retry.test.ts:22-24` is the canonical
spy). With `while (true)` and no exit, `runEventConsumer` never settles, so **every `await
mainPromise` / `await promise` / `await p` on it hangs to a vitest timeout**. The mechanical fix is
the same everywhere and introduces no test hook in `src/`: **delete the trailing `await <promise>`**
(the promise is already `.catch(() => {})`-ed, so a dangling pending promise is harmless), keep the
`await vi.advanceTimersByTimeAsync(...)` that already drives the run — adding a final
`await vi.advanceTimersByTimeAsync(0)` where a microtask flush was being relied on — and **delete
any `expect(exitSpy).toHaveBeenCalledWith(1)`**. `advanceTimersByTimeAsync` is bounded by its time
budget, so an unbounded loop scheduling a ≤30 s timer per round still terminates the advance.

Sites, all of which need exactly that change:

- `tests/monitor/retry.test.ts` — `:38-71` (`await mainPromise` `:65`, exit assert `:71`),
  `:83-98` (`:90`, `:98`), `:101-114` (`:110`, `:114`), `:117-163` (`await p` `:163`, whose comment
  "drain remaining retries so main() exits via the MAX branch" also needs rewording),
  `:203-214` (`:214`).
- `tests/monitor/index.test.ts` — `:488-506` (`:498`, `:503`) and `:512-529` (`:526`, `:529`).
- `tests/monitor/mode-cache.test.ts` — `:167-184` (`:184`).
- `tests/channel/event-bridge.test.ts` — the eleven `start(h.mcp, URL)` sites at `:101, 129, 170,
  196, 262, 338, 379, 416, 446, 511, 559`, each ending in `await promise;` (`start` returns
  `runEventConsumer` directly, `src/channel/event-bridge.ts:19-33`), plus the exit assertion at
  `:566`.

The five specs below are the ones whose *assertions* change, over and above that sweep.

1. `tests/monitor/retry.test.ts` — the spec at `:63-70` asserts `connectAttempts` is **exactly**
   `CHANNEL_MAX_RETRIES` because `process.exit` threw out of the loop. Rewrite it: with a
   fail-always connect, assert attempts exceed `CHANNEL_MAX_RETRIES` (e.g. ≥ 8) and the
   `process.exit` spy is **never** called. That inequality is the discriminator — an upper bound
   alone would pass for a fix that still exits.
2. Same file — assert the `/api/channel-error` POST happens **once** across ≥ 8 failures, and that
   its body still carries `opts.errorCode`. Kills a naive `while (true)` that re-reports every
   fifth failure, which would spam a route that `console.error`s on the server.
3. `tests/monitor/index.test.ts:446` — the exhaustion suite: keep the `MONITOR_CONNECT_FAILED` POST
   assertion, drop the exit assertion, assert the stdout notice matches
   `/retrying in the background/` and `/tandem_checkInbox/`, and assert it is written **once**.
   Kills a fix that changes the retry loop but leaves the misleading remedy text.
4. New spec (same file, or `tests/monitor/retry.test.ts`) — **recovery**: fail 6 times, then let a
   connect succeed; assert stderr contains `SSE connection restored` exactly once, and that a
   *second* outage reports to `/api/channel-error` again. That second half is what kills a latch
   that is set but never cleared — **and it is only reachable because the report tests `>=`**, so
   the recovered connection must NOT be held for `STABLE_CONNECTION_MS`: the spec ends the stream
   after a few seconds of fake time, leaving `retries` at 6+, which is precisely the state a `===`
   threshold could never report from again. Also assert the per-failure lines resume after the
   restored line (they are suppressed while the latch is set).
5. `tests/channel/event-bridge.test.ts:551-567` — `"POSTs CHANNEL_CONNECT_FAILED after exhausting
   CHANNEL_MAX_RETRIES and exits 1"`: keep the POST assertion, rename, and assert the process does
   not exit. The shim shares the consumer, so this is the second host's proof that one fix covered
   both.
6. `tests/monitor/shutdown.test.ts` untouched: SIGINT/SIGTERM and EPIPE still exit.
   `tests/monitor/index.test.ts` is **not** untouched — see the sweep above.

## Done when

The consumer retries past `CHANNEL_MAX_RETRIES` without exiting on both hosts; the error report and
the stdout notice fire once per outage and again after a recovery **that did not last
`STABLE_CONNECTION_MS`**; the monitor's notice names `tandem_checkInbox`; a permanently-unreachable
server produces a bounded number of stderr lines, none of them carrying a `/5` denominator;
`docs/architecture.md` and `docs/mcp-tools.md` no longer describe the exit; `npm run typecheck` +
`npx vitest run tests/monitor tests/channel` + `node scripts/ci/monitor-smoke.mjs` green.

## Not in scope

`CHANNEL_MAX_RETRIES` / `CHANNEL_RETRY_DELAY_MS` / `RETRY_MAX_DELAY_MS` values; the EPIPE exit; the
`onStable` 60 s stable-uptime reset; `ensureTandemServer`'s fail-fast for `tandem channel`'s own
startup (the shim's stdio transport genuinely cannot answer); making `/api/channel-error` visible
in the browser.

## Review corrections (round 1)

**Adopted**

- *`retries === CHANNEL_MAX_RETRIES` is satisfiable at most once per process, so every outage after
  the first would report nothing and test 4 could not pass.* Verified: `retries` is function-local
  (`src/shared/sse-consumer.ts:164`) and reset only by `onStable` (`:173-175`), armed 60 s after a
  handshake (`:278`), while `everConnected = true` (`:274`) — where the latch is cleared — runs on
  every handshake. Adopted: the trigger is now `retries >= CHANNEL_MAX_RETRIES &&
  !reportedExhaustion`, with the reason stated inline so it is not "simplified" back, and test 4
  now says explicitly that the recovery need not survive `STABLE_CONNECTION_MS`. (Three separate
  findings made this point; one correction covers all three.)
- *The test inventory is incomplete and "index.test.ts untouched" is false; ~17 specs terminate only
  because the `process.exit` spy throws.* Verified by reading each site. Adopted: the Tests section
  now opens with a preamble naming the termination mechanism and the mechanical change, enumerates
  every affected spec by file and line (including the eleven `start(h.mcp, URL)` sites in
  `tests/channel/event-bridge.test.ts`), and the false half of item 6 is deleted, keeping only the
  SIGINT/SIGTERM/EPIPE carve-out.
- *#1804 falsifies `docs/architecture.md:530-535` and `docs/mcp-tools.md:1408`, in the same PR that
  closes a "the doc describes a thing that does not run" issue.* Verified verbatim. Adopted as a new
  Fix bullet with the replacement wording; both files join the fix's file set. The `:1403` sample
  body stays, because the code still sends that string.
- *The per-failure log lines print "(47/5)" forever once the loop is unbounded, contradicting the
  wave-table's "single legible log line".* Verified at `:177-181` and `:210-213`. Adopted: the
  `/${CHANNEL_MAX_RETRIES}` denominator is dropped from both, and both are suppressed while
  `reportedExhaustion` is set, resuming when the recovery line clears it — a bounded trail rather
  than a flood.

**Not adopted**

- *"Gate the per-failure line to the first `CHANNEL_MAX_RETRIES` failures plus one line per
  subsequent hour."* The hourly-heartbeat half is not adopted: it needs a new timestamp and a new
  interval constant, which the wave-table's "no new frameworks, no new constant" rule forbids, and
  it buys nothing the "still retrying" line plus the restored line do not already give. The
  suppress-while-latched form adopted above achieves the same bound with the state that already
  exists.
