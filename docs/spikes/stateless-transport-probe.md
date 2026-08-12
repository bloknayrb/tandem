# Probe: does the MCP SDK really break in stateless mode? (#1253)

**Read 2026-08-12** against the installed dependency tree, not a running
server: every fact below is a source read of shipped code, so it is
reproducible from a checkout with `npm ci` and needs no live MCP client.

The question came from ADR-012, which asserted as fact that ~~the SDK crashes in stateless mode after the first `server.connect()`~~ — **refuted here (#1253/#1332)**, a 2024-era finding that had never been re-tested. It mattered because MCP `2026-07-28` is stateless, so the claim sat directly on the migration path (ADR-045's 2026-07-30 amendment, #1249, #1252).

**Verdict: refuted.** There is no crash, `server.connect()` is not involved,
and stateless mode is usable. The SDK forbids one specific thing — *reusing*
a stateless transport across requests — and says so in its own comment.

## What is actually in the SDK

Measured against **`@modelcontextprotocol/sdk` 1.30.0**, the version installed
under the `^1.12.1` pin at `package.json`:111.

1. **The guard.** `dist/esm/server/webStandardStreamableHttp.js`, inside
   `handleRequest`: comment at :172-173, the test at :174, the throw at :175,
   the flag set at :177.

   ```js
   // In stateless mode (no sessionIdGenerator), each request must use a fresh transport.
   // Reusing a stateless transport causes message ID collisions between clients.
   if (!this.sessionIdGenerator && this._hasHandledRequest) {
       throw new Error('Stateless transport cannot be reused across requests. Create a new transport per request.');
   }
   this._hasHandledRequest = true;
   ```

   `_hasHandledRequest` is touched in exactly three places in that file
   (initialised `false` at :58, tested at :174, set at :177). It is a
   per-**request** latch, so the boundary is the **second request on a given
   transport** — not the handshake, and not a `connect()` call.

2. **The Node path inherits it.** `dist/esm/server/streamableHttp.js` describes
   itself as "a thin wrapper around `WebStandardStreamableHTTPServerTransport`";
   it constructs one at :52 and forwards through
   `getRequestListener(async (webRequest) => … handleRequest(webRequest, …))`
   at :57-60. So the Node `StreamableHTTPServerTransport` Tandem uses defines
   no guard of its own — it gets this one.

3. **How the throw surfaces.** `getRequestListener` comes from
   `@hono/node-server`, whose `handleFetchError` (`dist/index.mjs`:719) turns a
   thrown error into `new Response(null, { status: 500 })` — a bare 500 with an
   empty body, applied at :801 and :895. A client sees the connection produce
   nothing intelligible. That is the plausible origin of the 2024 reading.

## `server.connect()` is a different, still-true guard

Worth recording, because the confusion has already been made once while
triaging this issue. `Protocol.connect()` does throw when a server already
holds a transport — `dist/esm/shared/protocol.js`:217, *"Already connected to a
transport. Call close() before connecting to a new transport, or use a separate
Protocol instance per connection."* That guard is real, is unrelated to
stateless mode, and is the basis of ADR-045 Decision 2 and of
`src/server/mcp/transport-registry.ts`:9-12.

Reading the two as one claim would replace a false statement with another
false statement and damage the ADR-045 story, which is correct as written.

## What this changes

- ADR-012's Rationale is struck and corrected in place (`docs/decisions.md`,
  ADR-012), with the audit trail preserved rather than deleted.
- Stateless mode's real rule is **a fresh transport per request**. Stateful
  mode is what lets one long-lived transport per session serve many requests,
  which is what Tandem does today and remains correct for the protocol
  versions it speaks.
- ADR-045's 2026-07-30 amendment still quotes the old wording and still asks
  for the probe that this file records. Rewriting it is a decision, not an
  edit — it depends on #1252 (era strategy) and #1249 — and is tracked in
  **#1332**.

## Not measured

No live stateless server was stood up, and no SDK v2 (`createMcpHandler`) was
exercised. Those belong with #1252's era decision. This file answers only the
narrow ADR-012 claim.
