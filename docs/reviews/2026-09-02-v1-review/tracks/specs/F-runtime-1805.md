# F-runtime — #1805 the stdio bridge exits on preflight failure although Claude Desktop never respawns it, and the message names only step one

Branch `fix/push-paths-runtime-1759`. Closes #1805. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/shared-cli.md:17`. Probe: the two existing preflight specs
in `tests/cli/mcp-stdio.test.ts` (dead port `http://127.0.0.1:1`), which today assert the exit this
issue calls a bug.

## Problem

`runMcpStdio` (`src/cli/mcp-stdio.ts:1233-1249`) calls `deferredShutdown(...)` when
`probeTandemServer` fails, and `deferredShutdown` (`:725-727`) is `setTimeout(() => shutdown(1,
synth), PREFLIGHT_GRACE_MS)`. Claude Desktop spawns the bridge once at app start and does not respawn
a stdio server that exited, so starting Desktop before Tandem — both are login items — leaves Tandem
missing from Desktop for the rest of that Desktop run. The printed guidance ("Start the Tauri app or
run `tandem start` on the host, then retry.") names only step one: following it changes nothing
visible, because the process it was talking to is gone.

Same class as #1804 — a process that exits when nothing will restart it — and fixed the same way in
both: keep the process alive and retry with a capped backoff. Neither adds a supervisor or a shared
abstraction.

## Fix

All in `src/cli/mcp-stdio.ts`.

- **Keep the `-32000`, drop the exit.** Rename the grace-window helper to
  `deferredSynthesize({message, detail})`: same `setTimeout(..., PREFLIGHT_GRACE_MS)`, but the
  callback runs `void synthesizeBuffered(message, detail)` and returns instead of `shutdown(1, …)`.
  Preserving the synthesis is deliberate — a deferred `initialize` trades an actionable error for a
  host-side hang (#336's property, pinned by `tests/cli/mcp-stdio.test.ts:425-452`), and fabricating a
  handshake is worse still. **Guard the callback on `!httpReady`**: `BACKOFF_INITIAL_MS` (1000) is
  shorter than `PREFLIGHT_GRACE_MS` (1500), so a recovery on the first retry probe can beat the timer
  and the callback must not synthesize errors for requests already forwarded.
- **Retry the preflight, capped, unbounded.** After `deferredSynthesize(...)`, `await
  waitForUpstream(baseUrl)` instead of `return` — a local `async` loop: `await sleep(delay)` →
  `await probeTandemServer({ url })` → return on `ok`, else `delay = Math.min(delay * 2,
  BACKOFF_MAX_MS)` from `BACKOFF_INITIAL_MS`. Reuse those constants; add none. `sleep` `.unref()`s
  its timer, matching every other timer here. Execution then falls through to the existing
  `http.start()` / `httpReady = true` / buffer-drain tail unchanged.
- **Do not keep buffering while the upstream is down.** `stdio.onmessage`'s `!httpReady` branch
  (`:750-755`) pushes into `preReadyBuffer` and arms no timer, and `synthesizeBuffered` is a one-shot
  (`:656-657`) — so with the exit removed every request arriving *after* the grace window would sit
  there with no reply and no timeout: a host-side hang for the whole outage plus an unbounded buffer
  replayed in one burst on recovery. Add a `preflightFailed` latch; while set, that branch answers
  `-32000` immediately via `sendErrorResponse` (dropping id-less notifications, as
  `synthesizeBuffered` already does). Clear it where `httpReady = true` is assigned. **Set it inside
  the `deferredSynthesize` callback, after `synthesizeBuffered` runs** — latching when the timer is
  armed would empty the grace window (`probeTandemServer` fails in ~1 ms against a dead port) and
  break the semantics `:425-452` pins.
- **Seed the handshake baseline on the first post-recovery reconnect, or nothing works.** The
  load-bearing half. A locally answered `initialize` is never forwarded, so `captureNegotiated`
  (`:740-748`) never runs and `negotiatedProtocolVersion` stays `undefined`; after recovery the
  transport holds no `Mcp-Session-Id`, the next request 404s `-32001`, `runReconnect` replays the
  handshake and then **throws** at `:1093-1099` with the ladder re-armed at `:1200` — a 30 s loop
  minting a fresh server session forever, strictly worse than today's exit. Fix: latch
  `deferredHandshake = true` **wherever a `-32000` is synthesized for a request whose id is the
  captured `handshakeInit`'s id** — **two** sinks, `synthesizeBuffered` and the `preflightFailed`
  branch, via **one shared predicate over the message** (two independent conditions is how they
  drift). Then in `runReconnect`'s `negotiatedProtocolVersion === undefined` branch, *when the latch
  is set*, seed `negotiatedProtocolVersion` / `negotiatedServerName` / `negotiatedServerVersion` from
  `identity`, clear the latch, write one stderr line (`deferred handshake completed against <url>;
  upstream session established`) and fall through to the replay tail instead of throwing. **Not the
  fail-open that check guards**: it exists for "we had a session, lost it, and never learned what to
  expect", whereas here this *is* the first handshake. With the latch clear the branch throws exactly
  as today, so #1759's property is untouched.
- **Log once, naming both steps.** Three stderr lines, written on the *first* failure only —
  which needs no latch: the preflight block is straight-line startup code and the retry ladder
  lives inside `waitForUpstream`, so it cannot re-enter. (An earlier draft specified a latched
  `warnedPreflight` flag; it guarded a block that can only run once, and was removed in review.)
  `Tandem server preflight failed at <url> (<reason>).` / `<kind-specific guidance>` /
  `Tandem's tools will not appear in this session until the server is reachable; if they are still missing after Tandem is running, restart the client (Claude Desktop does not respawn this bridge). Retrying in the background.`
  Subsequent failures write nothing; on recovery, one line: `Tandem server reachable at <url>;
  upstream ready.` No `console.log` — **stdout is reserved** (Critical Rule 3).
- **Leave the `http.start()` catch (`:1254-1261`) as an exit** — documented as unreachable with the
  current SDK, defensive for a future one. Replace its `deferredShutdown` with an inline
  `setTimeout(() => void shutdown(1, {…}), PREFLIGHT_GRACE_MS)` so the helper can go; say so in the
  PR body. **Export `PREFLIGHT_GRACE_MS`** (`:67`) — tests 3 and 5 straddle that deadline, and the
  test file already imports `isReplayId` / `nextBackoffMs` from this module.
- Not engaged: Y.Doc writes, Y.Map keys, `/api` routes, MCP tools, `data-testid`,
  `NON_LOOPBACK_ALLOWED`, the shipped skill.

## Tests

`tests/cli/mcp-stdio.test.ts`. The two existing preflight specs pin the old contract and are
**rewritten, not deleted**.

1. **Recovers and serves.** Spawn against a port with no listener; write `initialize` (id 1)
   immediately. **Sequence on the observed event, never a wall clock** — read id 1's reply and assert
   `-32000` (the grace-window synthesis, kept deliberately), *then* bind a `makeSessionServer`-style
   `/health` + `/mcp` server on that port. Bringing it up at a fixed "~2 s" instead races the
   `!httpReady` guard: on a slow `--import tsx` boot the t≈1 s probe finds it first and id 1 gets a
   real `result`. Then assert `child.exitCode` stays `null`; stderr contains `Tandem server
   reachable`; and `tools/list` (id 2) written **after** that line gets a real, non-`-32000` response
   with `deferred handshake completed` on stderr. That last pair proves the baseline was seeded —
   without it id 2 answers `-32000` and stderr carries `no handshake baseline`.
2. **Guidance is emitted once and names the restart.** Dead port; poll for `/preflight failed/i`,
   then wait past two retry rounds (`waitForUpstream` sleeps before probing, so probes land at t≈1 s
   and 3 s — wait ~4.5 s). Assert stderr contains `restart the client` exactly once, `preflight
   failed` exactly once, and `child.exitCode` is `null`. Kills a per-attempt logger and a fix that
   stops retrying.
3. **Rewrite the two existing preflight specs, each gaining the non-exit assertion it could not make
   before.** `:425-452` (`"synthesizes -32000 …"`) keeps every current assertion — id 99, code
   `-32000`, message `/not (running|ready)/i` — and then, after a further
   `await sleep(PREFLIGHT_GRACE_MS + 1000)`, asserts `child.exitCode` is `null`; the wait is what
   makes it a discriminator, since `shutdown()` writes the `-32000` *before* awaiting `http.close()`
   (`:699-720`). `:530` (`"does not synthesize for notifications (no id)"`) currently
   `await awaitClose(child)`, which can no longer happen: poll for `/preflight failed/i`, wait
   `PREFLIGHT_GRACE_MS + 1000` (imported, not hard-coded — the line and the grace timer are armed in
   the same block at `:1234-1243`, so a 1 s wait lands *before* `synthesizeBuffered` runs and reads
   empty even for a broken implementation), then assert `errorReplies(output.stdout(), -32000)` is
   `[]` **and** `child.exitCode` is `null`.
4. **The buffer does not swallow later requests.** Upstream still down: write `tools/list` 2 s after
   the `preflight failed` line (past the grace window) and assert it is answered `-32000` rather than
   nothing at all. Pins the `preflightFailed` latch.
5. **An `initialize` arriving after the grace window still recovers** — the second local-answer sink.
   Dead port; poll for `/preflight failed/i`, wait `PREFLIGHT_GRACE_MS + 500` (so
   `synthesizeBuffered` has already run against an empty buffer), *then* write `initialize` id 1 and
   assert the `preflightFailed` branch answers it `-32000` promptly. Bring the server up, write
   `tools/list` id 2, assert a real answer and `deferred handshake completed`. Without the latch on
   that second sink id 2 answers `-32000` — the failure test 1 cannot see.
6. **The no-baseline branch still throws when the latch is clear** — the mutation separating "seed
   only when `deferredHandshake` is set" from "always seed", and the only thing between this fix and
   the fail-open #1759's check exists to stop (`grep -rn "no handshake baseline" tests/` returns
   nothing today). **Reach `negotiatedProtocolVersion === undefined` with `stallInitializes`, never
   with `retireSession`**: the fake's `initialize` branch is unconditional (`:1866-1874` →
   `answerInitialize` at `:1808-1812`) and re-mints a session, while `retireSession` (`:1917-1919`)
   only clears `live`, so `captureNegotiated` *does* run and id 2 gets a 200. Instead spawn against a
   **healthy** `makeSessionServer` (so neither latch is set) with a short `TANDEM_REQUEST_TIMEOUT_MS`
   (300–500 ms, the value the suite already uses) and call `fake.stallInitializes(1)` **before**
   writing `initialize` id 1: `handshakeInit` is captured, never answered, and times out to `-32000`.
   Then `tools/list` id 2 404s session-less and drives `runReconnect` — assert id 2 answers `-32000`,
   stderr contains `no handshake baseline` and **not** `deferred handshake completed`.

## Done when

A bridge started before Tandem survives the outage, recovers the upstream and establishes a real MCP
session once Tandem appears, so a request written after recovery is served rather than answered
`-32000`; no process exit; requests arriving during the outage get `-32000` promptly instead of
hanging; the guidance names both steps and appears once; the two rewritten specs assert non-exit;
`npm run typecheck` + `npx vitest run tests/cli/mcp-stdio.test.ts` + `node scripts/ci/stdio-smoke.mjs`
green. **Scoped deliberately narrower than "no client restart":** the `initialize` that arrived
during the outage is still answered `-32000`, and a host treating that as terminal sends nothing
further — which is why the guidance says to restart the client if tools are still missing. The tests
establish that the *bridge* no longer has to be restarted; whether Claude Desktop re-handshakes on
its own is unverified and not claimed.

## Not in scope

Caching or fabricating a handshake so `initialize` can be answered while the upstream is down;
`ensureTandemServer` (the `tandem channel` preflight, which exits by design); the `http.start()`
catch; the `PREFLIGHT_GRACE_MS` value.

## Review corrections (scope cut)

The round 1–3 logs were replaced by this section; their load-bearing adoptions survive above (the
`deferredHandshake` seeding, the two-sink predicate, the `preflightFailed` latch, the `!httpReady`
guard, the `PREFLIGHT_GRACE_MS` export, the straddle waits in test 3).

**Findings fixed directly.** *The fail-closed spec could not construct the state it tests —
`retireSession` re-mints a session through the fake's unconditional `initialize` branch.* Verified at
`:1866-1874`, `:1808-1812`, `:1917-1919`; test 6 now uses `fake.stallInitializes(1)`, which already
exists (`:1771`, `:1925`), so no harness knob is added. *Test 1 raced the `!httpReady` guard,
inverting its own expected outcome on boot latency*: it now sequences on id 1's observed reply before
the server is bound, with the reason stated so it is not "simplified" back to a wall clock.

**Removed.** The retry-count spec (count `/health` requests in a 9–10 s window, "at least 4 and at
most 5") — calibration of an interval the issue does not name, ten seconds on a required `check` job,
bounds re-derived twice across rounds; tests 1 and 2 already discriminate "keeps retrying" from "gave
up". And the `!httpReady`-guard spec (bind a listener ~300 ms after spawn), whose own text conceded
it "passes vacuously rather than flakily" on a slow boot — a test that cannot distinguish its two
outcomes is not a pin. The guard is one condition on one callback, stated in Fix and accepted as
unpinned rather than pinned by a coin flip.
