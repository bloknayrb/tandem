# F-runtime — #1805 the stdio bridge exits on preflight failure although Claude Desktop never respawns it, and the message names only step one

Branch `fix/push-paths-runtime-1759`. Closes #1805. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/shared-cli.md:17`. Probe: the two existing preflight specs
in `tests/cli/mcp-stdio.test.ts` (dead port `http://127.0.0.1:1`), which currently assert the exit
this issue calls a bug.

## Problem

`runMcpStdio` (`src/cli/mcp-stdio.ts`, currently `:1233-1249`) calls `deferredShutdown(...)` when
`probeTandemServer` fails, and `deferredShutdown` (`:725-727`) is `setTimeout(() => shutdown(1,
synth), PREFLIGHT_GRACE_MS)`. Claude Desktop spawns the bridge once at app start and does not
respawn a stdio server that exited, so starting Desktop before Tandem — both are login items —
leaves Tandem missing from Desktop for the rest of that Desktop run. The printed guidance
(`"Start the Tauri app or run \`tandem start\` on the host, then retry."`) names only step one:
following it changes nothing visible, because the process it was talking to is gone.

This is the same class as #1804 — a process that exits when nothing will restart it — and is fixed
the same way in both: keep the process alive and retry with a capped backoff. Neither fix
introduces a supervisor or a shared abstraction.

## Fix

All in `src/cli/mcp-stdio.ts`. Two changes at the preflight site plus one helper.

- **Keep the `-32000`, drop the exit.** Rename the grace-window helper to `deferredSynthesize({message, detail})`: the same `setTimeout(..., PREFLIGHT_GRACE_MS)`, but the callback runs
  `void synthesizeBuffered(message, detail)` and returns instead of calling `shutdown(1, …)`.
  Preserving the synthesis is deliberate and is the one place this diverges from the issue's
  "answer from a cached handshake or defer it": a deferred `initialize` trades an actionable error
  for a host-side hang, and #336's actionable-`-32000` property is pinned by
  `tests/cli/mcp-stdio.test.ts:425-452`. Fabricating a handshake is worse still — it would invent
  the `serverInfo`/`protocolVersion` baseline that #1759's fail-closed check depends on.
  `deferredShutdown` has exactly one other caller (the `http.start()` catch, below); after this it
  has none and is deleted.
- **Retry the preflight, capped, unbounded.** After `deferredSynthesize(...)`, `await
  waitForUpstream(baseUrl)` instead of `return`. `waitForUpstream` is a local `async` loop:
  `await sleep(delay)` → `await probeTandemServer({ url })` → return on `ok`, else
  `delay = Math.min(delay * 2, BACKOFF_MAX_MS)` starting from `BACKOFF_INITIAL_MS`. Reuse the two
  existing constants; add no new ones. `sleep` must `.unref()` its timer, matching every other
  timer in this file, so the wait cannot by itself hold the process open once stdio closes.
  Execution then falls through to the existing `http.start()` / `httpReady = true` / buffer-drain
  tail unchanged, so any stdin traffic arriving after recovery is served normally.
- **Do not keep buffering while the upstream is down.** `stdio.onmessage`'s `!httpReady` branch
  (`:750-755`) pushes into `preReadyBuffer` and returns; nothing arms a per-request timer there,
  because the timeout machinery lives inside `forwardToUpstream`. `synthesizeBuffered` is a one-shot
  (`preReadyBuffer.splice(0)`, `:656-657`), so with the exit removed every request arriving *after*
  the grace window would sit in that buffer with no reply, no timeout and no close — a host-side
  hang for the whole outage, and an unbounded buffer that `:1272-1273` would then replay in one
  burst on recovery. Add a `preflightFailed` latch; while it is set, the `!httpReady` branch answers
  `-32000` immediately via `sendErrorResponse` (dropping id-less notifications, exactly as
  `synthesizeBuffered` already does) instead of buffering. Clear it where `httpReady = true` is
  assigned. `captureHandshake` still runs first, so an `initialize` arriving during the outage is
  still captured for replay.
  **Set the latch inside the `deferredSynthesize` callback, after `synthesizeBuffered` runs — not
  at the moment the timer is armed — and guard that callback on `!httpReady`.** Arming and latching
  together would mean the client's `initialize` almost never reaches `synthesizeBuffered`:
  `probeTandemServer` (`src/cli/preflight.ts:33-57`) resolves in ~1 ms against a dead port, so the
  latch would be set within milliseconds of spawn and every subsequent message would take the
  immediate-answer branch, leaving the grace window (`PREFLIGHT_GRACE_MS` = 1500,
  `src/cli/mcp-stdio.ts:67`) with an empty buffer. Latching after the synthesis keeps the existing
  grace-window semantics that `tests/cli/mcp-stdio.test.ts:425-452` pins, and only *then* switches
  to immediate answers. The `!httpReady` guard covers the other ordering: `BACKOFF_INITIAL_MS` is
  1000, so a recovery on the first retry probe sets `httpReady = true` and drains the buffer at
  ~1 s — before the 1.5 s grace timer fires — and the callback must not then synthesize errors for
  requests that were already forwarded, nor arm a latch on a healthy bridge.
- **Seed the handshake baseline on the first post-recovery reconnect, or nothing works.** This is
  the load-bearing half. `synthesizeBuffered` consumes the client's `initialize` and answers it
  locally, so it is never forwarded and `captureNegotiated` (`:740-748`) never runs —
  `negotiatedProtocolVersion` stays `undefined`. After recovery the SDK transport holds no
  `Mcp-Session-Id`, so the client's next request 404s `-32001` at `dispatchToSession`
  (`src/server/mcp/server.ts:565-570`), `forwardToUpstream` calls `triggerReconnect` (which does
  **not** decline — `handshakeInit` was captured), `runReconnect` replays the handshake and then
  throws at `:1093-1099` (`no handshake baseline to verify the new upstream against ... refusing to
  adopt`), and the catch re-arms unconditionally at `:1200`. The result is a 30 s ladder minting a
  fresh server-side MCP session forever — strictly worse than today's exit. **Fix:** latch
  `deferredHandshake = true` **on every path where the bridge answers the captured `initialize`
  locally**, and in
  `runReconnect`'s `negotiatedProtocolVersion === undefined` branch, *when that latch is set*, seed
  `negotiatedProtocolVersion` / `negotiatedServerName` / `negotiatedServerVersion` from `identity`,
  clear the latch, write one stderr line (`deferred handshake completed against <url>; upstream
  session established`) and fall through to the replay tail rather than throwing. **This is not the
  fail-open that check guards**: the branch exists for "we had a session, lost it, and never learned
  what to expect"; here there was never a session and this *is* the first handshake, so the baseline
  it establishes is the baseline. With the latch clear the branch throws exactly as today, so
  #1759's fail-closed property is untouched. Reusing `runReconnect`'s replay this way is deliberate
  — the alternative, forwarding the handshake from the recovery site, would duplicate the
  replay-id / deadline / `initialized` machinery. The price is one 404 round-trip on the first
  post-recovery request; that request is queued for replay (`canReplay` is true, the 404 carries
  `-32001`) and gets a real answer.
  **"Every path" is two paths, and naming only the grace-window one is the bug this sentence
  prevents.** The bullet above adds a *second* sink for a locally-answered `initialize` — the
  `preflightFailed` immediate-answer branch — and an `initialize` that lands after the grace window
  (Claude Desktop and Tandem both login items on a cold boot is exactly that timing; the window is
  ~1.5 s from spawn because `probeTandemServer` fails in milliseconds against a dead port) takes
  that branch, not `synthesizeBuffered`. With the latch set only in the grace-window path,
  `captureHandshake` still stores `handshakeInit` (`:733-737`), `captureNegotiated` (`:740-748`)
  never runs, and the first post-recovery request lands on the 30 s "no handshake baseline" ladder
  this bullet exists to close. So: set `deferredHandshake = true` **wherever a `-32000` is
  synthesized for a request whose id is the captured `handshakeInit`'s id** — inside
  `synthesizeBuffered` (check the buffered messages for `method === "initialize"` before the splice)
  **and** in the `preflightFailed` immediate-answer branch (check the message being answered). One
  small shared predicate over the message, used at both sites, is the implementation; two
  independent conditions is how they drift.
- **Log once, naming both steps.** A latched `warnedPreflight` flag (same shape as
  `warnedNoHandshake` / `warnedUnrecognized404`) gates three stderr lines written on the *first*
  failure only:
  `Tandem server preflight failed at <url> (<reason>).` /
  `<kind-specific guidance>` /
  `Tandem's tools will not appear in this session until the server is reachable; if they are still missing after Tandem is running, restart the client (Claude Desktop does not respawn this bridge). Retrying in the background.`
  Subsequent failures write nothing. On recovery, one line: `Tandem server reachable at <url>;
  upstream ready.` No `console.log` — **stdout is reserved** (Critical Rule 3), and this process is
  the MCP wire.
- **Leave the `http.start()` catch (`:1254-1261`) as an exit.** It is documented as unreachable
  with the current SDK (`start()` only constructs an `AbortController`) and is defensive for a
  future SDK that performs I/O there; retrying an unknown future failure is speculation. Replace
  its `deferredShutdown` with an inline `setTimeout(() => void shutdown(1, {…}), PREFLIGHT_GRACE_MS)`
  so the helper can go. Stated in the PR body so a reviewer does not read it as an oversight.
- **Export `PREFLIGHT_GRACE_MS`.** It is a module-private `const` at `:67`, and tests 5, 6 and 8
  below have to straddle that deadline. `tests/cli/mcp-stdio.test.ts:8` already imports
  `describeServerInfo` / `isReplayId` / `nextBackoffMs` from this module, so a test-visible export is
  the existing pattern; the alternative — hard-coding 2500 in three specs — silently decouples them
  from the constant they are timing against.
- Not engaged: Y.Doc writes, Y.Map keys, `/api` routes, MCP tools, `data-testid`,
  `NON_LOOPBACK_ALLOWED`, the shipped skill.

## Tests

`tests/cli/mcp-stdio.test.ts`. The two existing preflight specs pin the old contract and are
**rewritten, not deleted** — each gains the non-exit assertion it could not make before.

1. **Recovers and serves tools, with the full client sequence spelled out.** Spawn against a port
   with no listener. Write `initialize` (id 1) immediately.
   **The server must not appear until id 1 has actually been answered — anchor on the event, never
   on a wall clock.** Read id 1's reply (or poll stderr for the synthesized answer) and assert
   `-32000` (the grace-window synthesis — the outcome the fix deliberately keeps, not a defect);
   equivalently, wait `PREFLIGHT_GRACE_MS + 1000` from the `preflight failed` line, which the Fix's
   export bullet makes available. **Only then** start a `makeSessionServer`-style `/health` + `/mcp`
   server on that port. A "start the server after ~2 s" formulation asserts the opposite of the
   guard this same spec introduces: the `!httpReady` guard on the `deferredSynthesize` callback
   exists precisely because `waitForUpstream`'s first probe lands at `BACKOFF_INITIAL_MS` = 1000 —
   *before* `PREFLIGHT_GRACE_MS` = 1500 — so if the child's `--import tsx` boot happens to consume
   ~1 s (the suite budgets seconds for it elsewhere: `tests/cli/monitor.test.ts:52-55`,
   `tests/cli/mcp-stdio.test.ts:1985`), the t≈1 s probe finds the server already up, the guard
   suppresses the synthesis, the buffered `initialize` drains through `forwardToUpstream`, and id 1
   gets a real `result`. Boot faster and it gets `-32000`. That is a coin flip on a required `check`
   job; sequencing on the observed reply removes it entirely.
   Then assert: `child.exitCode` stays `null` throughout; stderr contains `Tandem server reachable`;
   then write `tools/list` (id 2) **after** that line and assert it gets a real, non-`-32000`
   response for id 2, and that stderr contains `deferred handshake completed`. That last pair is
   what proves the baseline was seeded — without it id 2 answers `-32000` and stderr carries `no
   handshake baseline`. Kills a fix that logs better text but still exits, one that stops retrying
   after the first failure, and one that recovers the process without recovering the session.
2. **Guidance is emitted once and names the restart.** Dead port, wait through ≥3 backoff rounds.
   `waitForUpstream` sleeps *before* probing and doubles, so the retry probes land at t≈1 s, 3 s and
   7 s relative to the preflight failure — **wait ~8 s from the `preflight failed` line**, not ~4 s
   (at 4 s only two retry rounds have happened, and `--import tsx` boot pushes even those later).
   Then: stderr contains `restart the client` exactly once, and `preflight failed` exactly once.
   Kills a per-attempt logger (a 30 s-cap ladder writing three lines forever into a log the user is
   reading to find the one that matters).
3. **Backoff is capped and does not hot-loop — bounded on both sides.** Count `/health` requests
   reaching a server that answers 503: **at least 4 and at most 5**. The count **includes the
   initial preflight probe** — `waitForUpstream` sleeps *before* probing, so the probes land at
   t≈0 (preflight), 1 s, 3 s and 7 s, and t≈15 s is outside the window.
   **Anchor the window on the fake's first `/health` request — the t≈0 preflight probe — not on
   `spawn()`, and make it 9–10 s.** A spawn-anchored 8 s window puts the 4th probe 1 s inside it on
   a fast boot and *outside* it on a slow one, and the child is spawned under `--import tsx`, whose
   boot the suite budgets in seconds elsewhere (`tests/cli/monitor.test.ts:52-55`); the lower bound
   would then fail for timing rather than for behaviour. Starting the clock at the probe the child
   itself makes removes boot latency from the arithmetic entirely, and the extra second is margin,
   not slack — the 5th probe is at t≈15 s, well clear.
   The upper bound kills a per-tick storm; the lower bound kills the opposite regression — an
   implementation that logs once and returns without looping makes exactly one request and would
   pass an upper bound. (`tests/monitor/retry.test.ts:66-68` states the same principle for the
   monitor.)
4. **Rewrite `:425-452`** (`"synthesizes -32000 … on preflight failure"`): keep every existing
   assertion — id 99, code `-32000`, message `/not (running|ready)/i` — and then, **after a further
   `await sleep(PREFLIGHT_GRACE_MS + 1000)` so the window straddles the old grace deadline**, assert
   `child.exitCode` is `null`. The wait is what makes this the spec it claims to be: `shutdown()`
   synthesizes the `-32000` *first* and only then awaits `http.close()` and `stdio.close()` before
   `process.exit` (`:699-720`, reached from `deferredShutdown` at `:725-727`), so an assertion made
   at the moment `readOneLine` resolves passes against today's unfixed code and discriminates
   nothing.
5. **Rewrite `:530`** (`"does not synthesize for notifications (no id) on preflight failure"`): it
   currently `await awaitClose(child)`, which can no longer happen. **The replacement window must
   straddle the grace deadline** — the `preflight failed` line and the grace timer are armed in the
   same block (`:1234-1243`) and `PREFLIGHT_GRACE_MS` is 1500, so "poll for the line, then wait
   1 s" asserts ~500 ms *before* `synthesizeBuffered` runs and would read empty even for an
   implementation that emits an id-less `-32000` — the one regression this spec exists to pin. Poll
   for `/preflight failed/i` on stderr, then wait `PREFLIGHT_GRACE_MS + 1000` (imported from
   `src/cli/mcp-stdio.ts` per the export bullet in Fix, not hard-coded as 2.5 s), then assert
   `errorReplies(output.stdout(), -32000)` is `[]` **and** `child.exitCode` is `null`. Strictly
   stronger than what it pinned before.
6. **The buffer does not swallow later requests.** With the upstream still down, write `tools/list`
   2 s after the `preflight failed` line (i.e. past the grace window) and assert it is answered
   `-32000` rather than nothing at all. Pins the `preflightFailed` latch; without it that request is
   buffered silently for the life of the outage.
7. **The no-baseline branch still throws when the latch is clear** — the mutation that separates
   "seed only when `deferredHandshake` is set" from "always seed", and the only thing standing
   between #1805 and the fail-open #1759's check exists to stop. `grep -rn "no handshake baseline"`
   over `tests/` returns nothing today, so this branch has **zero** test referents and a fix that
   simply deletes the latch passes every other spec here.
   **Reach `negotiatedProtocolVersion === undefined` with `stallInitializes`, never with
   `retireSession`.** `retireSession` only clears `live` (`tests/cli/mcp-stdio.test.ts:1917-1919`),
   while the fake's `initialize` branch is unconditional (`:1866-1874` → `answerInitialize` at
   `:1808-1812`), which **re-mints** a session and answers 200 with `serverInfo`. So
   `captureNegotiated` (`src/cli/mcp-stdio.ts:740-748`) *does* run, `negotiatedProtocolVersion` is
   set, and `tools/list` id 2 presents the live session id and gets the 200 `{echo}` at
   `tests/cli/mcp-stdio.test.ts:1897-1898` — not the `-32000` the spec asks for. As first written
   this test was unbuildable, not merely wrong, and with it unbuildable a fix that deletes the
   `deferredHandshake` latch and seeds unconditionally still passes every other spec here.
   Instead reach the state the way `src/cli/mcp-stdio.ts:1082-1092`'s own comment describes. Spawn
   against a **healthy** `makeSessionServer` (preflight succeeds, so `preflightFailed` and
   `deferredHandshake` are never set) with a short `TANDEM_REQUEST_TIMEOUT_MS` — 300–500 ms, the
   value the suite already uses for this shape. Call `fake.stallInitializes(1)` **before** writing
   `initialize` id 1: the fake accepts it and never answers (held at `:1866-1874`). `captureHandshake`
   (`:733-737`) still stores `handshakeInit`, so a later reconnect is not declined, but
   `captureNegotiated` never runs. id 1 times out to `-32000`. Then write `tools/list` id 2: the SDK
   transport holds no `Mcp-Session-Id`, so the POST 404s `-32001`, `runReconnect` replays the
   handshake (the stall budget is spent, so the replay *is* answered) and must **throw**. Assert id 2
   answers `-32000`, stderr contains `no handshake baseline`, and stderr does **not** contain
   `deferred handshake completed`. (Adding a `fail404NextInitialize()` knob to the fake is an equally
   acceptable route to the same state; if you take it, say so in the test's comment.)
8. **An `initialize` that arrives after the grace window still recovers.** Variant of test 1 for the
   second local-answer sink: dead port, poll stderr for `/preflight failed/i`, wait
   `PREFLIGHT_GRACE_MS + 500` (so `synthesizeBuffered` has already run against an empty buffer),
   *then* write `initialize` id 1 and assert it is answered `-32000` promptly by the
   `preflightFailed` branch. Bring the server up, then write `tools/list` id 2 and assert it gets a
   real, non-`-32000` answer and that stderr contains `deferred handshake completed`. Without the
   latch being set on that second sink, id 2 answers `-32000` and stderr carries `no handshake
   baseline` — the failure test 1 cannot see because its `initialize` goes through the grace-window
   path.
9. **A recovery that beats the grace deadline synthesizes nothing** — the spec for the `!httpReady`
   guard, which round 2 added for a real ordering hazard and which every other test here leaves
   unexercised (tests 1, 4, 5, 6 and 8 all keep the server down past the deadline, so a fix that
   omits the guard passes all of them while synthesizing `-32000` for requests it had already
   forwarded and latching `preflightFailed` on a healthy bridge). Starting the server *before*
   spawning is not the spec — preflight would simply succeed and the branch never runs. Instead:
   spawn against a port with **no listener**, write `initialize` id 1 immediately, and bind a
   `makeSessionServer`-style listener on that port **~300 ms after spawn**, so recovery lands on
   `waitForUpstream`'s first probe at `BACKOFF_INITIAL_MS` = 1000 — inside `PREFLIGHT_GRACE_MS` =
   1500. Assert id 1 receives a real `result` (**not** `-32000`), and that stderr contains no line
   from the immediate-answer path. Then write `tools/list` id 2 and assert a real answer, proving
   the bridge is not latched. This is the one test whose server timing is deliberately a wall clock
   — the hazard *is* a race — so keep the 300 ms comfortably under the 1 s probe and state in the
   comment that a slow `--import tsx` boot makes this test pass vacuously rather than flakily
   (the server is up before preflight, preflight succeeds, and there is nothing to guard).

## Done when

A bridge started before Tandem **survives the outage, recovers the upstream and establishes a real
MCP session once Tandem appears**, so a request written after recovery is served rather than
answered `-32000`; no process exit; requests arriving during the outage get `-32000` promptly
instead of hanging; the guidance names both steps and appears once; the two rewritten specs assert
non-exit; `npm run typecheck` + `npx vitest run tests/cli/mcp-stdio.test.ts` +
`node scripts/ci/stdio-smoke.mjs` green.

**Scoped deliberately narrower than "no client restart".** The `initialize` that arrived during the
outage is still answered `-32000`, and a host that treats an error to `initialize` as terminal will
send nothing further no matter how healthy the bridge is — which is exactly why the new guidance
line tells the user to restart the client if tools are still missing. What the tests establish is
that the *bridge* no longer has to be restarted and no longer needs the host to respawn it; whether
Claude Desktop re-handshakes on its own is unverified here and is not claimed. Test 1 proves
recovery by writing to stdin after the fact.

## Not in scope

Synthesizing or caching a handshake so `initialize` can be answered while the upstream is down
(rejected above); making `ensureTandemServer` — the `tandem channel` preflight, which exits by
design because its stdio transport cannot answer — behave the same way; the `http.start()` catch;
the `PREFLIGHT_GRACE_MS` value.

## Review corrections (round 1)

**Adopted**

- *The specced recovery path could not restore service: the grace-window synthesis kills the
  buffered `initialize`, so the recovered transport has no session and no handshake baseline, and
  the first post-recovery request dead-ends in `runReconnect`'s "no handshake baseline" throw
  (`src/cli/mcp-stdio.ts:1093-1099`) with the ladder re-armed at `:1200` forever.* Verified end to
  end: `synthesizeBuffered` splices at `:656-657`, `captureNegotiated` at `:740-748` never runs,
  `dispatchToSession` 404s a session-less POST at `src/server/mcp/server.ts:565-570`, and
  `PREFLIGHT_GRACE_MS` (1500) always beats `BACKOFF_INITIAL_MS` (1000) for the outage this issue is
  about. Adopted as the new "seed the handshake baseline" Fix bullet — implemented by teaching
  `runReconnect`'s no-baseline branch to seed under a `deferredHandshake` latch rather than by
  duplicating the replay machinery at the recovery site. Test 1 and "Done when" rewritten to state
  what the client actually experiences, so the acceptance criterion and the user-facing message no
  longer disagree.
- *Keeping the process alive while `httpReady` is false turns every post-synthesis request into a
  silent hang and makes `preReadyBuffer` unbounded.* Verified at `:750-755` (no timer armed on that
  branch) and `:656-664` (one-shot splice). Adopted as the `preflightFailed` latch bullet, plus new
  test 6.
- *Test 5's rewritten window closes ~500 ms before the grace deadline, so it can no longer fail.*
  Verified: the `preflight failed` write and the grace timer are armed together at `:1234-1243`,
  `PREFLIGHT_GRACE_MS = 1500` at `:67`. Adopted — the wait is now `PREFLIGHT_GRACE_MS + 1000` from
  the imported constant, with the straddle requirement stated as the reason.
- *Test 1's payoff assertion is unachievable as written and never names the client sequence.*
  Adopted: test 1 now spells out `initialize` during the outage, its `-32000`, and the two stderr
  discriminators (`Tandem server reachable`, `deferred handshake completed`).
- *Test 3's retry bound is one-sided and would pass for a fix that never retries.* Adopted: now at
  least 3, at most 4.
- *The headline "serves tools ... with no client restart" is not established for Claude Desktop.*
  Adopted: "Done when" now scopes the claim to the bridge and records the host-behaviour half as
  unverified.

**Not adopted**

- None.

## Review corrections (round 2)

**Adopted**

- *The `preflightFailed` latch, armed at the same moment as the grace timer, means the client's
  `initialize` almost never reaches `synthesizeBuffered` — so `deferredHandshake` is never set and
  the post-recovery path lands on exactly the 30 s "no handshake baseline" ladder round 1 claimed to
  close; spec test 1 would fail.* Verified: `probeTandemServer` (`src/cli/preflight.ts:33-57`)
  resolves in ~1 ms against a dead port, `deferredSynthesize` is armed at `:1243` before the 1500 ms
  `PREFLIGHT_GRACE_MS` (`:67`) elapses, `:750-755` is the only producer of `preReadyBuffer`, and
  `tests/cli/mcp-stdio.test.ts:439-441` already records both orderings. Adopted: the latch is now set
  **inside** the `deferredSynthesize` callback, after `synthesizeBuffered` runs, and that callback is
  guarded on `!httpReady` so a recovery faster than `PREFLIGHT_GRACE_MS` (possible —
  `BACKOFF_INITIAL_MS` is 1000) cannot arm it.
- *The spec adds a second sink that answers `initialize` locally, and only one of the two sets the
  latch, so an `initialize` arriving after `PREFLIGHT_GRACE_MS` still dead-ends.* Verified against
  `captureHandshake` (`:733-737`), `captureNegotiated` (`:740-748`) and `runReconnect:1093-1099`.
  Adopted: the `deferredHandshake` bullet now says the latch is set wherever a `-32000` is
  synthesized for the captured `handshakeInit`'s id — both `synthesizeBuffered` and the
  `preflightFailed` immediate-answer branch, via one shared predicate — and new test 8 drives an
  `initialize` written *after* the grace window. (Two findings made this point; one correction
  covers both.)
- *Nothing pins the THROW side of the no-baseline branch, so a fix that drops the latch and seeds
  unconditionally passes every specced test — the fail-open #1759's check exists to stop.* Verified:
  `grep -rn "no handshake baseline\|refusing to adopt" tests/` returns nothing. Adopted as new test 7
  (healthy preflight, `retireSession` before the `initialize` POST lands, assert `-32000` +
  `no handshake baseline` + absence of `deferred handshake completed`).
- *Test 4's `expect(child.exitCode).toBeNull()` passes on today's unfixed code, so it is not the
  discriminator it claims to be.* Verified: `shutdown()` (`:699-720`) writes the `-32000` before
  awaiting `http.close()` / `stdio.close()`, so the child has certainly not exited when
  `readOneLine` resolves. Adopted: test 4 now waits `PREFLIGHT_GRACE_MS + 1000` past the reply
  before asserting non-exit, the same straddle test 5 already specifies.
- *Test 3's bounds are met only by counting the initial preflight probe, and land exactly on the
  lower bound with no margin.* Verified: `waitForUpstream` sleeps before probing, so retry probes
  land at t≈1 s, 3 s, 7 s. Adopted: the window widens to 8 s, the bound becomes at least 4 / at most
  5, and the spec states that the t≈0 preflight probe is included.
- *Test 5 asks the spec to import `PREFLIGHT_GRACE_MS`, which is module-private and which the Fix
  section never exports.* Verified at `:67` (no `export`). Adopted as a new Fix bullet exporting it,
  matching how `nextBackoffMs` and friends are already test-visible; tests 5, 6 and 8 all rely on it.
  (Three findings made this point; one correction covers all three.)

**Not adopted**

- None.

## Review corrections (round 3)

**Adopted**

- *Test 7 — the only pin on the fail-closed THROW side of the no-baseline branch — cannot construct
  the state it tests, so it is red as written and the fail-open it exists to stop stays unpinned.*
  Verified: the fake's `initialize` branch is unconditional (`tests/cli/mcp-stdio.test.ts:1866-1874`
  → `answerInitialize` at `:1808-1812`, which re-mints `live`), while `retireSession` (`:1917-1919`)
  only clears `live` — so `captureNegotiated` runs, `negotiatedProtocolVersion` is set, and id 2 gets
  the 200 `{echo}` at `:1897-1898`. Adopted: test 7 now reaches the no-baseline state with
  `fake.stallInitializes(1)` plus a short `TANDEM_REQUEST_TIMEOUT_MS` — the original `initialize` is
  accepted and never answered, so `handshakeInit` is captured but `captureNegotiated` never runs —
  and the reconnect fires off the 404 for `tools/list` id 2. The `fail404NextInitialize()` knob the
  finding offered as an alternative is named as acceptable rather than mandated.
- *Test 1's first assertion races the `!httpReady` guard the same spec introduces, so the test
  inverts its own expected outcome depending on subprocess boot latency.* Verified: the grace timer
  fires at `PREFLIGHT_GRACE_MS` = 1500 (`src/cli/mcp-stdio.ts:67`) while `waitForUpstream`'s first
  probe lands at `BACKOFF_INITIAL_MS` = 1000 (`:109`), and the suite budgets seconds for
  `--import tsx` boot (`tests/cli/monitor.test.ts:52-55`, `tests/cli/mcp-stdio.test.ts:1985`). A
  server bound at spawn+2 s after a ~1 s boot is found by the t≈1 s probe, the guard suppresses the
  synthesis, and id 1 gets a real `result` where the spec asserts `-32000`. Adopted: test 1 now
  sequences on the observed event — read id 1's `-32000` (or wait `PREFLIGHT_GRACE_MS + 1000` from
  the `preflight failed` line) **and only then** bring the server up — with the reason stated so the
  ordering is not "simplified" back to a wall clock.
- *Test 2's stated arithmetic is wrong: `waitForUpstream` sleeps before probing, so at 4 s only two
  retry rounds have occurred.* Verified against the same sleep-then-probe shape test 3 already
  documents. Adopted: corrected to ~8 s from the `preflight failed` line, with the t≈1/3/7 s probe
  schedule spelled out.
- *Test 3's bounds have effectively zero lower-side margin and no stated window anchor, reproducing
  the flakiness the round-2 correction was trying to remove.* Adopted: the window now opens at the
  fake's **first `/health` request** (the t≈0 preflight probe) rather than at `spawn()`, removing
  boot latency from the arithmetic entirely, and widens to 9–10 s while keeping "at least 4, at most
  5".
- *The `!httpReady` guard on the `deferredSynthesize` callback — added in round 2 for a real
  ordering hazard — is exercised by no specced test.* Verified: tests 1, 4, 5, 6 and 8 all keep the
  server down past the grace deadline, so an implementation that omits the guard passes every one of
  them. Adopted as new test 9 — dead port at spawn, listener bound ~300 ms later so recovery lands
  on the t≈1 s probe inside the 1.5 s window, asserting id 1 gets a real `result` and no
  immediate-answer line. The finding's own note that starting the server before spawn is *not* the
  spec (preflight would just succeed) is carried into the test's text, as is the fact that a slow
  boot makes this test vacuous rather than flaky.

**Not adopted**

- None.
