# F-runtime — #1804 monitor and channel shim exit after 5 SSE retries; Claude Code never respawns them, so the "restart Tandem" remedy cannot work

Branch `fix/push-paths-runtime-1759`. Closes #1804. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/shared-cli.md:16`. Probe: `tests/monitor/retry.test.ts`,
`tests/monitor/index.test.ts:446` and `tests/channel/event-bridge.test.ts:540` — three suites that
today assert the exit this issue calls a bug. Evidence for "never respawned": spike F9,
`docs/spikes/plugin-monitor-tty-activation.md`, and the measurement at `src/monitor/run.ts:257-265`.

## Problem

`runEventConsumer` (`src/shared/sse-consumer.ts:157-224`) loops `while (retries <
CHANNEL_MAX_RETRIES)` (5) and, on the fifth consecutive failure, POSTs `/api/channel-error`, calls
`opts.onExhaustion`, and `process.exit(1)`. Both hosts — the plugin monitor
(`src/monitor/run.ts:193`) and the channel shim (`src/channel/event-bridge.ts:20`) — are launched
once per Claude Code session and are never respawned. Exhaustion arrives ~30 s in, so any Tandem
restart slower than that permanently kills the push path for that session, and the monitor's notice
(`run.ts:175-177`) then says `restart Tandem to restore real-time events` — the wrong process. Pull
keeps working, so it reads as "wakes just stopped".

Same class as #1805, fixed the same way: keep the process alive and keep retrying at the capped
backoff already there. No supervisor, no new abstraction, no new constant.

## Fix

- `src/shared/sse-consumer.ts` — `runEventConsumer` becomes `while (true)`, keeping `retries++`, the
  existing `Math.min(CHANNEL_RETRY_DELAY_MS * 2 ** (retries - 1), RETRY_MAX_DELAY_MS)` delay and its
  `await`. Both `process.exit(1)` calls go, with them the post-loop "retry loop exited unexpectedly"
  fallback (now unreachable). Correct the function's doc comment (`:150-156`), which states the
  deleted behaviour verbatim, and add `reportedExhaustion` to `_resetSseConsumerStateForTests`
  (`:684`), whose comment promises it "clears every byte of state below in one call".
- **Report exactly once per outage, at the same threshold — keep the `>=`.** A module-level
  `let reportedExhaustion = false`. When `retries >= CHANNEL_MAX_RETRIES && !reportedExhaustion`,
  set it, POST `/api/channel-error` with `opts.errorCode` as today, call
  `opts.onExhaustion?.({ everConnected })` — then **continue looping**. The latch makes the report
  once-per-outage; the comparison does not, and `>=` cannot go permanently silent if a later edit
  breaks the latch/`retries` coupling. `CHANNEL_MAX_RETRIES` keeps its name and value and becomes
  "how many failures before we say something out loud":
  `SSE connection lost after ${CHANNEL_MAX_RETRIES} retries; still retrying` replaces
  `SSE connection exhausted, reporting error and exiting`.
- **Suppress the two per-failure lines while latched.** `:177-181` and `:210-213` both interpolate
  `(${retries}/${CHANNEL_MAX_RETRIES})`; unbounded, those read "(47/5)" and become two stderr lines
  every 30 s forever. Drop the denominator from both (an attempt counter now, not a budget) and skip
  both while `reportedExhaustion` is set. A long outage then costs five failure lines, one "still
  retrying" and one "restored" — the wave-table's single legible trail, not a flood.
- **Clear the latch in `onStable`, not at the handshake.** `onStable` (`:173-175`, armed at `:278`,
  cleared in `connectAndStreamOnce`'s `finally` at `:499`) fires only after `STABLE_CONNECTION_MS`
  of *continuous* uptime and already owns `retries = 0`. Add: if `reportedExhaustion`, clear it
  (re-enabling the per-failure lines) and `console.error(\`${opts.logPrefix} SSE connection
  restored\`)`. **Not on the `everConnected = true` line (`:274`)** — that runs on *every* handshake,
  so a connect-then-die flap would re-arm the report and the stdout notice each cycle, and each
  stdout write is a model turn on CC 2.1.226: an unbounded stream of unsolicited turns plus one POST
  per cycle, strictly worse than today. The cost is a restored line 60 s late.
- `src/monitor/run.ts` — rewrite the `onExhaustion` stdout notice, keeping the
  `if (!everConnected) return` guard and its rationale comment except its third bullet ("a monitor
  that exits is never respawned…"), which stops being the reason for silence. The line becomes
  `Tandem monitor lost its connection and is retrying in the background — tandem_checkInbox still works and is authoritative\n`.
  `process.stdout.write` stays the delivery for that one line and nothing else moves to stdout
  (Critical Rule 3); the `onStdoutError` EPIPE exit is untouched and stays an exit.
- **Register a stdin-EOF shutdown — verbatim on one host, conditional on the other. This is the one
  place #1804 and #1805 are NOT symmetric, and the two hosts are not symmetric with each other
  either.** Removing the cap deletes the only self-termination path these two have for the case the
  fix targets: the monitor's remaining inventory is SIGINT/SIGTERM (`:244-245`) and `onStdoutError`
  (`:267-269`), and EPIPE fires only on a stdout **write**, which the kept `!everConnected` guard
  means a never-connected monitor never performs — so a consumer armed while Tandem is down, whose
  session then ends uncleanly, would have no exit at all and probe `/api/events` at the 30 s cap
  forever, one orphan per session. The counter-measure is already at `src/cli/mcp-stdio.ts:1225-1231`
  (`process.stdin.once("end", () => { void shutdown(0); })`) — but it works there **only because**
  `await stdio.start()` (`:1223`) runs first and `StdioServerTransport` attaches a stdin `data`
  listener, putting the stream in flowing mode; the comment at `:1225-1228` says so. An `'end'`
  listener does not by itself resume a paused stream.
  - **`src/channel/run.ts` — mirror it verbatim in shape, one line, no new abstraction**, in
    `runChannel()` beside the `StdioServerTransport` connect (`:203-204`), via its clean-exit path.
    No `resume()` is needed or wanted here: that transport reads stdin, exactly as in the bridge, so
    EOF is delivered. `src/channel/run.ts` joins the file set for that one line.
  - **`src/monitor/run.ts` — the same line alone would be a no-op, and the obvious repair is
    load-bearing enough to need a measurement before it is written.** Nothing in the monitor reads
    stdin: `grep -n "stdin\|resume(" src/monitor/run.ts src/monitor/index.ts` returns only the prose
    comments at `run.ts:26` and `run.ts:133`. (An earlier draft of this bullet said the grep "returns
    nothing today" — that is wrong for the monitor and true only of `src/channel/run.ts`.) Measured
    on Node 22: a script whose only stdin interaction is `process.stdin.once("end", …)`, run with
    stdin at `/dev/null`, **never** fires the handler; adding `process.stdin.resume()` fires it
    immediately. But `resume()` is fatal the other way — Claude Code spawns monitors via
    `spawn(cmd, [], { shell: true })` (`docs/architecture.md:499`), and a monitor whose stdin is
    `/dev/null` or already closed would then exit at startup, killing the push path outright.
    **Whether the plugin host gives the monitor a piped stdin is UNMEASURED.** So measure it first,
    then take exactly one branch: **(a) piped** — put `process.stdin.resume()` immediately above
    `process.stdin.once("end", …)` in `main()` (`src/monitor/run.ts:182`), shutting down via
    `shutdownMonitor`; or **(b) not piped, or the measurement is not made** — drop the monitor half
    entirely and delete the "on both hosts" clause from "Done when", rather than shipping a line that
    cannot fire and claiming a property that does not hold.
    **What shipped is neither branch, because review found a third option that needs no
    measurement** (`armStdinEndExit` / `onStdinEnd`): arm and `resume()`, but discriminate the EOF by
    AGE — one inside a 5s grace is logged and discounted (it is the `/dev/null`, closed-at-spawn or
    inherited-already-at-EOF shape), and only an aged EOF exits. The ambiguous case therefore fails
    toward keeping the push path rather than toward killing it at startup, and a decline of any kind
    writes one stderr line saying this run has no host-exit detection. The residual is stated in the
    code: when the channel is absent or its EOF is discounted, an uncleanly-ended session still
    leaves the monitor retrying at the 30s cap.
- `src/channel/event-bridge.ts` needs no change — it passes no `onExhaustion` and inherits the loop;
  test 6 proves it. **Say so in the PR body** with the file correction: the wave-table names
  `src/monitor/sse-consumer.ts`, which does not exist; the module is `src/shared/sse-consumer.ts`.
- **Two doc corrections the change makes false.** `docs/architecture.md:530-535` enumerates "On
  exhaustion … 3. Calls `process.exit(1)`" — rewrite as: after `CHANNEL_MAX_RETRIES` consecutive
  failures the consumer reports once to `/api/channel-error`, writes the retrying notice to stdout
  and keeps retrying at the 30 s cap; it does not exit, and reports again after a recovery followed
  by a fresh outage. Same edit: `:530`'s rationale for the stable-uptime reset ("never exhausting the
  cap") is false once there is no cap — keep the rule, restate the reason as "resetting per event
  would let a connect-then-die flap re-arm the once-per-outage report on every cycle".
  `docs/mcp-tools.md:1408` — drop "before exiting after retry exhaustion", keep the 3-second deadline.
- Not engaged: Y.Doc writes, Y.Map keys, `/api` routes (`/api/channel-error` unchanged and already in
  `NON_LOOPBACK_ALLOWED`), MCP tools, `data-testid`, the shipped skill.

## Tests

**The sweep first — the blast radius is ~17 existing specs, not three.** Every suite driving the
consumer terminates only because the mocked `process.exit` *throws* out of the retry loop
(`tests/monitor/retry.test.ts:22-24`); with `while (true)` and no exit, `runEventConsumer` never
settles, so every trailing `await mainPromise` / `await promise` / `await p` hangs to a timeout. The
mechanical fix, everywhere, adds no hook in `src/`: **delete the trailing `await <promise>`** (it is
already `.catch(() => {})`-ed), keep the `await vi.advanceTimersByTimeAsync(...)` that drives the run
(adding a final `advanceTimersByTimeAsync(0)` where a microtask flush was relied on), and **delete
every `expect(exitSpy).toHaveBeenCalledWith(1)`**. Sites: `tests/monitor/retry.test.ts` (`:38-71`,
`:83-98`, `:101-114`, `:117-163`, `:203-214`), `tests/monitor/index.test.ts` (`:488-506`, `:512-529`),
`tests/monitor/mode-cache.test.ts` (`:167-184`), the eleven `start(h.mcp, URL)` sites in
`tests/channel/event-bridge.test.ts` and its exit assertion at `:566`. **Isolate the counters**: a
loop parked in a `fetch` when `afterEach` restores real timers resumes against the *next* spec's stub
and inflates its totals — so in every spec asserting a count, capture it into a per-spec local right
after the final `advanceTimersByTimeAsync` and make that spec's stub permanently throwing once
captured. Test-side discipline only.

1. `tests/monitor/retry.test.ts:38-71` — **keep the existing connect-then-die stub exactly as it is**
   (each attempt emits one frame, then `s.error(...)`). It is the only *connect*-then-fail shape in
   the suite and the only one that can catch a latch cleared on the handshake rather than on
   `onStable`; under a fail-always stub that regression is invisible. Per the sweep, drop the `await`
   and the exit assertion, rename, then across ≥ 8 cycles assert: `connectAttempts` ≥ 8 and the
   `process.exit` spy **never** called (an upper bound alone passes for a fix that still exits);
   `/api/channel-error` POSTed **exactly once** with `opts.errorCode`; the monitor's notice written
   to stdout **exactly once**, matched with `/retrying in the background/` and **not**
   `/tandem_checkInbox/` — this stub delivers an event per cycle and the per-event line
   (`src/monitor/run.ts:141-148`) contains that phrase too.
2. `tests/monitor/retry.test.ts:83-98` and `tests/monitor/index.test.ts:488-506` — the two
   never-connected arms. Drop the exit assertions (and, in the first, assert attempts ≥ 8); keep the
   `MONITOR_CONNECT_FAILED` POST assertion in the second. **Replace the negated strings**: they look
   for `"Tandem monitor disconnected"` / `/disconnected/i`, which the new line does not contain, so
   they would go vacuous and leave the `!everConnected` guard pinned by nothing. Assert stdout
   matches neither `/retrying in the background/` nor `/tandem_checkInbox/`.
3. `tests/monitor/index.test.ts:512-529` — drop the exit assertion; assert the notice matches
   `/retrying in the background/` **and** `/tandem_checkInbox/`, written once. Kills a fix that
   changes the loop but leaves the misleading remedy text.
4. New spec in `tests/monitor/retry.test.ts` — **recovery must survive `STABLE_CONNECTION_MS`.** Fail
   6 times, let a connect succeed and hold the stream open past 60 s of fake time so `onStable`
   fires. Assert `SSE connection restored` appears **exactly once**, the per-failure lines resume
   afterwards, and a *second* outage POSTs `/api/channel-error` a **second** time. That last half
   kills a latch set and never cleared; item 1 is its anti-flap other half.
5. `tests/channel/event-bridge.test.ts:551-567` — keep the POST assertion, rename, assert the process
   does not exit. The shim shares the consumer, so this is the second host's proof that one fix
   covered both.
6. `tests/monitor/shutdown.test.ts` — SIGINT/SIGTERM and EPIPE still exit, plus stdin-EOF coverage
   split the way the Fix bullet is. After this change stdin-EOF is the only exit a never-connected
   consumer has, so nothing else in the suite can catch its absence — but **a source-text grep cannot
   tell an inert handler from a working one**: it is equally green on a firing handler, on a
   registered handler that can never fire, and on the string sitting in a comment. So it is only
   enough where the host is already known to read stdin.
   - `src/channel/run.ts` — keep the source-text pin that the file contains
     `process.stdin.once("end"`, matching the source-text pins this track already uses.
   - `src/monitor/run.ts`, **under branch (a) only** — a *behavioural* spec: call `main()`, assert
     `process.stdin.resume` was called (spy), then emit `'end'` on `process.stdin` and assert the
     mocked `process.exit` fired via `shutdownMonitor`. Under branch (b) there is no monitor spec
     here, because there is no monitor stdin behaviour to pin.

## Done when

The consumer retries past `CHANNEL_MAX_RETRIES` without exiting on both hosts; the error report and
the stdout notice fire once per outage — an outage ending only at `STABLE_CONNECTION_MS` of
continuous uptime, so a connect-then-die flap reports once — and fire again on the next outage; the
notice names `tandem_checkInbox`; an unreachable server produces a bounded stderr trail with no `/5`
denominator; **a never-connected channel shim whose stdin closes still exits** — and the monitor too
under branch (a) of the stdin-EOF bullet, the only branch that adds a monitor stdin line;
`docs/architecture.md` and `docs/mcp-tools.md` no longer describe the exit; `npm run typecheck` +
`npx vitest run tests/monitor tests/channel` + `node scripts/ci/monitor-smoke.mjs` green.

**Files touched.** `src/shared/sse-consumer.ts`, `src/monitor/run.ts`, `src/channel/run.ts`
(stdin-EOF only), `docs/architecture.md`, `docs/mcp-tools.md`, and the test files named above.

## Not in scope

`CHANNEL_MAX_RETRIES` / `CHANNEL_RETRY_DELAY_MS` / `RETRY_MAX_DELAY_MS` values; the EPIPE exit; the
`onStable` 60 s reset; `ensureTandemServer`'s fail-fast for `tandem channel`'s own startup; making
`/api/channel-error` visible in the browser. Also left alone, and named in the PR body: the
oversize-buffer throw at `src/shared/sse-consumer.ts:382-386` cannot advance `lastEventId`, so
without the cap the same >1 MB frame is re-fetched every 30 s for the session — its fix is already
recorded at `docs/plans/2026-08-07-channel-flag-removal.md` Stage 1b item 3.

## Review corrections (scope cut)

The round 1–3 logs were replaced by this section. Their load-bearing adoptions survive above: the
`>=` + latch trigger, the `onStable` latch clear (not the handshake), the sweep inventory, the
replaced negated strings, and the stdin-EOF bullet.

**Finding fixed directly.** *#1804 deletes the only self-termination path from two processes with no
parent-death detection.* Verified: the remaining inventory is signals + `onStdoutError`, and the kept
`!everConnected` guard means a never-connected monitor never writes to stdout, so EPIPE never fires.
Fixed by the stdin-EOF bullet — one line per host, mirroring `mcp-stdio.ts:1225-1231` — plus test
item 6 and a "Done when" clause; `src/channel/run.ts` joins the file set for that line.

**Removed.** The exact-count log calibration in item 1 (`/Retrying in \d+ms/` numbering exactly
`CHANNEL_MAX_RETRIES - 1`, with a parenthetical inviting the implementer to adjust it, plus the
`no line matches /\/5\b/` sweep): counting log lines to a fixed integer calibrates a string, not
behaviour, and the spec itself could not decide the number — the error POST and the stdout notice
each firing exactly once across ≥ 8 cycles still pins the suppression. Also removed: the
`docs/mcp-tools.md:1403` paragraph explaining why a sample string is *not* being changed, and the
separate items 2/3 split, merged above.

## Review corrections (post-cut)

Two findings, both on the stdin-EOF bullet the scope-cut round added, and both adopted directly.

**The bullet's own safety property did not hold on the monitor, and its only check was green
anyway.** `process.stdin.once("end", …)` fires in `src/cli/mcp-stdio.ts` only because
`await stdio.start()` runs first and `StdioServerTransport` attaches a stdin `data` listener, putting
the stream in flowing mode; `src/channel/run.ts:203-204` does the same for the shim. The monitor
reads stdin nowhere — verified this round, `grep -n "stdin\|resume(" src/monitor/run.ts
src/monitor/index.ts` returns only prose comments at `run.ts:26` and `:133` — so an `'end'` listener
alone never fires (measured on Node 22 with stdin at `/dev/null`) and the fix would have shipped the
orphan-forever monitor it exists to prevent. The bullet is now split per host: verbatim mirror for
the channel shim; for the monitor, an explicit UNMEASURED flag on whether the plugin host pipes
stdin, branch (a) pairing `process.stdin.resume()` with the handler if it does, and branch (b)
dropping the monitor half outright if it does not. `resume()` is not prescribed unconditionally
because it is fatal the other way — Claude Code spawns monitors with `spawn(cmd, [], { shell: true })`
(`docs/architecture.md:499`), and a `/dev/null` or already-closed stdin would make the monitor exit at
startup, killing the push path.

**Two corrections that came with it.** The bullet claimed `grep -n "stdin" src/monitor/run.ts
src/channel/run.ts` "returns nothing today"; it returns two prose hits in the monitor, and is
accurate only for `src/channel/run.ts`. And test item 6's source-text grep is green in all three
states (working, registered-but-inert, string-in-a-comment), so it now covers only the channel host,
with the monitor half replaced by a behavioural spec — `main()`, assert the `resume` spy, emit
`'end'`, assert the mocked exit via `shutdownMonitor` — that exists only under branch (a). The
"Done when" clause dropped its unconditional "on both hosts" to match.
