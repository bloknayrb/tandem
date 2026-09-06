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
  burst on recovery. Latch `preflightFailed = true` alongside the first `deferredSynthesize(...)`;
  while it is set, the `!httpReady` branch answers `-32000` immediately via `sendErrorResponse`
  (dropping id-less notifications, exactly as `synthesizeBuffered` already does) instead of
  buffering. Clear it where `httpReady = true` is assigned. `captureHandshake` still runs first, so
  an `initialize` arriving during the outage is still captured for replay.
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
  `deferredHandshake = true` when the grace-window synthesis answers a captured `initialize`, and in
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
- Not engaged: Y.Doc writes, Y.Map keys, `/api` routes, MCP tools, `data-testid`,
  `NON_LOOPBACK_ALLOWED`, the shipped skill.

## Tests

`tests/cli/mcp-stdio.test.ts`. The two existing preflight specs pin the old contract and are
**rewritten, not deleted** — each gains the non-exit assertion it could not make before.

1. **Recovers and serves tools, with the full client sequence spelled out.** Spawn against a port
   with no listener. Write `initialize` (id 1) immediately and assert it is answered `-32000` (the
   grace-window synthesis — the outcome the fix deliberately keeps, not a defect). After ~2 s start
   a `makeSessionServer`-style `/health` + `/mcp` server on that port. Assert: `child.exitCode`
   stays `null` throughout; stderr contains `Tandem server reachable`; then write `tools/list`
   (id 2) **after** that line and assert it gets a real, non-`-32000` response for id 2, and that
   stderr contains `deferred handshake completed`. That last pair is what proves the baseline was
   seeded — without it id 2 answers `-32000` and stderr carries `no handshake baseline`. Kills a fix
   that logs better text but still exits, one that stops retrying after the first failure, and one
   that recovers the process without recovering the session.
2. **Guidance is emitted once and names the restart.** Dead port, wait through ≥3 backoff rounds
   (`BACKOFF_INITIAL_MS` 1 s, so ~4 s): stderr contains `restart the client` exactly once, and
   `preflight failed` exactly once. Kills a per-attempt logger (a 30 s-cap ladder writing three
   lines forever into a log the user is reading to find the one that matters).
3. **Backoff is capped and does not hot-loop — bounded on both sides.** Count `/health` requests
   reaching a server that answers 503 for 6 s: **at least 3 and at most 4** (1 s + 2 s + 4 s). The
   upper bound alone kills a per-tick storm; the lower bound kills the opposite regression — an
   implementation that logs once and returns without looping makes exactly one request and would
   pass an upper bound. (`tests/monitor/retry.test.ts:66-68` states the same principle for the
   monitor.)
4. **Rewrite `:425-452`** (`"synthesizes -32000 … on preflight failure"`): keep every existing
   assertion — id 99, code `-32000`, message `/not (running|ready)/i` — and add `expect(child.exitCode).toBeNull()` after it. This is the spec that stops a "just defer everything"
   implementation.
5. **Rewrite `:530`** (`"does not synthesize for notifications (no id) on preflight failure"`): it
   currently `await awaitClose(child)`, which can no longer happen. **The replacement window must
   straddle the grace deadline** — the `preflight failed` line and the grace timer are armed in the
   same block (`:1234-1243`) and `PREFLIGHT_GRACE_MS` is 1500, so "poll for the line, then wait
   1 s" asserts ~500 ms *before* `synthesizeBuffered` runs and would read empty even for an
   implementation that emits an id-less `-32000` — the one regression this spec exists to pin. Poll
   for `/preflight failed/i` on stderr, then wait `PREFLIGHT_GRACE_MS + 1000` (import the constant
   rather than hard-coding 2.5 s), then assert `errorReplies(output.stdout(), -32000)` is `[]`
   **and** `child.exitCode` is `null`. Strictly stronger than what it pinned before.
6. **The buffer does not swallow later requests.** With the upstream still down, write `tools/list`
   2 s after the `preflight failed` line (i.e. past the grace window) and assert it is answered
   `-32000` rather than nothing at all. Pins the `preflightFailed` latch; without it that request is
   buffered silently for the life of the outage.

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
