# Spec: Per-Client Identity (Claude Code + Cowork Concurrent)

**Issue:** [#438](https://github.com/bloknayrb/tandem/issues/438) — *spec: per-client identity to support Claude Code + Cowork running concurrently*
**Status:** Design spec. **§3.2 (transport multiplexing) is implemented** — see [ADR-045](../decisions.md#adr-045-mcp-transport-multiplexing--one-mcpserver-per-session-keyed-by-mcp-session-id). §3.1 (identity), §3.3 (per-client inbox state), §3.4 (event routing), and §3.5 (settings UI) remain unimplemented. Prerequisite for [#452](https://github.com/bloknayrb/tandem/issues/452) (multi-Claude concurrent) per `docs/roadmap.md` (#438 → #452 dependency edge).

> **Probe P2 is answered (2026-07-22, SDK 1.27.1): Shape 2 is required.** `shared/protocol.js`'s `connect()` throws `"Already connected to a transport"` when `this._transport` is already set, so one `McpServer` provably cannot serve two live transports — Shape 1 below is not available. One further implementation fact the spec did not anticipate: `transport.sessionId` is minted while the transport *handles* the initialize request, not at construction, so entries can only be registered from the SDK's `onsessioninitialized` callback.
>
> **Probe P1 is partially answered, and the answer is worse than "indistinguishable."** For the Claude-Code-vs-Claude-Code case the discriminator is not `clientInfo` at all but `X-Claude-Session-Id`, and **whether it exists depends on the config path**: the plugin manifest's stdio entry carries it (subprocess → `CLAUDE_CODE_SESSION_ID` in env → forwarded by `mcp-stdio.ts`), while the direct-HTTP entry `buildMcpEntries` writes for Claude Code CLI (`{type:"http", url}` + static headers) has no subprocess and carries nothing. §3.3/§3.4 work must either accept sessions with no identity or move Claude Code CLI onto the stdio bridge.
**Audience:** Contributors implementing the per-client identity model.
**Related ADRs:** ADR-003 (MCP over REST), ADR-012 (Streamable HTTP transport), ADR-013 (chat persistence via JSON), ADR-019 (channel shim / SSE push), ADR-023 (Cowork plugin bridge — stdio via npx), ADR-024 (`bearer_methods_supported` empirical findings), ADR-027 (audience-based annotation model), ADR-031 (origin-tagged transactions), ADR-038 (MCP-first integration policy). This spec, when accepted, should land as a new ADR (next free number — ADR-044 at time of writing; ADR-043 was assigned to the Tauri updater audit, see `docs/decisions.md`) cross-linked from `docs/decisions.md`.

---

## 1. Problem statement

The Tandem MCP server was designed for **one active Claude client at a time**. With Cowork, a user can run Claude Code (a personal terminal session) and a Cowork Claude instance simultaneously against the same local Tandem server. The current architecture cannot support that — a single-client assumption is baked in at three independent layers. Each layer must be fixed before two clients can coexist; fixing one without the others still produces a broken experience.

This spec enumerates the current single-client model exactly as it works today, the design space for each layer, the trade-offs, and a recommended approach. It deliberately stops short of code. Several decisions hinge on **empirical findings** (what `clientInfo` Claude Code vs. Cowork actually send, whether two Streamable-HTTP sessions on one `McpServer` are safe). Those are called out as probes the implementation PR must run first — consistent with ADR-024's "measure, don't assume" discipline.

### 1.1 Why "Claude Code + Cowork" specifically

Both clients are *Claude* (ADR-038: Claude is the default, deepest-supported integration), but they reach Tandem by **different transports**:

- **Claude Code** connects to the HTTP MCP endpoint (`http://127.0.0.1:3479/mcp`) directly, and runs the channel shim as a stdio subprocess that consumes `GET /api/events` (ADR-019).
- **Cowork** runs in an isolated VM that does **not** forward `localhost` HTTP MCP servers into the VM (ADR-023). It reaches Tandem only through the `tandem mcp-stdio` proxy — a stdio↔HTTP bridge that relays JSON-RPC to the same `http://localhost:3479/mcp` endpoint.

So from the server's perspective, *both* arrive as HTTP requests to `/mcp`. The proxy hop for Cowork is transparent at the HTTP layer: the server sees two streams of `initialize` + tool calls hitting the same endpoint, with no built-in way to tell them apart. That is the crux of the problem.

---

## 2. Current single-client model (ground truth)

This section describes the code **as it exists on `master`**, not as we wish it were. Line references are anchors, not guarantees of stability.

### 2.1 Layer 1 — Single transport; second `initialize` evicts the first

`src/server/mcp/server.ts` holds **one** module-level transport:

```ts
let mcpServer: McpServer | null = null;
let currentTransport: StreamableHTTPServerTransport | null = null;
let connectingPromise: Promise<void> | null = null;
```

Every `POST /mcp` that is an `initialize` request calls `connectFreshTransport()`, which **tears down the existing transport** before connecting a fresh one:

```ts
async function connectFreshTransport(): Promise<void> {
  // ...
  if (currentTransport) {
    console.error("[Tandem] Closing previous MCP transport session");
    await mcpServer!.close();      // closes the ONE McpServer
    currentTransport = null;
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcpServer!.connect(transport);
  currentTransport = transport;
}
```

`mcpServer!.close()` closes the single long-lived `McpServer`, which terminates whatever session was attached. So if Claude Code is connected and Cowork sends `initialize`, Cowork's handshake **kicks Claude Code off** (and vice-versa). They cannot coexist. The `connectingPromise` chain only serializes concurrent rotations — it does not make rotations additive.

Note also that the server **ignores the `Mcp-Session-Id` header** that the Streamable HTTP transport generates (`sessionIdGenerator: () => randomUUID()`). The non-init `POST`/`GET`/`DELETE` handlers route blindly to `currentTransport` regardless of which session ID the request carries. This is the single most important fact for Layer 1: the SDK *already* mints session IDs we are throwing away.

### 2.2 Layer 2 — Shared inbox state; first caller wins

`src/server/mcp/awareness.ts` keeps inbox surfacing state in a **module-level singleton**:

```ts
// Track which annotation IDs have been surfaced to Claude via checkInbox.
const surfacedIds = new Map<string, number>();
```

`tandem_checkInbox` reads `surfacedIds` to decide which annotations are "new", then **mutates** it (via `processUnsurfacedInboxAnnotations`, which calls `surfaced.set(...)`). Because the Map is global:

- The **first** client to call `tandem_checkInbox` marks every pending annotation as surfaced → the **second** client sees an empty inbox.
- Chat is worse: unread user messages are read off `CTRL_ROOM`'s `Y_MAP_CHAT` and **marked `read: true` on the Y.Doc** by the first reader:

  ```ts
  if (msg.author === "user" && !msg.read) {
    chatMessages.push(/* ... */);
    withMcp(ctrlDoc, () => chatMap.set(msg.id, { ...msg, read: true }));
  }
  ```

  The `read` flag is a **single boolean on the shared CRDT message** (ADR-013: chat persisted as JSON, mirrored in `Y_MAP_CHAT`). Once the first client marks a message read, the second client never sees it.

So the inbox is **nondeterministic**: which client sees a given action depends on polling order. There is exactly one "seen" view, shared across all callers.

### 2.3 Layer 3 — Single auth token; no client identity

`src/server/auth/token-store.ts` loads or generates **one** bearer token (`loadOrCreateToken()`), shared by all clients. `src/server/auth/middleware.ts` validates it via constant-time SHA-256 compare, with a loopback bypass (loopback callers — i.e. *all* local clients today — skip the token entirely). There is:

- **No per-client token** — every client presents (or, on loopback, omits) the same secret.
- **No client-type signal** consumed anywhere. The server cannot distinguish "this request is Claude Code" from "this request is Cowork."
- **No notion of intended recipient** on any event, annotation, or chat message.

The auth model's only job today is the LAN-binding gate (ADR-024 era): reject non-loopback requests without a valid token. It carries **zero identity**.

### 2.4 Layer 4 — Event routing is broadcast-only

`src/server/events/queue.ts` is a single in-memory ring buffer (200 events / 60s TTL) with a flat subscriber set. `src/server/events/sse.ts` mounts `GET /api/events`; every connected SSE consumer receives **every** event. Observers filter by *transaction origin* (ADR-031: `browser`-origin writes emit; `mcp`/`file-sync`/`internal`/`reload` are skipped) so Claude never sees its own echoes — but there is **no per-recipient routing**. The channel shim (`src/channel/event-bridge.ts`) forwards everything it receives to Claude Code as `notifications/claude/channel`. If two channel consumers connected today (Claude Code's shim + a hypothetical Cowork channel), both would get the identical firehose.

### 2.5 Layer 5 — Settings UI has no multi-client concept

`src/client/` has no surface that represents "which clients are connected." The redesign mockup referenced in #438 shows a "Bind mode" toggle and a "Rotate token" button in a Claude Code settings panel, but nothing models *multiple simultaneous clients*. `POST /api/rotate-token` swaps the single token process-wide (`tokenRef.current`), with a 60s grace window for the previous token (`setPreviousToken`). Rotating today would force a re-handshake for *all* clients.

### 2.6 Summary table

| Layer | File(s) | Single-client assumption | Failure mode with 2 clients |
|---|---|---|---|
| Transport | `mcp/server.ts` | one `currentTransport`; init rotates it | second `initialize` evicts the first |
| Inbox state | `mcp/awareness.ts` | module-level `surfacedIds` Map + shared `read` flag | first poller drains the inbox; second sees nothing |
| Auth / identity | `auth/token-store.ts`, `auth/middleware.ts` | one token; loopback bypass; no client tag | cannot tell clients apart |
| Event routing | `events/queue.ts`, `events/sse.ts` | broadcast to all SSE subscribers | no way to route to a specific client |
| Settings UI | `src/client/` | no multi-client model | rotate forces all-client re-handshake |

---

## 3. Design dimensions

The five layers reduce to **three core design decisions** plus two follow-on surfaces. The follow-ons (event routing, settings UI) depend on how identity is established, so they are specified after it.

### 3.1 How does a client establish identity at connect time?

The MCP `initialize` request carries a `clientInfo` object (`{ name, version }`) per the MCP base protocol. After the handshake the SDK exposes it via `McpServer.server.getClientVersion()`. This is the **natural, zero-config identity hook** — it requires no new auth scheme and no user action.

**⚠️ Empirical probe required (P1).** We do **not** yet know what `clientInfo.name` Claude Code vs. a Cowork Claude instance actually send. Both might send `"claude-ai"` / `"claude-code"` / something else; they might be indistinguishable. **The implementation PR must run this probe first** (log `getClientVersion()` for both clients) before committing to `clientInfo`-based discrimination. If the names collide, fall back to **Option B or D below**. This mirrors ADR-024's "measure, don't assume" stance on Claude Code's MCP-client behavior.

**Options:**

- **A. Client-supplied `clientInfo` (preferred if probe P1 distinguishes them).** Read `name`/`version` from the handshake. Zero config. Risk: not under our control, may not disambiguate, clients can spoof it (acceptable — this is a loopback trust domain, not a security boundary).

- **B. Per-client registration handshake (custom `_meta` or a `tandem/register` request).** After `initialize`, the client (or its launch wrapper) calls a Tandem-specific registration that assigns/echoes a stable client ID. More control, but requires cooperation from each client's launch path. Cowork's path is `tandem mcp-stdio` (ADR-023), which we **own** — we can have the proxy inject a client ID it generates per-process. Claude Code's direct HTTP path we do **not** own, so this only half-solves discrimination unless Claude Code's wrapper is also ours (it is not).

- **C. Per-client bearer tokens.** Issue distinct tokens per registered client; the token *is* the identity. Strongest separation and the only option that survives a future LAN-binding scenario (where loopback bypass doesn't apply). Cost: the loopback-zero-config property (ADR-024) is the whole reason Claude Code "just works" today — requiring a token on loopback regresses that unless we make per-client tokens *optional* (anonymous loopback clients get a synthesized ephemeral ID; tokened clients get a stable one).

- **D. Transport-path inference.** Cowork *always* arrives via the `tandem mcp-stdio` proxy (a process we own); Claude Code arrives via its own HTTP client. The proxy can stamp a header (e.g. `X-Tandem-Client: cowork`) that the direct Claude Code path never sends. This cleanly distinguishes the *two clients in #438's scope* without depending on `clientInfo`, and it composes with A as a tiebreaker.

**Recommended:** **A + D, with C reserved for the LAN-binding future.** Use `clientInfo` as the primary identity (carries a human-readable name + version for the settings UI), and have the `tandem mcp-stdio` proxy stamp an `X-Tandem-Client`/`_meta` marker as an authoritative Cowork discriminator that does not depend on `clientInfo` being distinct. Synthesize a stable per-session client ID server-side keyed on `(clientInfo.name, transport-path-marker, Mcp-Session-Id)`. Keep loopback zero-config; per-client *tokens* (C) are specified but **deferred** to the LAN scenario where they actually buy something.

### 3.2 How is the transport multiplexed?

The SDK's `StreamableHTTPServerTransport` already generates a per-session `Mcp-Session-Id` (we currently discard it). The MCP Streamable HTTP spec is explicitly designed for **multiple concurrent sessions**, each keyed by that header. So the fix is to **stop throwing the session ID away** and maintain a map.

**⚠️ Empirical probe required (P2).** Confirm that **multiple `StreamableHTTPServerTransport` instances can attach to one `McpServer`** (or whether each session needs its own `McpServer`). The current code uses a single long-lived `McpServer` and rotates the transport; whether `mcpServer.connect(transport)` is safe to call N times for N live transports needs verification against the SDK version in `package.json`. There are two shapes depending on the answer:

- **Shape 1 — one `McpServer`, many transports** (if the SDK supports it). Cheapest. `mcpServer` stays a singleton; replace `currentTransport` with `transports: Map<sessionId, StreamableHTTPServerTransport>`.

- **Shape 2 — one `McpServer` *per* session** (if connect-many is unsupported or leaks state). Tool registrations are pure (`createMcpServer()` re-registers from scratch each time), so spinning up an `McpServer` per session is cheap and isolates any per-connection state the SDK keeps. `servers: Map<sessionId, { server, transport }>`.

**Routing change** (`mcp/server.ts`):

- `POST /mcp` **init** → mint a session (don't tear down others), store it in the map keyed by `Mcp-Session-Id`, attach the resolved client identity (§3.1).
- `POST`/`GET /mcp` **non-init** → look up the transport by the request's `Mcp-Session-Id` header; 404 if unknown (the SDK already validates this when sessions are tracked properly).
- `DELETE /mcp` → tear down **only** that session's transport, remove from map.
- Add a session-idle reaper (the current model has none because there was only ever one session): evict transports whose underlying connection has closed, to bound memory.

**Recommended:** Implement against **Shape 1** if probe P2 confirms it; otherwise Shape 2. Either way, the public change is *"key transports by `Mcp-Session-Id`, never evict on init."* This is the load-bearing fix — Layers 2/4 build on having a stable per-session client ID to key state by.

### 3.3 How is inbox state keyed per client?

Today `surfacedIds` is one global Map and chat `read` is one boolean. Both must become **per-client**.

**Surfaced annotations.** Replace the singleton with a per-client structure:

```ts
// Map<clientId, Map<annotationId, lastSurfacedEditedAt>>
const surfacedByClient = new Map<string, Map<string, number>>();
```

`tandem_checkInbox` resolves the caller's `clientId` (from the session → identity binding in §3.1/§3.2) and reads/writes only that client's sub-map. Each client gets an independent "seen" view. `resetInbox()` (test helper) clears the outer map. New clients start with an empty sub-map and therefore see the full backlog — which is the correct first-poll behavior.

**Chat `read` flag.** The single boolean cannot represent "read by Code but not by Cowork." Three options:

- **(a) Per-client read-set on each message.** Change `read: boolean` → `readBy: string[]` (or `Set`) of client IDs. A message is "unread for client X" iff `X ∉ readBy`. Most correct; requires a chat-message schema migration (ADR-013's JSON persistence + `Y_MAP_CHAT` mirror) and a `sanitizeChatMessage`-style read migration (legacy `read: true` → `readBy: ["*"]` meaning "all current clients"; legacy `read: false` → `readBy: []`).

- **(b) Per-client cursor (high-water mark).** Track, per client, the timestamp/ID of the last chat message that client has consumed. Don't mutate the message at all; each client's inbox = messages newer than its cursor. Simpler CRDT story (no per-message mutation, no migration of the message shape — the cursor lives in the same per-client server-side structure as `surfacedByClient`), at the cost of not modeling out-of-order reads (rarely relevant for a linear chat log).

- **(c) Leave `read` as a UI-only concern; drive Claude inbox purely off cursors/surfaced-sets.** The browser's own "read" state is separate from Claude's. This is arguably already true — the `read` flag exists mainly to stop re-surfacing to Claude, not to drive the human UI. Decoupling them means the human-facing read indicator and Claude's "have I seen this" become independent, which is what we want.

**Recommended:** **(b) per-client cursor**, unifying chat and annotation "seen" state into a single per-client server-side ledger keyed by `clientId`. Rationale: it avoids a CRDT schema migration on chat messages (lower risk, ADR-013 stays intact), it naturally extends `surfacedByClient` (one home for all per-client inbox state), and it stops `tandem_checkInbox` from writing to the shared `Y_MAP_CHAT` at all — removing the "first reader mutates shared state" footgun at its root. The human-facing `read` indicator in the browser becomes a separate, browser-owned concern (option c's decoupling), which is the correct ownership.

> **Privacy invariant preserved (ADR-027).** Per-client inbox keying does **not** change *what* is eligible to surface. Notes remain user-private and never reach any Claude client via `tandem_checkInbox` or the channel, regardless of client ID. Per-client state controls *which client has seen an eligible item*, not *whether an item is eligible*. The audience gate that enforces this **today** — the `type !== "comment"` filter in `src/server/events/observers/annotations.ts` (and `replies.ts`) plus `sanitizeAnnotation` in `src/shared/sanitize.ts` — sits upstream of all per-client logic and is untouched. (ADR-035's `narrowForChannel` projection is the *designed* future home of this gate, but it is marked **Deferred** and does not yet exist in `src/`; the live privacy invariant is ADR-027, enforced at those two points.)

### 3.4 Event routing: broadcast vs. directed

Today every SSE consumer gets every (browser-origin) event (§2.4). The question is whether to keep broadcast or add directed routing.

- **Broadcast (status quo, extended).** Both clients' channel consumers receive all events. Combined with per-client *inbox* state (§3.3), this is **sufficient for correctness**: even if both clients are *notified* of a user comment, each independently tracks whether it has *acted* on it via its own cursor. The push is just a latency optimization over polling (ADR-019); the inbox is the source of truth for "new to me."

- **Directed routing.** Route an event to a *specific* client (e.g. a user comment explicitly `directedAt` Cowork should push to Cowork's channel only). Requires (1) a recipient field on the annotation/event and (2) per-client SSE streams keyed by client ID so the server can pick a target. `directedAt` was **removed from the model in ADR-027**, not merely deprecated: the annotation schema **actively rejects** it via a Zod `.refine()` (`src/server/annotations/schema.ts` — *"directedAt is removed in ADR-027; run migrateFlagAndDirectedAt before validation"*) and it is stripped on the fast read path (`src/server/annotations/sync.ts`). Reviving it as a routing key therefore means **undoing a schema-enforced invariant** — relaxing the refine, re-adding the field to the type union, and reconciling with `migrateFlagAndDirectedAt` — not un-deprecating a dormant field. This *strengthens* the recommendation to defer directed routing.

**Recommended:** **Keep broadcast for v1 of per-client identity.** Directed routing is a larger data-model change (un-deprecating `directedAt` or adding a new recipient concept) that #438 does not strictly need — per-client *inbox* state already gives each client an independent view. **Defer directed routing to a follow-up** (it pairs naturally with #452 multi-Claude, where "this task is for agent B" routing becomes valuable). Document the seam: per-client SSE streams (keying `/api/events` consumers by client ID) are the enabling primitive; add them when directed routing lands, not before.

One concrete near-term consequence to handle: with two channel consumers, the channel shim's `wasEmittedViaChannel` dedup (used by `tandem_checkInbox` to avoid double-reporting an item already pushed via channel) is currently **global** (`emittedPayloadIds` in `events/queue.ts`). If both clients share that dedup, client B might suppress an inbox item merely because it was pushed to client A's channel. **This must become per-client** alongside the inbox state — i.e. "was this emitted via *my* channel" — or `tandem_checkInbox` should ignore channel-dedup for clients without an attached channel. Flag for the implementation PR.

### 3.5 Settings UI for multiple clients

The redesign mockup's "Bind mode" + "Rotate token" Claude Code panel assumes one client. With per-client identity:

- **Connected-clients list.** Surface the live sessions (from the transport map, §3.2) with their `clientInfo.name`/`version` and last-seen time. This is the minimum useful multi-client surface: the user can *see* that both Claude Code and Cowork are connected. Read-only; no new testid-bearing controls strictly required for v1.
- **Token rotation semantics.** With loopback-zero-config preserved (§3.1 recommendation), rotation only matters for the LAN/token scenario. If per-client tokens (Option C) are *not* implemented for v1, "Rotate token" stays a single-token, all-client operation — but the UI should *say so* ("rotating disconnects all clients") rather than implying per-client rotation. If/when Option C lands, rotation becomes per-client (revoke one client without disturbing the other).
- **No per-client *write* controls in v1.** Avoid shipping per-client mute/disconnect/route toggles until directed routing (§3.4) exists to back them — otherwise they'd be controls with no underlying mechanism.

**Recommended:** Ship a **read-only connected-clients list** (driven by the transport map) and **correct the rotation copy** to reflect single-token-all-client semantics. Defer per-client write controls to the directed-routing follow-up. This keeps the UI honest about what the backend actually does — avoiding the trap of claiming a capability that didn't ship.

---

## 4. Recommended approach (consolidated)

| Dimension | Recommendation | Deferred / follow-up |
|---|---|---|
| **Identity** | `clientInfo` (primary) + `X-Tandem-Client` marker stamped by the `tandem mcp-stdio` proxy (Cowork discriminator). Synthesize a stable server-side `clientId` per session. Loopback stays zero-config. | Per-client bearer tokens (Option C) — reserved for the LAN-binding scenario. |
| **Transport** | Key transports by `Mcp-Session-Id` in a `Map`; **never evict on `initialize`**; per-session teardown on `DELETE`; idle reaper. Shape 1 (one `McpServer`, many transports) pending probe P2; else Shape 2 (one `McpServer` per session). | — |
| **Inbox state** | Per-client ledger keyed by `clientId`: `surfacedByClient` for annotations + a per-client chat cursor (high-water mark). `tandem_checkInbox` stops mutating shared `Y_MAP_CHAT`. Per-client channel-dedup. | Out-of-order chat reads (per-message `readBy[]`) — not needed for a linear log. |
| **Event routing** | Keep broadcast. Per-client inbox state makes broadcast correct. | Directed routing (`directedAt`/recipient field + per-client SSE streams) — pairs with #452. |
| **Settings UI** | Read-only connected-clients list; correct rotation copy to "all-client" semantics. | Per-client write controls (mute/disconnect/route) — gated on directed routing. |

**Empirical probes the implementation PR must run first:**
- **P1** — log `getClientVersion()` (`clientInfo.name`/`version`) for both Claude Code and Cowork; confirm they're distinguishable. If not, lean on the proxy-stamped marker (Option D) as the authoritative discriminator.
- **P2** — confirm whether one `McpServer` accepts multiple concurrent `connect(transport)` calls cleanly (Shape 1) or whether per-session `McpServer` instances are required (Shape 2).

**Sequencing.** Transport multiplexing (§3.2) is the foundation — per-client inbox state (§3.3) and the connected-clients UI (§3.5) both key off the stable per-session `clientId` it produces. Implement in that order. Identity resolution (§3.1) and transport multiplexing land together (the session→identity binding happens at `initialize`).

---

## 5. Acceptance criteria mapping (issue #438)

| Issue acceptance criterion | Addressed by |
|---|---|
| Design document specifying per-client identity model | This document (→ promote to ADR-044). |
| Claude Code and Cowork connect simultaneously without evicting each other | §3.2 — key transports by `Mcp-Session-Id`, never evict on init. |
| `tandem_checkInbox` returns independent results per client | §3.3 — per-client surfaced ledger + chat cursor; per-client channel-dedup (§3.4). |
| Auth model distinguishes client type (Code vs. Cowork vs. future) | §3.1 — `clientInfo` + proxy-stamped marker; synthesized stable `clientId`. |
| Settings UI accounts for multiple simultaneous clients | §3.5 — read-only connected-clients list; honest rotation copy. |

---

## 6. Open questions / risks

1. **`clientInfo` indistinguishability (P1).** If Claude Code and Cowork present identical `clientInfo`, the proxy-stamped marker (Option D) is the only reliable discriminator for the two-client case, and a *third* future client with neither distinct `clientInfo` nor our proxy would be unidentifiable. Acceptable for #438's scope (Code + Cowork); revisit for #452.
2. **SDK session semantics (P2).** The whole transport-multiplexing design assumes `StreamableHTTPServerTransport` session tracking behaves per the MCP spec. Pin the verified SDK version in the ADR.
3. **Channel-shim multiplicity.** ADR-019's channel shim is a single stdio subprocess per Claude Code session. Whether Cowork can/should run its *own* channel consumer (vs. polling only) is unresolved — Cowork's VM isolation (ADR-023) may make SSE consumption from inside the VM impossible, in which case Cowork is **poll-only** and directed routing to Cowork's channel (§3.4) is moot. Confirm Cowork's SSE reachability before investing in per-client channels.
4. **Idle session leakage.** Multiplexing without a reaper leaks transports for crashed clients. The reaper (§3.2) is required, not optional — the single-transport model never needed one.
5. **Token rotation with multiple loopback clients.** With loopback-zero-config, rotation is a near-no-op for local clients (they never present the token). The 60s grace window (`setPreviousToken`) already smooths LAN-client rotation. No change needed for v1; the UI copy fix (§3.5) is the only deliverable.

---

## 7. Non-goals

- **No production code.** This is a spec; implementation is a separate PR (or PRs) gated on probes P1/P2.
- **No directed event routing.** Deferred (§3.4); broadcast + per-client inbox is sufficient for #438.
- **No per-client write controls in settings.** Deferred (§3.5).
- **No change to the audience/privacy model (ADR-027).** Per-client identity keys *who has seen* an eligible item, never *what is eligible*.
- **No multi-Claude orchestration (#452).** This spec is the prerequisite; #452's agent-to-agent routing builds on the directed-routing seam noted here.
