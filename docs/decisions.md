# Design Decisions

## ADR-001: Tiptap over ProseMirror Direct
**Decision:** Use Tiptap instead of raw ProseMirror.
**Rationale:** Tiptap provides an extension system and built-in collaboration support via `@tiptap/extension-collaboration`. Reduces boilerplate significantly.

## ADR-002: Hocuspocus for Yjs WebSocket, @hocuspocus/provider on the Client
**Decision:** Use Hocuspocus (MIT) as the Yjs WebSocket server and `@hocuspocus/provider` as the browser WebSocket provider.
**Rationale:** Same team as Tiptap. Built-in document management, persistence hooks. `@hocuspocus/provider` is required — `y-websocket` is protocol-incompatible with Hocuspocus v2, which prepends a `writeVarString(documentName)` to every message frame. `y-websocket` misreads that length byte as the outer message type, silently routing the browser to a phantom `""` document instead of `"default"`.

## ADR-003: MCP over REST for Claude Integration
**Decision:** Expose tools via MCP (HTTP, formerly stdio) instead of a custom REST API.
**Rationale:** Claude Code discovers MCP tools natively. No curl wrappers needed. Tools appear in Claude's tool list automatically. See ADR-012 for the stdio → HTTP migration.
**See ADR-038:** the MCP contract here applies to any MCP-capable client, not only Claude. The title's "for Claude Integration" framing pre-dates ADR-038's policy.

## ADR-004: .docx Review-Only by Default
**Status:** Superseded by #576 (v1.0 docx write-back). `.docx` is now editable; the protective layer is "never overwrite without an explicit save", not `contenteditable=false`.
**Original decision:** .docx files open in review-only mode. Never overwrite the original.
**Original rationale:** mammoth.js import is lossy (no complex tables, tracked changes, footnotes). Review-only prevents accidental data loss.
**Supersession (#576):** mammoth import is still lossy, so the data-loss concern is real — but it's addressed by *explicit-save gating* rather than by blocking edits. `.docx` opens writable; edits are held in the Y.Doc and serialized back to `.docx` (body content only — comments/tracked-changes are v1.1) **only on an explicit user/agent save** via the `docx` package (`saveBinary` adapter capability + `atomicWriteBuffer`). Auto-save never writes `.docx` (`BINARY_SAVE_FORMATS` is disjoint from `AUTO_SAVE_FORMATS`). Lossy-import warnings surface at open; export-downgrade warnings surface on save. The export is trust-boundary-gated (scrubbed hyperlinks, inline-only image embeds, no OLE objects, plain-text fallback for unknown nodes). See `src/server/file-io/docx-export.ts`.

## ADR-005: Node-Anchored Ranges for Overlays
**Decision:** Overlays use node-relative anchors (nodeId + offset) instead of character offsets.
**Rationale:** Character offsets break under concurrent editing. Node anchors survive edits to other paragraphs.

## ADR-006: Console.error for Server Logs
**Decision:** Use console.error for all server-side logging. `console.log`, `console.warn`, and `console.info` are redirected to `console.error` at startup.
**Rationale:** Originally required because MCP stdio transport used stdin/stdout for protocol messages. Now defense-in-depth — HTTP transport doesn't use stdout, but the redirect prevents regressions if stdio fallback is used or a dependency logs unexpectedly.

## ADR-007: Y.Map for Annotations
**Decision:** Store annotations in a Y.Map on the Y.Doc rather than in the document content.
**Rationale:** Annotations are metadata, not content. Storing them separately means they sync independently and don't pollute the document structure.

## ADR-008: Shared MCP Response Helpers
**Decision:** Extract `mcpSuccess`, `mcpError`, `noDocumentError` into `response.ts` instead of inlining the response envelope in every tool.
**Rationale:** 16+ tools each needed the same 3-line wrapping pattern. Centralizing it eliminated 267 lines of boilerplate and ensures consistent error shape across all tools.

## ADR-009: Two-Pass Y.Doc Loading for Correct Inline Mark Ordering
**Decision:** `mdastToYDoc` uses a two-pass approach: build the element tree first, attach to the Y.Doc, then populate text content. Text insertion uses `insert(offset, text, attrs)` with explicit null marks instead of `insert()` + `format()`.
**Rationale:** Yjs reverses insert ordering on detached `Y.XmlText` nodes. When formatted text (bold, italic) is inserted before plain text on a detached node, the delta comes back reversed after attachment. This caused `**Bold** then plain` to render as `plain then **Bold**` in list items and any paragraph with mixed marks. The two-pass approach ensures all Y.XmlText nodes are attached to the Y.Doc before text operations, and explicit null attributes prevent mark inheritance from adjacent formatted segments.

## ADR-010: docIdFromPath for Multi-Document Room Names
**Decision:** Generate document IDs by hashing the normalized file path and combining with a slug of the filename. Use this ID as both the server-side Map key and the Hocuspocus room name.
**Rationale:** Document IDs must be stable across sessions (same file always produces the same ID), readable in logs, and collision-resistant. A basename + hash scheme achieves all three without UUIDs or a persistent registry.

## ADR-011: Optional documentId on All MCP Tools
**Decision:** All MCP tools that operate on a document accept an optional `documentId` parameter, defaulting to the active document.
**Rationale:** Backward compatible — single-document scripts work unchanged. Multi-document workflows can target specific documents without switching the active context. Avoids a breaking API change while enabling document groups.

## ADR-012: Streamable HTTP Transport (replacing stdio)
**Decision:** Migrate MCP from `StdioServerTransport` to `StreamableHTTPServerTransport` on port 3479, with stdio preserved as a fallback via `TANDEM_TRANSPORT=stdio`.

> **Partly superseded — read with [ADR-045](#adr-045-mcp-transport-multiplexing--one-mcpserver-per-session-keyed-by-mcp-session-id) and its 2026-07-30 amendment.** Two claims below are dated. (1) *"Each `initialize` request rotates the transport"* was replaced by ADR-045's session registry — the `McpServer` is no longer long-lived-and-singular either. (2) *"the SDK crashes in stateless mode after the first `server.connect()`"* **was refuted by the #1253 probe (2026-08-12, SDK 1.30.0) and is struck below** — evidence in [`docs/spikes/stateless-transport-probe.md`](spikes/stateless-transport-probe.md). There is no crash, and `server.connect()` is not involved: `StreamableHTTPServerTransport.handleRequest` carries a deliberate guard that throws `Stateless transport cannot be reused across requests` once a transport built without a `sessionIdGenerator` has handled one request (tracked by `_hasHandledRequest`), so the boundary is the **second request on a given transport, not the handshake**, and under the Node wrapper the throw reaches the client as a bare 500 with an empty body — most likely what was read as a "crash" in 2024. That MCP `2026-07-28` is stateless is why this claim sat directly on the migration path and had to be re-probed; the answer is that stateless mode **is** usable and its rule is **a fresh transport per request**, while stateful mode is what lets one transport per session serve many and stays correct for the protocol versions Tandem speaks today. **ADR-045's 2026-07-30 amendment below still quotes the refuted wording and still asks for the probe that has since run; correcting that passage is tracked in #1332.** Also note the issue-#8 finding here attributes the stdio breakage to **Claude Code's** pipe management, not to Tandem — it does not rule the stdio transport out, and the plugin manifest's stdio entry works in production today.
**Rationale:** The stdio transport disconnects after the first `tandem_open` under Claude Code (Issue #8). Extensive investigation confirmed the bug is in Claude Code's stdio pipe management, not Tandem's server. Rather than waiting for an upstream fix, HTTP transport sidesteps the problem entirely. Uses stateful mode (`sessionIdGenerator: () => randomUUID()`) ~~because the SDK crashes in stateless mode after the first `server.connect()`~~ — **refuted; see the note above (#1332).** The real SDK constraint is that a *stateless* transport may not be reused across requests, so stateless mode requires a fresh transport per request; stateful mode is what lets one long-lived transport per session serve many. Each `initialize` request rotates the transport (Issue #18) — the `McpServer` is long-lived but the transport is ephemeral, created fresh per session. Express (bundled with the SDK) provides DNS rebinding protection via `createMcpExpressApp()`. This also prepares for Phase 2 (Cowork integration) which needs configurable URLs.

## ADR-013: Chat Persistence via JSON Files (not CRDT)
**Status:** Accepted
**Context:** Chat messages live in `Y.Map('chat')` on the `__tandem_ctrl__` Y.Doc. Y.Map is a CRDT — deleted keys persist in the internal state vector. The current 200-message prune in `saveCtrlSession` removes entries from the application layer but the underlying Y.Doc state still grows monotonically. This is fine for session-scoped chat but would cause unbounded state bloat if the Y.Doc were persisted long-term across sessions.
**Decision:** Persist cross-session chat history as JSON files alongside session data (one file per session at `%LOCALAPPDATA%\tandem\sessions\chat-{sessionKey}.json`), not by persisting the `__tandem_ctrl__` Y.Doc across server restarts.
**Options considered:**
- **(a) Keep session-scoped (status quo):** Simplest, no migration. Chat disappears on server restart. Sufficient for v1.
- **(b) SQLite via better-sqlite3:** True persistence, queryable, no CRDT bloat. Overkill for chat — adds a native dependency and compilation step.
- **(c) JSON file per session:** Simple step up from status quo. Matches existing session file pattern. Portable. No new dependencies.
- **(d) CRDT with compaction (periodic re-encode to fresh Y.Doc):** Stays in Yjs ecosystem. But compaction is complex — must recreate the Y.Map state without deleted keys, which requires serializing to JSON and rebuilding anyway. Fragile for marginal benefit.
**Rationale:** Option (c) provides persistence without CRDT overhead. On server start, load the JSON chat history and populate the Y.Map. On save, serialize the Y.Map to JSON (already done for the 200-message prune). No new dependencies, no compaction complexity, no state bloat. Migration path: if the JSON file doesn't exist, start fresh (backward compatible with existing sessions).
**Consequences:** Chat history survives server restarts. The Y.Map remains the live runtime store; JSON is the persistence layer. The 200-message limit in `saveCtrlSession` becomes the JSON file cap too. Future search/filtering can query the JSON directly without CRDT overhead.

## ADR-014: Cross-Platform Session Paths via env-paths
**Status:** Accepted
**Context:** Session storage was hardcoded to `%LOCALAPPDATA%\tandem\sessions\` with a fragile fallback to `.tandem/sessions` (project-relative). `freePort()` used Windows-only `netstat`/`taskkill`. Both blocked macOS/Linux distribution.
**Decision:** Use `env-paths` for XDG-aware session directories. Use `process.platform` detection in `freePort()` with `lsof` on macOS/Linux and `process.kill()` instead of shelling to `kill`. Guard UNC path rejection to Windows only.
**Options considered:**
- **(a) env-paths (chosen):** Zero-dep, ESM-only, returns platform-appropriate paths (LOCALAPPDATA on Windows, `~/Library/Application Support` on macOS, XDG_DATA_HOME on Linux). Exact match for the use case.
- **(b) Manual platform detection:** `process.platform` + `os.homedir()` + hardcoded subdirectories. Works but reinvents what env-paths already does correctly, especially XDG fallback logic.
- **(c) `appdata-path` / `app-data-folder`:** Less maintained, CJS-only, and don't handle the `data` vs `config` vs `cache` distinction.
**Rationale:** env-paths is the community standard (4M+ weekly downloads), handles edge cases (XDG_DATA_HOME override, suffix control), and is zero-dependency ESM. On Windows, `envPaths("tandem", { suffix: "" }).data` produces the same `%LOCALAPPDATA%\tandem` path as before — no migration needed.
**Consequences:** Session paths are now platform-appropriate. The `freePort()` function works on all three major platforms. UNC path security check remains active on Windows where it matters.

## ADR-015: tsup for Server Bundling
**Status:** Accepted
**Context:** The server built with plain `tsc`, producing unbundled JS that requires the full `node_modules` tree at runtime. For Tauri distribution, a single bundled file is much easier to package as a sidecar.
**Decision:** Use tsup (esbuild wrapper) to produce a single `dist/index.js` with all dependencies inlined. `tsc` remains for type-checking only (`--noEmit`).
**Options considered:**
- **(a) tsup (chosen):** esbuild-based, fast (77ms builds), zero-config for Node ESM, handles CJS interop automatically. Single `tsup.config.ts` file.
- **(b) esbuild directly:** Same engine as tsup but requires manual config for output format, platform, sourcemaps. tsup adds sane defaults without overhead.
- **(c) Rollup:** Slower, more config surface, better for libraries than Node servers. Overkill here.
- **(d) Keep tsc:** Simple but produces ~16 loose files plus the entire `node_modules` tree. Unsuitable for Tauri sidecar packaging.
**Rationale:** All server dependencies (yjs, remark, hocuspocus, MCP SDK, express, mammoth, etc.) are pure JS and bundle cleanly. No externals needed. The 88KB output is trivial to ship. `tsc --noEmit` in the `build` script ensures type errors are still caught in CI.
**Consequences:** `npm run build:server` produces a single `dist/index.js`. `npm run start:server` runs it. `npm run typecheck` validates types without emitting. The dev workflow (`tsx watch`) is unchanged.

## ADR-016: HTTP API for Browser File Opening
**Status:** Accepted
**Context:** Files could only be opened via Claude's `tandem_open` MCP tool. Users needed to open files from the browser without Claude Code running or connected.
**Decision:** Add REST endpoints (`POST /api/open`, `POST /api/upload`) on the existing MCP Express app (:3479). Extract shared file-opening logic from `tandem_open` into `file-opener.ts`, used by both MCP and HTTP paths. Uploaded files get synthetic `upload://` paths and are always read-only.
**Options considered:**
- **(a) HTTP REST endpoints (chosen):** Simple, reuses the existing Express app, clear separation from MCP protocol. CORS for browser origin.
- **(b) WebSocket-based open:** Send file path over Hocuspocus's `__tandem_ctrl__` channel. More complex, couples file management to the CRDT layer, harder to return errors.
- **(c) Browser-only FileReader with no server round-trip:** Would require the client to build Y.Doc content from file bytes — duplicating all format adapter logic in the browser.
**Rationale:** REST endpoints are the simplest path. The file-opener extraction also cleans up `document.ts` (which was a 600-line monolith) and makes the open logic independently testable.
**Consequences:** `file-opener.ts` is the single source of truth for file opening. `tandem_open` is now a thin MCP wrapper. Uploaded files can't be saved to disk (no real path) — `tandem_save` returns a session-only save with a clear message.

## ADR-017: Playwright E2E Tests with MCP SDK Client
**Status:** Accepted
**Context:** No browser-level integration tests existed. The critical path (open doc → Claude annotates → user reviews → text updates) was untested end-to-end.
**Decision:** Use Playwright with the MCP SDK's `Client` + `StreamableHTTPClientTransport` as the test client. Tests act as both browser user (via Playwright) and Claude (via MCP tool calls).
**Options considered:**
- **(a) SDK Client (chosen):** The MCP SDK already handles initialize, session IDs, and SSE parsing. ~30 lines of wrapper code.
- **(b) Raw JSON-RPC over HTTP:** Manual request construction, session ID tracking, SSE parsing. ~150 lines, fragile, duplicates SDK logic.
- **(c) Puppeteer:** Works but Playwright has better auto-waiting, parallel execution, and built-in `webServer` config.
**Rationale:** The SDK client is authoritative for the MCP protocol and eliminates an entire class of test-infrastructure bugs. `workers: 1` serializes tests because the server supports one MCP session at a time. Temp fixture dirs prevent session restore interference between tests.
**Consequences:** `McpTestClient` in `tests/e2e/helpers.ts` is the test helper. 8 tests cover the annotation lifecycle. CI runs E2E after build. `data-testid` attributes on client components provide stable selectors.

## ADR-018: Unified Position Modules (Issue #68)
**Status:** Accepted
**Context:** Position/coordinate conversion logic was scattered across multiple files: `flatOffsetToPmPos` in `annotation.ts`, `pmPosToFlatOffset` in `awareness.ts`, `flatOffsetToRelPos`/`relPosToFlatOffset` in `document-model.ts`, `resolveOffset` in `document.ts`, and `refreshRange` alongside annotation tools. Each consumer imported from a different location, making the coordinate system hard to reason about and easy to get wrong. The three coordinate systems (flat offsets, ProseMirror positions, Yjs RelativePositions) had no shared vocabulary or types.
**Decision:** Consolidate all position logic into three modules: `src/server/positions.ts` (server-side: flat offsets ↔ Y.Doc elements, flat ↔ RelativePosition, range validation), `src/client/positions.ts` (client-side: flat ↔ ProseMirror, annotation resolution), and `src/shared/positions/` (shared types like `RangeValidation`, `AnchoredRangeResult`, `PmRangeResult`, `ElementPosition`).
**Options considered:**
- **(a) Unified modules (chosen):** One file per layer (server, client, shared). All coordinate logic discoverable in one place per layer. Shared types prevent ad-hoc result shapes.
- **(b) Keep scattered but add shared types only:** Less disruption, but the "where does this function live?" problem remains.
- **(c) Single shared module:** Would require importing Y.js and ProseMirror types in both environments, creating bundling issues.
**Rationale:** Position bugs are the #1 source of annotation placement issues. Centralizing the logic makes it auditable and testable in isolation. The shared types enforce a consistent vocabulary across layers (`RangeValidation` instead of ad-hoc `{ valid, reason }` objects). Consumers import from one predictable location per layer.
**Consequences:** `src/server/positions.ts` exports `validateRange`, `anchoredRange`, `resolveToElement`, `refreshRange`, `flatOffsetToRelPos`, `relPosToFlatOffset`. `src/client/positions.ts` exports `annotationToPmRange`, `pmSelectionToFlat`, `flatOffsetToPmPos`, `pmPosToFlatOffset`. Annotation and awareness extensions are significantly simpler — they delegate to the position module instead of containing conversion logic inline. 307 new server position tests + 168 expanded client tests.

## ADR-019: Channel Shim for Push Notifications (Issue #106) — Claude default integration

**Status:** Accepted
**See ADR-038:** documents the channel push transport for the Claude default integration. Other MCP-capable clients use the same `/api/events` SSE endpoint directly; the Claude Code subprocess + Channels API path described here is Claude-specific.
**Context:** Claude Code previously relied on polling (`tandem_checkInbox`) to detect user actions — annotation accepts/dismisses, chat messages, document switches. Polling introduces latency (seconds between checks) and wastes tokens on empty responses. The Claude Code Channels API provides a push mechanism via `notifications/claude/channel`, but requires a stdio subprocess with specific SDK patterns.
**Decision:** Implement a thin channel shim (`src/channel/index.ts`) as a separate process alongside the existing HTTP MCP server. The shim connects to the Tandem server's SSE endpoint (`GET /api/events`) and forwards events to Claude Code as channel notifications. Server-side Y.Map observers detect browser-originated changes and emit `TandemEvent` objects to an event queue. All MCP-initiated Y.Map writes are tagged with `doc.transact(() => { ... }, 'mcp')` to prevent echo.
**Options considered:**
- **(a) Channel shim + SSE (chosen):** Thin subprocess for push, HTTP MCP stays for tools. Clean separation — shim is ~150 lines, handles only events + replies. SSE provides standard reconnection semantics with `Last-Event-ID`.
- **(b) Merge channel into HTTP MCP server:** Would require the HTTP server to also support stdio transport simultaneously, or migrate everything to stdio. Mixes concerns — 28 tools + event streaming in one transport.
- **(c) WebSocket channel from server to Claude Code:** No existing protocol support in the MCP SDK for server-initiated WebSocket pushes. Would need a custom transport.
- **(d) Enhanced polling with long-poll:** Reduces latency vs. regular polling but still requires Claude to initiate requests. Channels API exists precisely to solve this.
**Rationale:** The shim pattern keeps the channel concern isolated from the MCP tool server. Claude Code connects to both simultaneously: HTTP for tool calls, stdio for push events. The SSE event queue uses a circular buffer (200 events, 60s TTL) with `Last-Event-ID` replay for reconnection. Origin tagging is the key correctness mechanism — without it, Claude would see its own annotations echoed back as user actions.
**Consequences:** Two build outputs (`dist/server/index.js` + `dist/channel/index.js`). `.mcp.json` has both `tandem` (HTTP) and `tandem-channel` (stdio) entries. All MCP tool files (10 callsites across 6 files) must tag Y.Map writes with `MCP_ORIGIN`. The `createAnnotation` function signature changed to require `ydoc` as the second parameter (was optional) to support origin-tagged transactions. Channel meta keys use underscores only (Channels API silently drops hyphenated keys).

## ADR-020: SSE for Ephemeral Toast Notifications (Issue #101)
**Status:** Accepted
**Context:** The server needs to push transient notifications to the browser (annotation range failures, save errors). These are ephemeral — they don't need conflict resolution, persistence, or delivery to Claude. The existing Y.Map-based CRDT infrastructure is designed for persistent, conflict-resolved shared state.
**Decision:** Use a dedicated SSE endpoint (`GET /api/notify-stream`) with a server-side ring buffer (`src/server/notifications.ts`), separate from both the Y.Map-based document state and the channel event SSE (`GET /api/events`). The browser connects via `useNotifications` hook using native `EventSource`.
**Options considered:**
- **(a) Dedicated SSE endpoint (chosen):** Clean separation. No CRDT overhead. Ring buffer auto-evicts old notifications. Browser-only consumer — doesn't involve Claude or the channel shim.
- **(b) Y.Map('notifications'):** Would work but pollutes the CRDT with transient data. Y.Map entries are never truly deleted (they persist in the internal state vector). Notifications are fire-and-forget — CRDT conflict resolution adds no value.
- **(c) WebSocket messages:** Would require a custom message protocol alongside Hocuspocus's Yjs sync. Mixing concerns on the same WebSocket connection is fragile.
- **(d) Piggyback on channel SSE (`/api/events`):** Wrong consumer — channel SSE targets Claude Code via the shim. Browser toast notifications are unrelated to Claude's event stream.
**Rationale:** Ephemeral data should not enter the CRDT. The ring buffer (max 50 notifications) provides bounded memory usage without cleanup logic. SSE's native reconnection via `EventSource` provides reliability without custom retry code. The `useNotifications` hook deduplicates identical messages within a short window and renders a count badge instead of stacking duplicates.
**Consequences:** Two separate SSE endpoints on port 3479: `/api/events` (channel events for Claude) and `/api/notify-stream` (toast notifications for browser). New dependency on `EventSource` in the browser (natively supported in all modern browsers). Toast auto-dismiss timers are type-differentiated: error 8s, warning 6s, info 4s.

## ADR-021: extractText for tandem_getTextContent (Issue #148)
**Status:** Accepted
**Context:** `tandem_getTextContent` used `extractMarkdown()` for .md files, producing markdown syntax (e.g., `> ` for blockquotes). The annotation coordinate system uses flat text offsets from `extractText()`, which formats text with heading prefixes (`## `) and `\n` separators but does NOT include markdown syntax like blockquote prefixes. This mismatch caused offset drift — annotations placed using offsets from `tandem_getTextContent` on documents with blockquotes would land at incorrect positions.
**Decision:** Always use `extractText()` in `tandem_getTextContent`, regardless of file format. Never use `extractMarkdown()` for offset-bearing responses.
**Options considered:**
- **(a) Always extractText (chosen):** Offsets match the annotation coordinate system exactly. Users who need markdown can use `tandem_save` and read the file.
- **(b) Return both text and markdown:** More data for Claude but doubles token cost. The markdown would still have mismatched offsets, creating a footgun.
- **(c) Fix extractMarkdown to match flat offsets:** Would require rewriting the markdown serializer to produce identical character positions as extractText, defeating the purpose of having two formats.
**Rationale:** The primary use of `tandem_getTextContent` is reading document content to determine annotation ranges. Offset correctness is paramount — a human-readable markdown format is worthless if it causes annotations to land in the wrong place. The flat text format is already readable (heading prefixes are clear, paragraphs are newline-separated).
**Consequences:** `tandem_getTextContent` output for .md files no longer includes markdown syntax (no `> `, `- `, `*` etc.). Claude sees flat text with heading prefixes. Offsets from the response can be used directly with `tandem_highlight`, `tandem_comment`, `tandem_suggest`, etc. without drift.

## ADR-022: Unified Annotation Types — 5 to 3 (Issues #193, #245)
**Status:** Accepted
**Context:** The annotation type system had five values: `highlight`, `comment`, `suggestion`, `question`, and `flag`. In practice, `suggestion` was just a comment with replacement text, and `question` was just a comment directed at Claude. The distinction created unnecessary complexity: separate toolbar buttons (Comment, Suggest, Ask Claude), separate filter categories, separate code paths for creation and editing, and a `tandem_suggest` tool that duplicated `tandem_comment` logic.
**Decision:** Narrow `AnnotationTypeSchema` to three values: `highlight`, `comment`, `flag`. Absorb `suggestion` into `comment` with an optional `suggestedText` field. Absorb `question` into `comment` with an optional `directedAt` field. `tandem_comment` gains `suggestedText` and `directedAt` parameters. `tandem_suggest` remains as a legacy shim. `tandem_editAnnotation` simplified: `newText` sets `suggestedText` directly.
**Options considered:**
- **(a) Three types with optional fields (chosen):** Comments are the general-purpose annotation; `suggestedText` and `directedAt` are orthogonal modifiers. UI collapses to a single Comment button with "Replace" and "@Claude" toggles.
- **(b) Keep five types:** More explicit but the distinctions don't carry their weight. Five filter categories, five code paths, five toolbar buttons — all for two boolean-like distinctions.
- **(c) Two types (highlight + comment):** Flags are semantically distinct from comments (urgency, visual treatment). Merging them loses signal.
**Rationale:** The old `suggestion` and `question` types weren't independent concepts — they were comments with extra metadata. Making that explicit in the type system reduces surface area (fewer schema values, fewer UI controls, fewer tool variants) without losing expressiveness. The `suggestedText` and `directedAt` fields are composable — a comment can be both a suggestion and directed at Claude.
**Consequences:** `AnnotationTypeSchema` narrows from 5 to 3 values. Side panel filters replace "Suggestions"/"Questions" with "With replacement"/"For Claude". Browser toolbar collapses three buttons into one with toggles. `tandem_suggest` still works but is documented as a legacy shim. Existing annotations with `type: "suggestion"` or `type: "question"` are migrated on load.

## ADR-023: Cowork Plugin Bridge — stdio via npx, not HTTP (PRs #301, #304) — Claude default integration
**Status:** Accepted
**See ADR-038:** documents the Cowork plugin bridge for the Claude default integration. Cowork is a Claude Desktop feature; the stdio-via-npx bridge described here is one of the six Claude-specific extras.
**Context:** Claude Desktop's Cowork tab runs in an isolated VM and does NOT forward `localhost` HTTP MCP servers (either plugin-registered or globally registered in `claude_desktop_config.json`) into the VM. The Cowork support article confirms: *"Local MCP servers configured via claude_desktop_config.json... aren't available in Cowork."* Tandem originally registered a single plugin MCP entry: `{"type": "http", "url": "http://localhost:3479/mcp"}`. Cowork users saw zero `tandem_*` tools. We needed an empirical test and a distribution path that actually works.
**Decision:** Ship a `tandem mcp-stdio` CLI subcommand (thin stdio↔HTTP proxy that speaks the MCP stdio transport, preflights `/health`, and relays JSON-RPC to `http://localhost:3479/mcp`). Plugin MCP entries use `{"command": "npx", "args": ["-y", "tandem-editor", "mcp-stdio"]}`. Same pattern for the channel shim. Global `claude_desktop_config.json` entries remain HTTP for host Desktop sessions.
**Empirical findings (Phase 0 probes, 2026-04-15):**
- **Probe 6 baseline:** With both a global HTTP `tandem` entry and a plugin HTTP `tandem` entry registered, Cowork surfaced **zero** `tandem_*` tools. Only context7 (an npx-stdio entry) bridged. This invalidated both the "global HTTP bridges" and the "plugin HTTP bridges via dedup" hypotheses simultaneously.
- **Plugin-stdio DOES bridge:** context7 (`npx -y @upstash/context7-mcp@latest`) appeared as `mcp__plugin_tandem_context7__*` — proof that stdio-in-plugin reaches the Cowork VM.
- **Plugin cache constraint:** Plugins are copied to `~/.claude/plugins/cache/` WITHOUT `node_modules`. Repo-local launch commands (`npx tsx src/channel/index.ts`) fail in the plugin cache. Stdio entries must invoke a published npm package via `npx -y`.
- **Packaging bug — `workspaces` field in published tarball:** tandem-editor@0.6.1 shipped with `"workspaces": ["packages/*"]` in `package.json`. On Windows + Node 24, `npx -y tandem-editor <subcommand>` died with `ERR_UNSUPPORTED_ESM_URL_SCHEME` before any user code executed — the workspaces field caused npm 11 to hand the bin path to ESM `import()` as a raw `c:\...` string instead of a `file://` URL. Root cause proven by deleting the `workspaces` field from an installed copy and re-running — clean launch. Fix in 0.6.2: delete vestigial `packages/tandem-doc/` (never published, never imported; grep returned zero TS/JS/CI references; `npm view tandem-doc` → 404) and remove `workspaces` from root `package.json`.
**Options considered:**
- **(a) Stdio proxy via npx (chosen):** Matches the proven-working context7 pattern. `npx -y` handles its own caching. No committed build artifacts. Cold-start cost is one-time per machine.
- **(b) Public-internet remote MCP connector:** The officially sanctioned Cowork path per Anthropic docs. Requires exposing Tandem's MCP surface on a public URL, OAuth or token auth, and solving NAT traversal. Massively larger security and operational surface. Deferred to Phase 2+.
- **(c) Pre-built stdio shim committed to git:** Considered and rejected. Generated files in VCS = merge conflicts, confused contributors, and a permanent hygiene problem.
- **(d) prepack/postpack scripts or `clean-publish` to strip `workspaces` at publish time:** Strictly worse than removing `workspaces` from the repo entirely — leaves an invariant that someone can re-violate six months later without knowing.
**Rationale:** The proven bridge path is the one we ship. No speculation about Desktop internals survives Phase 0 probes: HTTP plugin entries don't bridge; stdio plugin entries via `npx -y <published-package>` do. The packaging fix is subtractive (delete dead code, remove an unused feature) rather than additive (new publish-time machinery), so future maintainers inherit fewer moving parts.
**Consequences:**
- Plugin `.claude-plugin/plugin.json` declares two stdio MCP servers: `tandem` (mcp-stdio) and `tandem-channel` (channel). Both shell out to `npx -y tandem-editor <subcommand>`.
- `tandem` npm CLI grows a `mcp-stdio` subcommand backed by the MCP SDK's `StreamableHTTPClientTransport` + `StdioServerTransport`.
- `src/shared/cli-runtime.ts` centralizes `redirectConsoleToStderr()` and `resolveTandemUrl()` — enforcing the "stdout is reserved" rule (CLAUDE.md §3) across both subcommands.
- `tandem` is required to be running on the host before Cowork plugin sessions do anything useful. Plugin README calls this out.
- The published tarball no longer contains a `workspaces` field. Future monorepo work must not reintroduce it without also adding a publish-time strip.
- **Follow-up owed:** CI smoke test that runs `npm pack` → install tarball globally → `npx -y tandem-editor --version` on Linux + Windows. The existing vitest harness spawns via `--import tsx` on source and bypasses the npm tarball + npx path — this is the class of bug it can't catch. Filed for Phase 2 prereqs.
- **Update (#1177):** the bare `npx -y tandem-editor <subcommand>` spec above let `npm exec` silently reuse any already-installed global `tandem-editor` — including a stale pre-desktop global predating `mcp-stdio` — instead of the intended version, producing "Server disconnected" on Claude Desktop startup. All npx entries (plugin manifest, Cowork VM installer, `tandem setup`'s Claude Desktop config) now pin an exact version instead: `npx -y tandem-editor@<version> <subcommand>`.

## ADR-024: `bearer_methods_supported` is advisory metadata; Claude Code ignores it (Phase 2 spike)
**Status:** Accepted (spike findings; enforcement change deferred to PR b)
**See ADR-038:** the spike findings here are empirical observations against the Claude default integration. Equivalent validation against other MCP clients is best-effort.
**Context:** The durable-annotations plan (`docs/superpowers/plans/2026-04-16-durable-annotations-cowork.md`) gates Phase 2 PR b (auth middleware) on two prerequisites. Task 5b asked: when `bearer_methods_supported` in the RFC 9728 Protected Resource Metadata is non-empty (e.g., `["header"]`), does Claude Code's MCP client change behavior — in particular, does it start sending an `Authorization` header? If yes, a conditional advertisement (`["header"]` when token active, `[]` when not — prescribed below) is necessary to avoid breaking the loopback-no-auth path. If no, the field is advisory and the flip has zero functional impact on connection behavior.

The current server (`src/server/mcp/server.ts:207,217`) advertises `bearer_methods_supported: []` unconditionally. The endpoint was introduced in `c57d7210` (2026-03-26, "serve RFC 9728 metadata so newer Claude Code skips auth prompt") because, at that time, newer Claude Code versions were observed probing `/.well-known/oauth-protected-resource` before connecting, and without the endpoint the client offered "authenticate" instead of listing tools. That commit reports an empirical probe from Claude Code; this ADR records the same measurement one year later.

**Decision:** The flip to `bearer_methods_supported: ["header"]` is safe and protocol-correct, but has no observable effect on Claude Code's CLI MCP client. Ship the flip in Phase 2 PR b alongside the auth middleware, gated on active-token state (conditional logic prescribed below). Do not ship the flip standalone — there is no functional benefit until the middleware enforces bearer auth, and leaving `[]` until then keeps the advertised posture consistent with the actual enforcement.

**Empirical findings (spike `spike/5b-bearer-probe`, 2026-04-17):**

Probe instrumentation — `src/server/mcp/server.ts` patched to (a) advertise `bearer_methods_supported: ["header"]` on both `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`, (b) log every GET of those paths with the User-Agent, and (c) log every POST `/mcp` with the `Authorization` and `mcp-protocol-version` headers. Server ran on an isolated port (3579, via `TANDEM_MCP_PORT=3579 npm run dev:server`) to avoid colliding with the real `tandem` entry on 3479.

- **Metadata serves as expected.** `curl http://localhost:3579/.well-known/oauth-protected-resource` returns `{"resource":"http://localhost:3579/mcp","bearer_methods_supported":["header"]}`. Same for the `/mcp`-suffixed variant. No middleware involvement, no CORS issues.
- **MCP SDK client (`@modelcontextprotocol/sdk` 1.x) does not read `bearer_methods_supported`.** Grep across `node_modules/@modelcontextprotocol/sdk/dist/esm` confirms the field is defined only in the Zod schema (`shared/auth.js:29`) and is never consulted in any branching logic in `client/auth.js`, `client/streamableHttp.js`, or `client/middleware.js`. The `_resourceMetadataUrl` field in `StreamableHTTPClientTransport` is populated only from a `WWW-Authenticate` response header on a 401 — the client does **not** proactively fetch `/.well-known/*` during a normal handshake.
- **SDK client empirical confirmation.** A minimal SDK probe (`_probe_client.mjs` in the spike worktree) connects to the probe server with and without a `requestInit.headers.Authorization` override. Probe logs show:
  - Case A (no override): `POST /mcp init=true authorization=(absent)`.
  - Case B (override): `POST /mcp init=true authorization="Bearer probe-5b-sdk-…"` and the `Authorization` header continues on every subsequent POST.
  - Neither case triggered a GET to `/.well-known/oauth-protected-resource`. Only the earlier manual curl requests appear in the well-known log.
- **Claude Code CLI empirical confirmation.** `claude mcp add --transport http --scope user tandem-probe-5b http://localhost:3579/mcp` plus `claude mcp list` (which performs a connection health check) produced the same pattern:
  - Without `--header`: health check shows `✓ Connected`. Probe logs show two init POSTs with `authorization=(absent)`. No GET on `/.well-known/oauth-protected-resource`.
  - With `--header "Authorization: Bearer probe-cli-bearer-token"`: probe logs show `POST /mcp init=true authorization="Bearer probe-cli-bea…"` — the configured header is forwarded verbatim. (Note: `claude mcp list` reported `✗ Failed to connect` in this case despite the header arriving on the wire; the failure appears unrelated to auth and is a separate `claude mcp list` quirk around initialize + listTools timing, not bearer enforcement.)
  - In neither case did Claude Code CLI GET `/.well-known/oauth-protected-resource`, contradicting the 2026-03-26 commit message's claim about newer Claude Code pre-probing. Either the pre-probe was removed from Claude Code, or it only fires after a 401 + `WWW-Authenticate` response from the server (consistent with the SDK's `_resourceMetadataUrl` path).

**Options considered:**
- **(a) Flip `[]` → `["header"]` standalone now (rejected):** Protocol-correct but has zero user-visible effect and misrepresents the server's actual posture (no middleware enforces bearer auth today). Creates an audit oddity: "why does the metadata claim bearer auth when anonymous loopback connections succeed?"
- **(b) Bundle the flip into Phase 2 PR b with conditional advertisement (chosen):** `bearer_methods_supported: ["header"]` only when a token is active and the auth middleware is enforcing it; `[]` otherwise. This ADR prescribes the conditional logic; PR b will implement it. The spike confirms the flip is behaviorally inert on the client, so the conditional logic is purely about server-side honesty.
- **(c) Drop the endpoint entirely:** Considered and rejected. Even if newer Claude Code no longer pre-probes, other MCP clients or future Claude Code versions may; RFC 9728 compliance is cheap and the endpoint is five lines. The 2026-03-26 original justification (avoiding an "authenticate" prompt) may still apply to non-Claude-Code clients.

**Rationale:** The field is advisory. Server-side metadata does not coerce client behavior in any MCP client we tested (raw SDK, Claude Code CLI). What controls whether `Authorization` is sent is the `headers` field in the MCP config entry — exactly the mechanism Task 5a verifies. The flip is worth doing for protocol honesty when enforcement is live, and not worth doing before.

**Consequences:**
- PR b (auth middleware) flips both `server.ts:207` and `:217` from `[]` to `["header"]`, guarded by "token is active" state. When no token is provisioned (fresh install, no `tandem rotate-token` invocation yet), the value stays `[]`.
- The code comment at `server.ts:200` ("Newer Claude Code versions probe this before connecting to MCP") overstates current behavior — Claude Code only hits `/.well-known/*` after a 401. Update the comment in PR b.
- The `claude mcp list` "✗ Failed to connect" behavior when an `Authorization` header is configured is a separate finding, filed as a follow-up investigation. It does not block Phase 2 work — the header reaches the server correctly; the CLI's health check is the only thing misreporting. May be a SDK-level timeout around `listTools` post-initialize.
- Spike branch `spike/5b-bearer-probe` is preserved for reference but not merged. PR b will re-land the identical one-line edits plus the conditional logic and middleware.

## ADR-025: Svelte 5 Migration Decision (Probe #312)

**Status:** Go | **Date:** 2026-04-26 | **Branch:** `probe/svelte` (preserved 90 days)

**Context:** Tandem's hardest client bugs (Lessons 5, 10, 14, 34, 44) stem from React's lifecycle model interacting with Y.js's imperative observer API. The hook `useYjsSync.ts` (350 LOC) requires 9 `useRef` calls, 3 cleanup callsite layers, 4 functional `setState` patterns, and 2 render-phase ref-sync patterns. This probe evaluated whether Svelte 5's rune-based reactivity genuinely simplifies this lifecycle management.

**Roadmap deviation:** `@tiptap/core` direct instantiation used instead of `svelte-tiptap`. The community wrapper provides only wrappers (EditorContent, BubbleMenu, NodeViewRenderer) that Tandem doesn't use. Vanilla approach is simpler with no wrapper dependency.

**Evaluation metrics (actual counts):**

| Metric | React | Svelte | Delta |
|--------|-------|--------|-------|
| LOC (lifecycle hook) | 350 | 370 | +6% |
| `useState` → `$state` | 12 | 12 | 0 |
| `useRef` → plain `let` | 10 | 8 | −2 |
| `useCallback` | 2 | 0 | −2 |
| `useEffect` → `$effect` | 3 | 4 | +1 |
| Cleanup callsite layers | 3 | 3 | 0 (Y.js-inherent) |
| Functional `setState(prev => ...)` | 6 | 0 | **−6** |
| Render-phase ref-sync | 2 | 0 | **−2** |

**Gate results:** All four passed. (1) Tiptap + Yjs + 3 custom extensions render and sync in Svelte 5, two-tab collab verified. (2) `yjsSync.svelte.ts` port complete, 6 functional setState + 2 render-phase syncs eliminated. (3) 200 open/close cycles with zero Y.Doc leaks. (4) RelativePosition resolves correctly; bridge pattern is 8 LOC in both frameworks.

**Per-lesson assessment:**
- **Lesson 5** (StrictMode double-mount): Structurally impossible in Svelte — no StrictMode equivalent.
- **Lesson 10** (allocation in state updaters): Structurally impossible — no functional `setState(prev => ...)`.
- **Lesson 14** (observer map cleanup): Same ceremony — imperative `observe`/`unobserve` with cleanup Map. Y.js-inherent.
- **Lesson 34** (Y.Doc swap severing observers): `$effect` auto-rewires on `$state` reassignment. Tab switch correctly unobserves old, observes new.
- **Lesson 44** (swap-vs-close phase): Same ceremony — explicit phase param required. Y.js-inherent.

**Svelte 5 constraints (migration requirements):**
1. `$state` does not proxy-track external mutable objects (Y.Doc, Y.Map). Bridge pattern (version counter in observer) required for reactive reads.
2. `$effect` cleanup ordering is unspecified across multiple effects. Each effect must be self-contained.
3. `state_unsafe_mutation` in `$derived` — stricter than React's `useMemo` (throws, not warns).
4. Reading + writing same `$state` in `$effect` creates infinite loop. Use plain `let` for accumulators.

**Decision:** Go. Migrate Tandem's client from React to Svelte 5, starting with v0.10.0. The probe eliminates two entire categories of recurring bug (Lessons 5, 10) and simplifies a third (Lesson 34). Y.js observer lifecycle (Lessons 14, 44) is acknowledged-neutral — identical ceremony in both frameworks.

**Migration sketch:** Incremental, one component at a time. `Editor.svelte` first (proven in Gate 1). Dual-framework ceiling at v0.11.0. E2E tests survive unchanged. Vite `resolve.dedupe` for prosemirror-*/yjs/@tiptap/* required. Tauri WebView validation before v0.10.0 merge.

**Consequences:**
- Full ADR draft with detailed evidence at `probe/svelte-spike/docs/adr-025-draft.md`.
- PR f (Cowork Settings UI) rebuilds in Svelte before v0.13.0.
- `useYjsSync.ts` (350 LOC, deferred in audit) is replaced rather than decomposed.
- Tiptap extensions remain unchanged (framework-agnostic, confirmed in Gate 1).

**Status (2026-05-01):** Complete. The atomic switchover shipped in v0.10.0 (PR #508). All 39 `.tsx` files replaced by `.svelte` counterparts; `react`, `react-dom`, `react-markdown`, and `@tiptap/react` removed from package.json. The dual-framework period lasted through v0.9.x only.

## ADR-026: Redesign Gap Audit Decisions (#439)

**Context:** Claude Design handoff bundle audited against v0.8.0 codebase. 11 gaps found between design and implementation. Full analysis in `docs/archive/redesign-review.md`; response prompt in `docs/archive/claude-design-response-prompt.md`.

**Decisions (2026-04-26):**

1. **`showAuthorship` default → `true`.** Match design. Existing users will see accumulated authorship history on upgrade. Tracked in #442.
2. **Highlight palette → 4 colors** (yellow/green/blue/pink, dropping red/purple). Migration strategy for existing `red`/`purple` annotation color keys delegated to Claude Design response. Risk: `HighlightColorSchema` is a strict Zod enum; removed keys cause annotation drops in `migrateToV1` unless migration logic is added.
3. **Layout → build `tabbed-left`** as a real `LayoutMode` variant in v0.9.0. The design's 3 swatches (tabbed-right, tabbed-left, three) are confirmed. `panelOrder` is currently ignored in tabbed mode; `tabbed-left` gets its own render branch. Tracked in #445.
4. **Density → spacing only.** No font-size collision with `textSize`. Design removes `--editor-size` font-size override from density levels.
5. **Authorship decorations → `data-tandem-author` attributes** (replacing `.tandem-authorship--*` CSS classes). Design CSS targets `[data-tandem-author="user"]` / `[data-tandem-author="claude"]`. Tracked in #443.
6. **Editor width minimum → 40%.** Applies as `maxWidth` on the editor flex child after panel subtraction. Tracked in #444.
7. **`imported` field → keep `author: "import"` enum value.** Design updates to match codebase. No code change.

**Blocking issues:** #440 (`heldInSolo` schema field) — resolved in PR #451. #441 (`/api/info` endpoint) — resolved in PR #458.

**Implementation status (2026-04-28):** Decisions 1, 2, 6 shipped in PR #451 (schema + palette). Decision 3 (`tabbed-left`) shipped in PR #461. Decision 5 (authorship data attributes) shipped in PR #462. Decision 4 (density) and 7 (`"import"` enum) required no code changes.

**Versioning:** All code-side work targets v0.9.0 (last breaking-change window). New settings UI deferred to Svelte rebuild (v0.10.0+) per ADR-025. Only the data model + `loadSettings()` parser changes land in v0.9.0.

## ADR-027: Annotation System Redesign — Audience-Based Model

**Status:** Accepted
**See ADR-038:** the `author: "claude" | "user" | "import"` constant and the `directedAt: enum(["claude"])` schema value defined here are preserved as pre-ADR-038 backward-compat artifacts. The wire-level string `"claude"` survives in exported annotation data; the data-model refactor milestone tied to `IntegrationConfig` (#477 PR 1) revisits both.
**Context:** First-principles analysis of the annotation system (see `docs/archive/annotation-system-analysis.md`) revealed that the type-based model (highlight / comment / flag) asks users "what kind of annotation?" when the natural question is "who is this for?" Users have three intents: instruct Claude, ask Claude a question, or leave a personal note. The current system encodes these indirectly through type choice and hidden sub-fields (`suggestedText`, `directedAt`), producing five visual presentations from three types. Additionally, `directedAt: "claude"` is vestigial — only Claude can set it (PR #382 removed the user's @Claude checkbox), meaning Claude directs comments at itself. `flag` overlaps with `highlight` (both mark text without additional info).
**Decision:** Redesign around audience. Three user annotation types: `highlight` (visual marker, not sent to Claude), `note` (personal text annotation, findable but Claude doesn't act), `comment` (text annotation sent to Claude). Claude creates only comments (with optional `suggestedText` for tracked changes). Remove `flag` type, `directedAt` field, `tandem_highlight` tool, `tandem_flag` tool, `tandem_suggest` tool, and modal review mode. Notes have a "convert to comment" action. Import (Word) comments enter as notes for user triage. `checkInbox` surfaces only comments, not notes or highlights. Selection toolbar becomes a near-text popup with text input and two submit buttons ("Note to self" / "Comment") plus highlight color buttons.
**Supersedes:** Parts of ADR-022 (type unification from 5→3). ADR-022's three types were `highlight`, `comment`, `flag`; ADR-027's three are `highlight`, `note`, `comment`.
**Options considered:**
- **(a) Audience-based model (chosen):** Primary distinction is who sees the annotation. Simpler mental model — users don't choose annotation types, they choose audience.
- **(b) Mode-gated audience:** Solo mode → personal notes, tandem mode → sent to Claude. Simpler (one button) but loses the ability to leave private notes while in tandem mode. Explicit buttons give per-annotation control.
- **(c) Keep current model, remove directedAt only:** Minimal change. Doesn't address the flag/highlight overlap or the unintuitive type-based mental model.
**Rationale:** The type-based model forced users to think in annotation taxonomy rather than intent. The audience-based model maps directly to user goals: mark text (highlight), write for myself (note), write for Claude (comment). Removing flag is safe because highlight colors already carry severity semantics. Removing `directedAt` eliminates a vestigial field with no behavioral backing. Making notes convertible to comments supports a natural workflow: review alone, mark up, then selectively share with Claude.
**Consequences:** `AnnotationTypeSchema` changes from `["highlight", "comment", "flag"]` to `["highlight", "note", "comment"]`. `sanitizeAnnotation()` migrates legacy `flag` → `note` and strips `directedAt`. Side panel filters change. Tutorial annotations updated. MCP tools reduced. Claude skill updated to not act on notes. Full design in `docs/archive/annotation-system-analysis.md`.
**Imported `.docx` comments (revised 2026-05-15, ADR-035 grilling pass):** Word reviewer comments enter as `author: "import"`, `type: "note"` — *not* `"comment"`. Rationale: imported comments are potentially third-party content (a colleague's review pass), not the active user's intent. The audience-based model already treats notes as user-private — visible to the user, surfaced via `tandem_getAnnotations`, but not auto-pushed to Claude. The user reviews each imported comment and promotes individually to `type: "comment"` (using the existing note→comment "Send to Claude" action) when they want Claude to act on it. `tandem_checkInbox` continues to ignore notes, including imports — Claude does not see imported comments without explicit user promotion. `sanitizeAnnotation` migrates legacy `author: "import", type: "comment"` records to `type: "note"` on read (emits an `import-comment-to-note` migration-log event). This reverses the earlier PR #482 / v0.9.1 revert; the original PR #474 import-as-note model was correct, and the revert traded user agency for convenience that wasn't load-bearing. The side-panel "Imported" filter (keyed off `author: "import"`) continues to work for both pre- and post-migration records.
**Target version:** v0.9.0 (data model + tool consolidation, PR #474); UI redesign (selection toolbar, convert-to-comment) deferred to v0.10.0 Svelte migration.
**Imported-comment writeback (revised 2026-06-17, docx-confidence Phase 0):** ADR-027 governs **Claude visibility**, which is a distinct boundary from the **`.docx` file round-trip**. Imported Word comments (`author: "import"`, stored as private `note`s) are now **written back to their source `.docx` on save**, even unpromoted — closing the priority-#1 confidence gap where a plain open→edit→save silently dropped reviewer comments (surfaced by the Phase 0d fidelity scoreboard; driver: "imported comments should not be dropped"). This does **not** weaken ADR-027's Claude-facing guarantees: imports stay `audience: "private"` and Claude-invisible throughout — the channel, `tandem_getAnnotations`, and `tandem_exportAnnotations` paths are untouched. Writing a comment back to the file it came from is content preservation, not Claude exposure. Enforcement lives solely in the `.docx` export gate (`src/server/file-io/docx-comment-export.ts`), which exports an annotation when EITHER it is a user/Claude `comment` (`type === "comment"` ∧ `audience !== "private"` ∧ `status === "pending"`) OR it is an **import round-trip** — `author === "import"` **AND** a populated `importSource`. The `importSource` corroboration is load-bearing: the durable store's `.passthrough()` envelope enum-validates `author` but does NOT cross-validate it against `importSource`, so `author: "import"` alone must never be sufficient to bypass the gate (a tampered/legacy record could otherwise smuggle user-private content into a shared file). Imported *replies* are gated symmetrically on `author === "import"` AND a populated `importAuthor`. Imports bypass the `type`, `audience`, **and** `status` gates — an accepted/dismissed import still round-trips (status is Tandem's review state, not the file's content); only an explicit **delete** (removal from the annotation map) drops an import from the file. Imported reply threads (`author: "import"` replies) likewise round-trip; user-authored notes/highlights and user-authored `private` replies never export. **Behavior note:** the reviewer's real name (`importSource.author`) now propagates as the Word comment byline on *every* save automatically — including Save-As to a *different* path (e.g. `internal-review.docx` → `client-deliverable.docx` carries the original reviewer's name). This is correct (it is their comment) but is a disclosure surface worth noting.
**Private note reply threads (revised 2026-06-03, #1000):** Notes may now carry reply threads — both user-authored replies and imported Word comment-reply threads (`author: "import"`). These replies are **user-private**: they display in the user's own UI (`getVisibleReplies` shows replies for notes and comments; highlights remain reply-less) but must NEVER reach Claude. Privacy is a durable property of the *reply* (`AnnotationReply.private`), set at creation for any reply whose parent is not a `comment`, **not** a function of the parent's current type — so a later note→comment promotion ("Send to Claude") cannot back-publish a previously-private reply. The Claude-facing boundary is enforced in three places, none of which moved for the relaxation: the channel observer (`src/server/events/observers/replies.ts` — only `comment` parents emit `annotation:reply`), and both MCP read paths (`tandem_getAnnotations` / `tandem_exportAnnotations`) via the single `channelVisibleReplies` helper (comment-parent gate **and** `private`-strip). `tandem_checkInbox` never attaches replies at all. Only the write-path guard (notes now accepted, highlights still rejected) and the client-display filter relaxed. Imported Word reply author names (`importAuthor`) and reply bodies are stored at rest in the durable annotation JSON alongside the existing `importSource.author`; they are never serialized to any Claude-facing surface. This is consistent with ADR-035's principle that audience/privacy is the load-bearing gate: a note and its entire reply thread stay private until the user explicitly promotes the note, and even then the pre-promotion thread remains local history.

## ADR-028: Plugin Monitor URL and Auth Resolution — `userConfig` over Hardcoded Default

**Status:** Split — the v0.10.1 resolution (`resolveTandemUrl` / `resolveAuthToken` precedence) is **Accepted** and shipped in v0.11.0; the v0.10.2 `userConfig` installer pre-population remains **Proposed**, pending the Sub-task D gate.
**Superseded in part by [ADR-047](#adr-047-claude-code-push-transport-activation):** the URL/auth resolution decision this ADR is titled for is untouched. Everything this ADR accumulated *about which transport is canonical* — the four updates and two corrections below — is superseded there, including rationale (1) of the 2026-07-19 decision, which rested on a permission relay that turns out to be unimplemented. Read ADR-047 for the transport question; the material below is kept as the record of how it was arrived at.
**See ADR-038:** the plugin monitor is one of the six Claude-specific extras built on top of the MCP contract. The URL/auth resolution policy here applies to the Claude monitor; other MCP clients connect to the same MCP HTTP endpoint without the plugin-host indirection.
**Context:** `src/monitor/index.ts` hardcoded `http://localhost:3479` and `authFetch` in `src/shared/cli-runtime.ts` read only `TANDEM_AUTH_TOKEN`. In Cowork VM sessions the monitor connects to loopback inside the VM (not the host's server) and silently fails; in custom-port and LAN-dev setups the URL override was ignored entirely. Phase 0 probe (2026-05) confirmed: (a) Claude Code's `monitors[]` manifest schema (CLI 2.1.126) rejects `env` blocks — the proposed manifest-level env injection approach is impossible; (b) the documented channel for runtime config is `userConfig` + `CLAUDE_PLUGIN_OPTION_*` env exports.
**Decision (v0.10.1):** Bake `CLAUDE_PLUGIN_OPTION_SERVER_URL` into `resolveTandemUrl()`'s precedence chain (before `TANDEM_URL`, after explicit override) and add peer function `resolveAuthToken()` with the same pattern for `CLAUDE_PLUGIN_OPTION_AUTH_TOKEN`. `authFetch` calls `resolveAuthToken()` instead of reading `TANDEM_AUTH_TOKEN` directly. Both the monitor and channel shim automatically benefit — no per-caller changes needed.
**Precedence rationale:** The order is `explicit override → CLAUDE_PLUGIN_OPTION_* → TANDEM_*`. Plugin-host vars represent the per-install configured value (written into `settings.json` by the Cowork installer or set by the user via `userConfig` UI), so they are the canonical install-time configuration. `TANDEM_*` is reserved for ad-hoc per-shell overrides — common in dev workflows but secondary to a stable plugin install. The explicit programmatic override sits above both so test code (and any future caller that needs to force a value) can short-circuit env entirely. Operators relying on `TANDEM_URL` from a plugin context must clear `CLAUDE_PLUGIN_OPTION_SERVER_URL` (or unset both and use the loopback default).
**Decision (v0.10.2, pending Sub-task D gate):** Add `userConfig` to `.claude-plugin/plugin.json` with `server_url` (non-sensitive) and `auth_token` (sensitive). Extend the Cowork installer (`src-tauri/src/cowork_installer.rs`) to pre-populate `pluginConfigs[<plugin-id>].options.server_url` in the Cowork workspace `settings.json` so users aren't prompted for LAN IPs manually. Gate: requires empirical confirmation that (1) monitors spawn in Cowork VM sessions, (2) `CLAUDE_PLUGIN_OPTION_*` vars reach the monitor process, and (3) the correct `pluginConfigs` key format (`TANDEM_ENABLED_KEY = "tandem@tandem"` is the strong prior based on `cowork_settings.json` patterns).
**Options considered:**
- **(a) Manifest `env` injection (eliminated by probe):** `monitors[]` schema rejects `env` blocks in CLI 2.1.126. Cannot install.
- **(b) Sidecar config file:** Installer writes `tandem_monitor.env.json`; monitor reads at startup. More surface area — adds a disk contract requiring a new CLAUDE.md Critical Rules entry.
- **(c) Monitor reads `installed_plugins.json`:** Reuses the Cowork installer's existing MCP-bridge env write. Fragile — depends on file-layout assumptions not yet empirically confirmed.
- **(d) `userConfig` + `CLAUDE_PLUGIN_OPTION_*` (chosen):** The documented, designed mechanism. Installer pre-populates `settings.json`; plugin host exports to all subprocess envs. Zero new disk contracts.
**Consequences:** Existing installs are backward compatible — all env vars are optional; callers get the same defaults when absent. Cowork real-time push remains gated on Sub-task D verification. `monitors[]` manifest `env` support remains an upstream gap — file issue against `anthropics/claude-code` (ref: issue #52245 monitor auto-arm, issue #27398 Cowork hook gaps).
**Update (2026-06-02, #985):** Spike B (`docs/spikes/plugin-monitor-viability-spike.md`, #712) subsequently established that Claude Code does not activate `experimental.monitors[].command` via *any* install path Tandem can use (`--plugin-dir`, path-source, or github-marketplace). *[Superseded 2026-08-09 — measured false for `--plugin-dir` on 2.1.226 in an interactive session; the variable was always TTY-vs-headless, not the install path. See the 2026-08-09 update below.]* The plugin monitor is therefore forward-looking only; until upstream activation lands, the **channel shim is the canonical v1.0 Claude Code push transport** and is registered by default for the Claude Code target (`shouldRegisterChannelShim`). *[Superseded 2026-08-07 — Track E removed the default; `shouldRegisterChannelShim` now returns `override ?? false`. Canonical, yes; default, no longer. See the 2026-08-08 update below.]* This reverts the earlier de-facto "monitor-canonical, channel-off-by-default" posture — see the #985 CHANGELOG entry and `docs/architecture.md` Plugin Monitor section.

**Update (2026-07-17):** Re-tested on Claude Code **2.1.212** — the monitor **does** activate interactively (via `--plugin-dir` and persistent installs), delivering an event to an idle session with no `--dangerously-...` flag. The 2.1.143 NO-GO above was version-specific, and its probes ran in `-p` print mode, where monitors never activate by design — so the NO-GO conflated two confounds. The monitor now ships **installable** via `npx -y tandem-editor@<version> monitor`: the manifest previously ran `node ${CLAUDE_PLUGIN_ROOT}/dist/monitor/index.js`, but `dist/` is gitignored so a github clone carried no binary, while npm ships `dist`. The channel shim **remains the registered default** *[no longer true as of Track E, 2026-08-07 — the shim is opt-in]*; the monitor is an independent push path, and the canonical-transport choice (channel vs monitor) was **deferred** at the time (resolved 2026-07-19, below) pending a content-richness probe (does the plugin host surface the monitor's stdout body or a generic wake?) and a measured double-fire rate (both active in one session double-deliver, confirmed).

**Correction (2026-08-06) — the 2026-07-17 update outran its evidence, in two different ways.**
It asserts three things: that the monitor activates via `--plugin-dir`, that it activates via
persistent installs, and that double-delivery was "confirmed". Those have different standing
and need separating.

- **The persistent-install half and the double-delivery claim were never measured for that
  text.** PR #1201, which shipped it, lists exactly these two as deferred: *"gated on two
  cheap interactive probes (P1 persistent-install activation, P2 combined-session
  double-delivery) … Not in this PR."* `docs/roadmap.md` then marks both resolved **by the PR
  whose own body defers them**. What did substantiate persistent-install activation is the
  **v0.18.0 acceptance run** — recorded at `CLAUDE.md`'s v0.18.0 entry as waking "an idle
  **manual** session" from the published package. Note that run shipped in the *same* release
  as this ADR text, not a later one, so no user saw the unsupported version in isolation;
  nothing in the repo connects the two. Cite the acceptance run, not #1201. Note also that
  "manual" there contrasts with *auto-launched*, not with *headless* — it is not by itself a
  claim about TTY attachment.
- **The `--plugin-dir` half WAS asserted by #1201** (its body reports a B1 re-test), and is
  now **unreproduced**: measured 2026-08-06 on 2.1.223, `--plugin-dir` did not activate
  `experimental.monitors[]` in any mode tested, and neither did a real marketplace install in
  `-p` print mode or under the launcher's headless `stream-json` flags. Deliberately
  *unreproduced* and not *falsified*: every cell tested was non-TTY, one of them is confounded
  (`--plugin-dir` headless cannot distinguish "inert headless" from "never loaded"), and the
  2026-07-17 text itself stipulates print mode is a place monitors never fire. Those negatives
  cannot refute an interactive claim. `--plugin-dir` **interactive** remains untested, and no
  spike file, probe script or raw output survives from the 2026-07-17 re-test — only the prose
  it produced. See `docs/spikes/plugin-delivery.md` for the harness and the cells it could and
  could not reach.

Practical consequence for rationale (2) below: an auto-launched session is headless by
construction, so on current evidence it would never spawn a monitor — the double-delivery
concern does not arise there, though it remains real for a hand-launched session that also
passes the channel flag.

**Update (2026-07-19) — canonical-transport decision RESOLVED: keep the channel.** The deferred choice is settled: the channel shim remains the canonical/default push transport; the plugin monitor stays an installable, no-flag alternative but is **not** made canonical, and the channel is **not** deprecated. Rationale: (1) the monitor is unidirectional (stdout-only), so the channel-only permission-prompt relay (`/api/channel-permission`) has no monitor equivalent — and the supervisor spawns `claude` with no TTY, so that relay is the only way a supervised session could surface a permission prompt; (2) auto-launched sessions already receive channel push, so a monitor there adds no new reach, only double-delivery; (3) making the plugin a global install would socialize the cost (a host-wide plugin-registry mutation for every user) without expanding the beneficiary set beyond manually-launched sessions. The monitor remains installable for that manual-CLI audience (#1201). See the Plugin Monitor section of `docs/architecture.md`.

**Correction (2026-08-04, #1266) — rationale (2) above was false.** "Auto-launched sessions already receive channel push" was never measured; it was inferred from the shim being registered on the spawn's flag vector. A spike against a real `claude` binary (`docs/spikes/channel-push-stream-json.md`) shows it does not hold under the flags the auto-launcher actually uses (`-p --input-format stream-json`): the shim loads and receives the event — `push.subscribers` rises while the child runs, and the frame is visible on `/api/events` — but the session never takes a turn. An aliveness control (a second turn written by hand onto the same idle session, answered normally) rules out a dead process, isolating the failure to the shim → Claude hop.

The decision to keep the channel canonical **stands** — rationales (1) and (3) are untouched, and the channel remains correct for manually-launched interactive sessions, which this spike did not test. What changes is that auto-launched sessions no longer depend on it: the supervisor now subscribes to the event queue in-process and writes wake turns onto the child's stdin directly (`src/server/launcher/supervisor.ts`). It registers as an **`"external"`** subscriber, so the WS-A2 Solo gate applies to it exactly as to the SSE consumers, and the wake turn deliberately carries no event payload — `tandem_checkInbox` stays the only path by which content reaches the AI.

**Update (2026-08-08) — the removal gate was evaluated. Verdict: KEEP `experimental.monitors`, and keep the plugin's `tandem-channel` entry.**

Track F of the push-delivery plan proposed deleting both from `.claude-plugin/plugin.json`: the monitor because it fires `exit 127` in sessions unrelated to Tandem when the host has no Node on its PATH, and the plugin's `tandem-channel` MCP entry as its bare-`npx` twin (same command, same host env, same failure — and `node-binary.ts`'s absolute-path fix applies to *generated* config, which a static manifest cannot use). Neither is deleted. Recording why, because the reasoning reverses two things that were briefly believed during the audit:

- **The `exit 127` field report is evidence the host still SPAWNS the manifest entry — which is less than "activates", and the earlier draft of this paragraph overstated it.** The line is *host* output: the plugin host ran the monitor's command string through a shell and reported `127`, command-not-found. That refutes "the current CLI ignores `experimental.monitors` entirely", which is the form the removal argument needed. It does **not** show that a monitor which starts successfully gets its stdout wired into the session as a notification — and "activates" has meant exactly that everywhere else in this ADR. The counterexample is in this same ADR: monitors "never activate by design" in `-p` print mode, yet a host that spawns in that mode would still report a spawn failure, so an `exit 127` line is fully compatible with non-activation. The field report also carries no CLI version for the sessions it describes, which is the same gap this update faults P-A2 for. The positive delivery evidence remains the v0.18.0 acceptance run on 2.1.212, and nothing here strengthens it. What changed is only that one line of the removal argument — "the incumbent may already be dead" — does not survive; an earlier draft cited the same report as *harm* while calling activation unproven, which it cannot be at once.
- **The replacement's standing was weaker than assumed at the moment the gate was written.** `docs/spikes/monitor-self-arm-probe.md` (P-A2) records no CLI version and armed the **shell** source — which [ADR-049](#adr-049-the-self-armed-wake--ws-transport-no-arbitration-payload-free-frames) decision 1 then demoted as unusable on Windows. So the `ws` source that actually ships was, at that point, backed by a read of the tool schema and nothing else. It has since been measured end to end (`docs/spikes/wake-socket-end-to-end.md`, Claude Code 2.1.226) — but the gate's rule stands regardless: **do not delete a working path on the strength of a replacement, however good, when the two populations are disjoint.** A user whose `npx` does not resolve has already lost the monitor; deleting it takes nothing from them and takes a working path from everyone else.

The noise is addressed without touching the path. `npx … monitor || exit 0` uses an operator valid in both `/bin/sh` and `cmd.exe` and zeroes the exit code — though it suppresses no stderr, and there is no portable one-liner that does both (`2>/dev/null` is a syntax error in `cmd.exe`). That trade — a silent failure in place of a loud one — is itself a judgement call, so it is **not** applied here either; it is filed with the gate below.

**What would open the gate,** stated so it is answerable from tracked files rather than from a memory of a probe (CLAUDE.md's dated-gate rule, #1308):

1. `git log --grep='self-arm'` shows the `ws` wake path shipped and no field report of it failing for one full release cycle, **and**
2. `docs/spikes/` contains an **interactive** run, on a named CLI version, of a monitor that starts successfully and whose output never reaches the session. Phrased as delivery rather than as "does not activate" on purpose: under the corrected reading above, a spawn-failure line is itself weak evidence of spawning, so "the host emitted nothing" is indistinguishable from a misconfigured probe and would be a criterion nothing could honestly satisfy.

Either "keep", "replace", or "retire" at review time; "wait and see again" is not an outcome. Tracked as **#1349** (titled with its date, so it surfaces in `gh issue list` rather than living only here), which also parks the untested `|| exit 0` mitigation.

**Update (2026-08-09) — the gate is CLOSED. Verdict: KEEP, permanently. #1349 resolves as "keep"; do not re-open it on a timer.**

Condition 2 above asked for "an **interactive** run, on a named CLI version, of a monitor that starts successfully and whose output never reaches the session." That run has now been made, and it measured the **opposite**: on Claude Code **2.1.226**, win32, a manifest-declared monitor armed once the interactive UI mounted (16.4 s after spawn in the one run where both timestamps were recorded) and **every stdout line then became a model turn** in a session that received no input at all. Four consecutive events, four turns. See [`docs/spikes/plugin-monitor-tty-activation.md`](spikes/plugin-monitor-tty-activation.md).

The gate could not be tested for a year because `winpty(1)` refuses to run when its own stdin is not a tty; driving ConPTY directly through `pywinpty` has no such requirement. That is the whole reason this sat unproven — not a hard constraint, a tooling assumption nobody re-examined.

Three consequences, and the third is the one that costs us something:

- **The 2026-08-08 verdict was right for a weaker reason than the one now available.** It rested on "do not delete a working path on the strength of an unproven replacement." The path is no longer *possibly* working; it is measured working, on the current CLI, end to end. The sentence above — "the positive delivery evidence remains the v0.18.0 acceptance run on 2.1.212, and nothing here strengthens it" — is superseded.
- **The manifest schema's own description states the mechanism.** `experimental.monitors` is described in the shipped schema as arming "persistent Monitor tasks", and its `command` field as delivering "each stdout line ... to the model as a `<task_notification>` event" — same task kind and same delivery as a `Monitor` tool task. So the manifest path adds no delivery machinery of its own; it only supplies a different arming trigger. Two honest limits: these are **description strings read by hand out of one build**, the weakest tier of evidence in this repo by `plugin-delivery.md`'s own standard, so the convergence is corroborated inference rather than direct observation of the code path; and it does not carry to the transport ADR-049 ships, since Decision 1 there mandates the shell-free `ws` source. What P-A2 corroborates is the **manifest** path, because P-A2 armed a shell command.
- **Both paths sit behind the same remote feature gate, `tengu_amber_sentinel`, which defaults to false.** The `Monitor` tool's `isEnabled()` and the plugin-monitor arming function read the identical flag. So neither path is unconditional, and ADR-049's "no install, no flag" framing overstates what the code supports. It is a defect in shipped copy, not in this decision: fixed in **PR #1353** and recorded as a dated amendment to ADR-049, which also adds the Windows Git Bash precondition that the `Monitor` tool has and the plugin monitor does not.

`|| exit 0` is **retired unapplied**. It was parked as a way to silence a failure; with delivery proven the failure is worth fixing rather than muting, and the fix is a resolvable command. The manifest's two unused levers — `${CLAUDE_PLUGIN_ROOT}` substitution (which also bypasses the cwd guard, since a path-ful command skips `where.exe` resolution) and `when: "on-skill-invoke:<skill>"` (which stops the monitor arming in sessions that have nothing to do with Tandem, the actual objection behind the removal proposal) — are the replacement. **`${CLAUDE_PLUGIN_ROOT}` is blocked as written**: `dist/` is gitignored, so a github-source install has no `dist/monitor/index.js` to point at, which is why the manifest reaches for `npx` in the first place. That is a distribution problem and needs its own decision; it is not a reason to keep a command that cannot resolve.

**Update (2026-08-09, #1354) — one lever applied, the other closed off.**

`when: "on-skill-invoke:…"` shipped. The monitor now arms when Claude first dispatches the Tandem skill in a session rather than at session start, which retires the "fires in unrelated sessions" objection without giving up the path. **It needs two manifest entries, not one.** The host matches `when === "on-skill-invoke:" + <published name>` by plain string equality, and the published name is qualified iff the dispatched skill came from a plugin. Tandem ships the `tandem` skill twice — the plugin auto-loads `skills/tandem/`, and `tandem setup --apply` writes `~/.claude/skills/tandem/SKILL.md` — so a user with both sees `/tandem` and `/tandem:tandem`, and the bare one resolves to the *non-plugin* copy. A manifest declaring only `tandem:tandem` would therefore arm for nobody who ran our own setup. Measured across F6–F8 in [`docs/spikes/plugin-monitor-tty-activation.md`](spikes/plugin-monitor-tty-activation.md) — F6 and F7 reproduced twice each, F8 once — and then confirmed end to end on the shipped manifest in F10, where the bare entry is the one that armed.

The trade is stated rather than hidden: a session that never dispatches the skill now gets no monitor, where before it got one. That is deliberate, and it is not as costly as it looks — the population that suffered the every-session `exit 127` is precisely the population for whom the monitor never worked, so they lose no coverage by it going quiet.

**A second consequence, less obvious, and it is a regression rather than a trade.** `SKILL.md` tells Claude to arm a self-armed watch only when Tandem reports nothing subscribed. Under `when: "always"` that was a sound test: the monitor connected at session start, so by the time anyone dispatched the skill the count was already non-zero and Claude declined. Now the skill dispatch *is* the arm trigger, and F10 measured 16 s from dispatch to the monitor arming — far longer than Claude's first tool call. So the count Claude reads is stale by construction, and a user with both the plugin and a `Monitor` tool gets two consumers and two wakes per event. The two preconditions overlap (both gate on `tengu_amber_sentinel`), so this is the expected case for that population, not a corner. Bounded, though: the inbox de-duplicates, so the cost is a wasted turn rather than a duplicate reply, and doubled wakes are themselves the only available signal — nothing server-side can distinguish the two consumers. `SKILL.md` v9 therefore tells Claude to `TaskStop` its own watch when it sees the doubling, which is the only party that can observe it.

**The command lever is closed, not merely blocked.** One new measurement and two static arguments — labelled, because only the first is evidence:

- **MEASURED.** `${user_config.KEY}` — a `type: "file"` field defaulting to an absolute node path, which would have been the escape hatch — **does not substitute into a monitor command**. A bare-`node` control armed while the substituted entry did not (`scripts/spikes/probe-monitor-userconfig.py`). *Stated limit, which the spike carries and this summary must not drop:* `--plugin-dir` runs no enable-time prompt, so the run cannot separate "monitors do not substitute `user_config`" from "defaults are not applied unless the user is prompted". The operative conclusion — you cannot reach a node path this way — holds either way; the mechanism is not what was measured.
- **INFERENCE from existing docs.** The documented field failure is a GUI launch whose PATH contains no Node, so switching the command word from `npx` to `node` fails identically. Both `docs/troubleshooting.md` and `docs/spikes/plugin-delivery.md` already said no static manifest string fixes this; that stands.
- **STATIC.** A committed bootstrap would *ship* — `package.json` `files` includes `.claude-plugin/` and `skills/` — but its fast path would not resolve: it would look for `dist/monitor/index.js`, and no plugin install shape has one. `dist/` is gitignored, and the host installs plugins from a git repo, a local directory or an archive, never from the npm tarball that does carry `dist/`. So the bootstrap always falls through to the same `npx`.

So the command half depends on distribution — #1335's archive source carrying `dist/` — and there is nothing left to try at the manifest level. Tracked in #1354.

## ADR-029: Action Registry and Command Palette

**Status:** Accepted
**Context:** Tandem had ~10 ad-hoc `window.addEventListener("keydown")` callsites scattered across `App.svelte`, `useSaveShortcut.svelte.ts`, and `useSettingsShortcut.svelte.ts`. The Settings → Shortcuts tab rendered a hardcoded `SHORTCUT_SECTIONS` array that rotted as shortcuts were added or changed. A command palette (Wave 2 redesign, #571) needed a shared list of actions to display and invoke.
**Decision:** Introduce a central action registry (`src/client/actions/registry.ts`). Actions are identified by a stable string `id` with a literal `group` discriminator (`"editor" | "navigation" | "view" | "document"`). The `shortcut` field is display-only; binding is the caller's responsibility. `run()` is a zero-arg closure that captures dependencies at registration time — no shared `ctx` parameter, which would require all callers to assemble an ever-growing context object. Builtins (`src/client/actions/builtin.ts`) register at module import time (so the Shortcuts tab has content on first paint) but lazily resolve deps via getters wired by App.svelte — avoiding circular imports and premature initialization. The Settings → Shortcuts tab derives its content from the registry; the hardcoded `SHORTCUT_SECTIONS` is removed. Ctrl+S and Ctrl+, are migrated from dedicated Svelte hook files into App.svelte's global keydown handler; the hook files are deleted.
**Collision policy:** `registerAction` with a duplicate id warns in production and throws in dev (surfacing the bug at the source). Pass `{ replace: true }` to update an existing entry intentionally (e.g., OutlinePanel re-registering heading-jump actions).
**Non-goals:** This ADR does not define a binding-from-string mechanism (shortcut strings are display-only in Wave 2). Full migration of all ad-hoc keydown listeners is deferred; only Save and Settings migrate in this PR. Heading-jump actions (one per H1-H3) will be registered by OutlinePanel when PR 569 merges and the action registry is available.
**Consequences:** All future shortcuts should register via the registry before adding a hardcoded `SHORTCUT_SECTIONS` entry. The Settings → Shortcuts tab now reflects the live registry state; an empty registry on first paint is a dev bug (builtins are registered at import, so this should not occur in practice).
**Superseded in part by [ADR-041](#adr-041-customizable-keyboard-shortcuts-override-layer):** the "shortcut strings are display-only; binding is the caller's responsibility" stance still holds for the registry, but ADR-041 adds a parallel override layer so the ~17 App-level discrete shortcuts ARE user-rebindable. The registry `shortcut` field remains the *default* display; the effective binding is now `override ?? default`.

## ADR-030: Windows Code Signing via Azure Trusted Signing + OIDC

**Status:** Accepted (#428, PR #685, 2026-05-15)

**Context:** Pre-v0.12.0 Windows builds shipped self-signed (CHANGELOG entry from the v0.7.x era). SmartScreen flagged every download until reputation accrued; users saw "Windows protected your PC" on first launch. Reputation never accrues because the cert changes per machine. Three options were weighed:

- **EV cert from a commercial CA (DigiCert, etc.):** ~$300–500/yr + hardware token. Reputation accrues against the certificate identity. Friction: hardware token must be present at sign time → either an always-on signing service or manual CI gating.
- **Azure Trusted Signing (Basic tier, Public Trust):** ~$10/month. Microsoft-managed signing service. Reputation accrues against the Trusted Signing identity. Certs are short-lived (~3 days) and minted on demand; no hardware token. Requires an Azure account + Identity Validation step.
- **Status quo (self-signed):** zero cost, persistent SmartScreen friction.

**Decision:** Azure Trusted Signing, Basic tier, Public Trust → Individual Validation. CI authenticates via OpenID Connect federation (`azure/login` action) using a service principal bound to a GitHub Actions environment as the OIDC subject anchor — **no long-lived `AZURE_CLIENT_SECRET` lives in repository secrets**. The `dotnet/sign` CLI does the signing via Tauri's `bundle.windows.signCommand` (object form, absolute path to `sign.exe` — Tauri spawns signCommand as a subprocess that doesn't reliably inherit `$env:GITHUB_PATH`).

**Defense in depth:** Two independent gates restrict signing to `refs/tags/v*` builds: (a) a GitHub UI "deployment branch and tag rule" on the `release` environment (`Tag: v*`), and (b) a workflow-level pwsh step that exits 1 if `github.ref` doesn't start with `refs/tags/v`. Either alone is sufficient; both together survive UI misconfiguration or workflow-edit accidents independently.

**Verification:** A post-sign step runs `Get-AuthenticodeSignature` on `tandem-desktop.exe` plus every artifact under `bundle/nsis` and `bundle/msi`, failing the job if any artifact is unsigned or has a stale timestamp. The signer-subject check is logged only (not pattern-matched) until the first signed rc captures the actual Trusted Signing Individual cert subject DN — a TODO comment at that branch tracks the follow-up. Trusted Signing Individual validation issues certs with `CN=<verified legal name>`, not `CN=Tandem`, so a naive `-match 'Tandem'` would fail every legit signature.

**Operational note (`dotnet/sign` version):** Pinned to `0.9.1-beta.26127.1` for the `code artifact-signing` subcommand. Stable `sign` 1.1.x exists but renames this subcommand surface; do not bump silently. The version pin lives in `.github/workflows/tauri-release.yml` with a "why-beta" comment.

**Operator setup (one-time, pre-first-signed-tag):** Before the first `v*` tag build, an operator must (a) create the `release` GitHub Actions environment (`Settings → Environments → New environment → "release"`), and (b) add a deployment-tag rule (`Deployment branches and tags → Selected branches and tags → Add rule → Ref type: Tag → Name pattern: v* → Add rule`). The workflow-level pwsh guard refuses to run the signing path off non-tag refs as belt-and-suspenders, but the deployment-tag rule prevents the `release` environment's OIDC token from being minted in the first place for non-tag builds. Both gates must be intentionally bypassed for a signing path to execute off a non-tag ref.

**Rollback procedure:** If Trusted Signing rejects an artifact mid-tag-build (cert profile mis-named, OIDC federation broken, account quota hit), the operator has two escape hatches: (a) **abort the tag build** — delete the tag, fix root cause, re-tag; the workflow refuses to sign without a `v*` ref so partial failure leaves no signed artifact on the GitHub Release. (b) **Emergency unsigned rc** — temporarily comment out the `signCommand` block in `tauri.conf.json`, retag as `vX.Y.Z-rc.unsigned` (NOT a final `vX.Y.Z`), publish as a pre-release with a SmartScreen-warning note in the release body. Final tags MUST be signed; pre-releases MAY be unsigned for diagnostic purposes only.

**Cost / quota ceiling:** Basic tier includes 5,000 signing operations / month at ~$10. One full release across all platforms uses ~6 operations (NSIS + MSI primary + sidecar). Monthly signing volume even with weekly rc tags is far below ceiling. If volume grows (e.g. nightly builds), upgrade to Premium or add throttling. Cost is per-signing-operation, not per-artifact-size; large NSIS bundles are not penalized.

**Out of scope / follow-ups:** Tightening `id-token: write` permission scope to the Windows job only (low risk, deferred); hardening the cert-subject regex after the first signed rc captures the real DN; Dependabot config for the pinned `azure/login` SHA (accepting the freeze).

## ADR-031: Origin-Tagged Transaction Wrappers

**Status:** Accepted; implemented (verified against `src/` 2026-05-25). `src/shared/origins.ts` exports all six helpers (`withMcp` / `withFileSync` / `withInternal` / `withReload` / `withModeRelease` / `withBrowser` — `withModeRelease` was added later for the server-owned Solo→Tandem release sweep and joins the channel-skip set), the skip-set matrix is enforced in `events/queue.ts` + `annotations/sync.ts`, and — since #1482 — no raw `*.transact(` remains in `src/` for real. That claim was **false when first written**: three raw calls sat in `src/client/hooks/useChatState.svelte.ts`, because `audit-origins.ts` walked only `src/server` and the PostToolUse hook only ever sees files an agent just edited. #1482 tagged twelve client sites (the three raw transacts plus nine bare `map.set` mutations the issue had not inventoried), widened the audit to all of `src` including `.svelte`, and added a DEV runtime check for the bare-mutation shape no static walk can see. This implements option (a) of the Consequences below — "one mental model... no exceptions for `src/client/` vs `src/server/`" — rather than amending it. Note the client half is **hygiene, not a leak**: client origins never reach the server, which re-tags every incoming update with the `Connection` (see docs/gotchas.md). **Enforcement diverged from the Consequences below:** the actual guard is the warn-only PostToolUse hook `.claude/hooks/check-raw-transact.sh` plus the `npm run audit:origins` script — there is no blocking pre-commit `block-raw-transact.sh` and no Biome AST rule. Separately, issues #695/#700 later reversed the tombstone column of the skip-set matrix — `file-sync` / `internal` now **record** tombstones rather than skipping them (see the matrix note below). Designed in the `/improve-codebase-architecture` grilling pass, 2026-05-15; landed incrementally across the redesign waves.

**Context:** Critical Rule #2 required every server-side `doc.transact(...)` to carry an origin string — `MCP_ORIGIN` ("mcp") for Claude-initiated writes, `FILE_SYNC_ORIGIN` ("file-sync") for disk-reload echoes. Enforcement was reviewer-eyes plus a post-tool-use hook. An audit found ~40 `transact()` callsites across the server; roughly half passed an origin and half did not. The unlabelled half were not (yet) bugs — they happen during session restore, mdast / docx population, tutorial seeding, scratchpad seeding, and `clearAndReload`, which all run before the event queue and durable-annotation observers attach to that document — but the rule "every write declares its origin" had a silent exception that lived only in the reviewer's head. The origins themselves were plain `string` constants, so a typo or a forgotten second argument compiled fine and broke echo-prevention silently.

**Decision:** Replace direct `doc.transact(...)` with five free-function helpers in `src/shared/origins.ts`:
- `withMcp(doc, fn)` — Claude-initiated writes from MCP tools.
- `withFileSync(doc, fn)` — writes echoing from the durable-annotation file-writer (the back-from-disk path: load JSON annotations, write into Y.Map).
- `withInternal(doc, fn)` — server-internal setup writes that must not surface as user events and must not be persisted back as if they were live edits. Worked examples (every `withInternal` callsite in the codebase falls into one of these):
  - Session restore — populating Y.Doc fragment from disk-cached state; pruning chat history pre-save (`src/server/session/manager.ts`).
  - mdast / `.docx` HTML population during file open (`applyPreparedContent` in `src/server/mcp/file-opener.ts`).
  - Tutorial / scratchpad seeding (`src/server/mcp/tutorial-annotations.ts`; scratchpad seed in `src/server/mcp/file-opener.ts`).
  - **`clear-and-reload`** user-initiated via `tandem_open force: true` — `withInternal`, distinct from the file-watcher `reloadFromDisk` path (`withReload`). The user-initiated force-reload semantically overwrites local state with disk truth; channel skip is correct, durable-sync skip is correct (the file is authoritative), tombstone skip is correct (cleared annotations are not user deletions).
  - **Cleanup-after-failure paths** — e.g. `populateDocFromContent` partial-state cleanup in `src/server/mcp/file-opener.ts` and `evictPartialDocState` eviction transacts. These are not user actions; observability surfaces should not see them.
  - **Server metadata broadcasts on CTRL_ROOM** — `broadcastOpenDocs` and `Y_MAP_STORE_READ_ONLY` writes in `src/server/mcp/document-service.ts`. These are server-internal state announcements. Today they are tagged `MCP_ORIGIN` only because every observer that would care happens to skip MCP — a behaviour-by-coincidence pattern. `withInternal` makes the intent explicit and survives future observer changes.
- `withReload(doc, fn)` — file-watcher reload path (the `reloadFromDisk` flow): channel skips the event (not a user action) but durable-sync *must* persist (we want the re-anchored relRanges saved). Added after the CRDT-reviewer agent flagged that `reloadFromDisk` couldn't be classified under the original four-origin set without regressing #622 or producing a labelling lie. The post-reload annotation-refresh step (`refreshAllRanges` + position relocation, currently the second transact in `reloadFromDisk`) is also `withReload` — it is a continuation of the same logical operation, not a separate user-intent write.
- `withBrowser(doc, fn)` — user edits originating in the browser. Sets origin `"browser"`. No listener filters on it today, but the explicit label preserves the universal rule and gives future listeners a value to read.

Skip-set matrix:

| Origin     | Channel event queue | Durable-sync observer | Tombstone observer |
|------------|---------------------|-----------------------|--------------------|
| `mcp`      | skip                | persist               | record             |
| `file-sync`| skip                | skip                  | record             |
| `internal` | skip                | skip                  | record             |
| `reload`   | skip                | **persist**           | record             |
| `browser`  | emit                | persist               | record             |

**Tombstone column reversed post-ADR (#695/#700; matrix above reflects current code).** The original ADR-031 decision had `file-sync` and `internal` *skip* tombstones, reasoning that the eviction-and-reopen path (clear under `file-sync`, repopulate from disk) must not tombstone the cleared annotations or they would not reappear after the reopen. Issues #695/#700 reversed this to **record tombstones for all origins**: skipping risked *losing* file-driven deletes when `loadAndMerge` was skipped or failed. Resurrection is prevented structurally rather than by skipping — `recordTombstone` stamps the tombstone at `prevRev + 1`, the merge deletes a Y.Map entry only when `stone.rev > ymapRec.rev` (otherwise it treats the live copy as a resurrection and keeps it), and `loadAndMerge` re-seeds the ledger from the on-disk file on every open. See the observer + merge logic in `src/server/annotations/sync.ts`.

A pre-commit hook (`.claude/hooks/block-raw-transact.sh`) blocks any new `*.transact(` outside the helpers' file. The grep is paired with a Biome AST lint rule (`MemberExpression(property.name === "transact")`) to catch dynamic-dispatch bypasses (`doc["trans" + "act"](...)`, `Reflect.apply`, etc.) the grep misses. Test fixtures that construct synthetic Y.Docs are allowlisted via path pattern (`tests/**`, `**/*.test.ts`) or routed through a `transactForTest` helper exposed from `src/shared/origins.ts`.

**Options considered:**
- **(a) Four helpers, universal hook rule (chosen):** One mental model — "every write goes through a helper." No exceptions for `src/client/` vs `src/server/`.
- **(b) Server-only wrapper, raw `transact` allowed in browser:** Smaller diff, but the hook rule needs a path exception, and a reader of `withMcp` naturally asks "what about user edits?" — the answer "raw transact" reintroduces the discipline-only contract the wrapper was meant to remove.
- **(c) Branded `Origin` type with same call shape:** Keep `doc.transact(fn, MCP_ORIGIN)`, but make `MCP_ORIGIN` a branded type so plain strings fail to type-check. Does not catch the actual bug we care about — `doc.transact(fn)` with no second argument still compiles, because Y.Doc's second arg is declared optional upstream.
- **(d) Audit-and-remove all untagged writes, three categories only:** Treats the unlabelled writes as latent bugs to clean up. Rejected because the writes are intentional — they are a real category (server-internal setup), and naming them is more honest than re-classifying each as `mcp` or `file-sync`.
- **(e) Scoped writer (`originScope(doc, MCP).run(fn)`):** Useful for codebases with many multi-step transactions sharing one origin. Tandem's writes are overwhelmingly single-step; the scope object is over-engineered.

**Rationale:** The wrapper turns Critical Rule #2 from a prose rule reviewers must remember into a structural rule the toolchain enforces. The universal hook rule (no raw `.transact(` anywhere in `src/`) is simpler to teach and to verify than a server-only rule with a client-side exception. `internal` exists because the unlabelled startup writes are a genuine category, not an accident — giving them a name makes the contract complete instead of implicit.

**Consequences:**
- `src/shared/origins.ts` owns the helpers and origin constants; `src/server/events/queue.ts` and `src/server/events/origins.ts` re-export for backward compatibility during migration.
- Pre-commit hook `.claude/hooks/block-raw-transact.sh` exits 2 (block) on `*.transact(` matches in `src/` outside the helpers' file.
- Channel event queue (`src/server/events/queue.ts`) and durable-annotation sync observer (`src/server/annotations/sync.ts`) skip transactions whose origin is `mcp`, `file-sync`, or `internal`.
- Migration touches the ~40 server `transact` callsites plus the small number of browser callsites (e.g. `src/client/editor/toolbar/highlight-toggle.ts`). Sequenced as a single PR — the helpers' behaviour is functionally identical to the existing `doc.transact(fn, origin)` call shape, so the migration is mechanical.
- Critical Rule #2 in `CLAUDE.md` rewritten to name the four helpers and the four categories; the old MCP_ORIGIN / FILE_SYNC_ORIGIN constants stay exported (as `withMcp`'s internal origin string) but are no longer surfaced in the contract.
- Future channel-event observer work (see #5 grill) can rely on origins being structurally enforced rather than disciplinary, which simplifies the observer-factory design.

## ADR-032: Position Module Results as Tagged Variants

**Status:** Accepted; implemented (verified against `src/` 2026-05-25) — `RefreshResult`, `PmRangeResult`, `AnchoredRangeResult`, and `RangeValidation` are all defined in `src/shared/positions/types.ts`. Continuation of ADR-018. Designed in the `/improve-codebase-architecture` grilling pass, 2026-05-15; landed incrementally across the redesign waves.

**Context:** ADR-018 consolidated position logic into `src/server/positions.ts`, `src/client/positions.ts`, and `src/shared/positions/`. The consolidation succeeded structurally but left the result *types* under-designed. Each of the four high-level entry points returns an ad-hoc shape that hides a sum type behind a single nominal return:
- `refreshRange(ann, ydoc, map?)` returns `Annotation` but takes six semantically distinct paths: healthy (unchanged), updated (relRange resolved to new offsets), lazy-attached (relRange computed from flat), repaired (dead relRange re-anchored from flat), stripped (dead relRange deleted because re-anchor failed — annotation is now degraded but indistinguishable from healthy at the type level), and inverted (newFrom > newTo — logs an error and returns input unchanged, silently masking data corruption).
- `annotationToPmRange(ann, pmDoc, ydoc)` already encodes its variant via a `method: 'rel' | 'flat'` field but does not include a `'failed'` arm (null is used) and every checked caller (`useAnnotationReview`, `Editor.svelte` extension, `useMarginPositions`) ignores `method` entirely.
- `anchoredRange(...)` returns `{ok, fullyAnchored, range, relRange?}` — a boolean-tagged variant in flat object form.
- `validateRange(...)` returns `RangeValidation` with ad-hoc `valid`/`reason` fields.

Callers cannot distinguish degradation from health, and the "inverted CRDT range" and "stripped, can't re-anchor" paths flow through caller code as if nothing went wrong. The `method` field in `annotationToPmRange` proves callers will accept a tagged field; nothing in the consuming code reads it because there is nothing to reach for elsewhere.

**Decision:** Promote every high-level position result to a tagged variant. Apply uniformly so the module presents one shape contract:
- `refreshRange` returns `RefreshResult = { kind: 'ok' | 'updated' | 'attached' | 'repaired' | 'degraded' | 'failed', annotation: Annotation }`.
- `annotationToPmRange` returns `PmRangeResult = { kind: 'rel', from, to } | { kind: 'flat', from, to } | { kind: 'failed' }`, promoting the existing `method` field into the discriminator.
- `anchoredRange` returns `AnchoredRangeResult = { kind: 'anchored' | 'flat', range, relRange? }` (replacing `ok`/`fullyAnchored`). Validation failures use `kind: 'invalid'` with a reason.
- `validateRange` returns `RangeValidation = { kind: 'valid' } | { kind: 'invalid', reason }`.

Callers that don't care about the variant destructure `.annotation` / `.from` / `.to` and proceed. Callers that should care switch on `kind` with an exhaustive `never` fallthrough, so future variants force compile-time updates. Diagnostic emission (toasts, banners) is a caller responsibility — the position module emits no notifications, leaving its functions pure and testable in isolation.

**Options considered:**
- **(a) Tagged variants across all position results (chosen).** Most honest about what each function does. Migration is mechanical (~10 caller sites). Pairs naturally with the existing `method` field, which becomes meaningful instead of decorative.
- **(b) Tagged variants only on `refreshRange` and `annotationToPmRange`.** Leaves `anchoredRange` / `validateRange` half-migrated under boolean-tagged shapes. Friction shows up next time a new caller needs to distinguish "validated but not anchored" from "fully anchored." Rejected: piecemeal migration is more expensive than one consistent pass.
- **(c) Status field bolted onto `Annotation`.** Conflates transient resolution state with the serializable data type. Annotation flows into Y.Map writes; a `_status` field would silently serialize unless every writer strips it. Re-introduces the discipline-only pattern that ADR-031 just eliminated for origin tagging.
- **(d) Side-channel diagnostic callback.** `refreshRange(ann, ydoc, map, { onEvent })` keeps the existing flat return and emits events for observability. Cannot *prevent* a caller from rendering a broken annotation — only tells you afterwards. Position outcomes are something callers should be able to react to, not just observe.
- **(e) Centralised notification emission inside the position module.** Position functions would push toasts on degraded/failed. Hidden side effect couples server position logic to the notification system; makes the module non-pure and harder to test. Rejected — the notification ring buffer exists precisely so callers can decide whether a particular degradation warrants user attention.

**Rationale:** The functions are already sum types — they just lie about it in their return signatures. Tagged variants make the true shape visible to TypeScript's exhaustiveness checker, which is exactly the structural enforcement pattern Tandem has been moving toward (ADR-018 for module location, ADR-031 for origin tagging). The "inverted CRDT range" and "stripped without re-anchor" bugs hiding in `refreshRange` get *names* in the new shape; caller code that doesn't handle them fails the type check, which is when you want to learn about it. Keeping the position module pure (no side-channel notifications) preserves the testability gains from ADR-018 — the entire module remains coverable by unit tests that never touch the notification ring buffer or the toast container.

**Consequences:**
- `src/shared/positions/types.ts` gains `RefreshResult`, `PmRangeResult` (replacing the existing one), `AnchoredRangeResult` (replacing the existing one), and `RangeValidation` updated to the new shape.
- ~10 caller sites migrate. For "don't care" callers (most), the change is mechanical: `const ann = refreshRange(...)` → `const { annotation } = refreshRange(...)`. For "should care" callers (margin overlay, side-panel review, MCP error responses for invalid ranges), a `switch` block decides what to do with `degraded` / `failed`.
- `console.warn` / `console.error` calls inside the position module are removed; the variant carries the same information without the side effect. Callers that want a log line emit one at the call site.
- `refreshAllRanges` inherits the new shape — returns `RefreshResult[]`. The `MCP_ORIGIN` import in `refreshAllRanges` becomes `withMcp(ydoc, run)` once ADR-031 lands.
- ADR-018 remains the canonical record of the module split; this ADR is a continuation focused on result-type design. No supersede relationship.

## ADR-033: Document Registry and Named Hocuspocus Lifecycle Interface

**Status:** Accepted; partially implemented (verified against `src/` 2026-05-25). The `DocumentRegistry` landed (`src/server/documents/registry.ts`, described in-file as "a minimal seam extraction" owning `openDocs` / `activeDocId` / the keep-alive predicate). The named `HocuspocusLifecycle` interface is **deferred:** `src/server/yjs/lifecycle.ts` does not exist, and the free callback slots (`setShouldKeepDocument`, `setDocLifecycleCallbacks` with `onDocSwapped` / `onDocUnloaded`) still live in `provider.ts`. Designed in the `/improve-codebase-architecture` grilling pass, 2026-05-15.

**Context:** Document state was spread across two modules with three implicit invariants enforced only by call-order discipline:

- `src/server/mcp/document-service.ts` owned `openDocs: Map<string, OpenDoc>` (per-tab metadata: filePath, format, readOnly, source), `activeDocId: string | null`, and registered a `shouldKeepDocument` predicate at module-load time via the side-effecting `setShouldKeepDocument((name) => openDocs.has(name) || name === CTRL_ROOM)`. It also owned `broadcastOpenDocs()`, which writes the open-document list to `Y.Map('documentMeta')` on the CTRL_ROOM Y.Doc so the browser sees fresh tab state.
- `src/server/yjs/provider.ts` owned `documents: Map<string, Y.Doc>` (Y.Doc instances keyed by Hocuspocus room name), the Hocuspocus instance and lifecycle (`onLoadDocument` / `afterUnloadDocument`), and three free callback slots — `shouldKeepDocument`, `onDocSwapped`, `onDocUnloaded` — registered from `document-service.ts` and `events/queue.ts` at module load to avoid circular imports.

The implicit invariants: `openDocs.has(id)` implies `documents.get(id)` is live; `activeDocId` must be a key in `openDocs` or null; `Y.Map('documentMeta')` must reflect `openDocs` after every add / remove / setActive; CTRL_ROOM is never evicted and never appears in `openDocs`. Any caller adding to `openDocs` but forgetting to call `broadcastOpenDocs`, or setting `activeDocId` to a value not in `openDocs`, breaks consistency silently. Failure manifests downstream as missing tabs, MCP tools finding a tracked doc whose Y.Doc Hocuspocus evicted, or stale browser tabs (the "stale CRDT tabs merge old state back" gotcha in CLAUDE.md is partially this coupling).

**Decision:** Introduce a `DocumentRegistry` (singleton, lives in `src/server/documents/registry.ts`) that owns `openDocs`, `activeDocId`, the keep-alive-predicate logic, and `broadcastOpenDocs`. The registry layers *above* `provider.ts`'s `documents` map — it does not absorb Y.Doc instance storage. The three free callback slots in `provider.ts` are replaced by a named `HocuspocusLifecycle` interface (`src/server/yjs/lifecycle.ts`) with explicit `shouldKeep(name)`, `onLoad(name, ydoc)`, and `onUnload(name)` methods. The registry implements this interface; `provider.ts` invokes it during Hocuspocus's lifecycle hooks.

Public registry interface (sketch — not authoritative):
- `open(id, meta: OpenDoc): void` — adds entry, broadcasts, sets active if first.
- `close(id): void` — removes entry, broadcasts, clears active if it was active.
- `setActive(id | null): void` — validates id ∈ openDocs (or null), broadcasts.
- `get(id): OpenDoc | undefined` / `getActive(): OpenDoc | null` / `getCurrent(documentId?): { ...OpenDoc, docName } | null`.
- `getYDoc(id): Y.Doc | undefined` — delegates to `provider.getDocument(id)`. Documented as "may have been replaced by Hocuspocus on browser connect — do not cache the reference across awaits."
- `eachOpen(): IterableIterator<[id, OpenDoc]>` — iteration without exposing the underlying Map.

**Options considered:**
- **(a) Registry layers above provider; named lifecycle interface (chosen).** Single writer for openDocs / activeDocId / broadcast (the registry). Single writer for `documents` (provider, driven by Hocuspocus's lifecycle hooks). The seam between them is the `HocuspocusLifecycle` interface — published, typed, no free callback slots.
- **(b) Registry absorbs provider's `documents` map.** Rejected. `documents` legitimately holds two classes of entries: tracked-open tabs MCP serves *and* Hocuspocus-internal rooms (CTRL_ROOM on first browser connect, stale-tab reconnects to closed docs) that have no `OpenDoc` metadata. Making the registry own `documents` forces it to model both — the type lies. Additionally, the merge-and-swap in `provider.onLoadDocument` destroys and replaces Y.Doc instances; today every read calls `getOrCreateDocument(name)` fresh, and that pattern is load-bearing. Absorption tempts callers to cache registry-returned Y.Doc refs across awaits and break under swap.
- **(c) Keep state in two modules, just add helpers.** Rejected — leaves the implicit invariants exactly where they are. Doesn't earn its keep.
- **(d) Dependency-injected registry passed through every consumer.** Rejected. Tandem has no DI framework, the registry is process-global by nature (one process serves one set of open documents), and the existing callers already depend on module-level state. DI would be ceremony without a payoff.

**Rationale:** The agent-grounded read of `provider.ts` makes the layered call clear: the boundary between "Hocuspocus's view of every live Y.Doc" and "MCP's view of user-facing tabs" is real, not poorly drawn. The smell isn't the boundary — it's the three free callback slots used to cross it. Naming the contract (the `HocuspocusLifecycle` interface) eliminates the smell while keeping the boundary. CTRL_ROOM is the proof case: it's a Hocuspocus document that holds persistent chat history and must never be evicted, but it never appears in the tracked-open list. Layered handles this trivially; absorption would force a phantom `OpenDoc` or a special branch in every registry method.

**Consequences:**
- `src/server/documents/registry.ts` (new) owns openDocs, activeDocId, broadcast, the keep-alive predicate, and implements `HocuspocusLifecycle`.
- `src/server/yjs/lifecycle.ts` (new) exports the `HocuspocusLifecycle` interface. `provider.ts` accepts a `HocuspocusLifecycle` instance instead of three free `set*` callback registrations. The setter functions (`setShouldKeepDocument`, `setDocLifecycleCallbacks`) and the module-load side effect in `document-service.ts` are removed.
- `src/server/mcp/document-service.ts` is reduced to file-open / save / restore workflows; its state-management section is replaced by registry calls. The `addDoc` / `removeDoc` / `getActiveDocId` / `setActiveDocId` / `getCurrentDoc` exports become registry methods.
- The `broadcastOpenDocs` invariant is enforced by the registry — callers can't add to openDocs without broadcasting because they can't touch openDocs directly.
- The "stale CRDT tabs merge old state back" gotcha in CLAUDE.md is partially mitigated: the registry guarantees Y.Map('documentMeta') matches the tracked-open list, so a reconnecting tab sees the current truth instead of a stale snapshot.
- Pairs with #2 (file-open paths grill, ADR-034 forthcoming): the unified file-open seam writes through the registry instead of poking three pieces of state in order.

## ADR-034: File-Open Pipeline with Named Entry Points and Shared Core

**Status:** Accepted; partially implemented (verified against `src/` 2026-05-25). Part 1 landed: `src/server/documents/open.ts` exposes named entry aliases (`openFromDisk` / `openFromUpload` / `openScratchpad`) that forward to `file-opener.ts`, plus a derived `kindOfOpenResult` helper. **Deferred:** the shared internal pipeline still lives in the ~1000-line `file-opener.ts`, the `openFromRestore` entry point is not yet exposed, and `OpenResult` remains a derived enum rather than a discriminator on the result type. Pairs with ADR-033. Designed in the `/improve-codebase-architecture` grilling pass, 2026-05-15.

**Context:** `src/server/mcp/file-opener.ts` is 1049 lines exposing three public entry points (`openFileByPath`, `openFileFromContent`, `openScratchpad`) and internal helpers (`applyPreparedContent`, `clearAndReload`, `wireAnnotationStore`, `ensureAutoSave`). Six callers invoke `openFileByPath`: `startup-file.ts` (cold-start file-association), `index.ts` (welcome/changelog auto-open), `mcp/routes/open.ts` (HTTP REST API), `mcp/document.ts` (`tandem_open` MCP tool), `mcp/convert.ts` (after `.docx` HTML conversion), and `mcp/document-service.ts` (session restore — using a dynamic `await import(...)` to dodge a circular dependency through provider/registry state). Each caller wires the same downstream steps (track the doc, broadcast, set active, attach auto-save) in slightly different orders. `OpenFileResult` conflates outcomes via booleans (`forceReloaded`, `alreadyOpen`). The "open before HTTP bind" startup invariant (CLAUDE.md) is enforced by call ordering in `src/server/index.ts` only.

**Decision:** Restructure file-opener around named entry points that delegate to one shared internal pipeline:

- **Public entry points** (`src/server/documents/open.ts`, replaces `mcp/file-opener.ts`):
  - `openFromDisk(filePath, opts?: { readOnly?, force? }): Promise<OpenResult>`
  - `openFromUpload(fileName, content: Buffer): Promise<OpenResult>`
  - `openScratchpad(): Promise<OpenResult>`
  - `openFromRestore(sessionEntry): Promise<OpenResult>` — replaces the dynamic-import workaround in `document-service.ts`.

- **Shared internal pipeline** takes a normalized `PreparedSource = { kind, docName, content?, filePath?, format, readOnly, source: 'file' | 'upload' | 'scratchpad' }` and runs a fixed step sequence:
  1. Source-specific prelude (path resolve+validate for disk, decode for upload, synthesize empty buffer for scratchpad).
  2. Acquire Y.Doc via `provider.getOrCreateDocument(docName)`.
  3. Populate Y.Doc inside `withInternal(doc, ...)` (ADR-031) — server-internal setup writes.
  4. Wire durable annotation store.
  5. Wire auto-save (skipped for `readOnly`, `scratchpad`, and `upload`).
  6. Register with `DocumentRegistry` (ADR-033) — which broadcasts and updates `Y.Map('documentMeta')` atomically.
  7. Return a tagged `OpenResult`.

- **Result type**: `OpenResult = { kind: 'opened' | 'already-open' | 'reloaded-from-disk' | 'failed', doc?, reason? }` — replaces booleans, consistent with ADR-032's tagged-variant pattern.

**Options considered:**
- **(a) Named entry points with shared internal pipeline (chosen).** Discoverability — `grep openFromDisk` is the answer to "how do I open a file?" Per-source option shapes stay typed at the entry point (disk has `readOnly` / `force`; upload has neither). Six existing `openFileByPath` callers migrate by renaming; the others migrate at their own pace.
- **(b) Single `openDocument(source: TaggedSource, opts: TaggedOpts)` function.** The tagged union for source forces options to also become a tagged union, since `readOnly`/`force` only make sense for disk. The compound discriminated union reads awkwardly at call sites and gains nothing over named entry points.
- **(c) Class-based `FileOpenWorkflow`.** Each entry path becomes a method on a class that holds shared dependencies (registry, file-watcher, notification ring). Reasonable but heavier than Tandem's existing functional module style. Names like `new FileOpenWorkflow(filePath).normalOpen()` read worse than `openFromDisk(filePath)`. The class buys nothing over the registry-singleton + shared-helper combination.
- **(d) Keep the current shape; just split the file.** Rejected — leaves the boolean-conflated result type, the dynamic-import workaround, and the "every caller wires the postlude" pattern intact.

**Cold-start ordering note:** The CLAUDE.md invariant — "startup document opens must precede HTTP bind in HTTP mode, or stale browser tabs CRDT-merge incomplete openDocuments lists" — remains enforced by call order in `src/server/index.ts`. Solving it structurally (e.g. a deferral queue executed after bind) would require machinery for a one-time-per-process rule. The pipeline does not enforce it; it documents the requirement on the public entry points' JSDoc and trusts the startup-file flow to call before `startHocuspocus(port)`. The OS file-association warm-start path (Tauri `single-instance` plugin POSTing `/api/open`) goes through `openFromDisk` after bind, which is correct — only the cold-start preface matters.

**Rationale:** The three current entry points are *already* distinct interfaces with shared postlude — naming that explicitly is more honest than the boolean-flagged `OpenFileResult`. Pulling the postlude into the registry (ADR-033) and the internal-setup writes into `withInternal` (ADR-031) lets the pipeline focus on what's actually unique: the source-specific prelude. The circular-import workaround in `document-service.ts:411` disappears because session-restore becomes a fourth public entry point in the same module rather than a back-door reach into file-opener.

**Consequences:**
- `src/server/documents/open.ts` (new) replaces `src/server/mcp/file-opener.ts`. Re-export from the old location for one release to ease migration; remove the shim in the next.
- `src/server/mcp/document-service.ts` shrinks substantially — its file-open / save / restore workflow becomes calls into the open pipeline and the registry; its state-management section goes to the registry (ADR-033).
- `OpenFileResult` (boolean-conflated) becomes `OpenResult` (tagged). All six current callers of `openFileByPath` migrate; the `forceReloaded` / `alreadyOpen` branches in callers like `mcp/document.ts:189` become `switch (result.kind)`.
- The dynamic `await import("./file-opener.js")` in `document-service.ts:411` is removed; session-restore goes through `openFromRestore`.
- `routes/upload.ts` continues to call `openFromUpload` (renamed from `openFileFromContent`); `routes/open.ts` calls `openFromDisk`.
- `mcp/document.ts`'s `tandem_open` tool becomes a thin wrapper around `openFromDisk`. The MCP tool is the *adapter*, not the implementation — matching the seam pattern from ADR-016.
- Pairs with #1 (annotation lifecycle, ADR-035 forthcoming): the post-load annotation re-anchor pass (`refreshAllRanges`) runs inside step 3 of the pipeline, so the annotation lifecycle module doesn't have to know about file-open ordering.

## ADR-035: Annotation Lifecycle Module

**Status:** Accepted; partially implemented (verified against `src/` 2026-05-25). `src/server/annotations/lifecycle.ts` exists and `src/server/mcp/annotations.ts` routes the accept/dismiss transitions through it (`acceptPending` / `dismissPending`, returning a tagged `LifecycleResult`). **Deferred:** the create / remove / edit paths, `promoteNoteToComment`, the `.docx` `importNote` entry, and the `narrowForChannel` channel projection still live on the handlers rather than in the lifecycle module. Builds on ADR-027 (audience model), ADR-031 (origin tagging), and ADR-032 (tagged result variants). Designed in the `/improve-codebase-architecture` grilling pass, 2026-05-15.

**Context:** The annotation lifecycle is fragmented across six modules. Creating one comment touches all of them in implicit order:

1. `src/server/mcp/annotations.ts` (668 LOC) — MCP tool handlers. Inserts into `Y.Map(Y_MAP_ANNOTATIONS)` with `ydoc.transact(() => map.set(id, ann), MCP_ORIGIN)`.
2. `src/shared/sanitize.ts` — privacy normalizer (ADR-027): strips `directedAt`, migrates legacy `flag`→`note`, derives audience. Called in three places (read, observer, edit) with different `onLossy` sinks.
3. `src/server/annotations/schema.ts` (386 LOC) — `nextRev()`, status transitions.
4. `src/server/annotations/store.ts` (582 LOC) — durable JSON persistence keyed by content hash.
5. `src/server/annotations/sync.ts` (519 LOC) — file-sync observer; tombstone tracking with a "this ordering is load-bearing" comment around `recordTombstone` that points at a real fragility.
6. `src/server/events/observers/annotations.ts` — channel projection with author/type cascade and the ADR-027 "drop notes from channel" rule enforced via `if (ann.type !== "comment") continue`.

Changing the annotation shape — adding a field, renaming a state, tightening a privacy rule — forces edits across all six. Three real bugs and risks surfaced during the grilling pass (annotation-model-reviewer second opinion, 2026-05-15):
- **Re-accept bug at `annotations.ts:491`**: `tandem_resolveAnnotation` flips status to accepted/dismissed *without* checking `status === "pending"` first. An already-resolved annotation can be re-accepted, bumping `rev` and re-firing channel events.
- **Privacy rule lives only at the projection point.** The note-drop rule is `if (ann.type !== "comment") continue` inside the observer. A future refactor that bypasses the observer (e.g. a new channel path, or a tool that emits events directly) loses the privacy guarantee with no compile-time signal.
- **Tombstone ordering coupling.** `removeAnnotationById` (annotations.ts:78) calls `recordTombstone` *before* the delete transact, with a load-bearing comment. This is a coupling between the MCP tool and the durable-sync layer — a write path that bypasses the lifecycle (CRDT merge from a stale tab, file-sync reload) won't tombstone correctly.

**Decision:** Introduce `AnnotationLifecycle` (`src/server/annotations/lifecycle.ts`) as the seam for all annotation mutations. MCP tool handlers in `src/server/mcp/annotations.ts` become thin *adapters* that validate inputs and translate `LifecycleResult` into MCP response envelopes. The lifecycle owns: origin-tagged writes (via ADR-031's `withMcp` / `withInternal`), rev bumps via `nextRev`, status transitions, sanitize-on-write, and channel-event projection via the observer factory (ADR-?, #5 grill). The durable annotation store stays an *observer-driven* seam — `sync.ts` watches Y.Map and persists; the lifecycle does not call into store/sync directly. Tombstone tracking moves entirely into the sync observer; the load-bearing ordering comment is fixed in place by widening the observer's snapshot, not by preserving the coupling.

**Privacy invariant placement (Q1).** Channel projection consumes a branded `ChannelEligible` type produced by a narrowing function `narrowForChannel(ann): ChannelEligible | null`. Notes return `null`; comments return the branded value. The observer factory's projection function takes `ChannelEligible`, not `Annotation`. A future refactor that drops the narrow gets a TypeScript error at the projection call site instead of silently leaking notes. `sanitizeAnnotation` stays the canonical privacy normalizer (ADR-027) and is called inside `narrowForChannel`; rules are not duplicated. The narrow happens at projection time — not write time — because `note→comment` promotion is a real path that must surface as a channel event, and audience can change post-write.

**State machine placement (Q2).** Separate methods, not a single `apply(action)`:
- `createComment(range, content, opts) → LifecycleResult`
- `createHighlight(range, color) → LifecycleResult`
- `createNote(range, content) → LifecycleResult`
- `importNote(range, content, importSource) → LifecycleResult` — imports enter as notes per the revised ADR-027 (potentially third-party content, user-gated for promotion to Claude).
- `editPending(id, patch) → LifecycleResult`
- `acceptPending(id) → LifecycleResult` — fixes the re-accept bug; rejects non-pending.
- `dismissPending(id) → LifecycleResult` — same.
- `replyToPending(id, content, author) → LifecycleResult`
- `promoteNoteToComment(id) → LifecycleResult` — the single promotion path for both user-authored notes and `author: "import"` notes. The note → comment audience change is what surfaces an annotation to Claude; identical handling for both author types means imports require the same explicit user action as personal notes.

Each method's `LifecycleResult` failure variant enumerates only the failures that method can produce — types carry the preconditions. A single `apply(action)` would force every caller to handle every failure variant and would not have surfaced the re-accept bug.

**Imported `.docx` comments (Q3).** Separate `importNote(range, content, importSource)` entry. Creation context differs — imports run under `withInternal` (ADR-031) during `.docx` load, not under `withMcp`; preserve `importSource` metadata; set `author: "import"`, `type: "note"`. The audience is `private` (not `outbound`) — Claude does not see imported comments via `tandem_checkInbox` or the channel until the user explicitly promotes via `promoteNoteToComment`. Surfacing parity is *not* automatic: imports are gated by user intent the same way personal notes are. This reverses the earlier ADR-027 stance that imports surface like Claude-readable comments by default. The reasoning: a `.docx` reviewer comment may originate from a colleague, not from the active Tandem user; auto-surfacing it to Claude assumes consent the user did not give. **`narrowForChannel`'s predicate is `audience === "outbound" && type === "comment"` (both, not either)** — the audience derivation in `sanitizeAnnotation` is the load-bearing privacy gate, not the type alone.

**Tombstone tracking (Q4).** Stays observer-driven in `sync.ts`. The current `recordTombstone`-before-delete ordering is a `sync.ts` bug to fix (widen the observer's snapshot so it captures the pre-delete state on its own), not a coupling for the lifecycle to inherit. Observer-driven tombstoning survives writes that bypass the lifecycle: stale-tab CRDT merges (`feedback_stale_crdt_browser_tabs.md`), file-sync reload, future write paths. The lifecycle's delete method (`dismissPending` flips status; actual map deletion is rare and only happens on explicit cleanup) does not call into sync.

**Options considered:**
- **(a) Lifecycle module with separate methods + branded channel narrow + observer-driven tombstones (chosen).** Privacy invariants become structural via the branded type. Pre/post conditions become method signatures. Durable store stays decoupled.
- **(b) Single `apply(action: AnnotationAction)` method.** Rejected — masks state-machine preconditions inside a runtime check, would not have caught the re-accept bug.
- **(c) Privacy check only at write time, not at projection.** Rejected — note→comment promotion changes audience after write; projection-time enforcement is mandatory.
- **(d) Lifecycle owns durable persistence directly (writes to store as part of `createComment`).** Rejected — couples lifecycle to disk I/O, loses the "observer is the source of truth for what's on disk" invariant, and bypasses survives-the-lifecycle write paths (CRDT merge, file-sync).

**Rationale:** The lifecycle module collapses six modules' worth of implicit ordering into one explicit seam. The branded `ChannelEligible` type turns ADR-027's privacy guarantee from prose-in-a-comment into a TypeScript invariant. Separate state-machine methods surface the re-accept bug as a side effect of the typing discipline. Keeping the durable store observer-driven preserves the existing "what's on disk reflects what's in Y.Map" property, which survives all write paths — not just the well-behaved ones.

**Consequences:**
- `src/server/annotations/lifecycle.ts` (new) — public seam.
- `src/server/mcp/annotations.ts` (668 LOC) shrinks substantially — handlers become thin adapters. Re-accept bug fixed as a structural consequence of `acceptPending` requiring `status === "pending"`.
- `narrowForChannel` (in `src/shared/sanitize.ts` or a new `src/server/annotations/projection.ts`) becomes the only producer of `ChannelEligible`. Observer factory (#5 grill) projection takes `ChannelEligible`.
- `sanitizeAnnotation` consolidated to one call inside the lifecycle's read path. The three current call sites (read/observer/edit) collapse; migration-log relay context (docHash) flows through the lifecycle as a parameter.
- `rev` bump ownership: lifecycle calls `nextRev`. `sanitizeAnnotation` stops being responsible for preserving `rev` across the consolidated path; pick lifecycle as the sole owner.
- `sync.ts` tombstone observer widened to snapshot pre-delete state. The "load-bearing ordering" comment in `removeAnnotationById` and `sync.ts` is removed because the dependency is removed.
- Tests: `note→comment` projection path covered explicitly. Re-accept rejected explicitly. Stale-tab merge tombstoning verified.
- Pairs with #5 (observer factory): the channel projection function is the consumer of `ChannelEligible`; the factory's typed seam makes the privacy invariant un-bypassable.
- Pairs with #4 (origin tagging): `withMcp` is invoked exclusively inside the lifecycle for user-intent writes; `withInternal` exclusively for `importComment` during `.docx` load. MCP tool handlers do not call `transact` directly.

## ADR-036: Format Adapter as Capability Set

**Status:** Accepted; partially implemented, shape diverged (verified against `src/` 2026-05-25). The capability-set principle partially landed: `FormatAdapter` in `src/server/file-io/types.ts` is now a `parse` / `apply` / `save?` shape (optional `save` is capability-style, and the silent `.catch(() => [])` comment-extraction failure is replaced by `LoadIssue[]` partial-failure surfacing). **Diverged / deferred from the sketch below:** the interface settled on `parse` / `apply` rather than `load` / `LoadResult`, and `extractComments?` / `applyTrackedChanges?` were **not** added as adapter capabilities — `applyTrackedChanges` remains a free function in `docx-apply.ts` consumed via a direct import through `file-io/index.ts`. Sharpens encoding of ADR-004 (.docx review-only) and unblocks issue #576 (.docx write-back). Designed in the `/improve-codebase-architecture` grilling pass, 2026-05-15.

**Context:** `src/server/file-io/types.ts` declares a three-method `FormatAdapter` interface (`load`, `save`, `canSave`). The actual capabilities of registered adapters do not match that shape:

- **markdown / txt**: both methods + `canSave: true` — fits the interface.
- **docx**: `load` does four things (.docx→HTML conversion, comment extraction with silent `.catch(() => [])` fallback, Y.Doc population from HTML, inject comments as annotations); `save()` returns `null`; `canSave: false`. The interface models one of three real `.docx` capabilities — the other two (extract-embedded-comments, apply-tracked-changes) live in `docx-comments.ts` and `docx-apply.ts` (829 LOC of `applyTrackedChanges`) and are consumed via direct imports from `mcp/convert.ts` and `file-opener.ts`. ADR-004's "review-only by default" semantics are encoded by `canSave: false` plus a `null` return — two ways of saying the same thing.

Consequences observed: the `.docx` comment-extraction `.catch` silently turns "comments failed to extract" into "document loaded fine, just no comments" — callers can't tell the difference and users get no signal. The `canSave` boolean and `save() === null` invariant must stay in lockstep; nothing enforces that. New capabilities (#576 docx write-back; future formats that emit metadata; future formats that support tracked changes) have no place to live in the current interface.

**Decision:** Redefine `FormatAdapter` as a *capability set* — each capability is an optional method. The presence of the method is the contract; no boolean flags duplicate the structural fact.

```ts
interface FormatAdapter {
  load: (doc: Y.Doc, content: string | Buffer) => Promise<LoadResult>;
  save?: (doc: Y.Doc) => SaveResult;
  extractComments?: (content: Buffer) => Promise<Comment[]>;
  applyTrackedChanges?: ApplyTrackedChangesFn;
}

type LoadResult =
  | { kind: 'ok' }
  | { kind: 'partial', issues: LoadIssue[] }  // e.g. comments-failed
  | { kind: 'failed', reason: string };

type SaveResult =
  | { kind: 'ok', content: string | Buffer }
  | { kind: 'failed', reason: string };
```

`canSave` becomes `'save' in adapter`. Read-only is structural: a format adapter without a `save` method *cannot* save, full stop. The registry's `getAdapter(format)` return type stays singular but inspections happen by capability probe at call sites.

Comment extraction migrates from `.docx`'s `load()` body into the adapter's optional `extractComments` method. The pipeline (ADR-034) calls `extractComments` if present, after `load`, and translates failure into a `LoadResult.partial` issue rather than swallowing in `.catch`. `applyTrackedChanges` becomes an optional capability — `mcp/convert.ts` probes `if (adapter.applyTrackedChanges)` instead of importing the function from a sibling file.

**Options considered:**
- **(a) Optional methods as the capability surface (chosen).** Structural — the interface tells you what an adapter can do. `'save' in adapter` is canonical TypeScript narrowing. Future capabilities (e.g. `exportTo: (format) => Buffer` for cross-format conversion) slot in without breaking existing adapters.
- **(b) Capability flags object alongside methods.** `{ canSave: bool, canExtractComments: bool, ... }` plus methods. Two ways to say the same thing (the existing flaw). Rejected.
- **(c) Adapter returns capability set on request.** `adapter.capabilities() → Set<string>`. Indirection without payoff; structural narrowing on optional methods is the idiomatic TypeScript answer.
- **(d) Sub-interfaces (`SaveableFormatAdapter extends FormatAdapter`).** Forces a class hierarchy that's all noise for a registry that just maps strings to adapters. Optional methods on one interface give the same compile-time narrowing without ceremony.

**LoadResult variants rationale.** The .docx comment-extraction `.catch(() => [])` is the canonical "silent partial failure" the variant model surfaces. `LoadResult.partial` with `issues: [{ kind: 'comments-failed', error }]` lets the file-open pipeline (ADR-034) push a notification to the user ("Document loaded; reviewer comments could not be extracted") instead of pretending nothing went wrong. Consistent with ADR-032's tagged-variant pattern across the codebase.

**Rationale:** The current interface lies about what `.docx` can do. The lie is harmless today because there's one .docx caller for each non-`load` capability, but every reach into `docx-comments.ts` or `docx-apply.ts` is a place that bypasses the registry — the registry says "use this adapter," and then the caller goes around the adapter to do the other thing. Modeling capabilities as the interface's primary content puts those operations under one roof and makes ADR-004's review-only invariant a structural property of the .docx adapter rather than a flag plus a null return. Issue #576 (.docx write-back) becomes a *capability addition* — the adapter grows a `save` method — without an interface change.

**Consequences:**
- `src/server/file-io/types.ts` rewrites with the capability-set interface + `LoadResult` / `SaveResult` variants.
- `src/server/file-io/index.ts` adapter definitions migrate: markdown/txt keep `load`/`save`, drop `canSave`. .docx keeps `load` (pure HTML conversion + Y.Doc population — no comment extraction inline), drops `save`/`canSave`, adds `extractComments`. The .docx adapter's body shrinks; the `.catch(() => [])` swallow becomes a structural `partial` result.
- `src/server/documents/open.ts` (the unified file-open pipeline from ADR-034) probes capabilities: calls `extractComments` if present, surfaces `LoadResult.partial` issues to the user via the notification ring buffer, calls `applyTrackedChanges` only when the adapter offers it.
- `mcp/convert.ts` (currently does .docx HTML→YDoc + apply-tracked-changes) imports from the adapter rather than from `docx-apply.ts` directly.
- ADR-004 stays accurate; the encoding sharpens. The CHANGELOG/PR description for #576 reads as "add `save` and `applyTrackedChanges` to the .docx adapter" rather than "flip `canSave` and add a write-back path elsewhere."
- Pairs with #2 (ADR-034): the file-open pipeline is the only place capability probing happens; MCP tool handlers do not probe.
- Pairs with ADR-032 (tagged variants): `LoadResult` and `SaveResult` follow the same shape pattern as `RefreshResult` / `PmRangeResult` / `OpenResult`. One mental model for "what did this operation actually do?" across the server.

## ADR-037: Layout Model — Rune Store Layered Over Settings

**Status:** Accepted; implemented (verified against `src/` 2026-05-25) — `createLayoutModel` in `src/client/layout/model.svelte.ts`, consumed by `App.svelte` (`leftVisible` / `rightVisible` / `toggleLeft` / `toggleRight`). Designed in the `/improve-codebase-architecture` grilling pass, 2026-05-15; landed across the redesign waves.

**Context:** Panel-visibility and rail-tab state is encoded as four settings fields on `settingsState` plus a derivation in `App.svelte`:

- `leftPanelVisible: boolean`, `rightPanelVisible: boolean` (raw user preference; persisted).
- `leftRailTabs: RailTab[]`, `rightRailTabs: RailTab[]` (which tabs sit on which rail; `RailTab = 'annotations' | 'chat' | 'outline'`).
- Derived in `App.svelte:461-463`: `effectiveRightVisible` is `rightPanelVisible && rightRailTabs.length > 0` — a rail with no tabs is forced invisible regardless of the boolean.
- Mutual exclusion: a tab lives on one rail at a time. Maintained by hand in `moveTabToRail` (App.svelte:488-510), which prunes the "other" rail's array when a tab moves.
- Disable rules: line 916 disables left-rail tabs that would orphan the right rail (`disabledLeftTabs = rightRailTabs.length === 1 ? rightRailTabs : []`).
- Two migrations in `useTandemSettings.loadSettings`: v1 `layout` enum → v2 two-boolean pair; v1 `leftSlot.kind` → v2 `leftRailTabs` array.
- Toggle handlers are asymmetric (`toggleLeft` flips; `toggleRight` reads the derived effective state before toggling).

Adding a rail tab today requires edits to `useTandemSettings.ts` (defaults + validation), `App.svelte` (toggle, move, derive, render), `TitleBar.svelte` (toggle UI), and `SidePanel.svelte` (tab consumption). The mutual-exclusion and disable-orphan invariants live in `App.svelte`'s render path, not in the state model. A future "left rail collapse" feature would have to re-derive `effectiveLeftVisible` in another component.

**Decision:** Introduce `LayoutModel` (`src/client/layout/model.svelte.ts`) as a Svelte 5 rune-store layered *over* `settingsState`, matching the pattern from ADR-033 (registry layered over provider). The model is the only place that knows the layout invariants. Components read derived state from the model; mutations go through model methods that call `settingsState.updateSettings` underneath.

Public surface (sketch):
- Derived getters: `effectiveLeftVisible`, `effectiveRightVisible`, `activeLeftTab`, `activeRightTab`, `disabledLeftTabs`, `disabledRightTabs`.
- Operations: `toggleRail(side: 'left' | 'right')`, `moveTabToRail(tab, side)`, `setActiveTab(side, tab)`.
- The model enforces mutual exclusion (moving a tab to a rail prunes it from the other) and the orphan-rail rule (the last tab on a rail can't be removed if the other rail is hidden; or the move forces the destination rail visible).
- Settings migration stays in `useTandemSettings.loadSettings` — it's a settings-shape concern. The model consumes a v2 shape only.

**Options considered:**
- **(a) Rune-store model layered over settings (chosen).** Single owner for invariants. Components stop reasoning about derived state and mutual exclusion. Settings persistence stays where it is; no parallel storage.
- **(b) Pull layout out of `settingsState` into its own persisted store.** Two persistence layers (one for layout, one for other settings) — more surface, no payoff. Layout is a settings concern from the user's perspective ("my panel preference").
- **(c) Compute derived state via `$derived` blocks scattered across components.** Status quo. Rejected — the invariants stay un-named and fragmented.
- **(d) Replace the two booleans with the v1 `layout` enum.** Goes backward. The two-boolean model (introduced in the layout-mode migration) is more expressive — it allows the "both rails visible" and "both rails hidden" states the enum couldn't represent. Rejected.

**Rationale:** The layout state isn't fundamentally different from the document registry (ADR-033) or annotation lifecycle (ADR-035): it's a set of correlated facts with implicit invariants that today's code maintains by hand. Naming the invariants by giving them a model makes them structural — a new component that wants to know "is the right rail effectively visible?" reads from the model; a new feature that adds a fourth rail tab type registers it through the model's operations; mutual exclusion is enforced by the only method that can mutate rail arrays. The Svelte 5 rune-store form keeps the API reactive without introducing a new state framework — same primitives the rest of the client already uses.

**Consequences:**
- `src/client/layout/model.svelte.ts` (new) — public layout seam.
- `App.svelte:461-510` (derivation + toggle + move handlers) shrinks to thin wrappers over model methods. `App.svelte:916` disable rule moves into `model.disabledLeftTabs`.
- `TitleBar.svelte` toggle handlers call `layoutModel.toggleRail('left' | 'right')` instead of `settingsState.updateSettings({...})`.
- Migrations stay in `useTandemSettings.ts`. The model trusts that `settingsState.settings` is v2-shaped.
- Future features (rail collapse, density modes affecting rail width, additional `RailTab` values like `'search'` or `'history'`) land as model extensions, not as changes propagated across four files.
- This is a client-only refactor; no ADR or memory entries about server architecture change. Pairs with no other ADR in this grilling pass — independent.

**Wave I amendment (2026-05-18):** The cross-rail tab picker is retired entirely. The left rail is hard-coded to the outline; the right rail is hard-coded to Annotations + Chat. The `leftRailTabs` / `rightRailTabs` settings fields are removed from the schema (v4→v5 migration strips them), the `RailTab` type is gone, and `LayoutModel.moveTabs` + the `leftTabs` / `rightTabs` getters are deleted. Layout-model surface narrows to visibility helpers (`leftVisible`, `rightVisible`, `toggleLeft`, `toggleRight`). The orphan-rail rule from §3 no longer applies; neither rail can empty because its tab set is fixed.

## ADR-038: MCP-First Integration Policy; Claude as Default Integration

**Status:** Accepted (2026-05-17)

**Context:** Tandem started Claude-integrated because Claude Code was the MCP-capable client we built against. The integration contract — exposed via `src/server/mcp/`, the 26 MCP tools, and the channel API at `src/channel/` — is **MCP**, not Claude. But the docs, the marketing copy, several in-app surfaces (the Tauri "Claude Not Found" dialog, `sample/welcome.md`, the OnboardingTutorial, the EmptyState), the MCP tool descriptions (sent to *every* connecting MCP client during tool discovery), `package.json`'s npm-published description, and the `.claude-plugin/marketplace.json` install blurb all read as if Claude is the only possible integration. This conflicts with the multi-provider scope already locked in D4 (roadmap.md:462) — ~~the v1.0 first-run wizard ships with a multi-provider model registry covering Anthropic + local LLM + OpenAI + Gemini~~ (registry half moved to v1.1; see 2026-06-11 update below) — and with the top distribution risk recorded in `docs/positioning.md:75-77` ("Tandem currently requires Claude Code, which gates the audience to developers and technical users"). *(Update 2026-06-11, twice: (a) the multi-provider registry half of D4 moved to v1.1; (b) same day, the local-model slice returned to v1.0 — canonical record in [ADR-039](#adr-039-non-mcp-model-providers-local-slice-v10-cloud-slice-v11). The MCP-first policy below is unaffected: MCP remains the contract for native integrations; the local-model loop is a Tandem-internal client, not a change to the integration contract.)*

This ADR records the policy that resolves the gap: Tandem is an MCP-first product; Claude is the default, deepest-supported integration; other MCP-capable clients are best-effort over the same MCP endpoint.

**Decision §1 — canonical policy statement.** Every doc surface that states the policy quotes the following paragraphs verbatim:

> Tandem's integration contract is **MCP**. The default integration is **Claude** (Claude Code + Claude Desktop) — it's what we recommend, what we test against, and it ships with the channel push, cowork, plugin monitor, and auto-launcher features. Any MCP-capable client can connect to the same MCP HTTP endpoint and use the same MCP tools, but the Claude-specific transports don't apply. Other clients are **best-effort, MCP-contract-compatible, not validated** today.
>
> **Integration setup** runs through the integration setup wizard (#477 PR 3). The earlier transitional behavior — Tandem auto-writing its MCP entry to Claude's config files on Tauri startup — was **removed in #477 PR 3c-ii-c**. Every integration (Claude included) is now configured via the wizard, never silently; `tandem setup --apply` is the scriptable non-interactive equivalent.

The canonical paragraph deliberately states **no tool count**. The exact figures live in one
place — [mcp-tools.md](mcp-tools.md) — with `CLAUDE.md` as the contributor-facing mirror. A
number embedded in a verbatim-quoted paragraph goes stale on every quoting surface at once,
which has now happened twice (27→28, then 28→29; see `audit-v3-docs.md` R7). Prose elsewhere
says "the MCP tools"; only the reference states how many.

Four terms have precise meanings; every doc surface uses them consistently:

| Term | Meaning |
|---|---|
| **MCP contract** | The active MCP tools at `http://127.0.0.1:3479` and the SSE event stream at `/api/events`. Available to every MCP client. |
| **Default integration** | Claude. Recommended in all install flows. Documented, tested, and the target of the first-run wizard's one-click setup. |
| **Claude-specific extras** | Six features built on top of the MCP contract that only work with Claude today: (1) channel push (channel shim + plugin monitor), (2) `--dangerously-load-development-channels` documentation for hand-launched sessions — the *launcher* wiring was deleted 2026-08-07 as inert under `-p` ([ADR-047](#adr-047-claude-code-push-transport-activation)), (3) auto-launcher (#477 PR 4), (4) Cowork plugin bridge (`tandem mcp-stdio`), (5) Claude Code skill (`skills/tandem/SKILL.md`), (6) plugin marketplace artifacts (`.claude-plugin/`). |
| **Best-effort, not validated** | What we say about other MCP clients today. We don't intentionally break them; we don't test them. The MCP HTTP endpoint is the same surface they all use. |

**Claude-side dev tooling** (`CLAUDE.md`, `.claude/hooks/`, `.claude/agents/`, `.claude/skills/`) is contributor-facing automation for working ON Tandem — not user-facing integration. It is listed separately from "Claude-specific extras" to avoid conflation.

**Decision §2 — auto-launch policy.** In v1.0, only Claude Code is auto-launched (#477 PR 4). Other entries in the multi-provider model registry (#477 PR 5) are recorded for configuration purposes but require user-driven startup. The wizard surfaces this asymmetry explicitly so users picking OpenAI / Gemini / a local LLM are not surprised that they have to launch the client themselves. Per-provider auto-launchers may be added in future ADRs.

**Decision §2b — auto-configuration deprecation.** Today's silent configuration-writing behavior is deprecated. Two surfaces are affected:
- (a) The Tauri-startup auto-write of Tandem's MCP entry to Claude's config files in `src-tauri/src/lib.rs`.
- (b) The `tandem setup` CLI command in `src/cli/setup.ts`, which writes the same entries from the npm install path.

Both are silent from the user's perspective today; both end when the integration setup wizard (#477 PR 3) ships. Replacements: the Tauri-startup behavior is replaced by first-run-wizard invocation; `tandem setup` becomes a non-interactive `tandem setup --apply` escape hatch (**amended** from the original "TTY-mode wrapper that prompts" wording — the contrarian review flagged interactive prompting as YAGNI for power users; the wizard owns the interactive flow). Auto-configuration code is removed in the same PR that lands the wizard.

**Status: implemented in #477 PR 3c-ii-{a..c}.** 3c-ii-a (#747) factored the config-apply helpers into `src/server/integrations/apply.ts`; 3c-ii-b (PR #773) split intent (`POST /api/integrations`) from side-effect (`POST /api/integrations/apply`) and made first-run wizard auto-open transport-agnostic; **3c-ii-c** deleted `/api/setup` + `run_setup()`, rewrote `tandem setup` as `tandem setup --apply`, and relocated the "no AI client detected" nudge into the wizard's connect step (now rendered as the #1084 "Install Claude Code" empty state). The desktop channel-shim path (formerly carried by the `/api/setup` startup run) is now injected into the sidecar as `TANDEM_CHANNEL_DIST` on spawn.

**Auto-launch (§2) is unaffected by §2b.** §2 governs whether Tandem *spawns* the AI client at session start; §2b governs whether Tandem *writes its MCP entry to the AI client's config file* silently. The two are independent: auto-launch survives because it's the user-invoked Tandem app spawning a child process; auto-config dies because it's Tandem writing to another app's config without explicit consent. When the wizard ships and a user picks Claude, auto-launch still spawns Claude Code per the auto-launcher design. *(2026-07-27: start-at-login breaks the "user-invoked Tandem app" premise this sentence rests on — a login launch is the OS invoking Tandem, not the user. See [ADR-046](#adr-046-start-at-login-desktop-only-hidden-boot-deferred-ai-launch) for how the deferral preserves it.)*

**§2b implementation status (PR #773 / #477 PR 3c-ii-b):** the wizard now separates **intent** (`POST /api/integrations` persists `integrations.json` — the user's stated configuration) from **side-effect** (`POST /api/integrations/apply` writes Claude's MCP entry to the detected config files). Both transitions enforce a layered security gate before any filesystem write: origin allowlist (CSRF), constant-time confirmation-nonce comparison (replay protection), LAN-fail-closed on every mutating route (the `TANDEM_ALLOW_UNAUTHENTICATED_LAN=1` opt-in does **not** relax this), in-process apply mutex (concurrent applies → 429), `homeOverride` body-field rejection, `assertPathSafe` symlink/realpath validation, and `IntegrationsFileSchema.safeParse` defense-in-depth at apply time. The response shape never echoes `entries`, `headers`, `env`, or any token-bearing field — only `{ id, status, code?, message? }` per integration. PR 3c-ii-c (shipped) deletes `/api/setup`, removes `run_setup()`, and rewrites `tandem setup` as non-interactive `tandem setup --apply`.

**Decision §3 — MCP and non-MCP providers.** MCP is the contract for *native* integrations. The multi-provider model registry (#477 PR 5) may include providers that don't speak MCP natively (OpenAI, Gemini); they integrate via Tandem's Agent SDK adapter (a future PR, likely ADR-039), not as direct MCP clients. *(2026-06-11: the **local slice's** mechanism is owned by [ADR-039](#adr-039-non-mcp-model-providers-local-slice-v10-cloud-slice-v11) and may diverge from the "Agent SDK adapter" wording here, which was written with OpenAI/Gemini cloud in mind; the cloud slice is unaffected.)* Adapter-shim integrations are second-tier — the MCP contract is the canonical interface and the one that gets new tool surface first.

**Decision §4 — Claude-specific code paths are encouraged, not tolerated.** Contributors may add Claude-specific code paths (additional channel push features, plugin manifests, hooks, skills, cowork extensions) without policy friction. The constraint is one-way: Claude-specific features are **additive**, not subtractive — the MCP contract continues to work for non-Claude clients. A Claude-specific feature that breaks the MCP contract for non-Claude clients is a regression; a Claude-specific feature that exists alongside the MCP contract is fine.

**Consequences:**

- User-facing copy uses "your AI" / "the AI" generically; Claude appears in concrete examples and as the default-recommended path. "Reference integration" remains technical contributor language and stays in this ADR; user-facing surfaces use plain language ("Claude works out of the box; other MCP clients need setup").
- **Stays Claude-named-by-design** (no churn, no deprecation):
  - `CLAUDE.md` body — Claude Code project memory for contributors working on Tandem.
  - `.claude-plugin/marketplace.json` + `plugin.json` *structural* Claude-specificity — these are Claude-marketplace artifacts and the manifest schema is Claude's. (The descriptive blurb users read during `claude plugin install` is updated; the manifest structure stays.)
  - `.claude/hooks/`, `.claude/agents/`, `.claude/skills/` — Claude Code dev-time automation.
  - `src/server/mcp/launcher.ts` — auto-launcher is Claude-specific by design per §2.
  - `src/client/components/CoworkOnboardingStep.svelte` — Cowork is a Claude Desktop feature per ADR-023.
  - CSS tokens `--tandem-author-claude` / `--tandem-claude-focus-bg` — code-internal.
- **Backward-compat artifacts preserved for v1.0; refactored when `IntegrationConfig` lands** (#477 PR 1):
  - `author: "claude" | "user" | "import"` constant — the wire-level string `"claude"` survives in exported annotation data. User-facing deprecation messages are neutralized; the schema string is left for backward-compat.
  - `directedAt: enum(["claude"])` schema value in `src/server/mcp/annotations.ts:347-376` — same rationale.
  - `src/cli/setup.ts` `TargetKind = "claude-code" | "claude-desktop"` type — replaced by `IntegrationConfig`.
- **Auto-launch parity:** v1.0 auto-launches Claude only. Per-provider auto-launchers are future work, each in its own ADR.
- **MCP-bridge for non-MCP providers:** the OpenAI/Gemini adapter design is owned by a separate ADR (likely ADR-039) — this ADR commits to the approach but not the implementation.

**Cross-references:** ADR-003 (MCP over REST), ADR-019 (Channel Shim — channel push transport), ADR-023 (Cowork Plugin Bridge — Cowork extra), ADR-024 (`bearer_methods_supported` — Claude Code empirical findings), ADR-027 (Annotation System Redesign — `author: "claude"` constant), ADR-028 (Plugin Monitor URL/Auth), ADR-040 (Audience & Monetization — supersedes the institutional-market framing referenced in this ADR's Context). Spike reports: `docs/spikes/plugin-monitor-viability-spike.md`, `docs/spikes/cli-session-resume-spike.md`, `docs/spikes/sidecar-launcher-spike.md`. Roadmap: `docs/roadmap.md` #477 + D4.

---

## ADR-039: Non-MCP Model Providers (Local Slice v1.0, Cloud Slice v1.1)

**Status:** Split. **Scope Accepted (2026-06-11, Bryan).** **Design resolved (2026-06-17) by the #1123 M0 spike** (`docs/spikes/local-llm-capability-spike.md`) — closed ahead of the 2026-07-02 kill date. The cloud slice still references ADR-038 §3. **This section is the canonical record of the twice-amended D4 model-support scope and the M0 verdict; every other surface (roadmap, triage, positioning, README) points here.**

**Scope history (both amendments preserved; neither erases the other):**
- **2026-06-11 (a), PR #1122:** the full BYO-models registry + adapter moved to v1.1. The registry UI (shipped v0.13.0) had been flag-gated off in v0.14.0 (`BYO_MODELS_ENABLED=false`, #1018/#1022) because no server-side LLM client consumed its config; the accepted consequence was "v1.0 charges while the reachable audience is Claude-Code users."
- **2026-06-11 (b), Bryan:** the **local-provider slice returns to v1.0** — Ollama / LM Studio / llama.cpp via OpenAI-compatible local endpoints, at **full-collaborator depth** (read document, create/edit annotations via server-resolved quote anchors, propose replacements, chat — a tool-use loop, not chat-only). The **cloud BYO-keys slice (OpenAI/Gemini) stays v1.1**. Supersedes amendment (a)'s consequence: v1.0's reachable audience is Claude users **plus anyone who can run a local model** — and the local path is no longer bounded to "MCP-capable" LLMs (the loop drives non-MCP local endpoints directly).

**Depth bar + fallback — RESOLVED by M0 (2026-06-17):** the kill-gate ran the full quantified bar (≥80% task success / Wilson-95 lower bound ≥70%, ≥20 trials per op + multi-step sequence, quote-anchored schema, 50-page envelope) on a CPU-box ladder (qwen2.5:7b / llama3.1:8b / qwen2.5:14b). **No model cleared the autonomous full-collaborator bar** — blocked by multi-step sequencing and 50-page deep retrieval (≤50% everywhere; the mandatory envelope column failed for all three). The **constrained structured-output fallback** was then measured (single forced call; strict + lenient-resolver + one-retry variants) and **also did not clear all three ops in any one model** under the autonomous bar.

**Shipping decision (Bryan, 2026-06-17, with spike evidence — the renegotiation this line promised):** ship the local-model capability anyway, **as an opt-in / experimental BYO-model feature**, because the 80%/Wilson bar measures *autonomous* quality and **Tandem is human-in-the-loop**: every local comment/replacement is a *proposal anchored to visible text the user accepts or rejects* (ADR-027), so measured gaps degrade to experimental-quality variance under review, not silent corruption. Tiers: **chat default-on** (100% across qwen models, shippable as-is); **comment/replacement opt-in + "experimental, review every suggestion"** (per-op the bar is reachable — comment clears for qwen7b, replacement for qwen14b — just not all-at-once); **multi-step / 50-page autonomous out of scope**. Guidance: recommended **parameter floor ≥14B** for editing + "quality varies" label (honest caveat: params predict imperfectly — llama3.1:8B trailed qwen2.5:7B on comments). The harness (`probe/local-model-spike/`) is retained as the reusable re-test gate. M1–M4 ship as v0.17.0 on this scoping.

**Monetization edge (binding):** the license/trial gate (ADR-040 §3, #1116) applies **identically** when the configured model is local — a free local model does not change what's free.

**Design decisions — RESOLVED by M0 (2026-06-17):**
- **Loop architecture — CONFIRMED:** server-side loop over the same internal operations the MCP tools wrap (`createAnnotation`, `addReplyToAnnotation`, `anchoredRange`), **not** a spawned MCP client. Validated runnable with no server wiring and no `src/` changes (Phase A0 import smoke). Diverges from ADR-038 §3's "Agent SDK adapter" wording (which was written for the cloud slice).
- **Tool contract — quote anchors:** tools take `quoted_text` + `occurrence_index`; the server resolves via `findOccurrence` + `anchoredRange({rejectHeadingOverlap:true})`; the model never sees offsets. M0 surfaced **occurrence-index / repeated-phrase disambiguation as the dominant editing weakness** — the v0.17.0 implementation should harden the anchor contract (markdown-unescape; clamp a redundant occurrence_index to the sole match when `matchCount === 1`; consider one bounded `ANCHOR_NOT_FOUND` repair round-trip). These are the measured artifact fixes, gated to never mis-anchor a repeated quote.
- **Origin-tag contract — reuse `withMcp`/`MCP_ORIGIN`:** validated. Consequence across the five ADR-031 skip-sets: identical to Claude writes (channel-event-skipped so the loop can't echo to itself, durable-synced, tombstoned). Correct under "one active agent at a time"; a dedicated `withLocalAgent` is only needed for concurrent Claude + local (#438/#452, v1.1+).
- **Endpoint reachability — loopback-only default for v1.0;** LAN-with-opt-in deferred (it materially changes the SSRF/DNS analysis and must be a separate gated decision, not inherited from `IntegrationConfig.url`).
- **Context-window budget / windowed reading:** short docs primed fully; long docs use `get_outline`→`read_section`. M0 showed small models fail deep windowed retrieval (envelope ≤50%), so **50-page autonomous work is out of v0.17.0 scope** and documented as such.
- **Identity:** v0.17.0 uses `author: "claude"` placeholder; provider-keyed authorship is #1123 M3. ADR-027 (notes private from ALL models) unchanged.
- Registry persistence relocation (client-localStorage-only today — #1123 M1a), conversation persistence, and event-ingestion triggers remain implementation detail for M1.

**One active agent at a time in v1.0** — concurrent Claude + local model is #438/#452, v1.1+.

**Cross-references:** #1123 (engineering tracker, M0–M4), ADR-038 §3, ADR-040 §1/§2/§3, ADR-031 (origins), ADR-026/027 (the `author` model #1123 M3 extends), roadmap Wave 5M / v0.17.0.

---

## ADR-040: Audience and Monetization (Individuals; Same-Canvas Moat; Free Beta to One-Time License)

**Status:** Accepted (2026-06-12) — Supersedes the institutional-market and undecided-revenue framing in docs/positioning.md. All sections (§1–§6) are now fully accepted following legal counsel draft of the BUSL re-scope. **Amended 2026-08-18 and 2026-08-19 (#1346)** — the §3 gate changes shape from per-tool content-write to a surface gate (unlicensed = plain markdown editor, no AI at all, reads included); the 14-day trial is unchanged. Read both amendments below before reading §3 as current.

**Context:** Tandem shipped without a recorded audience or revenue decision. `docs/positioning.md` frames the market as institutions and (§economics) says paying cases "require either a hosted offering or a support contract… This needs a decision." `README.md` said "Tandem is free to use." `docs/roadmap.md` tracks "#394 Monetization" as "tracked outside engineering roadmap." The product is BUSL-1.1 (source-available): the base grant is non-production use only; the **Additional Use Grant** extends limited production use ("Personal use and individual self-hosting are permitted; commercial hosting or resale of the Licensed Work is not") — so individuals already use it in production for free. It converts to MIT at the earlier of the Change Date (2029-06-10 / v1.0 GA + 2 years) **and** the BUSL per-version 4-year floor. This ADR supersedes the institutional-market and undecided-revenue framing.

**Decision §1 — Audience: individuals.** Target = individuals (writers, editors, researchers, developers) on their own documents — not institutions. Local-first and BYO-LLM are non-negotiable product identity; consequently the near-term reachable market is bounded by users who already run an MCP-capable LLM. Breadth is pursued by **lowering setup friction** (multi-provider first-run wizard / roadmap D4), not by a bundled/hosted inference layer (which would add recurring cost and revisit local-first — deferred to a possible post-1.0 decision). *Note (2026-06-11, two amendments — canonical record in [ADR-039](#adr-039-non-mcp-model-providers-local-slice-v10-cloud-slice-v11)): (a) the multi-provider registry half moved to v1.1; (b) same day, the **local-model slice returned to v1.0** (Bryan, #1123). Net consequence: v1.0's reachable audience is Claude users plus anyone running a local model, and the "bounded by users who already run an MCP-capable LLM" framing above relaxes for the local path — the #1123 loop drives non-MCP local endpoints directly. Cloud BYO keys (OpenAI/Gemini) remain v1.1.* Supersedes positioning.md's §The Market and the institutional/technical-user audience framing recorded in **ADR-038's Context** ("gates the audience to developers and technical users" is ADR-038's phrasing). ADR-038's MCP-first integration *policy* is unaffected and is the basis for §2.

**Decision §2 — Moat: same canvas + persistent review record.** Headline: you and your AI work on the same live document — no copy-pasting between a chat window and your editor — highlighting text the AI sees and edits/comments on **in place**, as first-class objects you **accept, dismiss, or discuss**, powered by your own MCP LLM. The durable differentiator beneath the headline is annotations as **persistent, addressable, queryable first-class objects** + the **.docx review-record loop** (Word-comment round-trip). ChatGPT Canvas, Claude artifacts (MCP-connected), and `docx-mcp` do in-place editing, but not a persistent, queryable, exportable review record — that is the wedge. BYO-MCP-LLM is the enabler. Basis: ADR-038 (MCP-first).

**Decision §3 — Monetization & capture: free beta → one-time license at v1.0.** Free during public beta. At v1.0 **one public build** self-trials and **requires a valid offline-signed license to keep running** past the trial (a hard gate, not a nag); its auto-updates come from a **license-checked endpoint** that serves new builds only while the license's update window is current (this enforces a bundled-updates window / paid major-version upgrades). Pricing set later (~$29–79). No separate gated download — a shared installer is useless without a license, so license-to-run is the capture vector and gating the download would be redundant infra. The trial clock is on-device → soft; the hard gate is the signed license. *(Note 2026-06-11, #1123: the gate applies **identically** when the configured model is a free local LLM — bringing your own model does not change what's free; see ADR-039.)* Source-available remains a high-bar escape hatch. Existing beta users are **grandfathered** with a free signed license at 1.0 (goodwill over the small early-cohort revenue); new users pay.

**Decision §4 — Activation: offline signed license files.** *Running* validates an Ed25519-signed license on-device against an embedded public key — no network, no telemetry, air-gapped, binds a copy to its buyer. Update *checks* are network (as today); for the licensed build they authenticate entitlement at the update endpoint, which **logs only what's needed to authorize** (ideally a signed entitlement check, not the raw key). No usage analytics — the no-telemetry promise holds for running the app.

**Decision §5 — Licensing change (Accepted 2026-06-12).** Narrows the Additional Use Grant to permit personal use and individual self-hosting solely for evaluation purposes for up to 30 days. Continued or production use requires a paid commercial license. The Change Date resets per version (calculated as two years after the public general availability release of each specific version), ensuring commercial protection remains current across subsequent releases.

**Decision §6 — Distribution & payment.** Checkout via a Merchant of Record (Polar.sh or Paddle) for payment + global VAT/sales-tax + the issuance webhook; licensing decoupled, low lock-in. **One public build** stays on GitHub Releases; the licensed app's updater authenticates entitlement at a small license-checked endpoint (Keygen, or a Cloudflare Worker). License-to-run is enforced in the **server** (booted by both the Tauri sidecar and the npm CLI). LLC + accountant before taking money.

**Options considered:**
- **Public binary + honor-system nag (one-time, whole app)** — no capture vector; rejected.
- **Gated download host + dual trial/paid builds** — redundant with license-to-run; extra infra for no added capture; rejected.
- **Subscription / hosted SaaS** — contradicts local-first/no-backend; rejected.
- **Enterprise / support contracts** — mismatched to individuals; rejected.
- **Donations / free forever (go-light)** — lower-effort fallback; rejected — full commitment to the paid model.
- **Online license validation for running** — phones home; rejected for offline files (§4).

**Consequences:**
- Doc surfaces updated: positioning.md, README.md (free-during-beta + activation/telemetry + audience bullets), roadmap.md (#394), security.md, workflows.md + user-guide.md, CHANGELOG.md.
- One public build throughout (no installer takedown); the only gated surface is the update endpoint.
- In-app license-verification + server-side trial gate + license-authenticated updater are v1.0 work — tracked in #1116 (engineering, Wave 5L / v0.16.0) + #1117 (commercial infra, Bryan-led calendar gate) since 2026-06-11; the v1.0.0 tag is gated by the Commercial-readiness exit criterion in roadmap.md.
- Existing beta users are grandfathered with a free license at 1.0; new users pay.
- §1/§2 finalized; revenue ceiling is modest and accepted (full commitment, no kill-criterion).
- **§6 narrowed to Polar for the issuance seam (2026-07-03, #1176):** the issuance Worker (`infra/license-issuance-worker/`) verifies Polar's Standard-Webhooks (svix) signature scheme specifically — it does not implement Paddle's webhook scheme. §6's "Polar.sh or Paddle" framing is still open at the checkout-provider level, but the built issuance seam is Polar-only in practice; adding Paddle later means a second signature-verification path in the Worker, not a drop-in swap.


**Amendment (2026-08-18, #1346) — unlicensed is a plain markdown editor: a surface gate, not a per-tool one.**

Five decisions (@bloknayrb). §3's *strictness* is unchanged — it was always a hard gate. What changes is the **shape** of what falls inside it, and one of the five is not a licensing decision at all.

**1. Unlicensed = plain markdown editor, no AI integration at all.** Not a read-only AI. The gate becomes a **surface** gate — refuse the AI surfaces outright — rather than the content-write, per-tool gate that is merged today (twelve `gatedTool()` MCP tools plus their `/api` twins, with reads, chat, `open`, save/export and `tandem_resolveAnnotation` explicitly Allowed). Two reasons beyond the commercial one: a twelve-tool enumeration must be re-audited on every new tool and Critical Rule 9 exists because forgetting one half of a pair is a silent hole, whereas a surface refusal has one thing to get right; and "Tandem without a license is a markdown editor" is a sentence a user can hold, where "Claude can read but not annotate" is not.

**Surface A stops gating document rooms.** Today `applyConnectionGate` marks every non-`CTRL_ROOM` connection read-only when restricted. Under this amendment that is close to the inverse of the intent: unlicensed means *your document is fully editable, there is simply no AI*. The `CTRL_ROOM` carve-out inverts with it — `CTRL_ROOM` is kept writable today so chat survives, and chat is now an AI surface that must not.

**2. Annotation resolution is a user action. This is a feature requirement, not a gating carve-out.** Accept and reject belong to the editor UI; the user can resolve, Claude cannot. It holds at **every** license status, licensed included, so it is not conditional on the gate and does not ship dark with it.

*Verified at master.* The user half is **already native** and needs no work: `useAnnotationReview.svelte.ts` `resolveAnnotation()` writes the status straight into `Y.Map('annotations')` and applies any `suggestedText` client-side through ProseMirror, over Hocuspocus. It touches neither MCP nor `/api` — no route exists and the client calls none. The remaining work is therefore **subtractive, not constructive**: retire `tandem_resolveAnnotation` (`src/server/mcp/annotations.ts`), which is wrapped in `withErrorBoundary` and is deliberately ungated today, along with the `store.acceptAnnotation` / `dismissAnnotation` lifecycle entries where they exist only to serve it.

This also **independently confirms the Surface A change above**. Because the user's accept is a Hocuspocus write, a Surface A read-only clamp would block the user from resolving their own annotations — precisely the action this decision makes theirs alone. The two decisions would contradict each other if Surface A kept gating documents.

**3. One enforcement point across every AI surface — OPEN; discovery completed 2026-08-18, design pending.** The requirement is that MCP transport, Surface A and the `/api` routes share a single enforcement point. *Verified at master: they do not.* The requirement is also **ambiguous**, and the two readings have opposite answers: one decision *function* already exists, while one *interception* is not reachable by refactor, because the surfaces share no call path — a WebSocket connection lifecycle, JSON-RPC dispatch, Express middleware and an in-process call cannot be routed through one frame. They share a decision **primitive** — `resolveLiveLicenseState()`, with both consumers branching on `status === "restricted"` — but enforcement is spread across five sites — *mechanisms*, not surfaces; see the surface count below — each deciding independently what to do, and rendering refusal three different ways (an MCP error envelope, an HTTP 403, and a silent read-only connection clamp):

1. `gatedTool()` — registration-site wrapper, twelve MCP tools.
2. Direct in-handler `licenseGate()` — `src/server/mcp/document.ts` and `routes/open.ts` (the `force: true` sub-path). Not discoverable by grepping the wrapper.
3. `licenseGateMiddleware` — seven mutating `/api` routes, at the registration site.
4. `applyConnectionGate` — Surface A, Hocuspocus `onAuthenticate`.
5. `licenseGate()` inside `src/server/local-model/tools.ts` — **the local-model collaborator loop (ADR-039, #1123), which the issue's inventory does not name.** Its own comment states it "bypasses both license enforcement surfaces (no Hocuspocus connection; not an MCP tool)". It is an AI surface, so under decision 1 the whole loop is refused when unlicensed, not merely its three mutating tools.

`deriveLicenseUi` in the client is a sixth, advisory site; it must not be counted as enforcement.

Two surfaces have no enforcement site at all today because the current shape does not gate them, and acquire one under decision 1: **chat** (`CTRL_ROOM`, `tandem_reply`, `tandem_checkInbox`), and the **AI wake/push paths** (`/api/wake`, the channel shim, the plugin monitor, the supervisor), which exist solely to wake a model. Collapsing all of this is the actual design work this issue now owns.

**The surface inventory (discovery, 2026-08-18).** Counting by *surface* rather than by mechanism gives **six**, and that is the axis this decision asks about — which is why the question could not be answered as posed: nothing enumerated the surfaces, the gated-set list being an inventory of *operations*. It is now enumerated in [`docs/licensing-explained.md`](licensing-explained.md#ai-surfaces--the-1346-inventory) and pinned by `tests/docs/ai-surface-inventory-claims.test.ts`, which derives its sets from source so a new AI surface fails the build rather than going unlisted. Three results change the work:

- **MCP over stdio is free.** `src/cli/mcp-stdio.ts` registers no handlers and forwards raw JSON-RPC, so refusing at the HTTP transport also refuses Claude Desktop and Cowork. There is no fourth transport to gate.
- **Chat and the push paths are deliberately open, not overlooked.** `connectionShouldBeReadOnly` exempts `CTRL_ROOM` and `shouldForwardExternally` passes `chat:message` unconditionally, both so chat survives as the read-only escape hatch. Decision 1 inverts that: chat *is* the AI integration.
- **Surface A is not an AI surface at all.** It clamps the human's editor — the same conclusion decision 2 reaches by the annotation-resolution route, so two independent paths arrive at deleting it.

**Four admission points, not one interception.** Each surface has one narrow admission point, and three are existing functions with every caller in one place: `appendClaudeChatMessage()` (every AI chat write), `subscribe(cb, "external")` (every push consumer), the MCP session handshake (both transports), and the collaborator's start path. Four checks against the 20+ per-operation checks today, taking Critical Rule 9's per-tool cost from two edits to zero — the strongest *technical* argument for decision 1, independent of the commercial one.

**One consequence, settled by decision 7 below:** the sixteen ungated read tools stop being safely ungated. They are ungated on the rule that reads are the escape hatch, and `RESTRICTED_MESSAGE` promises it verbatim — but under decision 1 the escape hatch belongs to the **human's editor**: the user keeps opening, reading and exporting, and the AI reads nothing. Open question 1 in #1346 settled what happens to existing annotations but not whether Claude may still *read* them; the second amendment answers that it may not.

**4. No fail-open, no grace period.** Licenses are offline-verified and perpetual: the run gate checks the Ed25519 signature only, enforced at the type level by the `SignatureVerified` brand so that wiring in the stricter expiry-checking verifier is a compile error. There is no expiry to fail open from and nothing to specify — ADR-040 as accepted contains no fail-open or grace-period language, and this amendment introduces none.

One precision, so "no expiry" is not over-read: it is a property of **licenses**, not of the trial. The on-device trial clock does end (`TrialInfo.expiresAt`), and a license's own `expiresAt` governs the **update window** alone — never whether the app runs.

**5. Terminology: always "unlicensed", never "expired" or "lapsed".** There are no lapsed users, only people who never bought. This is copy, and the copy that contradicts it is already written: `RESTRICTED_MESSAGE` in `src/server/mcp/license-gate.ts` opens "Your Tandem trial has ended", and the wall, the trial banner and that module's header comment all frame the state as a trial ending. All of it is rewritten at the flip to name the state as unlicensed and the consequence as AI features disabled. The internal `status: "restricted"` identifier is **not** required to change — `license-types.ts` records that both gates decide on that exact literal, so a fourth status value or a rename fails **open** at every enforcement surface until all of them are updated.

**Second amendment (2026-08-19, #1346) — the trial, the toolset, and what unlicensed looks like.** Three answers (@bloknayrb) settling the open questions the first amendment flagged. Still dark; still no code moves here.

**6. The trial survives, and it is not in tension with decision 5.** Fourteen days of **full** functionality with no purchase, after which a license key is required to continue with full functionality. `TrialInfo` and the on-device clock stay exactly as built. The apparent conflict with "there are no lapsed users" dissolves on inspection: **a trial ending is not a license expiring.** Someone whose fourteen days ran out never bought a license, so nothing of theirs lapsed and nothing was taken — "unlicensed" describes them accurately. Decision 5 governs how the state is *named*, not whether a clock exists. So the clock is mechanism and stays; "expired" is vocabulary and goes.

**7. Unlicensed means Claude holds no `tandem_*` tools at all — reads included.** This closes the half of open question 1 the issue did not ask. The issue settled that existing annotations stay visible and resolvable *by the user*; it left open whether Claude may still read them. It may not. There is no partial toolset and no read-only AI mode: the surface gate refuses the MCP handshake, so the tools are absent rather than present-and-failing.

Two consequences worth stating because they are easy to get backwards:

- **The escape hatch belongs to the editor, not to Claude.** "You can always open, read and export your work" remains true and is the point — but it is the *user* doing it. The sixteen ungated read tools are not a carve-out to preserve; they disappear with the surface.
- **`mcp-stdio.ts` needs no gate of its own.** It registers no handlers and forwards raw JSON-RPC, so refusing the HTTP transport also refuses Claude Desktop and Cowork. Verified during the discovery step; do not add a second refusal there.

**8. The unlicensed UI: frozen transcript, with a persistent notice.** The chat/annotation rail keeps its footprint and its **history stays full-colour and readable**; only the live surfaces — the composer and the annotation actions — grey out, alongside a persistent notice naming the state. Rationale: the failure this design most needs to avoid is a user believing their work was taken, and keeping the transcript at full fidelity makes "we did not take anything" a visible fact rather than a claim in a support document. The notice exists because a greyed composer alone is too subtle a boundary — a user discovers the state by trying to type.

Two rejected alternatives, recorded because both are reasonable and will be re-proposed:

- **Collapsing the rail to a spine** is correct as a collapse the **user chooses**, and wrong as the default. Someone who has decided not to buy should be able to reclaim the width permanently; deciding it for them on day 15 both hides the state and removes their choice.
- **Turning the rail into a permanent activation panel** is rejected as a *standing* state. Activation belongs in Settings and in the in-trial notice, not pinned beside every document indefinitely — that is the version of this that reads as nagging on day 400.

**9. Refusal copy.** Decision 5 applied. The refusal must carry both the reason and the purchase URL: the #1463 measurements caught a model inventing a remedy that does not exist when given neither.

| Surface | Replaces | With |
|---|---|---|
| MCP + `/api` | "Your Tandem trial has ended, so Tandem's editing and annotation tools are unavailable." | "Tandem is unlicensed. AI features are disabled. Your document is unaffected and stays fully editable." |
| Local-model loop | "Editing is unavailable — the Tandem trial has ended." | "Tandem is unlicensed. AI features are disabled." |
| Status pill | "Trial ended" | "Unlicensed" |
| Rail notice | *(none today)* | "AI features are off. Activate a license to bring Claude back." |
| In-trial, day 12 | "Trial expires in 2 days" | "2 days left. Purchase a license to keep Claude." |

The internal `status: "restricted"` literal is **not** renamed — `license-types.ts` records that both gates decide on that exact string, so a rename fails **open** at every enforcement surface until all of them move together.

**Constraint — everything stays dark.** `LICENSE_GATE_ENABLED` remains `false` in `tsup.config.ts` and the build stays byte-identical with the flag off. This amendment is a design change to merged-but-inert code; no code moves on it here. The gated-set enumeration in [`docs/licensing-explained.md`](licensing-explained.md#the-gated-set--this-list-is-the-api-halfs-review) is superseded in **shape** by decision 1 but remains an accurate description of the code as merged, so it stands as Critical Rule 9's review surface until the surface gate is implemented.

**Cross-references:** ADR-038 (MCP-first policy — basis for §2), ADR-022 / ADR-026 / ADR-027 (annotation system / authorship / data model — the in-place review surface), ADR-028 (split-status pattern), ADR-039 (local-model collaborator — the fifth enforcement site named in the 2026-08-18 amendment), `docs/positioning.md`, `docs/licensing-explained.md`, `docs/roadmap.md` #394 + D4, `LICENSE` (BUSL-1.1), #1116 (engineering tracker), #1346 (the 2026-08-18 amendment and the 2026-08-19 second amendment).

## ADR-041: Customizable Keyboard Shortcuts (Override Layer)

**Status:** Accepted (2026-05-27)
**Context:** Tandem ships ~60 keyboard shortcuts, none user-configurable. The real key→action mapping is NOT the action registry (ADR-029 made `shortcut` display-only) — it lives in `matchShortcut()` (`src/client/hooks/useAppShortcuts.ts`), a hand-ordered `if/else` chain keyed on `e.code`/`e.key` + modifiers, with deliberately preserved "legacy quirks" (e.g. `Ctrl+S` matches even with Alt held; `Ctrl+Shift+S`→save-as is tested *before* `Ctrl+S`→save and falls through). App.svelte's dispatch table owns the side effects. Several matcher `ShortcutId`s carry runtime context via Shift or are digit families (`Ctrl+1..9`) and are not single discrete chords.
**Decision:** Add an **override layer** rather than rewriting the matcher. (1) Scope: only the ~17 App-level discrete (single-chord) shortcuts are remappable — `save`, `save-as`, `settings`, `settings-modal`, `toggle-palette`, `new-scratchpad`, `close-tab`, `open-file`, `toggle-mode`, `reopen-closed-tab`, `comment-on-selection`, `toggle-authorship`, `toggle-left-panel`, `toggle-right-panel`, `annotation-next`, `annotation-prev`, `select-block`. Text-formatting/Tiptap keymaps and family/context shortcuts (`find`, `find-nav`, accept/dismiss, `pick-tab`, `toggle-help`, `select-all`) stay fixed/read-only. (2) `matchShortcut(e, overrides?)` loops overrides first (strict-equality `chordMatches`, so iteration order is not a correctness risk) and returns the remapped id; then runs the existing chain, but each *remappable* branch's return is wrapped `if (!isOverridden(id, overrides)) return …` so a remapped-away default still **falls through** to its sibling (remap `save-as` away ⇒ `Ctrl+Shift+S` falls through to `save`) instead of dying. Empty/undefined overrides ⇒ byte-identical to before, so non-remappers and the E2E suite see zero change. (3) Edit UX = click-to-record; conflicts block the assignment and name the owner. `findConflict` (`src/client/actions/shortcut-conflicts.ts`) checks effective remappable bindings, then **fixed matcher branches derived live from the matcher** (`claimedByFixedShortcut` synthesizes an event and runs `matchShortcut` with no overrides — see hardening note), then a `RESERVED_CHORDS` set covering only the **non-matcher** reservations (separate tab-cycle/zoom window listeners, version-pinned Tiptap *letter* keymaps). (4) Storage: `customShortcuts: Record<RemappableShortcutId, ShortcutChord>` in `TandemSettings` (schema v8→v9); `normalizeKnownFields` re-validates on every load/merge via `parseCustomShortcuts`, dropping entries that are junk, non-bindable (no primary modifier / Numpad / Tab-Escape-Enter), collide with a fixed branch or reserved chord, or duplicate a chord already held by a higher-priority id — so a stale or hand-edited override can't shadow a fixed shortcut or silently dead-bind via the override-first loop.
**Why not bind from registry strings:** the registry `shortcut` is a human label (`"Ctrl+Shift+S"`), not a machine chord, and registry ids don't map 1:1 to matcher `ShortcutId`s (`find` vs `find-in-tabs`/`find-next`; `annotation-previous` vs `annotation-prev`). The matcher is the binding authority; the registry crosswalk (`REGISTRY_TO_SHORTCUT_ID`) exists only for Help-catalog reflection.
**Consequences:** `chord` uses physical `e.code` (layout-independent, mirroring the matcher). `comment-on-selection` (Ctrl+Alt+M) and `toggle-palette` have no registry row, so they appear in the editable Settings list but not the Help catalog. The Tiptap reserved slice is hand-maintained and pinned to the `@tiptap/*` versions in `package.json` — a Tiptap major bump requires re-auditing it. New remappable shortcuts must be added to `REMAPPABLE_SHORTCUT_IDS` + `DEFAULT_BINDINGS`; new *fixed* shortcuts are picked up automatically by `claimedByFixedShortcut` if they go through `matchShortcut`, and only need a `RESERVED_CHORDS` entry if they live in a separate listener (tab-cycle/zoom) or a Tiptap keymap.
**Conflict-model hardening (2026-05-27):** the original design hand-transcribed the matcher's fixed chords into `RESERVED_CHORDS` as *exact tuples*, but several fixed branches match *families* (`find`/`find-nav` ignore Alt; `pick-tab` ignores Alt+Shift; the `?` help branch has no modifier gate). The exact-tuple list missed those variants, so a user could remap onto e.g. `Ctrl+Shift+/`, `Ctrl+Alt+F`, or `Ctrl+Shift+3` and the override-first loop would silently steal the fixed function. Fixed by deriving fixed-branch conflicts live from the matcher (`claimedByFixedShortcut` reuses `matchShortcut` as the single source of truth — no second copy of the gating to drift), moving the conflict/validation helpers into `shortcut-conflicts.ts` to avoid a circular import, and removing the now-redundant matcher entries from `RESERVED_CHORDS`. The one irreducible US-layout assumption is the synthetic `e.key` derivation for `?`/`/`; non-US layouts keep the matcher's pre-existing layout quirk. Because the feature is unshipped, the only holders of an exploit-bound override are pre-merge testers, who lose that binding on next load (restoring the fixed shortcut) — there is no public migration.
**Cross-references:** ADR-029 (Action Registry — superseded in part), ADR-037 (Layout Model — rune store over settings, the persistence pattern reused here).


## ADR-042: Markdown Fidelity — Raw-Construct Passthrough + Visibility Toggle

**Status:** Accepted (2026-06-03)

**Context:** Tandem wires `remark-gfm` into both the parser and stringifier, so every CommonMark + GFM construct becomes correct mdast. But a construct only round-trips if **both** the mdast↔Y.Doc mapping (`src/server/file-io/mdast-ydoc.ts`) and the Tiptap editor schema support it. Several constructs were parsed but then **silently dropped** on the way into the Y.Doc because their mdast nodes carry no `.value` string and the `default` cases only preserved value-bearing nodes: **footnote references + definitions**, **reference-style links + their definitions** (`linkReference`/`imageReference`/`definition`), and **inline HTML**. They vanished entirely on the first save. Nested inline images degraded to alt-text (URL/title lost). Issue #981 is the audit umbrella; task lists are carved out to #982.

**Decision:** Preserve every unsupported construct as **verbatim markdown source**, re-emitted as an mdast `html` node on save (the `mdast-util-to-markdown` html handler is literally `return node.value || ''` — it never escapes), and surface a show/hide toggle. Two carriers, mirroring the pre-existing `markdownHtml` raw-HTML-block mechanism:

- **Block-level raw** (`footnoteDefinition`, `definition`, unknown structured blocks) → stored as a `paragraph` carrying a new boolean **`markdownRaw`** attribute; serialized via `serializeMdastBlock` (wrap in `root`, `trimEnd`).
- **Inline raw** (`footnoteReference`, `linkReference`, `imageReference`, nested inline image, inline `html`) → stored as text under a new **`rawMarkdown`** mark (a standalone `Mark.create`, added to the server `ALL_MARKS` allowlist so `buildAttrs` emits it; the Tiptap mark name byte-matches the delta key); serialized via `serializeMdastInline` (wrap in `root > paragraph`, trim).

**Why the `html`-node wrapper (do not "simplify" it away):** gfm's own handlers would serialize an unwrapped structured node correctly too, but the wrapper earns its keep on the **forward** path — it stores the source as real Y.Doc *text* so flat offsets / `getElementText()` include it (the annotation coordinate system stays aligned) and the visibility toggle has a DOM anchor — and on the **reverse** path it bypasses the project's custom `text` escaper. Storing as text/marks (never `insertEmbed`) is the load-bearing coordinate-safety property: an embed would collapse the run to flat-length 1 and desync every later annotation.

**Visibility toggle:** a new `showRawMarkdown` setting (default on) flips a `hide-raw-md` class on the `.editor-scroll` wrapper; `editor.css` then `display:none`s `.tandem-raw-md` spans and `[data-markdown-raw]` paragraphs (CSS only — the source is always in the Y.Doc and saves regardless of the toggle). Surfaced in Appearance settings (`appearance-show-raw-markdown`).

**Documented normalizations (deliberate, not loss):** `remark-stringify` canonicalizes setext→ATX headings, indented→fenced code, bullet/emphasis markers to `-`/`*`, hard-break style, entity decoding, autolinks to angle form (`<https://…>`), and loose-list paragraphs → tight (blank lines between list items are dropped; `spread: false` is hardcoded in `yDocToMdast`). The fidelity test asserts **idempotency + content-preservation**, not byte-identity to hand-authored input.

**Amendment (2026-08-14, #1448): two claims in that paragraph were wrong, and the test contract in its last sentence is what let them stand.**

"Idempotency + content-preservation, not byte-identity" sounds like a modest, honest contract. It is not: **every defect found in #1448 satisfies it.** Each one mangles the document exactly once and is then a stable fixed point, so `pass2 === pass1` holds and the suite stays green while the file on disk is wrong. The contract could not fail, which is why nothing failed for months. It is replaced by **byte-identity on the first pass** for anything a reader would notice, measured by `tests/server/file-io/roundtrip-corpus.test.ts` and `tests/client/editor-roundtrip.test.ts`.

Three specific corrections:

- **"Hard-break style" was never a normalization.** What actually happened is that the *editor* converted **soft line wraps into hard breaks** — a semantic change, not a style choice. A soft wrap lives in the Y.Doc as a literal `\n` inside a `Y.XmlText`; a hard break is a sibling `Y.XmlElement("hardBreak")`. The Y.Doc distinguishes them; ProseMirror does not, so its DOM re-read split paragraph text on newlines. Saving then wrote a trailing `\` onto every wrapped line and renderers broke the paragraph at the author's wrap column. Fixed by declaring `whitespace: "pre"` on the paragraph node. Genuine hard-break *style* (`  ` vs `\`) is still normalized and that part stands.
- **The "no silent drop" guarantee did not hold for the raw carriers this ADR introduces.** `getElementPlainText` read only `Y.XmlText` children, so a newline held as a sibling `hardBreak` was dropped without warning and every multi-line raw block collapsed onto one line (#1458) — the exact failure mode this ADR exists to prevent, in the exact constructs it was written to protect.

- **Loose→tight was never a normalization either, and is now fixed.** `spread` was hardcoded `false` on both the list and each item in `yDocToMdast`, so every loose list in 56 of this repo's files was rewritten tight on the first save. It is now carried through the Y.Doc and declared on the Tiptap nodes (`ListSpreadExtension`), because an attribute the client schema does not declare is discarded by `computeAttrs` before the DOM is ever involved and then pruned from the Y.Doc — the same mechanism that destroyed table alignment.

**The replacement contract, in full.** A difference is either **visible** — a reader opening the file in another editor or viewer would see it — or **invisible**. Visible differences are defects and are held at zero by the corpus. Invisible ones are canonicalization: they are permitted, they must be idempotent (change once, then hold), and they are enumerated here so they are a stated behaviour rather than a discovery.

The invisible set, measured across all 245 tracked `.md` files in this repo:

- Marker and structure style with no mdast representation: setext→ATX headings, indented→fenced code, bullet/emphasis/fence/ordered markers, `***`→`---`, blank-line runs collapsed, entity decoding, autolinks to angle form.
- Table geometry: hand-authored `|---|---|` cannot be reproduced, and a row's trailing empty cell is made explicit. Cell *padding* no longer churns (`tablePipeAlign: false`), which was 112 of the 201 originally-differing files; alignment colons survive (they are carried as a declared `align` attribute).
- Code-span style: padding spaces inside a fence, a longer-than-minimal fence, and a span wrapped across a source line coming back on one line. CommonMark renders all three identically.
- Mark order where the source cannot be recovered: two marks covering exactly the same run come back in a fixed order (`~~**x**~~` → `**~~x~~**`). A delta segment's attributes are a set — Yjs does not record which mark opened first. Where run *lengths* differ, nesting IS recovered; that was the V5 defect and it is fixed.
- Escape noise: a literal backtick, a `\[label]` matching a real definition, and a `\@` before a host-shaped string all keep their backslash. Each is a deliberate over-keep — see the `text` handler in `markdown.ts`, whose rule 3 documents two corruptions caused by trying to be tidier.

Everything above renders identically. Recovering any of it needs a per-node source-marker layer, which is a materially larger project and is out of scope.

**Line endings are preserved, not normalized** (`src/server/file-io/line-endings.ts`): the dominant ending is detected at load and restored at save, while the model itself is always LF. A CRLF file previously came back mixed — block separators LF, intra-paragraph soft wraps CRLF — which is worse than either pure form and invisible to a repo corpus, since `.gitattributes` pins `*.md text eol=lf`. The detected set is `\n`, `\r\n` **and bare `\r`** (classic Mac). The third member is not hypothetical tidiness: `toLf` collapses `\r` like any other ending, so while the type admitted only two forms a lone-CR file had no name to be recorded under and was rewritten to LF on every line, silently and with no path back. A normalization the type system cannot express is a normalization nothing can undo.

**A persisted session is stamped with `DOCUMENT_MODEL_REVISION`.** `ydocState` is a bare `Y.encodeStateAsUpdate` of an already-parsed document, so none of the above reaches it; a session written under an older revision is discarded on reopen in favour of a fresh parse, unless it is `dirty` or an `upload://` path, where it is the only copy of the content.

**Deferred (#982):** GFM task lists / checkboxes need a first-class `TaskList`/`TaskItem` node and `checked` mapping; today they degrade to plain bullets. This is a documented gap pinned by `markdown-fidelity.test.ts` so it can never become a silent drop.

**Consequences:** the round-trip is a stable fixed point (re-open re-parses the emitted source into the same gfm nodes and re-stores them). Coverage: `tests/fixtures/markdown-fidelity.md` + `markdown-fidelity.test.ts` (every construct, idempotency, the #982 gap) and `markdown-raw-constructs.test.ts` (forward/reverse mapping + slice-level flat-offset stability). New settings fields must be enumerated in `normalizeKnownFields` (an allowlist) or they are silently dropped at runtime — `showRawMarkdown` is pinned by a presence/default regression.

**Cross-references:** ADR-027 (note privacy — raw passthrough is a view/serialization concern, not annotation data), ADR-031 (origin tagging — file-sync/internal writes), #981 (audit umbrella), #982 (task lists), #605 / lessons #69 (the remark-stringify escaper the wrapper bypasses).

## ADR-043: Updater — No Rollback, No In-Updater Post-Restart Health Probe (v1)

**Status:** Accepted (2026-06-07)

**Context:** The Tauri auto-updater path (`perform_install` in `src-tauri/src/lib.rs`) runs `kill_sidecar` → `wait_for_port_release` (+ Windows `wait_for_sidecar_unlock`) → `update.download_and_install` (minisign-verified) → `app.restart()`. Issue #925 flagged two gaps: (1) no rollback if `app.restart()` fails to relaunch a broken/corrupt new binary, and (2) no health-poll *inside* the updater path after restart.

**Decision:** Ship v1 with current behavior unchanged (option **(c)** of #925). The decisive constraint is that **Tauri v2 `AppHandle::restart()` is divergent** — it exits and relaunches the process without returning (tauri-apps/tauri #12310/#13923/#11392). Therefore: (2) an in-`perform_install` post-restart probe is unreachable dead code by construction; and (1) rollback cannot be driven from the old process, which is gone the instant `restart()` runs — true rollback would require a standalone watchdog/bootstrapper process plus a `.previous` binary copy and platform-specific swap-back logic. Neither the [Tauri v2 updater docs](https://v2.tauri.app/plugin/updater/) nor [CrabNebula's auto-updates guide](https://docs.crabnebula.dev/guides/auto-updates-tauri) recommend either; both stop at `download_and_install()` + relaunch with no rollback or post-restart verification.

**Why this is acceptable:** The post-restart health verification #925 asks for **already exists for the sidecar** — the relaunched process's `start_sidecar` → `wait_for_health` (bounded) and the `MAX_RESTARTS` retry loop, which surfaces a native "Server Error" dialog on exhausted failure. (The `sidecar-restart-failed` WebView event is emitted only from the manual `restart_sidecar` command, **not** this startup path.) The only uncovered case is the Tauri *shell* failing to relaunch at all, which is rare (reached only after signature verification; a binary that won't run on the target OS fails the *first* launch, not a relaunch) and unobservable from Rust without an external supervisor.

**Deferred follow-up (optional, not v1-blocking — filed as #1118, 2026-06-11):** The one in-process-only hardening that survives the divergent-`restart()` constraint is a persisted "pending update" marker — write a sentinel before `restart()`; the next boot clears it on version-match or surfaces a one-time "your update may not have completed — report a bug" banner on mismatch. Diagnostic/recovery-hint only (no binary swap), sketched in `docs/spikes/updater-rollback-healthpoll-audit.md` §6, and must be compiled + runtime-verified in a real Tauri build before landing.

**Cross-references:** Audit doc `docs/spikes/updater-rollback-healthpoll-audit.md`, #925, tauri-apps/tauri #12310 (`restart()` may exit before `RunEvent::Exit`).

## ADR-044: Cowork Detection — Dual Scan Roots, Shape Guard, Write-Time Revalidation, Background Heal

**Context:** Cowork workspace detection scanned only the MSIX layout (`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\local-agent-mode-sessions`). The direct-download Claude Desktop installer — the common case — keeps sessions at `%APPDATA%\Claude\local-agent-mode-sessions`, so most real installs showed "Not detected on this computer" in the integration wizard. Closing that gap surfaced four interlocking decisions (plan: `docs/plans/cowork-detection-airtight.md`; adversarially reviewed by security/design/windows-platform agents before implementation).

**Decisions:**

1. **Dual scan roots, exact-alias dedup only.** `roots_under()` discovers both the MSIX layout and the Roaming direct-install layout. MSIX-virtualized and real Roaming dirs are distinct real directories (filter-driver overlay, not a junction) — a dual install legitimately yields two roots, each with a per-root `MAX_WORKSPACES` cap so neither starves the other. `dirs::config_dir()` resolves the Known Folder, which ignores a modified `%APPDATA%` env var that Electron honors — rare divergence, accepted (fail mode is plain `undetected`).
2. **Publisher-anchored MSIX package match** (`Claude_*` or `AnthropicPBC.Claude*`), never `contains("Claude")` — each `Packages\` subdir is a container owned by that package's identity; a substring match would let a foreign package (`EvilCorp.TotallyClaude_x`) stage the inner layout and receive Tandem's token across the MSIX sandbox boundary. Verified 2026-06: the real family name is `Claude_pzs8sxrjxfjjc` (registered as bare "Claude"), so `Claude_*` matches Store installs today; `AnthropicPBC.Claude*` is future-proofing only.
3. **Workspace shape guard: UUID-or-marker union.** A vm dir qualifies when both path components are UUID-shaped OR it contains `cowork_plugins\`. UUID-only would silently zero detection if Claude renames session dirs; marker-only deadlocks on fresh workspaces (our installer is what creates `cowork_plugins` when absent). The union can only widen. Rejections are debug-logged with one aggregate info line per scan. The shape filter narrows the candidate set BEFORE the five-step security guard, which is untouched.
4. **`check_acl` allows `<config_dir>\Claude\local-agent-mode-sessions`** (and ONLY that Roaming subtree). Token-confidentiality call made explicitly: the wizard already writes the same bearer token into Roaming via `claude_desktop_config.json`, so this adds no new exposure class. `warn_if_roaming` logs when a write lands there (roaming profiles sync `%APPDATA%` to the profile server).
5. **Write-time revalidation on ALL installer write entry points** (`revalidate_resolved_path` at fn top): closes the #433 scan→write TOCTOU on the non-handle write paths (enable, rescan, heal) that previously bypassed the handle registry defense. Originally `install_tandem_plugin_into_workspace` / `uninstall_tandem_plugin_from_workspace` only; the PR #1110 review-fix batch extended it to `apply_token_to_all_workspaces` and `reconcile_orphans` (per-workspace, before the token rewrite — the orphan firewall-rule cleanup in `reconcile_orphans` runs before the loop and is unaffected). No residual non-handle TOCTOU remains.
6. **Background heal task** (5-min interval, first tick at launch, Rust-side): when `cowork_meta.enabled`, installs plugin entries into workspaces lacking one — so the workspace created by the user's *first* Cowork session gets configured headlessly. Rust interval beats the client-poll alternative (poller only runs while a settings surface is mounted) and the `notify` watcher (new crate + lifecycle for no real latency need). Read-only precheck (zero writes in steady state); the per-process attempt set records a workspace only on a **terminal** outcome — success or `InsecureAcl` (a redirected/synced path that won't become safe), so those don't loop — while a **transient** failure (`Locked` / `SchemaDrift` / `Failed` / error) is left retryable so a momentary glitch self-heals on the next tick (PR #1110 review-fix; the original "mark every attempt" poisoned transient failures until restart). The manual Re-scan button deliberately bypasses the guard; no firewall work or UAC ever.
7. **Pre-arm enable rejected:** `cowork_toggle_integration` requires `detect_vethernet_subnet()`, and the Hyper-V vEthernet adapter only exists after Cowork has run — enabling before first run would hard-fail (and the firewall allow-rule needs a UAC prompt no background task should fire). Instead the UI's `undetected` state carries an honest sub-detail (`noClaude` / `noWorkspacesYet` / `blocked`) driven by `claudeDesktopDetected` (existence checks only, incl. the MSIX-virtualized config path) and `workspacesBlocked` (guard-rejection count — redirected/UNC/OneDrive AppData gets "can't safely configure", not a false "run Cowork once" promise).

**Status (v0.14.x):** shipped with this change.

## ADR-045: MCP Transport Multiplexing — One `McpServer` Per Session, Keyed by `Mcp-Session-Id`

**Status:** Accepted (2026-07-22). Implements §3.2 of `docs/spikes/per-client-identity-spec.md` (#438).

> **Amended 2026-07-30 — MCP revision `2026-07-28` removes the mechanism this ADR is built on, and splits implementations into eras this ADR now sits on one side of.** [SEP-2567](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2567) deletes protocol-level sessions and the `Mcp-Session-Id` header; [SEP-2575](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2575) deletes the `initialize` handshake, the standalone GET stream, and SSE resumability **on the MCP endpoint** — Tandem's own `/api/events` `Last-Event-ID` replay is an unrelated mechanism (ADR-019) and is untouched. Cross-call state moves to explicit, server-minted handles passed as ordinary tool arguments. A server supporting *only* the new revision **SHOULD** ignore an arriving `Mcp-Session-Id`, not mint or echo one, and answer `405` to GET/DELETE. That is `SHOULD`, not `MUST` — the header ceases to exist rather than being prohibited, which is what leaves the dual-era option below open.
>
> **The era model is the load-bearing part, and this is a fork rather than a migration.** The revision names three kinds of implementation: *legacy* (`initialize` handshake, `2025-11-25` and earlier), *modern* (per-request `_meta`), and *dual-era* (both, which a server **MAY** serve concurrently on one endpoint). Tandem is a legacy server. Two rows of the [compatibility matrix](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#compatibility-matrix) bound everything below:
>
> - **Modern client + legacy server = Fails.** There is no negotiation handshake — *"Every request carries its protocol version, and the server accepts or rejects each request independently"* — and the mechanisms that would let a server steer a client to a shared version (`UnsupportedProtocolVersionError`, `server/discover`) exist only on modern servers. So what keeps Tandem working is **not** a protocol guarantee: it is that a *dual-era* client probes, gets a non-modern error, and falls back to `initialize`. That is a property of Claude Code's implementation, not of the spec. **Watch item: if Claude Code ships modern-only, Tandem stops working outright.**
> - **Legacy client + modern server = Fails**, and *"legacy clients have no fall-forward mechanism."* So when Tandem adopts the revision it must be **dual-era**, or every un-upgraded Claude Code and Cowork install breaks hard on the same day.
>
> **Nothing here is broken and no code changed.** Verified 2026-07-30 against the published tarball: SDK 1.30.0 — the version `package-lock.json` pins — still exports `LATEST_PROTOCOL_VERSION = '2025-11-25'`, with no `2026-07-28` in `SUPPORTED_PROTOCOL_VERSIONS`. Both SEPs merged in May, so this is a revision the SDK has not adopted, not one it had no chance to. (A dev box's `node_modules` may lag the lockfile — cite the lockfile or the tarball, not the installed tree.) Decisions 1–6 are correct for every protocol version Tandem can currently speak, and the eviction bug they fix is real on all of them.
>
> **Corrected reading of the decisions.** They do not die; they become the **legacy branch of a dual-era server**, and live at least as long as the revision's new minimum twelve-month deprecation window:
>
> - **Decisions 1, 3, 4 (registry, `onsessioninitialized`, reaper, LRU cap) — survive, scoped to legacy.** A dual-era server picks behavior from how the client opens, and an `initialize` request selects legacy semantics *scoped to the session* — which is exactly what the registry serves. Two legacy clients still contend, so the bug this ADR fixes stays live on that branch. What is **undetermined** is the modern branch's shape: "one `McpServer`, no registry" is not available on the evidence, because Decision 2's `Protocol.connect()` throw is a property of the SDK's `Protocol` class and SEP-2567 does not touch it — one server still cannot hold two concurrent transports. The SDK's stateless transport mode constructs a server per request instead, and ADR-012 asserted ~~*"the SDK crashes in stateless mode after the first `server.connect()`"*~~ — a 2024 claim **refuted by the #1253 probe in 2026 (#1332)**, see the ADR-012 note above. Whether to adopt stateless mode here is a separate question and still depends on #1505/#1249.
> - **Decision 5 (`AsyncLocalStorage`) — survives.** It binds per request, which is the case a stateless protocol presents. Two refinements: `mcpSessionId` goes empty, and `claudeSessionId`'s *lookup path* changes — today it is captured at `initialize` and replayed from the registry entry on later requests, so with no registry it must be read from the header per request.
> - **Decision 6 (`X-Claude-Session-Id`) — survives, and gains importance rather than losing it.** It is a Tandem header, not a protocol one. Do **not** expect `io.modelcontextprotocol/clientInfo` to replace it: the spec marks that field optional, says it is *"self-reported… not verified by the protocol"* and that implementations **SHOULD NOT** *"use them to change the behavior of the client or server"*, and its type carries only `{name, version}` — so two concurrent Claude Code instances send byte-identical values. For telling one Claude session from another it is strictly worse than the session id it replaces.
> - **`hasSession` — becomes partial, not meaningless.** The Consequences below redefine it as "≥1 live session." On a dual-era server that stays sound *for legacy attachments* and goes silent about modern ones, so the job is to **supplement** it, not replace it. It still needs care: the natural supplement is a recency signal, which answers a different question and inverts the failure mode. Tracked in **#1249**; see `docs/spikes/ai-readiness-mcp-session.md`.
>
> **New server obligations on the modern branch,** none of which exist today: `server/discover` (servers **MUST** implement it); required `Mcp-Method`/`Mcp-Name` request headers with server-side header↔body validation (a CORS-preflight surface, given Tandem's own Express middleware and Host check); `resultType` on every result; `ttlMs`/`cacheScope` on every list result. Decision 1's `404 -32001` stays legal — the new error-allocation policy grandfathers `-32000`–`-32019`, and the draft's `HeaderMismatch` was renumbered *away from* `-32001` to `-32020`.
>
> **Consequence for #438:** §3.3/§3.4/§3.5 must not be keyed on `Mcp-Session-Id`, and the modern branch **MUST NOT** vary `tools/list` per connection (SEP-2567), which forecloses per-client tool lists outright. See the amendments in `docs/spikes/per-client-identity-spec.md` and `docs/spikes/session-identity-transport-probe.md`.
>
> **The decision this amendment does not make:** when Tandem becomes dual-era. (The companion question — whether Tandem ever *drops* the legacy branch — **is** now decided; see the 2026-08-18 amendment immediately below.) Dual-era adoption is tracked in **#1505**, and the watch item above — Claude Code's own era, an external dependency with no signal that would surface a change before users hit it — in **#1506**. #1252, which previously owned all three, is closed.
>
> **Amendment (2026-08-18, #1252) — the legacy branch is permanent. Tandem never drops it.**
>
> One of the two questions the paragraph above deferred is now answered, and the answer is that it
> was never really a scheduling question. **Tandem keeps the legacy branch indefinitely.**
>
> **This was already decided once and did not reach the record.** The 2026-08-06 backlog triage put
> it as D-8 — *"commit to 'dual-era, legacy retained indefinitely'?"* — and answered **"Yes to
> both"** ([`docs/triage/2026-08-06/backlog-triage-2026-08-06.md`](triage/2026-08-06/backlog-triage-2026-08-06.md),
> [`brief-438.md`](triage/2026-08-06/brief-438.md)). The ADR amendment that answer called for was
> never written, so the question stayed open in #1252 for another twelve days and was re-litigated
> from scratch. A decision whose only home is a dated triage table is a decision that will be made
> again; this amendment is that missing home.
>
> The reason is the matrix row, not a preference: *legacy client + modern server = Fails*, and
> *"legacy clients have no fall-forward mechanism."* Removal is therefore **unrecoverable
> client-side** — every un-upgraded Claude Code and Cowork install breaks hard on the same day, with
> no negotiation, no degraded mode, and nothing the user can do from their end. There is no version
> of Tandem that works without the legacy branch, so there is nothing to schedule.
>
> **The spec's twelve-month feature-lifecycle window is not an inherited obligation here.** #1252
> cited it as a reference point for what a deprecation window would have to look like *if* one were
> ever planned. None is, so the clock never starts. Do not read the citation as a commitment Tandem
> has taken on.
>
> This makes the legacy branch a permanent half of a dual-era server rather than a transitional one,
> which sharpens the "survive, scoped to legacy" reading above: Decisions 1, 3 and 4 are not living
> on borrowed time pending a removal date. They are the legacy branch, and the legacy branch stays.
>
> **What #1252 deferred that is still open**, now tracked separately because the two halves have very
> different urgency and one of them is not blocked on anything:
>
> - **Dual-era adoption** — serving `2026-07-28` concurrently on the same endpoint. Additive, and
>   **blocked** on the TypeScript SDK shipping support: SDK 1.30.0, the version `package-lock.json`
>   pins, still exports `LATEST_PROTOCOL_VERSION = '2025-11-25'`. Tracked in **#1505**.
> - **The watch item** — whether Claude Code itself goes modern-only, which is the only live failure
>   mode in this whole area and must not sit behind the blocked work. Tracked in **#1506**, on a
>   monthly cadence deliberately *not* gated on the SDK.

**Context:** Tandem's HTTP MCP server held a single module-level transport. Every `initialize` called `connectFreshTransport()`, which closed the previous transport before attaching a new one. The MCP SDK 404s any request whose `Mcp-Session-Id` it doesn't recognize, so the *second* Claude client to connect silently evicted the first one's tool channel; the evicted client's next `tandem_*` call failed until it re-handshook, which then evicted the second. Two Claude Code sessions — or Claude Code plus Cowork — could not coexist. The SDK was already minting a per-session id on every handshake and we were discarding it.

**Decisions:**

1. **Key live transports by the SDK's `Mcp-Session-Id`; never evict on `initialize`.** `src/server/mcp/transport-registry.ts` holds the map; `POST`/`GET`/`DELETE /mcp` look the session up by header and answer **404 `-32001` "Session not found"** when it is unknown. The old code answered 503 `-32000` "No active session" for a stale id, which reads as *the server is down* when the truth is *that session is gone, re-initialize*.

2. **One `McpServer` instance per session ("Shape 2" of the spec), not a shared singleton.** This resolves the spec's probe **P2**: SDK 1.30.0's `shared/protocol.js` `connect()` throws `"Already connected to a transport"` when `this._transport` is set, so a single server provably cannot serve two live transports. Shape 1 is not available. Tool registration is pure and unconditional, so per-session servers are cheap.

3. **Register from `onsessioninitialized`, not after `connect()`.** `transport.sessionId` is minted while the transport *handles* the initialize request, so it is `undefined` immediately after construction — the callback is the only correct registration point. The `/mcp` route closes any session whose handshake finished without initializing, since the registry cannot reap an entry it never received.

4. **A reaper is required, not optional.** The single-transport model never needed one (there was only ever one entry). A map grows for every client that vanishes without sending `DELETE /mcp` — crash, SIGKILL, closed laptop. Two bounds: a 30-minute idle TTL swept every 5 minutes, and a hard cap (16) that evicts the least-recently-used entry. The cap evicts rather than refusing the new session: a refused `initialize` looks like a broken server to a user who just opened a legitimate session, whereas LRU eviction degrades the same way the old code did — except it now takes 16 sessions to get there instead of 2.

5. **Per-request session context via `AsyncLocalStorage`** (`src/server/sessions/context.ts`), entered around the awaited `transport.handleRequest` on **every** `/mcp` verb — POST, GET and DELETE — rather than only where a tool call can be dispatched today, so a future SDK that dispatches over another verb cannot silently lose the caller's identity. Tool handlers take only their declared arguments, so this is how a handler learns its caller without threading a parameter through all six `register*Tools` functions. It works because the SDK dispatches `tools/call` through an unbroken promise chain from `handleRequest` (`webStandardStreamableHttp.js` → `Protocol._onrequest` → `Promise.resolve().then(handler)` → the tool callback) — no timer, no emitter tick, no detour via the standalone GET SSE stream. The constraint this creates: the `run()` must wrap the **entire awaited** `handleRequest`; resolving the id into a module-level "current session" variable instead would be racy across concurrent sessions. That is not a theoretical objection — `tests/server/mcp-session-context.test.ts` drives two overlapping tool calls from different sessions and was verified to fail on exactly those isolation cases when the module was swapped for a naive module-level variable.

6. **`X-Claude-Session-Id` is optional and must stay optional.** It identifies the *Claude Code* session (as opposed to the MCP transport session) and only the stdio-bridge config path carries it — that entry runs as a Claude Code subprocess, so `CLAUDE_CODE_SESSION_ID` is in its environment and `mcp-stdio.ts` forwards it. The direct-HTTP `.mcp.json` entry that `buildMcpEntries` writes for Claude Code CLI (`{type:"http", url}` + static headers) has no subprocess and no per-launch value, so it carries nothing. The server re-validates the header on arrival rather than trusting the sender's guards. Everything here works without it; only the follow-on event-routing work (#438 §3.4) needs it, and closing that gap is a separate decision.

**Consequences:** `GET /health`'s loopback-only `hasSession` now means "≥1 live session" instead of "a transport object exists" — same contract for its consumers (`useAiReadiness`, `tandem doctor`). `/api/info`'s `toolCount` is snapshotted from a throwaway `createMcpServer()` at boot, because there is no longer a boot-time singleton to read it from. `closeMcpSession()` now also clears the idle reaper, so it fully undoes what `startMcpServerHttp` set up — tests that start a server per case must call it or they accumulate one live interval each. Coverage: `tests/server/transport-registry.test.ts` (cap/TTL/LRU/replace/close-failure), `tests/server/mcp-multi-session.test.ts` (real HTTP, two concurrent handshakes, scoped DELETE, unknown-id 404), and `tests/server/mcp-session-context.test.ts` (context isolation). The latter two were each verified to fail against the pre-change implementation, so they pin the regressions rather than restating current behavior.

**Cross-references:** `docs/spikes/per-client-identity-spec.md` (#438) §2.1/§3.2/§6.4, ADR-012 (Streamable HTTP transport), ADR-023 (Cowork stdio bridge), #452 (multi-Claude concurrency, which this unblocks). Still single-client after this change and tracked separately: `surfacedIds` and the shared chat `read` flag in `mcp/awareness.ts` (spec §3.3), and broadcast-only event routing in `events/sse.ts` (spec §3.4).

## ADR-046: Start at Login — Desktop-Only, Hidden Boot, Deferred AI Launch

**Status:** Accepted (2026-07-27). Implements #1236.

**Context:** Tandem was strictly user-invoked. Launching the desktop app spawned the node sidecar, which started Hocuspocus + MCP and, when a `claude-code` integration existed, spawned Claude Code as a managed child. Closing the window hid to tray and kept the server alive, but nothing brought Tandem back after a reboot — a user who works in Tandem daily had to remember to start it, and any agent workflow that assumed Tandem was reachable silently wasn't. The repo's existing "auto-launcher" launches *Claude Code*, not Tandem, so this was greenfield.

**Decisions:**

1. **Desktop app only; `tauri-plugin-autostart` rather than three hand-rolled OS integrations.** No systemd unit, LaunchAgent, or Run-key writing for the npm CLI — `tandem start` stays foreground. A maintained plugin covering Windows/macOS/Linux beats three bespoke implementations, and the tray gives an exit affordance a headless daemon lacks. The honest cost, recorded because reviewers were right to press on it: a full GUI process (WebView, updater, Cowork heal loop) is a heavy way to obtain a background document server. If the server ever needs to run without the shell, that is a different feature, not a tweak to this one.

2. **Default OFF, opt-in from Settings → Network.** Never enabled on install or upgrade. The toggle sits at top level rather than under *Advanced* — it changes what happens on every boot, which is not a rarely-touched knob.

3. **The OS is the source of truth, not `tandem:settings`.** The registration is mutable outside Tandem (Task Manager → Startup, System Settings → Login Items, `~/.config/autostart`), so a mirrored boolean would drift with no moment at which to reconcile it. `createAutostart` reads live state on every Settings open. **Consequence: `CURRENT_SCHEMA_VERSION` did not move, there is no migration, and `TandemSettings` gained no field.** That is deliberate — don't "fix" it later by adding one.

4. **An argv flag (`--tandem-autostart`), not an env var.** The registration's command line is the only thing the OS lets us control, and a flag is visible to a user inspecting the startup entry where an env var would not be. `extract_file_arg` already skips `-`-prefixed args, so the flag can never be mistaken for a file-association path; `autostart_flag_is_not_a_file_arg` pins that rather than leaving it to luck. `TANDEM_DISABLE_AUTOSTART=1` is the debug escape hatch that makes a login launch behave as an ordinary one.

5. **Boot launches start hidden in the tray — but only when a tray actually exists.** `tauri.conf.json` sets `visible: false` and `setup()` becomes the sole visibility authority. Two guards make that safe:

   - **`StateFlags::VISIBLE` is masked out of `tauri-plugin-window-state`.** Verified against the pinned 2.4.1 source: `restore_state` does `self.show()?.set_focus()?` when the flag is set and the cached state says visible. Since the common case is a user who quit with the window open, leaving the flag on would have overridden the hidden-boot decision *and stolen focus during login*. (There was no pre-existing bug — `restore_state` only ever shows, never hides — so the conflict appears exactly at the moment `visible: false` is introduced.) Masking the one flag preserves size/position restore; `skip_initial_state` would not have.
   - **`should_start_hidden(autostart, tray_available)`.** On Linux without libappindicator the tray build fails and `CloseRequested` exits the process; a hidden, trayless Tandem would be an unreachable zombie holding :3478/:3479. The flag measures *construction*, though, not visibility — `TrayIconBuilder::build()` succeeds on GNOME without a status-icon extension and renders nothing. So on Linux the **first-ever** autostart launch always shows the window (`autostart-seen` marker in the app data dir), guaranteeing one chance to find the setting and turn it off.

   Normal launches show the window as the **first statement of `setup()`**, ahead of the log plugin, `build_http_client().expect(...)`, sidecar spawn, and tray construction — so no fallible startup work can strand a user-initiated launch behind an invisible window.

6. **A boot launch does not auto-launch Claude Code.** §2 of [ADR-038](#adr-038-mcp-first-integration-policy-claude-as-default-integration) grounds auto-launch in "the user-invoked Tandem app spawning a child process." A login launch is the OS invoking Tandem, so that premise does not hold: the machine would silently spawn an AI agent at every boot with nobody present. The sidecar receives `TANDEM_DEFER_LAUNCHER=1`, the server resolves `deferred-autostart`, and `POST /api/launcher/start` promotes it once a human appears.

   - **A one-shot `AtomicBool` latch, not a captured env value.** The `.env(...)` chain lives inside `for attempt in 0..=MAX_RESTARTS` and `restart_sidecar` re-enters `start_sidecar` from scratch — the existing code guards `TANDEM_OPEN_FILE` with `if attempt == 0` for exactly this reason. A captured flag would mean: boot hidden → user opens window → launcher starts → sidecar crashes and restarts → the fresh sidecar defers again, no second trigger ever fires, Claude never returns for the session. The latch is re-read on every spawn attempt, so a restart inherits current reality rather than a snapshot from boot.
   - **The trigger lives in Rust, and presence is a separate concept from showing the window.** The plan originally specified a client-side `document.visibilityState` listener; that was changed during implementation. Rust knows exactly when the window is shown, whereas the WebView's `visibilityState` semantics for a natively-hidden Tauri window are unverified, and a client trigger does nothing at all if the WebView fails to mount. A Tauri *event* would not work (events aren't buffered and the listener may not exist yet — see `STARTUP_REJECTION`), but a direct loopback POST has no such constraint.

     The first implementation hung `note_user_presence` directly off `show_main_window`, reasoning that a single choke point catches every path. Review found that wrong, and the bug it produced is instructive: `setup()` *itself* shows the window at boot on two Linux paths, ~200 lines before the sidecar's health poll returns. The latch was consumed by `swap`, the POST hit a connection-refused, and — with no retry and no second trigger — Claude never launched for the rest of the session. The choke point should be *user intent*, not *window state*. `show_main_window` is now the mechanical primitive that startup uses; `show_main_window_for_user` is the user-intent wrapper that also signals presence. Two further guards fell out: the release waits on the existing `SIDECAR_HEALTHY` flag rather than POSTing blind, and a failed release re-arms the latch, so `swap` is a claim rather than a commitment.
   - **Accepted consequences:** the tray's "Setup AI Assistant" item signals presence too, so it releases the launcher — the supervisor's own gate (a `claude-code` integration with `apply !== "skip"`) is the backstop. And the two degraded Linux paths that show a window at boot *do* release the launcher deliberately, because with no tray and no Dock icon there is no later signal that could ever release it; a stranded launcher is worse than an early one, and it is confined to configurations we already warn about.

7. **`POST /api/launcher/start` checks the reason BEFORE the nonce.** It is the only route that can create a supervisor from null — `relaunch` and `start-fresh` both funnel through `requireSupervisor()`, which 503s in exactly the deferred state. If the reason check were skipped or reordered, the route would be an HTTP **bypass of `TANDEM_DISABLE_LAUNCHER=1`**, a kill switch that otherwise cannot be defeated remotely. Hence also `resolveInitialLauncherReason`: `TANDEM_DISABLE_LAUNCHER` outranks the deferral, and `TANDEM_DEFER_LAUNCHER` is honored **only** when `TANDEM_TAURI_SIDECAR === "1"` (the server reads `process.env` regardless of who spawned it, and `tandem start` inherits the shell environment — without that gate an exported var would permanently kill the auto-launcher on the npm distribution, which has neither a toggle nor a trigger to recover with). Single-flight is set synchronously before the first `await` and shares the `relaunch`/`start-fresh` exclusion group; two concurrent `createSupervisor()` calls would orphan the first supervisor's reaper child, which shutdown could never reap.

   Note on guard strength, so it isn't overstated elsewhere: `assertOriginAllowlisted` reads a forgeable header, so it is a CSRF control and nothing more. `assertLoopbackForMutation` was, *when this ADR was written*, conditional on `TANDEM_ALLOW_UNAUTHENTICATED_LAN=1` and therefore inert in the default configuration — that is the reading this decision was originally reasoned against. **#1293 flipped it: it now rejects every non-loopback peer in every configuration**, so on this route it is load-bearing rather than decorative. Do not reason from "the loopback gate is inert anyway" when reordering or dropping a guard here. The primary protection is still the loopback bind plus Bearer auth for non-loopback callers. Same posture as `relaunch`, so this is not a regression.

8. **`GET /api/launcher/status` redacts `reason` off-loopback entirely.** `deferred-autostart` is a live presence oracle — it means *this machine auto-booted and the human hasn't opened the window yet*. Omitting the whole field rather than filtering one value also future-proofs the enum. Client-side, `useAiReadiness` maps the deferred state to `booting` (chip suppressed) instead of `unconfigured`; without that branch a fully-configured user who boots hidden would be told to run the integration wizard, which is worse than saying nothing.

9. **macOS uses `MacosLauncher::LaunchAgent`, and the deciding factor is the read path.** In `auto-launch` 0.5 (what the plugin pins) the AppleScript variant's `is_enabled()` shells out to `osascript` — which requires Automation (TCC) approval. Since `autostart_get_status` runs on every Settings open, choosing AppleScript would pop a "Tandem wants to control System Events" prompt at users who never asked for autostart at all; enabling costs two further pop-ups. LaunchAgent's `is_enabled()` is a plain `plist.exists()`. The known trade-off: a LaunchAgent plist points at the Mach-O inside the bundle and launches it outside LaunchServices, which may weaken the Apple Events (`RunEvent::Opened`) that file associations rely on. That risk is narrower than prompting every macOS user, affects only login-launched instances, and `RunEvent::Reopen` (added here, so a hidden app's Dock icon works) plus single-instance still function. **Unverified on real hardware** — if Apple Events do break, this is a one-constant change.

10. **Commands are app-defined, not the plugin's JS API.** `autostart_get_status` / `autostart_set_enabled` in `src-tauri/src/autostart.rs` mean no `autostart:default` capability grant and no `@tauri-apps/plugin-autostart` npm dependency, and they buy two things the plugin API cannot: **readback-after-write** (an MSIX/Store package cannot write HKCU Run conventionally — it needs an appxmanifest `StartupTask` extension the plugin doesn't emit — so a write can appear to succeed and be virtualized away; the returned `enabled` is always the OS's value, never the requested one) and **error redaction** (`auto_launch` errors embed the plist / `.desktop` / registry path and therefore the home directory; only a fixed enum crosses the IPC boundary).

**The threat-model change is uptime, and it belongs in the user docs too.** Autostart makes Tandem always-on: session restore re-opens the user's documents into memory, Hocuspocus serves them on :3478, and MCP/API binds :3479. Every loopback-trust decision — loopback exempt from Bearer auth, `GET /api/document/raw` loopback-only-but-unauthenticated, and (as this ADR was written, before #1293 made it unconditional) `assertLoopbackForMutation` a default no-op — now holds 24/7 rather than only while the user is present. Decision 6 *sharpens* this: the server is up and the human is provably absent. `docs/configuration.md` says so plainly. What this is **not** is a persistence-mechanism escalation: `HKCU\...\Run`, `~/.config/autostart`, and `~/Library/LaunchAgents` are all user-writable, so no privilege boundary is crossed.

**Consequences:**

- **A pre-existing bug had to be fixed here, and fixing it required a second fix.** `installer-hook.nsi` has invoked `"$INSTDIR\tandem.exe" --uninstall-scrub` since it was written, but nothing in the Rust binary parsed that flag *and* the binary is not named `tandem.exe` (no `mainBinaryName`, no `[[bin]]` → Tauri names it after the Cargo package, `tandem-desktop`). Cowork plugin entries and firewall rules have never been scrubbed on Windows uninstall. Repairing the dispatch alone would have been actively harmful: Tauri's NSIS template runs the old uninstaller on **upgrade** (`PageLeaveReinstall`, with `/UPDATE` appended) and inserts `NSIS_HOOK_PREUNINSTALL` unconditionally, so every release would have wiped the user's registrations — including their new autostart preference. The `${If} $UpdateMode <> 1` guard ships with the dispatch fix. `$UpdateMode` is populated by then: `un.onInit` parses `/UPDATE` and `FunctionEnd`s immediately before `Section Uninstall`. `tests/build/installer-hook-update-guard.test.ts` pins both, since nothing in CI builds an NSIS installer.
- The Rust scrub's scope is exactly what the `.nsi` comment promised (Cowork entries, firewall rules) plus the autostart registration — on Windows both `HKCU\...\Run` and the `StartupApproved\Run` value, since `auto-launch`'s `disable()` leaves the latter behind. MCP config entries and the bundled skill stay with the npm CLI's scrub, whose bundle is not among the Tauri resources. The npm CLI scrub gained `removeAutostartEntry` as well: macOS and Linux have no uninstaller to run the Rust path, and `docs/data-locations.md` directs those users to `tandem --uninstall-scrub` and promises it removes the entry.
- **`npm run test:e2e` will kill an autostarted sidecar.** `freePort` *kills* whatever holds :3478/:3479 and runs on every HTTP boot, so E2E runs, `tandem start`, and `dev:server` all collide with an autostarted instance. Documented in `docs/configuration.md`; developers should leave the toggle off.
- Known upstream limitation, not fixed here: `auto-launch` 0.5 writes the Windows Run value as `format!("{} {}", app_path, args)` — **unquoted**. `CreateProcess`'s successive-path fallback resolves the common case, and `C:\Users\` is not user-writable, so the classic unquoted-path hijack does not apply; fixing it properly means bypassing the plugin.
- Left open deliberately: what opens at boot (`sample/welcome.md`, or `CHANGELOG.md` read-only after an upgrade — so a post-update reboot silently loads the changelog into an invisible window); boot-time native error dialogs from a tray-only app; WebView background throttling of `useAiReadiness`'s poll while indefinitely hidden; and Windows fast-user-switching with two users both autostarting.

**Cross-references:** [ADR-038](#adr-038-mcp-first-integration-policy-claude-as-default-integration) §2 (the consent premise this defers to preserve), ADR-044 (Cowork detection, whose registrations the scrub now actually removes), #477 PR 4a/4b (the Claude Code auto-launcher and its routes).

## ADR-047: Claude Code Push-Transport Activation

**Status:** Accepted (2026-08-07). Supersedes in part [ADR-028](#adr-028-plugin-monitor-url-and-auth-resolution--userconfig-over-hardcoded-default).

**Context:** The question "how does Claude Code get real-time events from Tandem?" had no owner. ADR-028 is titled *Plugin Monitor URL and Auth Resolution* and answers a different question; it then accumulated four updates and two corrections about which transport is canonical, none of which touched its `**Status:**` line. A reader consulting it normally learned nothing about the transport decision, and the record contradicted itself in places. House precedent (ADR-004, ADR-027, ADR-029, ADR-039, ADR-040) is a new ADR plus a pointer when the subject changes. This ADR owns the transport question; ADR-028 keeps the URL/auth precedence chain it was written for.

The immediate trigger was discovering that the auto-launcher had been passing `--dangerously-load-development-channels server:tandem-channel` since #477 PR 4 and that this had never done anything, while six documentation surfaces asserted that it did.

### 1. The activation gate

Read statically from the Claude Code 2.1.223 binary, on one account, on 2026-08-07. Every step must pass before a channel is registered:

| Step | Rejects when |
|---|---|
| Capability | the session declares no `claude/channel` capability |
| Protocol era | the negotiated protocol predates channels |
| Provider | the auth provider is not `firstParty` — API-key and third-party logins fail here |
| Feature availability | the remotely-served feature payload has channels off for the account |
| Org policy | policy blocks channels |
| Session registration | the channel was never registered for this session |
| Entry kind | for **`plugin:`** entries: no marketplace match, or not on the allowlist. For **`server:`** entries: **rejected unconditionally unless `dev`** |

Two consequences are load-bearing and neither was previously written down.

**`tandem-channel` can never be allowlisted.** It is a `server:` entry; the allowlist is keyed on `plugin@marketplace`. There is no listing shape a bare MCP server could hold, so "get Tandem onto the allowlist" is not a slow path — it is not a path. `dev` is set at exactly two sites, both on the interactive onboarding path, which is why `--dangerously-load-development-channels` is the only mechanism that exists for this entry kind and why `--channels server:tandem-channel` fails identically in both modes.

**This table describes one account at one moment.** The availability step reads a remotely-served, per-account, disk-cached feature payload. Phrase anything written from it as "as of 2.1.223 on this account", never as a permanent property of Claude Code.

### 2. Canonical transport per session kind

| Session kind | Transport | Needs |
|---|---|---|
| **Auto-launched** (supervisor-spawned) | **Supervisor stdin wake** (#1266) | nothing from the user |
| **Hand-launched, interactive** | Self-armed watch, channel shim, or plugin monitor | a `Monitor` tool; or the dev-channels flag; or a plugin install **plus a dispatch of the tandem skill** |
| **Hand-launched, `-p` / headless** | none available | — |

**The launcher no longer emits the dev-channels flag** (deleted 2026-08-07; `src/shared/launcher/contract.ts` carries the reason inline, pinned by a regression test). It was inert for two independent reasons: the flag is parsed only inside an `if (!isNonInteractiveSession)` branch and `-p` is that mode, and #1266 measured end-to-end that no turn results under these flags even when the shim does receive the frame. Nothing observable changes on deletion — the shim's *registration* lives in `~/.claude.json`, independent of argv, so an auto-launched session still spawns it and `push.subscribers` stays above zero. A reader checking `tandem doctor` for a difference will correctly find none; that is the expected result, not a failed change.

The channel shim remains the registered default for hand-launched sessions. The plugin monitor stays an installable alternative and is now the *recommended* one in user-facing copy, with a stated precondition: monitors are spawned through a non-login shell, so they inherit whatever PATH Claude Code itself started with, and a GUI-launched Claude Code frequently has no resolvable Node — `exit 127` (`docs/spikes/plugin-delivery.md`). Recommending it unqualified would be a fresh over-claim of the kind this ADR exists to remove.

> **Update (2026-08-09, #1354).** That failure used to fire in *every* session, including ones unrelated to Tandem, because the manifest armed the monitor with `when: "always"`. It now arms on `on-skill-invoke`, so it is present when Tandem is in play and absent otherwise — the error is now informative where it appears rather than noise everywhere. **Two entries are required, not one:** the host matches `when === "on-skill-invoke:" + <published name>` by plain string equality, and the published name is qualified iff the skill came from a plugin. Tandem ships the `tandem` skill twice (plugin `skills/`, and `tandem setup --apply`'s user-level copy), so `tandem:tandem` and `tandem` are both live names — measured in `docs/spikes/plugin-monitor-tty-activation.md` F6–F8. The cost is that a session which never dispatches the skill gets no monitor, which is the deliberate trade: the population that suffered the noise is the population for whom the monitor never worked.

### 3. ADR-028's rationale (1) is void

The 2026-07-19 keep-the-channel decision rested on three rationales. Their standing today:

1. **Void.** "The monitor is unidirectional, so the channel-only permission-prompt relay has no monitor equivalent" — the relay does not work either. Nothing in `src/client/` reads `pendingPermissions`; the shim registers `permission_request` as an MCP *notification* handler, and notifications cannot be answered; `POST /api/channel-permission-verdict` deletes the entry and logs the verdict, which never reaches Claude Code. The code says so itself (*"SSE push to browser is a follow-up"*), so this is a capability declared ahead of an implementation that never landed — not a regression. It is documented as shipped API in `docs/mcp-tools.md`, which is also wrong.
2. **Already retracted** by the 2026-08-04 correction (#1266): auto-launched sessions never received channel push.
3. **Survives.** Making the plugin a global install would socialize a host-wide registry mutation without expanding the beneficiary set. This is an install-cost argument, not a capability one.

So the keep-the-channel decision now stands on (3) alone. Whether that reopens monitor-canonical is a separate decision and is **not** taken here. What must not happen is the record continuing to claim a capability leg that is a stub.

**On the evidence standing of ADR-028's own history**, absorbed here so it is not a separate chain to follow: the 2026-07-17 update overstated itself in two ways. Its persistent-install and double-delivery claims were credited to #1201, whose body defers exactly those two probes; the real basis for persistent-install activation is the v0.18.0 acceptance run. Its `--plugin-dir` half was asserted by #1201 and is now **unreproduced** on 2.1.223 — deliberately unreproduced rather than falsified, since every cell retested was non-TTY and no primary record of the original re-test survives.

### 4. A supervised session has no approval surface

Worth stating because it is currently incidental rather than designed. `buildClaudeArgs` passes no `--permission-mode`, no `--allowedTools`, and no skip flag; under `-p` the dev-channels flag is not parsed; the channel permission callbacks are wired only on the interactive path; and there is no TTY. A supervised session therefore has no way to ask for tool approval and no way to be answered. The flag deletion is the moment this becomes documented instead of accidental. If an approval surface is ever wanted there, it needs designing — not restoring the flag.

### 5. Open direction (not decided here)

Two facts argue for revisiting the `plugin:` spelling, which was previously dismissed:

- **`plugin.json` has a first-class `channels` field** (`{ server, displayName?, userConfig? }`) and Claude Code ships a scaffold generator for channel plugins. That is the supported authoring path; Tandem's manifest does not use it. A `plugin:` entry is the only kind the allowlist can accept.
- **A `channel_enable` SDK control request registers a channel at runtime** over the stream-json control channel — the launcher's exact mode. It gates on `pluginSource`, requiring a marketplace-installed plugin, which makes it the only known path to real channel push in an auto-launched session and could retire the supervisor's stdin wake.

Both are speculative and need their own probe. Both also inherit a ceiling: `channel_enable` requires a completed marketplace install, and #1316's field reports are of users who could not complete one.

**Method note.** Every claim here about Claude Code internals comes from reading a minified binary with `grep -a`. That method produced a confidently wrong answer during this work — see lesson 95. Treat each fragment as provisional and re-verify before relying on it.

**Cross-references:** [ADR-028](#adr-028-plugin-monitor-url-and-auth-resolution--userconfig-over-hardcoded-default) (superseded in part), [ADR-038](#adr-038-mcp-first-integration-policy-claude-as-default-integration) §extras, #1266, #1316, `docs/spikes/channel-push-stream-json.md`, `docs/spikes/plugin-delivery.md`, `docs/plans/2026-08-07-channel-flag-removal.md`.
---

## ADR-048: Chat stays global (CTRL_ROOM-scoped), not document-scoped

**Status:** Accepted — 2026-08-08
**Context:** #1263, #1264, ADR-018 (CTRL_ROOM)

**Decision:** the chat thread between the user and Claude is a single global conversation, stored in `CTRL_ROOM` and shared across every open document. It does not become per-document.

This ADR records a choice that was already load-bearing in shipped code but had never been written down as a decision — which is why #1263 sat open for months as a `needs-design-decision`. The behaviour is at `constants.ts` (the chat Y.Map key), `awareness.ts` (the CTRL_ROOM chat map), and `ctrl-chat.ts`. #1264 then made unread counts and message filenames `documentId`-aware while *deliberately* leaving scope global, and that split is the substance of this decision: **messages carry document context; the thread does not inherit document boundaries.**

**Rationale.** The conversation is not per-file, and the mismatch is not cosmetic. A user asks about one document while looking at another, pastes from a third, and asks a follow-up after switching tabs — that is one thread, and cutting it at tab boundaries would fragment a conversation the user experiences as continuous. The genuine problem behind the request ("which message was about which file?") is a *labelling* problem, and #1264 solved it the cheap way, by labelling.

**Consequences:**

- `Clear Chat` clears everything. That is the correct blast radius for a global thread, and it is the one place a user may be surprised; the confirmation copy carries the weight.
- Messages sent with no document open, and system messages, have somewhere to live by construction. Under per-room scoping they would have needed an invented home — a real design problem that global scoping simply does not have.
- The unread count is global, with per-document attribution shown on the message. A per-document badge would need `chatSeen` to become per-room state.
- **What was declined, with its price**, so this is not re-litigated as a small change: per-document chat is multi-PR — per-room chat maps, a `chatSeen` baseline migration for every existing user (there is no per-room baseline to migrate *from*), a home for `documentId`-less messages, and re-deciding `Clear Chat`'s scope. None of that is exotic; all of it is real, and none of it buys back something #1264 did not already deliver.

**Reopen condition:** a concrete workflow where the global thread actively loses information — most plausibly many-document sessions where attribution labels stop being enough to find a past exchange. Volume alone is not the trigger; search over the global thread is the cheaper answer to that.

---

## ADR-049: The Self-Armed Wake — `ws` Transport, No Arbitration, Payload-Free Frames

**Status:** Accepted (2026-08-07). Settles the two conflicts Track D-2 of the push-delivery plan deliberately left open. Gated on P-A2, which **passed** — see [docs/spikes/monitor-self-arm-probe.md](spikes/monitor-self-arm-probe.md).

**Context:** A Claude Code session can arm its own watch with the host's `Monitor` tool and be woken while idle — no plugin, no marketplace, no `npx`, no channel flag, so it routes around every install failure observed in the field. P-A2 then confirmed a *persistent* watch survives: five browser-origin events delivered over 16m30s through the real SSE pipeline, still alive at the end. Two design conflicts were left unresolved on purpose, because the probe results were what decided them. This ADR records both answers and the measurements behind them.

> **Amendment (2026-08-09) — "no install, no flag" is not "unconditional".** The `Monitor` tool is `isEnabled(){ return Zue() && Jf() }` in the shipped 2.1.226 binary, and **both halves are preconditions this ADR did not know about** (IN CODE; read by hand out of one build, the weakest tier of evidence here):
>
> - `Zue()` is the remote feature gate `tengu_amber_sentinel`, whose *client-side* default is false. The **same** flag gates plugin monitors, so those two do not back each other up the way independent transports would. Only the channel shim is free of it.
> - `Jf()` is `true` off Windows; **on Windows it requires Git Bash** — `CLAUDE_CODE_GIT_BASH_PATH`, or Git Bash under `Program Files`, or a `where.exe git` result resolved through the cwd-containment guard of [`plugin-delivery.md`](spikes/plugin-delivery.md) F1. This one is **not** shared with the plugin monitor, which falls back to PowerShell.
>
> The second bullet is the sharper correction, because Decision 1 below reasons that the shell source needs Git Bash on Windows and therefore "`ws` is **required**, not preferred." That is right about the *source* and does not rescue the *tool*: on a stock Windows box with no Git Bash, `isEnabled()` is false and the `Monitor` tool is never offered, whatever source we would have passed it. Worse, the two failures compose — the Windows tester of `plugin-delivery.md`, whose per-user Git sits under his home directory while his cwd *is* his home directory, is refused by that same guard, so the identical root cause takes away his plugin install **and** his self-armed watch. For that user the channel shim is the only path left.
>
> **Do not read "defaults to false" as a population estimate.** It is a static read of a client-side default, not the served value; both accounts we can observe had it **on** — this one, and the macOS field reporter whose host demonstrably spawned the plugin monitor (`exit 127` is host output, which requires passing the gate). The honest claim is that availability is *conditional and unobservable to us*, not that it is rare.
>
> Nothing in the decisions below changes; what changes is the claim. User-facing copy must say "where Claude Code offers a Monitor tool" rather than promising one, and **must name the channel shim — not the plugin monitor — as the fallback**, since the plugin shares the first precondition. `SKILL.md` already read "If your host offers a `Monitor` tool"; `README.md`, `CHANGELOG.md`, `doctor`, the setup wizard, `troubleshooting.md` and CLAUDE.md were corrected to match in **PR #1353**.
>
> **This risk was recorded and then written past, which is the part worth remembering.** [`connection-honesty-findings.md`](spikes/connection-honesty-findings.md) already said of the `Monitor` tool: "It is present in this one. If absent, any design keyed on A1 silently no-ops." The shipped copy was written anyway, because every measurement anyone took was taken on the one account where it works. A precondition the product cannot observe will always look satisfied from inside the room where it is satisfied. (A *session* can see whether the tool is in its list without arming — that is exactly what `SKILL.md`'s conditional does. It is the **server** that cannot know, which is why no doctor check can assert it.)

### Decision 1 — take the `ws` source, and drop session-bound arbitration entirely

The conflict as stated: `ws` is pure JSON config with no shell, therefore no `${CLAUDE_CODE_SESSION_ID}` expansion, therefore no session id — and the arbitration rule was "unbound consumers are never arbitrated," so `ws` makes arbitration a no-op. Take the shell instead and the placeholder hazard returns: an unexpanded `${…}` passes `SESSION_ID_RE` (`cli-runtime.ts:107`) and arrives looking valid while being *identical across every session*, which is worse than no identity at all.

**P4 removes the choice.** The proven `curl … | grep --line-buffered` fallback succeeded on win32 **only because git-bash is installed** — `curl` resolved to `/mingw64/bin/curl` under `MINGW64_NT`. Neither binary exists on a stock Windows install, and `Monitor`'s `command` runs in that same shell. The plan filed this as a caveat; it is a blocker. `ws` is **required**, not preferred.

That would be a real loss if arbitration were load-bearing. It is not — **it duplicates a gate that already exists one layer down, and has for as long as `checkInbox` has existed:**

- `surfacedIds` (`mcp/awareness.ts:55`) is a **module-level** map. Process-global, keyed by `documentId:itemId` — *not* by MCP session and *not* by Claude session. The first `tandem_checkInbox` to see an annotation records it; a second session's poll does not see it again.
- Chat is stronger still: `checkInbox` sets `read: true` on each message *as it collects it*, inside the same pass.

So two concurrent sessions racing to answer the same item are already arbitrated — by the inbox ledger, for every transport, with no session identity anywhere in the mechanism. A self-armed wake does not change this. N sessions wake, N call `checkInbox`, one gets the item and the rest get an empty inbox. The cost of the extra wakes is tokens, not correctness.

This also retires the "session-bound tier" idea for good rather than merely deferring it. It was already refused as **unreachable** (`buildMcpEntries` writes a direct-HTTP entry with no session header for exactly the hand-launched population this work exists for), as **unsound** (a bound-but-inert consumer is indistinguishable from a live one, so suppressing the remedy equals asserting delivery), and as a **silent-lockout primitive** (session ids are filenames in `~/.claude/projects/`). Choosing `ws` now makes it impossible as well as unwise, which is a better place to stand.

### Decision 2 — wake frames carry no payload; `?filter=wake` **strips**, it does not merely narrow

Confirmed by measurement, not inference: every notification in the P-A2 run carried the full message body — `"payload":{"messageId":"msg_…","text":"probe event 3 of 5",…}`. The plan noted `?filter=wake` narrows event *types* and does not strip payloads. It must now do both.

Three reasons, in ascending order of force:

1. **Defense in depth for Solo.** A frame with no content cannot leak content. A future regression in `shouldForwardExternally` would then cost timing, not the user's words.

2. **Duplicate replies, mechanically.** A model that answers from the notification payload never calls `checkInbox`, so the item is never marked surfaced — and is re-reported on the next wake. Note this is **coupled to Decision 1**: dropping arbitration is only safe *because* the wake carries nothing to answer from. The ledger arbitrates only if somebody actually polls, and a payload-carrying wake is precisely the thing that stops them polling. The two decisions hold each other up; changing either alone reopens the other.

3. **Wakes are lossy — MEASURED, and this is the decisive one.** The burst case (25 chat sends in ~6s) did *not* stop the watch; it rate-limited, emitting `[1 events suppressed — output rate too high]` and `[6 events suppressed — …]`. All **25/25** reached the SSE socket, and at least **7** never became notifications. The data was never lost — the pull path saw all 25 — but the wake was. A model answering from the payload answers from a view it cannot know is incomplete, and has no way to discover the gap. This is the same conclusion #1266 reached for the supervisor's stdin wake, now reached independently by a second push path from a live measurement.

**Frame shape: `id`, `type`, `timestamp`. Nothing else.** Specifically **not** `documentId` — `docIdFromPath` builds it as `<basename-slug>-<hash>`, so it is a filename in all but name; `events/push-liveness.ts`'s docblock refuses to retain one for exactly this reason, and the wake path must not reintroduce what that module deliberately dropped. `id` stays because `Last-Event-ID` resumption needs it. `type` stays because "annotation versus chat" is the one bit that helps a model pick its next tool while telling it nothing the pull path would have withheld.

### Consequences

- **Two push paths, one contract.** The supervisor's stdin wake (#1266) and the self-armed wake now agree: payload-free, pull-path-authoritative. Track D-2 asked for either a strip or a justification for divergence; this is the strip.
- **Net-new server work: a WS wake endpoint on :3479.** Hocuspocus owns :3478 and speaks the Y.js protocol, so it cannot carry this. The endpoint subscribes as `"external"` — it is a consumer outside this process, so it must sit behind the queue's Solo gate exactly as the SSE consumers do.
- **`?filter=wake` on `/api/events` stays**, as the documented Unix fallback: `curl` and `grep` *are* stock on macOS and Linux, so the shell path is fully portable there. It is Windows that forces `ws`, not every platform.
- **`isWakeWorthy` is now shared** (`events/wake-scope.ts`) rather than private to the supervisor. Three consumers must agree on the answer — the stdin wake, the SSE `?filter=wake` narrowing, and the `/api/wake` WebSocket endpoint — and a drifted second copy would not fail loudly, it would quietly report the wrong story. The delivery-state join is **not** among them, despite an earlier draft of this line saying so: it runs on `isUnansweredAsk`, which drops the accept/dismiss status flips as well as `document:*`. The two must stay apart, so widening `isWakeWorthy` does not retune `waitingMs`.
- **Not decided here:** whether the arm command lives in the MCP `instructions` field. Tandem's main server sends none today (only `src/channel/run.ts:58` does), and whether Claude Code surfaces that field to the model is **UNVERIFIED** — it could not be probed because nothing sends one. `SKILL.md` is the fallback home and needs no new mechanism.

> **Update (2026-08-11) — decided, and the UNVERIFIED above is resolved.** The host *does* surface the field: with tool search on (the default) **only tool names and server instructions load upfront**, they are truncated at 2KB, delivered once per session, and exist to "help Claude understand when to search for your tools, similar to how skills work"; a live session's context carries an "MCP Server Instructions" section rendering them verbatim. The main server now sends one (`SERVER_INSTRUCTIONS`, `src/server/mcp/server.ts`).
>
> **The arm command still does not live there** — that half of the "not decided" stands, for `wake-advisory.ts`'s reason: a second emitter of runnable commands re-opens the pattern that lets an imported Word comment imitate Tandem's own output. `instructions` points at the capability; `SKILL.md` holds the call.
>
> **What forced the decision** is PR #1393's measurement: natural first-use dispatch of the skill is **3 of 6**, and every declining trace shows `ToolSearch` *before* `tandem_status` — so at the moment the behaviour was decided the model held Tandem's tool names and an *empty* instructions string, with nothing about wake monitoring in context at all. `SKILL.md` cannot be the only home for a first-use instruction when first use is what fails to reach it.
>
> **Two consequences to carry.** (1) The text must exempt launcher-spawned sessions, because it arrives *before* any skill decision and `SKILL.md`'s "do not arm if Tandem launched you" caveat would otherwise be read too late — an unconditional instruction here double-wakes the population that already works. (2) `instructions` rides on the `initialize` result, which MCP `2026-07-28` removed, so this is now a **second** thing keyed to the legacy branch alongside `Mcp-Session-Id` — tracked in #1249 rather than left to be found by regression.
>
> **`when: "always"` stays rejected — decided by Bryan, 2026-08-11: "i dont want the monitor to always be armed."** This closes the question #1354 left open. The 3-of-6 measurement above was new input to it and did not change the answer, so the one *model-independent* arming option is off the table for good: #1354's `on-skill-invoke` trigger stands, and first-use arming remains a matter of raising the probability that the model chooses to arm (this amendment, plus the skill description) rather than removing the judgment. Do not re-propose `always` on the strength of a low dispatch rate — that argument has been made, with data, and declined.

**Cross-references:** [ADR-045](#adr-045-mcp-transport-multiplexing--one-mcpserver-per-session-keyed-by-mcp-session-id) (why neither session id is a usable key), ADR-027 (the Solo/privacy contract the strip reinforces), #1266 (the supervisor's payload-free wake), `docs/spikes/monitor-self-arm-probe.md` (P-A2, P4, and the burst measurement).

---

## ADR-050: `/api` Is Loopback-Only for Non-GET, Enforced at the Mount

**Status:** Accepted — 2026-08-08
**Context:** #1320, #1293, #1121 F6/F7, ADR-045

**Decision:** the loopback rule for `/api` is a single middleware mounted `app.use("/api", …)`, not a call each handler is expected to make. `enforceLoopbackMutation` rejects every non-loopback peer using a method other than GET/HEAD/OPTIONS, with an enumerated exemption set.

**Rationale — the shape of the rule was the bug, not any individual missing call.** Every prior gate on this surface was a call inside a handler body. Three consequences, each of which has already cost a review cycle:

1. A new route inherits nothing. Nine mutating routes were ungated by omission rather than decision, four of them taking a caller-supplied filesystem path.
2. The gate is invisible at the registration site, so `grep 'app.post'` proves nothing about coverage. That is how the contested count went 4 → 11 → 9 → 10 across three passes, each pass correcting the previous *list* instead of re-deriving.
3. Enforcement for the `/api` half was doc review over a hand-maintained obligation list. Forgetting to add to an obligation list fails **open**.

Inverting the default fixes all three at once: deny is structural, and the hand-maintained list becomes the *exemptions*, where forgetting fails closed.

**Why "non-GET" and not "mutating".** `GET /api/channel-permission` evicts TTL-expired entries, so it mutates. A rule phrased over mutation would need a per-route inventory of what counts — precisely the artifact this ADR abolishes. Method is a property of the request; mutation is a property of the handler, and only one of those is knowable at the mount.

**Why reads are exempt.** `document/raw` and `diagnostics` refuse a non-loopback caller; `info`, `sessions`, `backups`, `launcher/status`, `models` and `integrations` scrub their payload instead. Those scrubs were designed and reviewed for LAN callers, and the `resolvedLanIP` Host accommodation exists to let them work. Extending the invariant to GET would strand both. The result is now coherent rather than accidental: **LAN peers may read `/api`; their writes are refused.**

**Consequences:**

- **The carve-out set is the one hand-maintained decision left.** The `/api/channel-*` family plus `DELETE /api/chat` — the channel shim and monitor run against a non-loopback `TANDEM_URL`, which is how Cowork reaches a Tandem elsewhere. The family is carved out rather than the subset with a caller today: two members have no non-loopback caller in the tree, but picking them off would be an untested tightening of a documented transport, and a family is checkable at a glance. **Adding to this set is a security change.** It is keyed by **method and path**, because a path-only key does not mean `DELETE /api/chat` — it means every non-GET method on that path, so the obvious next route there would inherit LAN-write access with nothing in the diff able to notice. For six paths, forgetting would have failed open.
- **`/api/shutdown` is inside the invariant, not an exception to it.** It is covered like every other mutator and additionally self-gates. The distinction matters because this repo uses these enumerations as review inventories: a reader who believed it exempt could weaken the hand-rolled gate as redundant, or add a remote caller.
- **Nothing in CI exercises the shim against a non-loopback host**, and `channel/run.ts` logs a 403 to stderr and continues, so a broken carve-out surfaces only as a Cowork user reporting silence. The positive-control cases in `tests/server/api-loopback-invariant.test.ts` are the only detector — and they must be mounted, because Express strips the mount prefix (`req.path` reads `/channel-reply`, not `/api/channel-reply`) and a unit test calling the middleware directly passes green while every Cowork POST 403s.
- **`/api/wake` is outside the middleware's reach, not outside the policy.** It is a WebSocket upgrade on the `http.Server` upgrade event and carries its own Origin guard. Naming it is what keeps "`/api` is loopback-only" from becoming the next false absolute — which is the failure mode #1320 was filed about.
- **`tandem rotate-token` against a remote `TANDEM_URL` now 403s**, and that is documented usage (README, `docs/configuration.md`). Rotation runs on the host. The CLI was fixed in the same change to roll the token file back on a refusal instead of leaving the client on a credential the server will never accept — a defect that predates this decision but which this decision makes routine.
- **The 23 `assertLoopbackForMutation` call sites stay.** Redundant on the happy path is the point; and one mounted middleware is one thing to get wrong.

**Declined:** making the DNS-rebinding Host check path-wide in the same change. It is a real improvement — `createApiMiddleware` is still threaded per route, the same shape objected to here — but it carries its own OPTIONS-ordering risk and belongs in its own PR.

**Reopen condition:** a supported client that must write to `/api` from another machine. `API_BASE` in `src/client/utils/fileUpload.ts` is a hardcoded `127.0.0.1`, so no shipped client can today; that constant is the thing to change first, deliberately.

**Cross-references:** [ADR-045](#adr-045-mcp-transport-multiplexing--one-mcpserver-per-session-keyed-by-mcp-session-id), #1293 (the unconditional per-handler gate), #1121 F6/F7, #1291 (CORS denies by absence).
