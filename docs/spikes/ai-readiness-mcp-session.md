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

**Ship Option 1 now** (done) to stop the second-agent footgun and the false
notice, then **adopt Option 2** when the readiness model is next touched — most
naturally alongside re-enabling `BYO_MODELS_ENABLED`, when the client will want a
single endpoint that answers "can AI act?" across supervised process, external
session, and (eventually) in-app model. Option 3 is the right shape only once
that third input exists. **Bryan's call** on whether to pull Option 2 forward
into this change or keep it as a follow-up.

## Verification note

The Tauri titlebar runtime (where the chip renders) can't be exercised in this
environment. Desktop verification — confirming the chip is suppressed with a
manually-launched session, and that `/health` `hasSession` flips correctly on
connect/disconnect — is Bryan's manual pass.
