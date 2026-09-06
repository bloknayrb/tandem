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
- **Report exactly once per outage, at the same threshold — keep the `>=`.** A
  module-level `let reportedExhaustion = false`. When
  `retries >= CHANNEL_MAX_RETRIES && !reportedExhaustion`, set it, POST `/api/channel-error` with
  `opts.errorCode` as today, and call `opts.onExhaustion?.({ everConnected })` — then **continue
  looping**. The `!reportedExhaustion` latch is what makes the report once-per-outage; the threshold
  comparison is not. Since the recovery bullet below clears the latch in `onStable` — the same
  callback that already does `retries = 0` — the two are now reset **together**, so a `===` test
  would also be satisfiable on the next outage. Keep `>=` anyway: it is the form that cannot go
  permanently silent if a later edit ever breaks that coupling (reset one without the other and
  `===` is never true again for the life of the process), and it costs nothing.
  `CHANNEL_MAX_RETRIES` keeps its name and value and becomes "how many failures before we say
  something out loud", which the log line must reflect:
  `SSE connection lost after ${CHANNEL_MAX_RETRIES} retries; still retrying` replaces
  `SSE connection exhausted, reporting error and exiting`.
- **Fix the two per-failure log lines, which an unbounded loop turns into nonsense.**
  `:177-181` writes `SSE connection failed (${retries}/${CHANNEL_MAX_RETRIES})` and `:210-213`
  writes `Retrying in ${delay}ms (attempt ${retries}/${CHANNEL_MAX_RETRIES})` — with `retries` now
  unbounded those read "(47/5)", and at the 30 s cap they are two stderr lines every 30 s forever
  for a session whose Tandem is simply not running. Drop the `/${CHANNEL_MAX_RETRIES}` denominator
  from both (they are an attempt counter now, not a budget), and **suppress both while
  `reportedExhaustion` is set**, re-enabling them in `onStable` when the recovery clears it. A long
  outage then costs a bounded five failure lines, one "still retrying" line, and one "restored" line
  — which is the wave-table's "single legible log line", not a flood.
- **Say so on recovery — in `onStable`, not at the handshake.** The `onStable` callback in
  `runEventConsumer` (`src/shared/sse-consumer.ts:173-175`, armed at `:278` and cleared in
  `connectAndStreamOnce`'s `finally` at `:499`, so it fires only after `STABLE_CONNECTION_MS` of
  *continuous* uptime) already owns `retries = 0`. Add to it: if `reportedExhaustion`, clear it —
  which re-enables the per-failure lines — and
  `console.error(\`${opts.logPrefix} SSE connection restored\`)`.
  **Do not put any of this on the `everConnected = true` line (`:274`).** That line runs on *every*
  successful handshake, not the first — its own in-place comment says so. A link that handshakes and
  dies inside `STABLE_CONNECTION_MS` (a permanently-replayed oversize frame, `:382-386`; a server
  restarting in a loop; `tests/monitor/retry.test.ts:38-71`'s stub, which is exactly this shape)
  would then clear the latch on every cycle, so `retries >= CHANNEL_MAX_RETRIES &&
  !reportedExhaustion` goes true again on every cycle and the report **and the stdout notice** fire
  every ~30 s forever. Each of those stdout writes becomes a model turn on CC 2.1.226
  (`docs/architecture.md`, Plugin Monitor section), so that variant is an unbounded stream of
  unsolicited model turns and one `/api/channel-error` POST per cycle — strictly worse than today's
  single line and exit, and the exact regression this issue must not trade for. Clearing the latch
  where `retries` is reset makes the two reset together and makes "once per outage" literally true,
  an outage ending only when the link has been healthy for `STABLE_CONNECTION_MS`. The visible cost
  is that the restored line arrives 60 s after the reconnect rather than at once; that is the right
  trade for a line whose whole job is to be true when it is read.
- **Correct `runEventConsumer`'s own doc comment** (`src/shared/sse-consumer.ts:150-156`), which
  states the deleted behaviour verbatim: "Reports `opts.errorCode` to `/api/channel-error` and calls
  `process.exit(1)` after `CHANNEL_MAX_RETRIES` consecutive failures." It becomes: reports once to
  `/api/channel-error` after `CHANNEL_MAX_RETRIES` consecutive failures and keeps retrying at the
  capped backoff; it never exits, and it reports again after an outage that follows
  `STABLE_CONNECTION_MS` of recovered uptime.
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
  **Say this in the PR body**, along with the file correction: the wave-table names
  `src/monitor/sse-consumer.ts`, which does not exist; the module is `src/shared/sse-consumer.ts`
  and it has two hosts (`src/monitor/run.ts:193` and `src/channel/event-bridge.ts:19-33`), so the
  shim inherits the fix with no shim edit — which is what test 6 below proves.
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

The seven specs below are the ones whose *assertions* change, over and above that sweep.

**Every string these specs negate must be updated in the same edit that changes the line it
negates.** Two of them today assert the absence of `"Tandem monitor disconnected"` /
`/disconnected/i`; the new notice contains neither substring, so leaving them as they are makes both
vacuous and leaves the `!everConnected` silence guard pinned by nothing. Items 2 and 3 below carry
that.

1. `tests/monitor/retry.test.ts:38-71` — **keep the existing connect-then-die fetch stub exactly as
   it is** (each `/api/events` attempt emits one frame, then `s.error(...)`). Do **not** replace it
   with a fail-always connect: that stub is the only *connect*-then-fail shape in the suite, and it
   is the only shape that can catch a latch cleared on the handshake rather than on `onStable`.
   Under a fail-always stub the latch is never cleared and every other spec here passes while that
   regression is invisible. Drop the `await mainPromise` and the exit assertion (per the sweep),
   rename, and assert across ≥ 8 connect/fail cycles:
   - `connectAttempts` ≥ 8 and the `process.exit` spy is **never** called. That inequality is the
     unbounded-retry discriminator; an upper bound alone would pass for a fix that still exits.
   - `/api/channel-error` is POSTed **exactly once**, and its body still carries `opts.errorCode`.
   - `process.stdout.write` receives the monitor's notice **exactly once** (the handshake succeeds
     each cycle, so `everConnected` is true and the guard does not suppress it). This pair is what
     discriminates a per-cycle latch clear from a per-outage one; no other specced test does.
   - stderr: lines matching `/SSE connection failed/` number **exactly `CHANNEL_MAX_RETRIES`** (the
     suppression holds after the report), and **no** emitted line matches `/\/5\b/`. That is the
     "single legible log line" half of Done-when, which nothing pinned before.
2. `tests/monitor/retry.test.ts:83-98` (`"stays silent on stdout when it never connected"`) — the
   never-connected arm. Drop the `await mainPromise` and the exit assertion; assert attempts ≥ 8.
   **Replace the negated string**: it looks for `"Tandem monitor disconnected"`, which the new line
   does not contain. Assert stdout matches neither `/retrying in the background/` nor
   `/tandem_checkInbox/`.
3. `tests/monitor/index.test.ts:488-506` (`"…but stays SILENT when it never connected"`) — keep the
   `MONITOR_CONNECT_FAILED` POST assertion, drop the exit assertion, and **replace
   `not.toMatch(/disconnected/i)`** with `not.toMatch(/retrying in the background/)` and
   `not.toMatch(/tandem_checkInbox/)`. This is the spec that keeps the `if (!everConnected) return`
   guard honest.
4. `tests/monitor/index.test.ts:512-529` (`"writes the stdout notice when a live stream is lost"`) —
   drop the exit assertion; assert the notice matches `/retrying in the background/` **and**
   `/tandem_checkInbox/`, and that it is written **once**. Kills a fix that changes the retry loop
   but leaves the misleading remedy text.
5. New spec (`tests/monitor/retry.test.ts`) — **recovery, and the recovery must survive
   `STABLE_CONNECTION_MS`.** Fail 6 times, then let a connect succeed and **hold the stream open
   past `STABLE_CONNECTION_MS`** (advance fake time > 60 s with the `ControllableStream` alive) so
   `onStable` fires. Assert stderr contains `SSE connection restored` **exactly once**, that the
   per-failure lines resume afterwards (they were suppressed while the latch was set), and that a
   *second* outage of `CHANNEL_MAX_RETRIES` failures POSTs `/api/channel-error` a **second** time.
   That last half kills a latch that is set and never cleared. State the hold requirement in the
   spec's own comment: a recovery shorter than `STABLE_CONNECTION_MS` deliberately reports nothing
   new — that is the anti-flap property item 1 pins, and the two specs are the two halves of one
   contract.
6. `tests/channel/event-bridge.test.ts:551-567` — `"POSTs CHANNEL_CONNECT_FAILED after exhausting
   CHANNEL_MAX_RETRIES and exits 1"`: keep the POST assertion, rename, and assert the process does
   not exit. The shim shares the consumer, so this is the second host's proof that one fix covered
   both.
7. `tests/monitor/shutdown.test.ts` untouched: SIGINT/SIGTERM and EPIPE still exit.
   `tests/monitor/index.test.ts` is **not** untouched — see the sweep above.

## Done when

The consumer retries past `CHANNEL_MAX_RETRIES` without exiting on both hosts; the error report and
the stdout notice fire **once per outage**, where an outage ends only at `STABLE_CONNECTION_MS` of
continuous uptime — so a connect-then-die flap reports once, not once per cycle — and fire again on
the next outage after such a recovery; the monitor's notice names `tandem_checkInbox`; a server that
is unreachable, or that flaps without ever staying up 60 s, produces a bounded stderr trail
(`CHANNEL_MAX_RETRIES` failure lines plus one "still retrying" line, then silence), none of them
carrying a `/5` denominator; `docs/architecture.md` and `docs/mcp-tools.md` no longer describe the
exit; `npm run typecheck` + `npx vitest run tests/monitor tests/channel` +
`node scripts/ci/monitor-smoke.mjs` green.

## Not in scope

`CHANNEL_MAX_RETRIES` / `CHANNEL_RETRY_DELAY_MS` / `RETRY_MAX_DELAY_MS` values; the EPIPE exit; the
`onStable` 60 s stable-uptime reset; `ensureTandemServer`'s fail-fast for `tandem channel`'s own
startup (the shim's stdio transport genuinely cannot answer); making `/api/channel-error` visible
in the browser.

**One trade this change makes, named so a reviewer does not have to find it.** The oversize-buffer
throw at `src/shared/sse-consumer.ts:382-386` fires *before* any frame boundary is found, so it is
the one remaining throw that cannot advance `lastEventId`; the reconnect re-sends the same
`Last-Event-ID` and `replaySince` (`src/server/events/queue.ts:416`) re-delivers the same frame.
Today `CHANNEL_MAX_RETRIES` gives that a bounded death; after this change it becomes a permanent
re-fetch of a >1 MB frame every 30 s for the life of the session. That scenario, and its fix
(dropping the over-length buffer and continuing, matching the file's own "advance past garbage"
frame-skip policy at `:38-44`), are already recorded at
`docs/plans/2026-08-07-channel-flag-removal.md` Stage 1b item 3 and are deliberately left there —
this PR is the minimal exit removal, not the frame-skip widening.

## Review corrections (round 1)

**Adopted**

- *`retries === CHANNEL_MAX_RETRIES` is satisfiable at most once per process, so every outage after
  the first would report nothing and test 4 could not pass.* Verified: `retries` is function-local
  (`src/shared/sse-consumer.ts:164`) and reset only by `onStable` (`:173-175`), armed 60 s after a
  handshake (`:278`), while `everConnected = true` (`:274`) — where the latch is cleared — runs on
  every handshake. Adopted: the trigger is now `retries >= CHANNEL_MAX_RETRIES &&
  !reportedExhaustion`, with the reason stated inline so it is not "simplified" back, and test 4
  now says explicitly that the recovery need not survive `STABLE_CONNECTION_MS`. (Three separate
  findings made this point; one correction covers all three.) **Partly superseded in round 2:** the
  `>=` stays, but the latch clear moved from the handshake to `onStable`, so a recovery must now
  survive `STABLE_CONNECTION_MS` to re-arm the report. See round 2 below.
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

## Review corrections (round 2)

**Adopted**

- *Clearing `reportedExhaustion` at `everConnected = true` fires the report and the stdout notice
  once per retry CYCLE on any connect-then-fail loop, not once per outage — an unbounded stream of
  unsolicited model turns — and rewriting test 1 to a fail-always stub deletes the only spec that
  exercises that shape.* Verified: `src/shared/sse-consumer.ts:274` runs on every handshake (its own
  comment says so), `retries` is reset only by `onStable` at `:173-175`, and
  `tests/monitor/retry.test.ts:38-71` is exactly the connect-then-die shape. Adopted in full: the
  latch clear and the `SSE connection restored` line moved into the `onStable` callback, which
  already owns `retries = 0`, so both reset together; test 1 now **keeps** the existing stub and
  asserts one POST and one stdout write across ≥ 8 cycles; test 5 (was 4) holds the recovered stream
  past `STABLE_CONNECTION_MS`; Done-when restated. (Two findings made this point; one correction
  covers both.)
- *The `>=` rationale is now wrong in its own terms.* Adopted: `>=` is kept, but as defence in depth
  — with the latch and `retries` reset together by `onStable`, `===` would also work; `>=` is the
  form that cannot go permanently silent if that coupling is ever broken.
- *The two never-connected SILENCE specs negate `"Tandem monitor disconnected"` / `/disconnected/i`,
  strings the new notice does not contain, so both become vacuous and the `!everConnected` guard
  ends up pinned by nothing.* Verified at `tests/monitor/retry.test.ts:95` and
  `tests/monitor/index.test.ts:506`. Adopted: Tests items 2 and 3 now replace the negated strings
  with `/retrying in the background/` and `/tandem_checkInbox/`, under a general rule stated in the
  preamble.
- *Test 3 conflated the two specs inside the exhaustion describe; one of them must stay silent on
  stdout.* Verified: `tests/monitor/index.test.ts:488-506` is the never-connected arm, `:512-529`
  the notice arm. Adopted: split into items 3 and 4.
- *Done-when's "bounded stderr lines, none carrying a `/5` denominator" is asserted by no test.*
  Adopted: item 1 now spies `console.error` and asserts exactly `CHANNEL_MAX_RETRIES` lines matching
  `/SSE connection failed/` and zero matching `/\/5\b/`.
- *The `runEventConsumer` JSDoc at `src/shared/sse-consumer.ts:150-156` states the deleted behaviour
  verbatim and is not in the fix's file set.* Verified. Adopted as a new Fix bullet.
- *The unbounded loop turns the oversize-frame case into a permanent 30 s replay, and the spec does
  not record it.* Verified at `:382-386` (throw before any frame boundary, so `lastEventId` cannot
  advance) and `src/server/events/queue.ts:416`. Adopted as a named trade in Not-in-scope, pointing
  at the existing record in `docs/plans/2026-08-07-channel-flag-removal.md` Stage 1b item 3. The
  mitigation itself is not taken here: widening the frame-skip policy to the buffer-overflow branch
  is a second behaviour change in a different bug class, and the wave-table's rule for this track is
  minimal fixes in the named files.
- *The wave-table names `src/monitor/sse-consumer.ts`, which does not exist.* Verified: the module
  is `src/shared/sse-consumer.ts`, hosted by both `src/monitor/run.ts` and
  `src/channel/event-bridge.ts`. Adopted as a PR-body note on the `event-bridge.ts` Fix bullet.
- *The `>=` plus no-reset-on-reconnect means a flapping server reports per blip rather than per
  outage.* Adopted, and resolved rather than merely recorded: moving the latch clear to `onStable`
  is precisely what makes a blip report nothing. Test 1 is the spec that pins it.

**Not adopted**

- *Keep the `SSE connection restored` stderr line at the handshake "if a prompt signal is wanted",
  moving only the latch.* Not adopted. A handshake-time line reintroduces the flood the same
  finding's main half removes — the connect-then-die loop would print `restored` every ~30 s
  forever. The line goes where the latch goes, and the spec now states the 60 s delay as the
  deliberate price of a line that is true when it is read.
