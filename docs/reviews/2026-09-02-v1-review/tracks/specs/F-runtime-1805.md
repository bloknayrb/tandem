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

1. **Recovers without a restart.** Spawn against a port with no listener, then start a
   `/health`-answering server on that port after ~2 s. Assert: `child.exitCode` stays `null`
   throughout; stderr eventually contains `Tandem server reachable`; a `tools/list` written
   **after** that line gets a real (non-`-32000`) response. Kills a fix that logs better text but
   still exits, and one that stops retrying after the first failure.
2. **Guidance is emitted once and names the restart.** Dead port, wait through ≥3 backoff rounds
   (`BACKOFF_INITIAL_MS` 1 s, so ~4 s): stderr contains `restart the client` exactly once, and
   `preflight failed` exactly once. Kills a per-attempt logger (a 30 s-cap ladder writing three
   lines forever into a log the user is reading to find the one that matters).
3. **Backoff is capped and does not hot-loop.** Count `/health` requests reaching a server that
   answers 503 for 6 s: at most 4 (1 s + 2 s + 4 s), never a per-tick storm. Kills a fix that drops
   the doubling or reuses a fixed 0 delay.
4. **Rewrite `:425-452`** (`"synthesizes -32000 … on preflight failure"`): keep every existing
   assertion — id 99, code `-32000`, message `/not (running|ready)/i` — and add `expect(child.exitCode).toBeNull()` after it. This is the spec that stops a "just defer everything"
   implementation.
5. **Rewrite `:530`** (`"does not synthesize for notifications (no id) on preflight failure"`): it
   currently `await awaitClose(child)`, which can no longer happen. Replace the close-wait with a
   poll for `/preflight failed/i` on stderr plus a further 1 s, then assert
   `errorReplies(output.stdout(), -32000)` is `[]` **and** `child.exitCode` is `null`. Strictly
   stronger than what it pinned before.

## Done when

A bridge started before Tandem serves tools once Tandem appears, with no client restart and no
process exit; the guidance names both steps and appears once; the two rewritten specs assert
non-exit; `npm run typecheck` + `npx vitest run tests/cli/mcp-stdio.test.ts` +
`node scripts/ci/stdio-smoke.mjs` green.

## Not in scope

Synthesizing or caching a handshake so `initialize` can be answered while the upstream is down
(rejected above); making `ensureTandemServer` — the `tandem channel` preflight, which exits by
design because its stdio transport cannot answer — behave the same way; the `http.start()` catch;
the `PREFLIGHT_GRACE_MS` value.
