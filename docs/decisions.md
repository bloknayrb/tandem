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
**Decision:** .docx files open in review-only mode. Never overwrite the original.
**Rationale:** mammoth.js import is lossy (no complex tables, tracked changes, footnotes). Review-only prevents accidental data loss.

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
**Rationale:** The stdio transport disconnects after the first `tandem_open` under Claude Code (Issue #8). Extensive investigation confirmed the bug is in Claude Code's stdio pipe management, not Tandem's server. Rather than waiting for an upstream fix, HTTP transport sidesteps the problem entirely. Uses stateful mode (`sessionIdGenerator: () => randomUUID()`) because the SDK crashes in stateless mode after the first `server.connect()`. Each `initialize` request rotates the transport (Issue #18) — the `McpServer` is long-lived but the transport is ephemeral, created fresh per session. Express (bundled with the SDK) provides DNS rebinding protection via `createMcpExpressApp()`. This also prepares for Phase 2 (Cowork integration) which needs configurable URLs.

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

**Context:** Claude Design handoff bundle audited against v0.8.0 codebase. 11 gaps found between design and implementation. Full analysis in `docs/redesign-review.md`; response prompt in `docs/claude-design-response-prompt.md`.

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
**Context:** First-principles analysis of the annotation system (see `docs/annotation-system-analysis.md`) revealed that the type-based model (highlight / comment / flag) asks users "what kind of annotation?" when the natural question is "who is this for?" Users have three intents: instruct Claude, ask Claude a question, or leave a personal note. The current system encodes these indirectly through type choice and hidden sub-fields (`suggestedText`, `directedAt`), producing five visual presentations from three types. Additionally, `directedAt: "claude"` is vestigial — only Claude can set it (PR #382 removed the user's @Claude checkbox), meaning Claude directs comments at itself. `flag` overlaps with `highlight` (both mark text without additional info).
**Decision:** Redesign around audience. Three user annotation types: `highlight` (visual marker, not sent to Claude), `note` (personal text annotation, findable but Claude doesn't act), `comment` (text annotation sent to Claude). Claude creates only comments (with optional `suggestedText` for tracked changes). Remove `flag` type, `directedAt` field, `tandem_highlight` tool, `tandem_flag` tool, `tandem_suggest` tool, and modal review mode. Notes have a "convert to comment" action. Import (Word) comments enter as notes for user triage. `checkInbox` surfaces only comments, not notes or highlights. Selection toolbar becomes a near-text popup with text input and two submit buttons ("Note to self" / "Comment") plus highlight color buttons.
**Supersedes:** Parts of ADR-022 (type unification from 5→3). ADR-022's three types were `highlight`, `comment`, `flag`; ADR-027's three are `highlight`, `note`, `comment`.
**Options considered:**
- **(a) Audience-based model (chosen):** Primary distinction is who sees the annotation. Simpler mental model — users don't choose annotation types, they choose audience.
- **(b) Mode-gated audience:** Solo mode → personal notes, tandem mode → sent to Claude. Simpler (one button) but loses the ability to leave private notes while in tandem mode. Explicit buttons give per-annotation control.
- **(c) Keep current model, remove directedAt only:** Minimal change. Doesn't address the flag/highlight overlap or the unintuitive type-based mental model.
**Rationale:** The type-based model forced users to think in annotation taxonomy rather than intent. The audience-based model maps directly to user goals: mark text (highlight), write for myself (note), write for Claude (comment). Removing flag is safe because highlight colors already carry severity semantics. Removing `directedAt` eliminates a vestigial field with no behavioral backing. Making notes convertible to comments supports a natural workflow: review alone, mark up, then selectively share with Claude.
**Consequences:** `AnnotationTypeSchema` changes from `["highlight", "comment", "flag"]` to `["highlight", "note", "comment"]`. `sanitizeAnnotation()` migrates legacy `flag` → `note` and strips `directedAt`. Side panel filters change. Tutorial annotations updated. MCP tools reduced. Claude skill updated to not act on notes. Full design in `docs/annotation-system-analysis.md`.
**Imported `.docx` comments (revised 2026-05-15, ADR-035 grilling pass):** Word reviewer comments enter as `author: "import"`, `type: "note"` — *not* `"comment"`. Rationale: imported comments are potentially third-party content (a colleague's review pass), not the active user's intent. The audience-based model already treats notes as user-private — visible to the user, surfaced via `tandem_getAnnotations`, but not auto-pushed to Claude. The user reviews each imported comment and promotes individually to `type: "comment"` (using the existing note→comment "Send to Claude" action) when they want Claude to act on it. `tandem_checkInbox` continues to ignore notes, including imports — Claude does not see imported comments without explicit user promotion. `sanitizeAnnotation` migrates legacy `author: "import", type: "comment"` records to `type: "note"` on read (emits an `import-comment-to-note` migration-log event). This reverses the earlier PR #482 / v0.9.1 revert; the original PR #474 import-as-note model was correct, and the revert traded user agency for convenience that wasn't load-bearing. The side-panel "Imported" filter (keyed off `author: "import"`) continues to work for both pre- and post-migration records.
**Target version:** v0.9.0 (data model + tool consolidation, PR #474); UI redesign (selection toolbar, convert-to-comment) deferred to v0.10.0 Svelte migration.

## ADR-028: Plugin Monitor URL and Auth Resolution — `userConfig` over Hardcoded Default

**Status:** Proposed
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

## ADR-029: Action Registry and Command Palette

**Status:** Accepted
**Context:** Tandem had ~10 ad-hoc `window.addEventListener("keydown")` callsites scattered across `App.svelte`, `useSaveShortcut.svelte.ts`, and `useSettingsShortcut.svelte.ts`. The Settings → Shortcuts tab rendered a hardcoded `SHORTCUT_SECTIONS` array that rotted as shortcuts were added or changed. A command palette (Wave 2 redesign, #571) needed a shared list of actions to display and invoke.
**Decision:** Introduce a central action registry (`src/client/actions/registry.ts`). Actions are identified by a stable string `id` with a literal `group` discriminator (`"editor" | "navigation" | "view" | "document"`). The `shortcut` field is display-only; binding is the caller's responsibility. `run()` is a zero-arg closure that captures dependencies at registration time — no shared `ctx` parameter, which would require all callers to assemble an ever-growing context object. Builtins (`src/client/actions/builtin.ts`) register at module import time (so the Shortcuts tab has content on first paint) but lazily resolve deps via getters wired by App.svelte — avoiding circular imports and premature initialization. The Settings → Shortcuts tab derives its content from the registry; the hardcoded `SHORTCUT_SECTIONS` is removed. Ctrl+S and Ctrl+, are migrated from dedicated Svelte hook files into App.svelte's global keydown handler; the hook files are deleted.
**Collision policy:** `registerAction` with a duplicate id warns in production and throws in dev (surfacing the bug at the source). Pass `{ replace: true }` to update an existing entry intentionally (e.g., OutlinePanel re-registering heading-jump actions).
**Non-goals:** This ADR does not define a binding-from-string mechanism (shortcut strings are display-only in Wave 2). Full migration of all ad-hoc keydown listeners is deferred; only Save and Settings migrate in this PR. Heading-jump actions (one per H1-H3) will be registered by OutlinePanel when PR 569 merges and the action registry is available.
**Consequences:** All future shortcuts should register via the registry before adding a hardcoded `SHORTCUT_SECTIONS` entry. The Settings → Shortcuts tab now reflects the live registry state; an empty registry on first paint is a dev bug (builtins are registered at import, so this should not occur in practice).

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

**Status:** Accepted (implementation pending — grilling pass under `/improve-codebase-architecture`, 2026-05-15)

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
  - **Server metadata broadcasts on CTRL_ROOM** — `broadcastOpenDocs`, `Y_MAP_GENERATION_ID`, `Y_MAP_STORE_READ_ONLY` writes in `src/server/mcp/document-service.ts`. These are server-internal state announcements. Today they are tagged `MCP_ORIGIN` only because every observer that would care happens to skip MCP — a behaviour-by-coincidence pattern. `withInternal` makes the intent explicit and survives future observer changes.
- `withReload(doc, fn)` — file-watcher reload path (the `reloadFromDisk` flow): channel skips the event (not a user action) but durable-sync *must* persist (we want the re-anchored relRanges saved). Added after the CRDT-reviewer agent flagged that `reloadFromDisk` couldn't be classified under the original four-origin set without regressing #622 or producing a labelling lie. The post-reload annotation-refresh step (`refreshAllRanges` + position relocation, currently the second transact in `reloadFromDisk`) is also `withReload` — it is a continuation of the same logical operation, not a separate user-intent write.
- `withBrowser(doc, fn)` — user edits originating in the browser. Sets origin `"browser"`. No listener filters on it today, but the explicit label preserves the universal rule and gives future listeners a value to read.

Skip-set matrix:

| Origin     | Channel event queue | Durable-sync observer | Tombstone observer |
|------------|---------------------|-----------------------|--------------------|
| `mcp`      | skip                | persist               | record             |
| `file-sync`| skip                | skip                  | **skip**           |
| `internal` | skip                | skip                  | skip               |
| `reload`   | skip                | **persist**           | record             |
| `browser`  | emit                | persist               | record             |

The tombstone observer's `file-sync` skip is load-bearing: file-opener's eviction-and-reopen path (clear under `file-sync`, repopulate from disk) must not tombstone the cleared annotations or they would not reappear after the reopen. Same for `internal` (population writes are not real deletes even when overwriting prior state).

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

**Status:** Accepted (implementation pending — grilling pass under `/improve-codebase-architecture`, 2026-05-15). Continuation of ADR-018.

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

**Status:** Accepted (implementation pending — grilling pass under `/improve-codebase-architecture`, 2026-05-15)

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

**Status:** Accepted (implementation pending — grilling pass under `/improve-codebase-architecture`, 2026-05-15). Pairs with ADR-033.

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

**Status:** Accepted (implementation pending — grilling pass under `/improve-codebase-architecture`, 2026-05-15). Builds on ADR-027 (audience model), ADR-031 (origin tagging), and ADR-032 (tagged result variants).

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

**Status:** Accepted (implementation pending — grilling pass under `/improve-codebase-architecture`, 2026-05-15). Sharpens encoding of ADR-004 (.docx review-only) and unblocks issue #576 (.docx write-back).

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

**Status:** Accepted (implementation pending — grilling pass under `/improve-codebase-architecture`, 2026-05-15).

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

**Context:** Tandem started Claude-integrated because Claude Code was the MCP-capable client we built against. The integration contract — exposed via `src/server/mcp/`, the 26 MCP tools, and the channel API at `src/channel/` — is **MCP**, not Claude. But the docs, the marketing copy, several in-app surfaces (the Tauri "Claude Not Found" dialog, `sample/welcome.md`, the OnboardingTutorial, the EmptyState), the MCP tool descriptions (sent to *every* connecting MCP client during tool discovery), `package.json`'s npm-published description, and the `.claude-plugin/marketplace.json` install blurb all read as if Claude is the only possible integration. This conflicts with the multi-provider scope already locked in D4 (roadmap.md:462) — the v1.0 first-run wizard ships with a multi-provider model registry covering Anthropic + local LLM + OpenAI + Gemini — and with the top distribution risk recorded in `docs/positioning.md:75-77` ("Tandem currently requires Claude Code, which gates the audience to developers and technical users").

This ADR records the policy that resolves the gap: Tandem is an MCP-first product; Claude is the default, deepest-supported integration; other MCP-capable clients are best-effort over the same MCP endpoint.

**Decision §1 — canonical policy statement.** Every doc surface that states the policy quotes the following paragraphs verbatim:

> Tandem's integration contract is **MCP**. The default integration is **Claude** (Claude Code + Claude Desktop) — it's what we recommend, what we test against, and it ships with the channel push, cowork, plugin monitor, and auto-launcher features. Any MCP-capable client can connect to the same MCP HTTP endpoint and use the same 26 tools, but the Claude-specific transports don't apply. Other clients are **best-effort, MCP-contract-compatible, not validated** today.
>
> **Integration setup** runs through the integration setup wizard (#477 PR 3). Today's transitional behavior — Tandem auto-writing its MCP entry to Claude's config files on Tauri startup — is **deprecated when the wizard ships**. Going forward, every integration (Claude included) is configured via the wizard, never silently.

Four terms have precise meanings; every doc surface uses them consistently:

| Term | Meaning |
|---|---|
| **MCP contract** | The 26 MCP tools at `http://127.0.0.1:3479` and the SSE event stream at `/api/events`. Available to every MCP client. |
| **Default integration** | Claude. Recommended in all install flows. Documented, tested, and the target of the first-run wizard's one-click setup. |
| **Claude-specific extras** | Six features built on top of the MCP contract that only work with Claude today: (1) channel push (channel shim + plugin monitor), (2) `--dangerously-load-development-channels` flag wiring, (3) auto-launcher (#477 PR 4), (4) Cowork plugin bridge (`tandem mcp-stdio`), (5) Claude Code skill (`skills/tandem/SKILL.md`), (6) plugin marketplace artifacts (`.claude-plugin/`). |
| **Best-effort, not validated** | What we say about other MCP clients today. We don't intentionally break them; we don't test them. The MCP HTTP endpoint is the same surface they all use. |

**Claude-side dev tooling** (`CLAUDE.md`, `.claude/hooks/`, `.claude/agents/`, `.claude/skills/`) is contributor-facing automation for working ON Tandem — not user-facing integration. It is listed separately from "Claude-specific extras" to avoid conflation.

**Decision §2 — auto-launch policy.** In v1.0, only Claude Code is auto-launched (#477 PR 4). Other entries in the multi-provider model registry (#477 PR 5) are recorded for configuration purposes but require user-driven startup. The wizard surfaces this asymmetry explicitly so users picking OpenAI / Gemini / a local LLM are not surprised that they have to launch the client themselves. Per-provider auto-launchers may be added in future ADRs.

**Decision §2b — auto-configuration deprecation.** Today's silent configuration-writing behavior is deprecated. Two surfaces are affected:
- (a) The Tauri-startup auto-write of Tandem's MCP entry to Claude's config files in `src-tauri/src/lib.rs`.
- (b) The `tandem setup` CLI command in `src/cli/setup.ts`, which writes the same entries from the npm install path.

Both are silent from the user's perspective today; both end when the integration setup wizard (#477 PR 3) ships. Replacements: the Tauri-startup behavior is replaced by first-run-wizard invocation; `tandem setup` becomes a TTY-mode wrapper that prompts for the same answers the GUI wizard collects. Auto-configuration code is removed in the same PR that lands the wizard. Until then, the existing behaviors continue to ship; users see a one-time toast on first launch after upgrade to v0.13.0+ announcing the upcoming change.

**Auto-launch (§2) is unaffected by §2b.** §2 governs whether Tandem *spawns* the AI client at session start; §2b governs whether Tandem *writes its MCP entry to the AI client's config file* silently. The two are independent: auto-launch survives because it's the user-invoked Tandem app spawning a child process; auto-config dies because it's Tandem writing to another app's config without explicit consent. When the wizard ships and a user picks Claude, auto-launch still spawns Claude Code per the auto-launcher design.

**§2b implementation status (PR #773 / #477 PR 3c-ii-b):** the wizard now separates **intent** (`POST /api/integrations` persists `integrations.json` — the user's stated configuration) from **side-effect** (`POST /api/integrations/apply` writes Claude's MCP entry to the detected config files). Both transitions enforce a layered security gate before any filesystem write: origin allowlist (CSRF), constant-time confirmation-nonce comparison (replay protection), LAN-fail-closed on every mutating route (the `TANDEM_ALLOW_UNAUTHENTICATED_LAN=1` opt-in does **not** relax this), in-process apply mutex (concurrent applies → 429), `homeOverride` body-field rejection, `assertPathSafe` symlink/realpath validation, and `IntegrationsFileSchema.safeParse` defense-in-depth at apply time. The response shape never echoes `entries`, `headers`, `env`, or any token-bearing field — only `{ id, status, code?, message? }` per integration. PR 3c-ii-c follows: deletes `/api/setup`, removes `run_setup()`, and rewrites `tandem setup` as non-interactive `tandem setup --apply`.

**Decision §3 — MCP and non-MCP providers.** MCP is the contract for *native* integrations. The multi-provider model registry (#477 PR 5) may include providers that don't speak MCP natively (OpenAI, Gemini); they integrate via Tandem's Agent SDK adapter (a future PR, likely ADR-039), not as direct MCP clients. Adapter-shim integrations are second-tier — the MCP contract is the canonical interface and the one that gets new tool surface first.

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

**Cross-references:** ADR-003 (MCP over REST), ADR-019 (Channel Shim — channel push transport), ADR-023 (Cowork Plugin Bridge — Cowork extra), ADR-024 (`bearer_methods_supported` — Claude Code empirical findings), ADR-027 (Annotation System Redesign — `author: "claude"` constant), ADR-028 (Plugin Monitor URL/Auth). Spike reports: `docs/spikes/plugin-monitor-viability-spike.md`, `docs/spikes/cli-session-resume-spike.md`, `docs/spikes/sidecar-launcher-spike.md`. Roadmap: `docs/roadmap.md` #477 + D4.
