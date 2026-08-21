# Probe: does the MCP SDK really break in stateless mode? (#1253)

**Read 2026-08-12** against the installed dependency tree, not a running
server: every fact below is a source read of shipped code, so it is
reproducible from a checkout with `npm ci` and needs no live MCP client.

The question came from ADR-012, which asserted as fact that ~~the SDK crashes in stateless mode after the first `server.connect()`~~ — **refuted here (#1253/#1332)**, a 2024-era finding that had never been re-tested. It mattered because MCP `2026-07-28` is stateless, so the claim sat directly on the migration path (ADR-045's 2026-07-30 amendment, #1249, #1505).

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

## Not measured — for the ADR-012 answer above

No live stateless server was stood up; that belongs with #1505's dual-era work.
Everything above this line answers only the narrow ADR-012 claim.

**SDK v2 is no longer out of scope for this file** — the addendum below was
added later (#1332) and does cover `createMcpHandler`. It has its own, narrower
scope statement in its closing paragraph: it reads published tarballs, and still
stands no v2 server up.

## Addendum (#1332): v2's legacy composition — GA, not unreleased

**v2 shipped.** `@modelcontextprotocol/server@2.0.0` (with `/core`, `/client`,
`/server-legacy`) published to npm **2026-07-27** — confirmed via
`curl https://registry.npmjs.org/@modelcontextprotocol/server` (`time`
field: `2026-07-27T23:55:22Z`) and via `npm pack
@modelcontextprotocol/server@2.0.0` / `@modelcontextprotocol/core@2.0.0`,
inspected locally. `@modelcontextprotocol/sdk` — the name Tandem's
`package.json` pins at `^1.12.1`, resolved by `package-lock.json` to
`1.30.0` (published the same day, `2026-07-27T17:56:01Z`, six hours
earlier) — is the **retired umbrella package**, not a missing release: its
monorepo root `package.json` is `"private": true` at a placeholder
`"2.0.0-alpha.0"` that was never published (`npm view
@modelcontextprotocol/sdk dist-tags` still reads `{"latest":"1.30.0"}`;
none of its 79 published versions start with `2.`).

Every mechanism claim below cites the **published tarball**
(`npm pack`, inspected locally) rather than the `typescript-sdk` monorepo's
`main` branch, which by the time it was read (commit `3924de99`,
2026-08-18) was already ~3 weeks past the `2.0.0` tag — post-release main,
not the released package. The one exception is noted inline.

- `@modelcontextprotocol/server@2.0.0`'s published type declarations
  (`dist/createMcpHandler-dBHMsxwf.d.cts:3854`) declare
  `legacy?: 'stateless' | 'reject'` — no stateful legacy option on the type
  itself. The published runtime (`dist/index.mjs`) throws
  `TypeError("The 'legacy' option only accepts 'stateless' or 'reject', not
  a handler function...")` for a function-valued option (message text
  grepped verbatim from that file; the construction-time guard's line
  numbers — `packages/server/src/server/createMcpHandler.ts:622-633` — are
  the one post-release-`main` citation in this list, since the tarball's
  bundled runtime has no source line numbers of its own).
- The default, `'stateless'` (same `.d.cts`, `CreateMcpHandlerOptions.legacy`
  doc comment): each legacy request is served "by a fresh instance from the
  same factory over a streamable HTTP transport constructed with only
  `sessionIdGenerator: undefined`"; GET/DELETE answered `405` /
  `Method not allowed.`.
- `'reject'`: legacy-classified requests are rejected with the
  unsupported-protocol-version error naming the endpoint's supported
  revisions (notifications acknowledged `202` and dropped) — there is no
  2025 serving in that mode.
- The published `.d.cts` documents and exports a composition seam for
  keeping a *stateful* legacy branch anyway: `isLegacyRequest`
  (`dist/createMcpHandler-dBHMsxwf.d.cts:3997`), routed in user land in
  front of a `legacy: 'reject'` handler — the doc comment's own example,
  "an existing legacy deployment (for example a sessionful streamable HTTP
  wiring)," is preserved verbatim in the published bundle (:3849, :3956),
  not just monorepo narrative. So Decisions 1/3/4 stay buildable, just no
  longer an SDK-provided posture of `createMcpHandler` itself.
- `WebStandardStreamableHTTPServerTransport` — the stateful transport class
  — is still exported (`dist/index.d.cts:605` declares it, `:738`'s export
  statement lists it alongside `createMcpHandler`, `isLegacyRequest`,
  `legacyStatelessFallback`, `CLIENT_INFO_META_KEY`, and `Implementation`,
  all six in one statement). v2 did not remove stateful transports; only
  `createMcpHandler`'s own built-in posture is limited to
  `'stateless' | 'reject'`.
- `CLIENT_INFO_META_KEY` is `'io.modelcontextprotocol/clientInfo'` — found
  directly in the published `@modelcontextprotocol/core@2.0.0` runtime
  bundle (`dist/auth-CUe6YdwF.mjs:32`), unchanged from the value ADR-045
  Decision 6 already cites.
- `ImplementationSchema` (same package, `dist/auth-CUe6YdwF.mjs:260-265`)
  extends `BaseMetadataSchema` (`name`, optional `title`) with
  `IconsSchema` (optional `icons`), `version` (required), and optional
  `websiteUrl` / `description` — six fields, matching what `decisions.md`'s
  Decision 6 correction now states.

One item is settled from the SDK Tandem actually runs, not the v2 read
above: **the stateless legacy path emits no `Mcp-Session-Id` header at
all.** Issue #1332's own v2 bullet reports "legacy `initialize` returns 200
with `Mcp-Session-Id: null`"; that `null` is `Headers.get()` on an absent
header, not a sent value — the same rendering appears in the #1253 probe
table's *content-type* slot for the `500` rows (issue #1332's body uses
`status content-type :: body`, and rows 2-4 read `500 null ::`). Confirmed
two ways: the **installed 1.30.0**
(`node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js`)
sets `this.sessionId = this.sessionIdGenerator?.()` on init (:530), and
every response path that writes the header guards it with
`if (this.sessionId !== undefined)` (:278-279, :331-332, :624-625,
:924-925) — with no `sessionIdGenerator`, the header is never written. The
**published `@modelcontextprotocol/server@2.0.0`** runtime carries the
identical pattern: `dist/index.mjs` sets `this.sessionId =
this.sessionIdGenerator?.()` at :666, guarded at :490, :533, :718, :890.

Still not measured: no live v2 server was exercised, only source/tarball
reads; adoption timing is unchanged and still belongs with #1505.
