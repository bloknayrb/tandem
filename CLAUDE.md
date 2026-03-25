# Tandem -- Collaborative AI-Human Document Editor

## Quick Reference
- `npm run dev:server` -- Backend: Hocuspocus on :3478 + MCP HTTP on :3479
- `npm run dev:client` -- Frontend: Vite on :5173
- `npm run dev:standalone` -- Both frontend + backend (via concurrently)
- `npm run dev` -- Alias for `vite` (frontend only)
- `npm run build:server` -- Bundle server via tsup → `dist/server/index.js`
- `npm run start:server` -- Run bundled server (`node dist/server/index.js`)
- `npm run typecheck` -- Type-check server + client without emitting
- `npm test` -- Run vitest (unit tests)
- `npm run test:e2e` -- Run Playwright E2E tests (requires server running or auto-starts via webServer)
- `npm run test:e2e:ui` -- Playwright UI mode for interactive E2E debugging

## Architecture
Three layers: Browser (Tiptap) <-> Tandem Server (Hocuspocus + MCP) <-> Claude Code

### Server (src/server/)
- `index.ts` -- Entry point, starts MCP HTTP on :3479 and Hocuspocus WebSocket on :3478 (stdio fallback via TANDEM_TRANSPORT=stdio)
- `mcp/` -- MCP tool definitions (document, annotations, navigation, awareness), `file-opener.ts` (shared file-open logic for MCP + HTTP API), `server.ts` (Express app with MCP routes + REST API)
- `yjs/` -- Y.Doc management, the authoritative document state
- `file-io/` -- FormatAdapter interface + registry (`getAdapter`), format converters (markdown, docx), `atomicWrite` helper
- `session/` -- Session persistence to %LOCALAPPDATA%\tandem\sessions\

### Client (src/client/)
- Tiptap editor with collaboration extensions
- Connects to Hocuspocus via WebSocket (@hocuspocus/provider)
- App.tsx is layout + UI state only; `useYjsSync` hook (src/client/hooks/) manages OpenTab objects (one per open document), each with its own Y.Doc + provider
- `DocListEntry` and `OpenTab` types live in `src/client/types.ts`
- DocumentTabs shows tab bar + "+" button (FileOpenDialog); tab switching passes different ydoc/provider to Editor (key-based remount)
- FileOpenDialog (src/client/components/) provides path input and drag-and-drop upload for opening files without Claude
- Annotations observed from Y.Map('annotations') on the active tab's Y.Doc
- AnnotationExtension renders highlights/comments/suggestions as ProseMirror Decorations
- AwarenessExtension renders Claude's focus paragraph + broadcasts user selection to Y.Map('userAwareness')
- SidePanel: annotation filtering (type/author/status), bulk accept/dismiss, keyboard review mode (Tab/Y/N)
- ReviewSummary overlay shown when all pending annotations are resolved

### Shared (src/shared/)
- `types.ts` -- TypeScript interfaces shared between server and client
- `constants.ts` -- Colors, annotation types, defaults, ports, `SUPPORTED_EXTENSIONS`

## Key Patterns
- All document mutations go through the server's Y.Doc
- Claude's MCP tools mutate Y.Doc directly -> changes sync to browser via Hocuspocus
- Annotations stored in Y.Map('annotations'), not in the document content
- Claude's status stored in Y.Map('awareness') key 'claude'; user's selection in Y.Map('userAwareness')
- Server logs use console.error (stdout reserved for MCP protocol in stdio mode; defense-in-depth in HTTP mode)
- Ranges use `resolveRange()` for safe targeting (not raw offsets)
- Two coordinate systems: "flat text offsets" (server side, includes heading prefixes) and "ProseMirror positions" (client side, structural). Extensions convert between them.
- Annotation ranges use Yjs RelativePosition (`relRange` field) for CRDT-anchored positions that survive concurrent edits. Flat offsets in `range` are the fallback. `refreshRange()` resolves relRange → flat offsets on read; lazily attaches relRange to annotations that lack it.
- tandem_edit rejects ranges that overlap heading markup (e.g., "## ") — target text content only
- User→Claude communication via `tandem_checkInbox` (annotation actions, responses, and chat messages) and `tandem_reply` (Claude's chat responses). Chat sidebar provides freeform conversation alongside annotation-based review. Call `tandem_checkInbox` between tasks.
- Multi-document: each open file gets a unique documentId (hash of path), used as both Map key and Hocuspocus room name. All MCP tools accept optional `documentId` param, defaulting to the active document.
- Server broadcasts `openDocuments` list via Y.Map('documentMeta') on each doc's Y.Doc. Client listens and syncs tabs.
- Files can be opened from the browser via HTTP API (`POST /api/open` for path, `POST /api/upload` for content) or via MCP `tandem_open`. Both paths converge in `file-opener.ts`. Uploaded files get synthetic `upload://` paths and are read-only (no disk path to save to).
- E2E tests use `data-testid` attributes (kebab-case, e.g. `data-testid="accept-btn"`). Key elements: annotation cards, accept/dismiss buttons, review mode button, tab items.

## Implementation Status (as of 2026-03-25)

**Done (Steps 0-6 + Phase 1 + Sprint 5):**
- [x] Step 0: Repo scaffolding, npm install, TypeScript compiles, Vite builds
- [x] Step 1: Hocuspocus on :3478, Tiptap editor with Yjs Collaboration, Y.Doc sync
- [x] Step 2: 20 MCP tools registered and functional (document, annotation, navigation, awareness)
- [x] Step 3: Annotations — server-side Y.Map storage + client-side ProseMirror Decoration rendering
- [x] Step 4: Awareness — Claude's focus paragraph, status text, user selection/typing broadcast
- [x] Step 5a: Markdown round-trip — remark-based MDAST↔Y.Doc conversion, .md load/save
- [x] Step 5b: .docx review-only mode — mammoth.js→HTML→Y.Doc, read-only guards
- [x] Step 6: Session persistence — save/resume Y.Doc + annotations across server restarts
- [x] Phase 1 - Document Groups: multi-document tabs, per-doc rooms, documentId on all tools, tab bar UI
- [x] Phase 1 - Polish: keyboard review mode (Tab/Y/N), annotation filtering, bulk accept/dismiss, review summary
- [x] Phase 1 - New tools: tandem_listDocuments, tandem_switchDocument, tandem_flag (26 total MCP tools)
- [x] Phase 1.5 - Chat Sidebar: session-scoped chat via Y.Map('chat'), tandem_reply tool, ChatPanel UI
- [x] Phase 1.5 - Edit sync fix: afterUnloadDocument hook cleans up stale Y.Doc references
- [x] Browser file open: "+" button in tab bar, path input + upload dialog, drag-and-drop on editor, HTTP API (`/api/open`, `/api/upload`)
- [x] Playwright E2E test suite: 8 tests (7 passing, 1 skipped pending decoration fix), McpTestClient helper, data-testid attrs, CI integration

**Infrastructure fixes (2026-03-20 — 2026-03-24):**
- [x] Switch browser provider from `y-websocket` → `@hocuspocus/provider` (protocol-incompatible with Hocuspocus v2)
- [x] MCP starts before Hocuspocus to beat Claude Code's initialize timeout (stdio mode only)
- [x] `freePort()` evicts stale processes on startup; uncaughtException handler survives malformed WS frames
- [x] `console.log = console.error` + `quiet: true` prevent stdout pollution of the MCP wire
- [x] Migrate MCP from stdio to Streamable HTTP transport (fixes Issue #8 — stdio disconnect)
- [x] fix(server): normalize path in `docIdFromPath` for cross-platform basename extraction (Windows backslash vs Linux)
- [x] fix(ci): add `@types/node` and split client/server tsconfigs to resolve typecheck failures
- [x] fix(ci): update OIDC permissions in claude-review workflow
- [x] fix(server): per-session MCP transport rotation so `/mcp` restart works without server restart (Issue #18)
- [x] feat(annotations): migrate ranges to Yjs RelativePosition for CRDT-anchored positions (Issue #37)
- [x] fix(session): guard afterUnloadDocument so auto-save never persists empty Y.Docs (Issue #44)
- [x] fix(session): clear stale openDocuments from ctrl session on restore, await before Hocuspocus starts (Issue #44)
- [x] feat(client): upgrade React 18 → 19 (Issue #28)
- [x] refactor(file-io): FormatAdapter interface + registry, atomicWrite helper (Issue #36, #52)
- [x] fix(session): defensive fallback when restored session yields empty doc (Issue #44)
- [x] fix(client): prevent duplicate tab creation from concurrent observer firings via pendingIdsRef (Issue #44)
- [x] feat(server): cross-platform freePort + session paths via env-paths (Issue #29)
- [x] feat(build): tsup server bundling — single-file `dist/index.js` output (Issue #32)
- [x] feat(client): browser file open UI — FileOpenDialog, HTTP API, file-opener.ts extraction (Issue #42)
- [x] test(e2e): Playwright E2E tests for annotation lifecycle — 8 tests, McpTestClient, CI integration (Issue #30)
- [x] refactor: data-testid attributes on SidePanel and DocumentTabs for E2E selectors

**Remaining — see [docs/roadmap.md](docs/roadmap.md):**
- [ ] Phase 2: Cowork integration — configurable port/URL, cross-platform sessions, MCP registration
- [ ] Phase 3: .docx comments export — Word-native `<w:comment>` elements via JSZip
- [ ] Phase 4: Distribution — launch channels, positioning, pricing
- [ ] Phase 5: Discovery sprint — CLI mode, VS Code extension, tracked changes, etc.

## Known Issues
- **MCP stdio disconnect (Issue #8):** Resolved by migrating to Streamable HTTP transport. Stdio fallback (`TANDEM_TRANSPORT=stdio`) still has this issue — use HTTP mode (default).
- **MCP session re-initialization (Issue #18):** Resolved. Transport is now rotated per session — Claude Code's `/mcp` restart works without restarting the Tandem server.
- **Y.js "Invalid access" warnings:** Harmless stderr noise during session restore. Data syncs correctly.
- **Server must be running before Claude Code connects.** HTTP transport means Claude Code doesn't auto-spawn the server. Run `npm run dev:server` first.

## Documentation
- [MCP Tool Reference](docs/mcp-tools.md) -- All 26 MCP tools + HTTP API endpoints
- [Architecture](docs/architecture.md) -- Diagrams, data flows, coordinate systems
- [Workflows](docs/workflows.md) -- Real-world usage patterns
- [Roadmap](docs/roadmap.md) -- Phase 2+ roadmap, known issues, future extensions
- [Design Decisions](docs/decisions.md) -- ADRs (001-017)
- [Lessons Learned](docs/lessons-learned.md) -- 18 lessons including E2E testing gotchas

## Gotchas (save yourself time)
- **stdout is still redirected.** Even though MCP now uses HTTP by default, `console.log`, `console.warn`, and `console.info` are ALL redirected to stderr in index.ts (defense-in-depth for stdio fallback). If you add a dependency that logs to stdout, it will corrupt the MCP wire in stdio mode.
- **Y.XmlText must be attached before populating.** Inserting formatted text into a detached Y.XmlText reverses segment order. Always attach to Y.Doc first, then insert text (two-pass pattern in mdast-ydoc.ts). See Lesson 9.
- **Y.XmlElement.setAttribute needs `as any` for numbers.** TypeScript types say string-only but Tiptap stores numeric heading levels. Cast with `as any`.
- **Start the server before connecting Claude Code.** `npm run dev:server` starts both Hocuspocus (:3478) and MCP HTTP (:3479). Claude Code connects via the `url` in `.mcp.json`. To test server changes, restart `dev:server` then `/mcp` in Claude Code. Vite hot-reloads client code automatically.
- **Hocuspocus rooms = document IDs.** The room name IS the document ID from `docIdFromPath()`. `CTRL_ROOM` (exported from `shared/constants.ts`) is reserved for the bootstrap coordination channel. Never use it as a document ID.
- **Session files live in a platform-appropriate directory** (via `env-paths`): `%LOCALAPPDATA%\tandem\sessions\` on Windows, `~/Library/Application Support/tandem/sessions/` on macOS, `~/.local/share/tandem/sessions/` on Linux. Keyed by URL-encoded file path. Delete them to force a fresh load (useful when debugging session restore issues). See `src/server/platform.ts`.
- **The `freePort()` function kills stale processes on ports 3478 and 3479 at startup.** Cross-platform: `netstat`/`taskkill` on Windows, `lsof`/`process.kill` on macOS/Linux, `ss` fallback on Linux. Intentional — clears zombie instances from crashed servers. But it means you can't run two Tandem instances simultaneously.
- **Coordinate system mismatch is the #1 source of annotation bugs.** Server uses flat text offsets (includes `## ` heading prefixes + `\n` separators). Client uses ProseMirror positions (structural, no prefixes). `flatOffsetToPmPos` and `pmPosToFlatOffset` convert between them. If annotations appear in the wrong place, check the conversion.
- **Uploaded files (`upload://` paths) are read-only.** `tandem_save` returns a session-only save for these. `sourceFileChanged()` returns false (no disk file to check). Sessions still persist normally — the synthetic path is the session key.
- **E2E tests require no running dev server.** `npm run test:e2e` starts both servers via Playwright's `webServer` config. `freePort()` will kill any existing server on :3478/:3479. Running E2E alongside `dev:server` will terminate your dev server.
- **`data-testid` naming convention:** kebab-case, descriptive. Examples: `accept-btn`, `dismiss-btn`, `review-mode-btn`, `annotation-card-{id}`, `tab-{id}`, `file-open-dialog`, `file-path-input`, `open-file-btn`.

## Security
- Server binds to 127.0.0.1 only
- DNS rebinding protection: `/mcp` routes via `createMcpExpressApp({ host })`; `/api` routes via Host-header validation in `apiMiddleware` (both reject non-localhost Host headers)
- CORS on `/api` routes reflects any `http://localhost:*` origin — no hardcoded port
- Rejects UNC paths on Windows (prevents NTLM hash leakage)
- HTTP API validates file extensions against `SUPPORTED_EXTENSIONS` (.md, .txt, .html, .htm, .docx)
- File size limit: 50MB (enforced in both `openFileByPath` via `fs.stat` and `openFileFromContent` via content length)
- Atomic file saves (write to temp, then rename)
