# Spec: surfacing "MCP session active" into AI-readiness (#1054 / #1018)

Status: **proposal — needs Bryan's decision on the readiness contract.**
Scope: the contained correctness fix is shipped in this PR (Option 1, dual-poll).
This note records the root-cause and the contract options so the longer-term
shape can be decided deliberately rather than implicitly.

## Root cause (both issues)

`useAiReadiness` (`src/client/hooks/useAiReadiness.svelte.ts`) derived readiness
**only** from the auto-launcher's `GET /api/launcher/status`. The launcher
(#477 PR 4) supervises a Claude Code process **it spawned**. It has no knowledge
of any other agent.

An agent can connect to Tandem **without** the launcher:

- The user launches Claude Code manually from a terminal in a project where the
  tandem MCP server is configured (the documented zero-config path).
- Any MCP client opens the streamable-HTTP transport at `:3479/mcp`.

In that case the launcher truthfully reports `{ available: true, running: false }`
→ readiness state `stopped` → the **"Restart Claude Code"** chip, *while tools
and chat are actively flowing*.

Consequences:

1. **#1054** — clicking the restart chip calls `relaunchClaudeCode()`, which
   spawns a **second** Claude Code instance alongside the live external session:
   two agents attached to the same documents.
2. **#1018 (the residual surface)** — the same false-`stopped` state makes
   `aiReadiness.chip` non-null, so chat/comment sends raise the
   "Message saved — no AI is connected yet" notice (`App.svelte`), telling the
   user their message won't be seen while Claude is in fact reading it.

### #1018's actual AI-call path

There is **no in-app outbound LLM call path** today. "AI" in Tandem is the
external Claude Code agent over MCP: it reads/writes the chat and annotation
Y.Maps via the 28 MCP tools (read-after-write on the CRDT). The in-app Models
registry (BYO API key) stores keys in the OS keychain but **no server-side LLM
client consumes them** — which is why it is gated behind `BYO_MODELS_ENABLED`
(off) as of #1022. So "connected but no AI" is never a silently-failing
downstream call; it is the readiness signal not reflecting a connected agent.
The remaining gap after #1028/#1029/#1031 is exactly the externally-launched
session that the launcher can't see — which this fix closes.

## The authoritative signal

The server already knows when an MCP client is connected:
`GET /health` returns `hasSession: boolean` (loopback-only, redacted for
non-loopback callers) — derived from `currentTransport !== null`
(`src/server/mcp/server.ts`). `currentTransport` is the open streamable-HTTP
transport; it read `true` for a connected-but-idle session during diagnosis, so
it reflects "a client is attached" rather than "a request is in flight".

## Options

### Option 1 — client dual-poll (SHIPPED in this PR)

`useAiReadiness` polls **both** `/api/launcher/status` and `/health`, and treats
`hasSession: true` as `ready` (promotion only — it never demotes a launcher-`ready`
state). Both fetches share the existing generation guard and fail-safe
("keep prior value on a blip").

- **Pros:** smallest blast radius; no wire-contract change; `/health` is already
  loopback-gated for that field; both issues fixed immediately; trivially
  revertible.
- **Cons:** two polls instead of one; readiness truth is now assembled
  client-side from two endpoints; a future consumer must remember both.

### Option 2 — server folds it into `LauncherStatus`

Add an `mcpSessionActive?: boolean` (loopback-only) field to `LauncherStatus`
(`src/shared/launcher/contract.ts`); the status handler reads the transport
state (via a `() => boolean` getter, mirroring `getSupervisor`) and the client
keeps a **single** status source.

- **Pros:** one client poll; readiness has one authoritative endpoint; the
  "an agent is connected, supervised or not" fact lives server-side where it's
  cheapest to compute correctly.
- **Cons:** a wire-contract change — touches the contract, the status handler's
  redaction logic (the field must be loopback-only and omitted from the
  `minimal` shape), the route's late-bound deps, and tests. It also entangles
  two independent concerns (process supervision vs. transport presence) in one
  struct. The launcher routes are HTTP-mode-only; `hasSession` is meaningful
  even in configurations where the launcher is `available: false`, so the field
  semantics ("session active even though the launcher isn't supervising it")
  need a clear contract note.

### Option 3 — a dedicated readiness endpoint

A new `GET /api/ai-readiness` that returns the *resolved* state
(`ready | stopped | unconfigured`) computed server-side from launcher + transport.

- **Pros:** single source of truth, no client-side assembly, easy to extend when
  a real outbound LLM client lands (it can fold in model availability too).
- **Cons:** most code; a new route + contract + tests; premature until the
  readiness model stabilizes (BYO models still gated off).

## Recommendation

> **Qualified 2026-07-30 (#1249):** Option 2 should no longer be adopted as
> written — see §"Stateless MCP (`2026-07-28`) changes what this signal can
> mean" below.

**Ship Option 1 now** (done) to stop the second-agent footgun and the false
notice, then **adopt Option 2** when the readiness model is next touched — most
naturally alongside re-enabling `BYO_MODELS_ENABLED`, when the client will want a
single endpoint that answers "can AI act?" across supervised process, external
session, and (eventually) in-app model. Option 3 is the right shape only once
that third input exists. **Bryan's call** on whether to pull Option 2 forward
into this change or keep it as a follow-up.

## Stateless MCP (`2026-07-28`) changes what this signal can mean — added 2026-07-30 (#1249)

Everything above assumes the server can observe *attachment*. MCP revision
[`2026-07-28`](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
removes protocol-level sessions ([SEP-2567](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2567))
and the `initialize` handshake ([SEP-2575](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2575)).

**Not urgent, and not broken.** The newest published SDK (1.30.0, the version
`package-lock.json` pins) still exports `LATEST_PROTOCOL_VERSION = '2025-11-25'`.
This section is scoped to the SDK bump that adopts the new revision.

**And the signal degrades rather than dying.** The revision permits a *dual-era*
server serving both handshake and stateless clients on one endpoint, and
[ADR-045](../decisions.md#adr-045-mcp-transport-multiplexing--one-mcpserver-per-session-keyed-by-mcp-session-id)'s
amendment argues Tandem must be one — legacy clients have no fall-forward, so
dropping the legacy branch breaks every un-upgraded install. On a dual-era server
`hasSession` stays sound *for legacy attachments* and goes silent about modern
ones. The task is therefore to **supplement** it, not replace it.

### What specifically stops being true

§"The authoritative signal" above rests on one observed property: `hasSession`
"read `true` for a connected-but-idle session during diagnosis, so it reflects
*a client is attached* rather than *a request is in flight*." For a modern-era
client that property is gone. Post-ADR-045 the field is
`getMcpSessionCount() > 0`; modern clients never increment it.

**Option 2 must not be adopted as written.** It folds `mcpSessionActive?: boolean`
into the `LauncherStatus` *wire contract* — a two-valued field, in the surface
that is hardest to change, for a question that is about to need three values (see
below). If the readiness model is next touched before the SDK bump, prefer
Option 3's resolved-state endpoint, whose inputs can change without a contract break.

### The replacement answers a different question — and the demotion path is worse than it looks

The natural substitute is a last-MCP-request timestamp plus a staleness window.
It answers "has a client acted recently," not "is a client attached." An
idle-but-present Claude reads `false` once the window lapses.

**Correcting a mis-statement that was in an earlier draft of this section:**
`useAiReadiness` is *not* promotion-only with respect to `hasSession`.
`readHasSession()` writes `mcpSessionActive = fresh` whenever `fresh !== null`,
so a confident `false` demotes. Only `null` — network blip, non-OK, malformed
body, or the loopback-only field absent — is non-demoting. That matters because
it means a lapsed window produces **two** regressions, on different paths:

1. **The restart chip returns.** `state` falls through to launcher truth, which
   for an externally-launched session is `stopped` → the "Restart Claude Code"
   chip → clicking it spawns a second agent. This is #1054 exactly.
2. **The status pill goes dark, including in the auto-launched case.**
   `liveIndicator` is `if (!mcpSessionActive) return null`, with no launcher
   fallback, and `aiIndicatorView` ranks `liveIndicator === "connected"` above
   the booting gate. So a lapsed window blanks `status-ai-indicator` and
   suppresses the #651 "Claude is working" pill even where `state` stays `ready`
   and no chip ever appears — a second regression, with a different
   precondition, on the surface WS-B/#1210 was built for.

Also note `probeSession` returns `false` under a lapsed window, so the #1083
mitigation that exists to suppress the false "no AI is connected" notice stops
suppressing it.

**The cheap fix is already in the contract.** `fetchHasSession` is three-valued
(`boolean | null`) and its own comment says *"absence is unknown, not no session."*
Route a lapsed recency window to **`null`, not `false`**, and the existing
keep-prior-value fail-safe handles it — no new latch, no decay policy, no change
to either consumer. Decide this deliberately; it is the whole design.

`useReachabilityCheck` is a different case, not an equivalent one: `claudeConnected`
is a one-way latch behind a bounded 20-second poll deadline. Its failure mode is
that a freshly-restarted Claude which has not yet made a tool call never latches
inside 20s against a window measured in minutes.

### Build it from the clock that already exists — but measure its coverage first

`src/server/mcp/presence-expiry.ts` keeps a module-state freshness clock swept
against `PRESENCE_TTL_MS = 300_000`, including the reasoning for why the clock
lives in module state rather than in a CRDT field. Prefer extending it to adding
a second, differently-calibrated one.

Two gaps to close before trusting it, the second of which is easy to miss because
the module's own docblock overstates it: it is keyed **per document** while
`hasSession` is a global question; and it is **not** refreshed by "any MCP
activity." `noteClaudeActivity` has exactly two production callers —
`withTypingPresence` (which wraps only the mutating tools) and the `tandem_status`
write path. A read-mostly Claude (`getTextContent`, `getAnnotations`, `checkInbox`)
refreshes nothing, so deriving a global readiness signal from it as-is would
under-report an actively working agent — the same inverted failure one layer down.

Note also that **`ping` was removed** by SEP-2575, so the obvious cheap keepalive
is not available to backstop a recency signal.

### Two connection-oriented signals that survive, and were nearly overlooked

"There is nothing attached to observe" is too strong. Both of these answer the
attachment question without a recency window:

- **`subscriptions/listen`** is the revision's replacement for the GET stream: a
  single long-lived POST-response stream that stays open, so stream close is a
  real negative edge. Caveat: the client must opt in to notification types, so
  whether Claude Code opens one is a probe, not a given.
- **`/health`'s existing `push.subscribers`** — the channel shim's SSE consumer
  count — is a long-lived attachment on the Claude side that lives entirely
  outside the MCP protocol and is untouched by SEP-2567. Its caveats are already
  written down in `routes/health.ts` and `cli/doctor.ts` (structurally disjoint
  from the pull path; a positive count includes an attached-but-inert shim; only
  present when `withChannelShim` was configured), so it is not a drop-in — but it
  is connection-oriented with no inverted failure mode.

### Second-order: presence's negative edge — mostly already gone

`clearAllClaudePresence()` fires from `onsessionclosed` when the registry empties,
so session end is positive knowledge that Claude is gone. Stateless MCP removes
that signal for modern clients.

Worth knowing before treating this as a new loss: it fires **only** on an explicit
`DELETE /mcp`. It is not wired to LRU eviction or the idle reaper, so a crashed or
SIGKILLed Claude — the cases Decision 4's reaper exists for — already falls
through to the 5-minute presence TTL today. The stateless change widens an
existing gap rather than opening one. Decide whether a stale "Your AI is
thinking…" for up to five minutes is acceptable, or whether something else
supplies the negative edge.

## Verification note

The Tauri titlebar runtime (where the chip renders) can't be exercised in this
environment. Desktop verification — confirming the chip is suppressed with a
manually-launched session, and that `/health` `hasSession` flips correctly on
connect/disconnect — is Bryan's manual pass.
