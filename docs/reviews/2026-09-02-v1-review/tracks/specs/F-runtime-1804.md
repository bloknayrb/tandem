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
  `retries++`, the per-failure `console.error`, the existing
  `Math.min(CHANNEL_RETRY_DELAY_MS * 2 ** (retries - 1), RETRY_MAX_DELAY_MS)` delay and the
  `await new Promise(r => setTimeout(r, delay))`. Both `process.exit(1)` calls go, and with them the
  post-loop "retry loop exited unexpectedly" fallback (now unreachable by construction).
- **Report exactly once per outage, at the same threshold.** A module-level
  `let reportedExhaustion = false`. When `retries === CHANNEL_MAX_RETRIES && !reportedExhaustion`,
  set it, POST `/api/channel-error` with `opts.errorCode` as today, and call
  `opts.onExhaustion?.({ everConnected })` — then **continue looping**. `CHANNEL_MAX_RETRIES` keeps
  its name and value and becomes "how many failures before we say something out loud", which the
  log line must reflect: `SSE connection lost after ${CHANNEL_MAX_RETRIES} retries; still retrying`
  replaces `SSE connection exhausted, reporting error and exiting`.
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
- Not engaged: Y.Doc writes, Y.Map keys, `/api` routes (`/api/channel-error` is unchanged and
  already in `NON_LOOPBACK_ALLOWED`), MCP tools, `data-testid`, the shipped skill.

## Tests

1. `tests/monitor/retry.test.ts` — the spec at `:63-70` asserts `connectAttempts` is **exactly**
   `CHANNEL_MAX_RETRIES` because `process.exit` threw out of the loop. Rewrite it: with a
   fail-always connect and a fake-timer/attempt-capped harness, assert attempts exceed
   `CHANNEL_MAX_RETRIES` (e.g. ≥ 8) and the `process.exit` spy is **never** called. That inequality
   is the discriminator — an upper bound alone would pass for a fix that still exits.
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
   that is set but never cleared.
5. `tests/channel/event-bridge.test.ts:540-563` — `"POSTs CHANNEL_CONNECT_FAILED after exhausting
   CHANNEL_MAX_RETRIES and exits 1"`: keep the POST assertion, rename, and assert the process does
   not exit. The shim shares the consumer, so this is the second host's proof that one fix covered
   both.
6. `tests/monitor/index.test.ts` / `shutdown.test.ts` untouched: SIGINT/SIGTERM and EPIPE still
   exit.

## Done when

The consumer retries past `CHANNEL_MAX_RETRIES` without exiting on both hosts; the error report and
the stdout notice fire once per outage and again after a recovery; the monitor's notice names
`tandem_checkInbox`; `npm run typecheck` + `npx vitest run tests/monitor tests/channel` +
`node scripts/ci/monitor-smoke.mjs` green.

## Not in scope

`CHANNEL_MAX_RETRIES` / `CHANNEL_RETRY_DELAY_MS` / `RETRY_MAX_DELAY_MS` values; the EPIPE exit; the
`onStable` 60 s stable-uptime reset; `ensureTandemServer`'s fail-fast for `tandem channel`'s own
startup (the shim's stdio transport genuinely cannot answer); making `/api/channel-error` visible
in the browser.
