# Design Decisions

## ADR-001: Tiptap over ProseMirror Direct
**Decision:** Use Tiptap (React wrapper) instead of raw ProseMirror.
**Rationale:** Tiptap provides React bindings, extension system, and built-in collaboration support. Reduces boilerplate significantly.

## ADR-002: Hocuspocus for Yjs WebSocket, @hocuspocus/provider on the Client
**Decision:** Use Hocuspocus (MIT) as the Yjs WebSocket server and `@hocuspocus/provider` as the browser WebSocket provider.
**Rationale:** Same team as Tiptap. Built-in document management, persistence hooks. `@hocuspocus/provider` is required — `y-websocket` is protocol-incompatible with Hocuspocus v2, which prepends a `writeVarString(documentName)` to every message frame. `y-websocket` misreads that length byte as the outer message type, silently routing the browser to a phantom `""` document instead of `"default"`.

## ADR-003: MCP over REST for Claude Integration
**Decision:** Expose tools via MCP (HTTP, formerly stdio) instead of a custom REST API.
**Rationale:** Claude Code discovers MCP tools natively. No curl wrappers needed. Tools appear in Claude's tool list automatically. See ADR-012 for the stdio → HTTP migration.

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

## ADR-019: Channel Shim for Push Notifications (Issue #106)

**Status:** Accepted
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

## ADR-023: Cowork Plugin Bridge — stdio via npx, not HTTP (PRs #301, #304)
**Status:** Accepted
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

**Blocking issues:** #440 (`heldInSolo` schema field), #441 (`/api/info` endpoint for About panel).

**Versioning:** All code-side work targets v0.9.0 (last breaking-change window). New settings UI deferred to Svelte rebuild (v0.10.0+) per ADR-025. Only the data model + `loadSettings()` parser changes land in v0.9.0.
