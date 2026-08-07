# Stale-tab drop-and-resync on generation mismatch

Branch: `fix/stale-tab-resync` (off master). Plan item 2 of the "solid for anybody" audit
(Tier 1.2). Revision 2 — rewritten after two adversarial plan reviews (crdt-reviewer +
general) which independently converged on the same two critical corrections (gate must be
`onAuthenticate`; CTRL_ROOM must not be exempt). All version-compat questions were settled
by reading the vendored Hocuspocus sources, not empirically.

## Problem

A browser tab that survives a server restart reconnects its per-document Hocuspocus
providers and CRDT-merges its old Y.Doc state into the server's document. Two regimes:

- **Session-restored restart (benign):** server restored the doc via `Y.applyUpdate` from
  the saved session — shared history, merge-back is a near-no-op.
- **Disjoint-history load (the bug):** no session, or `sourceFileChanged()` true —
  `file-opener.ts#maybeRestoreSession` returns false and the server populates a **fresh
  Y.Doc**. The stale tab's merge then duplicates the entire old document alongside the
  new content (YATA integrates both sides of two unrelated insert histories — confirmed),
  and autosave can write that corruption to disk.

This regime is **not rare on desktop**: the Settings → Network "Restart sidecar" button
and the crash auto-restart path hard-kill the sidecar (`child.kill()` in
`src-tauri/src/lib.rs`) with the WebView surviving — no graceful shutdown, no session
save, divergent histories every time. The npm/browser mode and dev are equally exposed.

The existing banner (CTRL_ROOM generation-id observer in `yjsSync.svelte.ts:352`) detects
the restart **after** the fact and prevents nothing. Worse, the CTRL_ROOM merge-back can
clobber `Y_MAP_GENERATION_ID` itself: the stale tab's old value and the server's new value
are concurrent YMap writes resolved by clientID comparison — effectively a coin flip — so
the banner (and any resync keyed on observing the gen change) can silently never fire.

## Why client-only dropping is insufficient (the race) — CONFIRMED

Each tab has its own `HocuspocusProvider` → own WebSocket (v3 provider with `url` config
creates its own `HocuspocusProviderWebsocket`). On reconnect every provider independently
sends Auth + SyncStep1 in `onOpen`; the SyncStep2 reply pushes the entire disjoint stale
state. Nothing orders any of this after the CTRL_ROOM observer callback on a different
socket. A server-side gate is required.

## Design (revision 2)

### 1. Server: generation token gate in `onAuthenticate` — ALL rooms, including CTRL_ROOM

- `writeGenerationId()` (`document-service.ts:1169`) already runs before Hocuspocus binds
  (`index.ts:345` vs `:495`) — **no boot reordering**. Only change: capture the UUID in
  module state and export `getGenerationId(): string | null`. Keep the CTRL_ROOM map
  write for diagnostics; the client no longer depends on it.
- Add `onAuthenticate({ token })` to the `Hocuspocus` config in `provider.ts`:
  `token !== getGenerationId()` → throw. **No CTRL_ROOM exemption** — a stale ctrl
  provider merging back is exactly how the generation channel itself gets corrupted
  (reviewer finding: stale gen can win the CRDT merge on the server's ctrl doc and
  permanently lock out every client, including fresh page loads).
- Why `onAuthenticate` and not `onConnect`: in @hocuspocus/server 2.15.3,
  `ClientConnection.messageHandler` processes queued messages **un-awaited before**
  `onConnect` resolves — an `onConnect` throw races sync processing. Defining
  `onAuthenticate` flips `requiresAuthentication` on: non-Auth messages are queued
  per-document and only drained in `setUpNewConnection`, which a hook throw never
  reaches. PermissionDenied is sent, the queued stale sync is never processed.
- Wire compat is confirmed from vendored sources: provider 3.4.4 always sends Auth
  *before* SyncStep1 (`token ?? ""` even when unset), and the Auth message format is
  byte-identical between common 2.15.3 / 3.4.4. The v2 server's
  Authenticated/PermissionDenied replies parse cleanly in the v3 provider, which then
  emits `authenticationFailed`.
- Move the existing Origin/DNS-rebinding check INTO `onAuthenticate` as well (keep the
  `onConnect` copy as belt-and-braces): the same un-awaited-queue race applies to it
  today — a pre-existing hardening gap this PR closes incidentally.

### 2. Generation distribution: HTTP, not the ctrl map

- Add `generationId` to `GET /api/info` (`src/server/mcp/routes/info.ts`). Not a
  secret — it's an anti-corruption nonce, not auth; WS is already loopback-bound +
  Origin-checked. The client already fetches this route (`useAppInfo.ts`).
- Client boot (`yjsSync.svelte.ts`): fetch `/api/info` first, then create the CTRL
  provider with `token: <gen>`. Bootstrap becomes async — the factory stays synchronous,
  provider creation moves into the fetch continuation; `connectionStatus` already
  initializes to `"connecting"`, which covers the fetch window. Fetch failure → retry
  with backoff (server down ≡ WS down; same user-visible state).
- **Tokens are pinned strings captured at provider construction** — never a closure over
  the live variable. The token identifies the ydoc's provenance: if the generation has
  changed since the provider's ydoc was created, that ydoc is stale by definition and
  must never re-authenticate. (The two reviewers disagreed here; the data-safety
  invariant is the tiebreaker.)

### 3. Client: full rebuild on `authenticationFailed`

- On `authenticationFailed` from ANY provider (ctrl or tab): single-flight →
  re-fetch `/api/info` → if the generation differs from the pinned one, tear down
  everything (ctrl provider/ydoc + all tab providers/ydocs + pending providers +
  observers, the existing `toRemove`/`destroy()` discipline) and re-run the bootstrap
  with the new generation. The fresh ctrl sync delivers the doc list, which recreates
  tabs with fresh empty ydocs. Show the `serverRestarted` banner; reset
  `lastAppliedActiveEpoch`.
- The old observer-based gen-mismatch branch becomes redundant (a stale ctrl provider is
  now rejected before it can observe anything) — remove it; banner moves to the rebuild
  path.
- Rebuild must be deferred out of any Y observer callback (microtask) — never
  `ydoc.destroy()` the doc whose observer is mid-dispatch. `authenticationFailed` is a
  provider event, not a Y observer, but the deferral discipline is cheap and future-proof.
- Rejected-provider semantics (confirmed): on auth failure the server leaves the socket
  open until the 30s idle timeout; the provider reports websocket "connected" while
  denied. Never infer health from `status` events — `authenticationFailed` is the signal.
- `src/client/svelte-harness/EditorHarness.svelte` also constructs a provider (room
  `"harness-doc"`, connects then immediately disconnects) — it will now be denied;
  harmless, add a comment (or fetch info if trivial).

### 4. Unsaved-edit semantics (explicit trade-off)

Drop-and-resync discards browser edits made while the server was down. Merge-back
"preserved" them but corrupts the document in the disjoint regime. For **graceful**
restarts, PR #1087's shutdown flush makes this lossless. For sidecar hard-kill restarts
(desktop restart button, crash auto-restart) up to ~60s of edits since the last autosave
tick are lost — already true before this PR for disk state; the banner says documents
were refreshed. File a follow-up issue: make `restart_sidecar` attempt a graceful stop
(flush HTTP call or SIGTERM-equivalent) before `kill()`.

## Implementation order

1. **Repro integration test** (`tests/server/stale-tab-resync.test.ts`, vitest, real WS):
   start Hocuspocus on an ephemeral port (avoid Windows reserved range — use `listen(0)`
   pattern), populate a doc server-side, connect a Node `HocuspocusProvider` (inject the
   allowed Origin via a `ws.WebSocket` subclass passed as `WebSocketPolyfill` whose
   constructor adds `{ headers: { Origin: "http://127.0.0.1" } }` — the provider calls it
   with one arg), sync, stop, start a fresh instance + fresh Y.Doc with different content,
   reconnect the stale client, assert the pollution (content union) — the repro.
2. Server gate (`onAuthenticate` + `getGenerationId()` + info-route field) — flip the
   repro assertions: server doc stays clean; stale client gets `authenticationFailed`;
   current-gen client syncs; CTRL_ROOM is gated too; a no-ctrl-session restart cannot
   clobber the server's generation (the gate rejects the stale ctrl provider).
   Also cover: rapid provider destroy→recreate on a room with annotations survives the
   Hocuspocus unload/swap cycle (`registerAnnotationObserver` swap-vs-close, #333).
3. Client: async bootstrap + pinned tokens + `authenticationFailed` rebuild. Review with
   `svelte-migration-reviewer` (R4: teardown/recreate within one flush; editor binding
   must not see a destroyed ydoc).
4. Manual verification (Playwright can't restart its webServer): dev-server stale-tab
   procedure from the CLAUDE.md gotcha, AND the Tauri restart-sidecar button.
5. Docs: CLAUDE.md gotcha update, architecture note, CHANGELOG; file the
   graceful-sidecar-restart follow-up issue.

## Resolved review questions

- R1/R2 (version compat, hook ordering): settled from vendored sources — see Design §1.
- R3/R4 (teardown reentrancy / editor binding): confirmed safe shape; deferral discipline
  added in §3.
- R5 (rejection noise): one denial per ~30s per stale provider until rebuild lands;
  bounded.
- R6 (other consumers): only `EditorHarness.svelte` (handled §3); no tests/scripts/channel
  consumers exist today.
- E2E impact: none — no existing E2E restarts the server mid-test.
- Blast radius of polluted ctrl room (phantom tabs, spurious channel events to Claude):
  eliminated by gating CTRL_ROOM rather than repairing after the fact.
