# Tandem -- Collaborative AI-Human Document Editor

## Quick Reference
- `npm run dev:server` -- Backend: Hocuspocus on :3478 + MCP HTTP on :3479
- `npm run dev:client` -- Frontend: Vite on :5173
- `npm run dev:standalone` -- Both frontend + backend (via concurrently)
- `npm run dev` -- Alias for `vite` (frontend only)
- `npm run build:server` -- Bundle server via tsup → `dist/server/index.js`
- `npm run start:server` -- Run bundled server (`node dist/server/index.js`)
- `npm run typecheck` -- Type-check server + client without emitting
- `npm run doctor` -- Diagnose setup issues (Node version, .mcp.json, server health, ports)
- `npm test` -- Run vitest (unit tests)
- `npm run test:e2e` -- Run Playwright E2E tests (requires server running or auto-starts via webServer)
- `npm run test:e2e:ui` -- Playwright UI mode for interactive E2E debugging

## Architecture
Three layers: Browser (Tiptap) <-> Tandem Server (Hocuspocus + MCP) <-> Claude Code

### Server (src/server/)
- `index.ts` -- Entry point, starts MCP HTTP on :3479 and Hocuspocus WebSocket on :3478 (stdio fallback via TANDEM_TRANSPORT=stdio)
- `positions.ts` -- Unified position/coordinate module: `validateRange`, `anchoredRange`, `resolveToElement`, `refreshRange`, `flatOffsetToRelPos`/`relPosToFlatOffset`
- `notifications.ts` -- Toast notification system: ring buffer of `NotificationPayload` objects, `pushNotification()` + `subscribe()`/`unsubscribe()` for SSE consumers
- `mcp/` -- MCP tool definitions (document, annotations, navigation, awareness), `file-opener.ts` (shared file-open logic for MCP + HTTP API), `document-service.ts` (shared document lifecycle helpers: `closeDocumentById`), `server.ts` (MCP transport + Express composition), `api-routes.ts` (REST API: `/api/open`, `/api/upload`, `/api/close`, `GET /api/notify-stream`), `channel-routes.ts` (channel endpoints: `/api/channel-*`, `/api/events`, `/api/launch-claude`), `launcher.ts` (Claude Code spawner)
- `events/` -- Channel event infrastructure: `types.ts` (TandemEvent definitions), `queue.ts` (Y.Map observers + circular buffer), `sse.ts` (SSE endpoint handler)
- `yjs/` -- Y.Doc management, the authoritative document state
- `file-io/` -- FormatAdapter interface + registry (`getAdapter`), format converters (markdown, docx, docx-html, docx-comments), `atomicWrite` helper
- `platform.ts` -- Cross-platform helpers: `sessionDir()`, `freePort()`, `waitForPort()` (TCP port availability polling)
- `session/` -- Session persistence to %LOCALAPPDATA%\tandem\sessions\; `listSessionFilePaths()` for startup auto-restore

### Channel Shim (src/channel/)
- `index.ts` -- Standalone stdio MCP server spawned by Claude Code as a channel subprocess. Low-level `Server` class (not `McpServer`). Declares `claude/channel` + `claude/channel/permission` capabilities. Exposes `tandem_reply` tool.
- `event-bridge.ts` -- SSE client that connects to `GET /api/events` on the Tandem server, parses events, pushes `notifications/claude/channel` to Claude Code, and posts awareness updates back.

### Client (src/client/)
- `positions.ts` -- Unified client position module: `annotationToPmRange` (with `method` diagnostic), `pmSelectionToFlat`, `flatOffsetToPmPos`/`pmPosToFlatOffset`
- Tiptap editor with collaboration extensions
- Connects to Hocuspocus via WebSocket (@hocuspocus/provider)
- App.tsx is layout + UI state only; `useYjsSync` hook (src/client/hooks/) manages OpenTab objects (one per open document), each with its own Y.Doc + provider
- `DocListEntry` and `OpenTab` types live in `src/client/types.ts`
- DocumentTabs shows tab bar + "+" button (FileOpenDialog); tab switching passes different ydoc/provider to Editor (key-based remount). Overflow tabs scroll horizontally with arrow buttons. Tabs support HTML5 drag-and-drop reorder and Alt+Left/Right keyboard reorder. Long filenames are ellipsized with a tooltip showing the full name. `useTabOrder` hook manages persistent tab ordering.
- ToastContainer (src/client/components/) renders toast notifications from `GET /api/notify-stream` SSE endpoint. Type-differentiated auto-dismiss (error 8s, warning 6s, info 4s), dedup with count badge, max 5 visible. `useNotifications` hook manages EventSource connection.
- OnboardingTutorial (src/client/components/) floating card at bottom-left, 3-step progression (review → ask → edit). `useTutorial` hook detects step completion via annotation status, user annotation creation, and editor focus. localStorage persistence, suppressed after completion.
- FileOpenDialog (src/client/components/) provides path input and drag-and-drop upload for opening files without Claude
- HelpModal (src/client/components/) shows keyboard shortcuts reference, toggled by `?` (suppressed in text inputs)
- Annotations observed from Y.Map('annotations') on the active tab's Y.Doc
- AnnotationExtension renders highlights/comments/suggestions as ProseMirror Decorations
- AwarenessExtension renders Claude's focus paragraph + broadcasts user selection to Y.Map('userAwareness')
- SidePanel: annotation filtering (type/author/status, including "Imported" filter for Word comments), bulk accept/dismiss (with confirmation, respects active filters), keyboard review mode (Tab/Y/N/Z), 10-second undo window on accept/dismiss, inline annotation editing (pencil button on pending annotations)
- ChatPanel + SidePanel are both always mounted (CSS display toggle, not conditional rendering) so local state (filters, scroll position) persists across panel switches
- ChatPanel shows Claude typing indicator (animated dots + status text) when `claudeActive` is true
- StatusBar: connection status (three-state: connected/connecting/disconnected with reconnect attempt count + elapsed time), Claude activity, interruption mode selector (All/Urgent/Paused). Prolonged disconnect (>30s) shows a dismissible banner that auto-clears on reconnect. Urgent-only mode shows flags, questions, and explicitly `priority: 'urgent'` annotations; hides comments, highlights, and suggestions. Client broadcasts `interruptionMode` to Y.Map('userAwareness').
- ReviewSummary overlay shown when all pending annotations are resolved

### Shared (src/shared/)
- `types.ts` -- TypeScript interfaces shared between server and client (includes `editedAt` on Annotation, `ConnectionStatus` enum, `NotificationPayload`)
- `constants.ts` -- Colors, annotation types, defaults, ports, `SUPPORTED_EXTENSIONS`
- `offsets.ts` -- Flat-text format contract: `headingPrefixLength`, `FLAT_SEPARATOR`
- `positions/` -- Shared position types: `RangeValidation`, `AnchoredRangeResult`, `PmRangeResult`, `ElementPosition`

## Key Patterns
- All document mutations go through the server's Y.Doc
- Claude's MCP tools mutate Y.Doc directly -> changes sync to browser via Hocuspocus
- Annotations stored in Y.Map('annotations'), not in the document content. Y.Map key strings are centralized in `shared/constants.ts` (`Y_MAP_ANNOTATIONS`, `Y_MAP_AWARENESS`, etc.) — never use raw string literals for Y.Map keys. Annotation `author` field is `"user" | "claude" | "import"` — the `"import"` author is used for Word comments extracted from .docx files.
- Claude's status stored in Y.Map('awareness') key 'claude'; user's selection and `interruptionMode` in Y.Map('userAwareness'). `tandem_status` and `tandem_checkInbox` include the user's current `interruptionMode` in their response so Claude can adapt behavior.
- Server logs use console.error (stdout reserved for MCP protocol in stdio mode; defense-in-depth in HTTP mode)
- Ranges use `validateRange()` and `anchoredRange()` for safe targeting (not raw offsets)
- Three coordinate systems unified in position modules: "flat text offsets" (server, includes heading prefixes), "ProseMirror positions" (client, structural), and "Yjs RelativePositions" (CRDT-anchored, survive edits). Server logic in `src/server/positions.ts`, client logic in `src/client/positions.ts`, shared types in `src/shared/positions/`.
- Annotation ranges use Yjs RelativePosition (`relRange` field) for CRDT-anchored positions. `anchoredRange()` creates both flat + rel in one call. `refreshRange()` resolves relRange → flat offsets on read; lazily attaches relRange to annotations that lack it. `annotationToPmRange()` resolves to PM positions with a `method` diagnostic ('rel' | 'flat').
- tandem_edit rejects ranges that overlap heading markup (e.g., "## ") — target text content only
- User→Claude communication via `tandem_checkInbox` (annotation actions, responses, and chat messages) and `tandem_reply` (Claude's chat responses). Chat sidebar provides freeform conversation alongside annotation-based review. Call `tandem_checkInbox` between tasks.
- **Channel push (Issue #106):** The Tandem channel shim (`src/channel/`) pushes real-time events to Claude Code via `notifications/claude/channel`, replacing polling. Y.Map observers in `events/queue.ts` detect browser-originated changes (origin !== 'mcp') and stream them via SSE to the shim. All MCP-initiated Y.Map writes are tagged with `doc.transact(() => { ... }, 'mcp')` to prevent echo. The channel coexists with the HTTP MCP server — Claude Code has both connections simultaneously.
- **Channel API endpoints:** `GET /api/events` (SSE stream), `POST /api/channel-awareness` (shim→StatusBar), `POST /api/channel-error`, `POST /api/channel-reply`, `POST /api/channel-permission`, `POST /api/channel-permission-verdict`, `POST /api/launch-claude`.
- **Toast notifications use SSE, not Y.Map.** Ephemeral notifications (annotation range failures, save errors) are pushed via `GET /api/notify-stream` SSE endpoint from `src/server/notifications.ts`. This avoids polluting the CRDT with transient data that doesn't need conflict resolution or persistence. The browser's `useNotifications` hook connects via EventSource.
- Multi-document: each open file gets a unique documentId (hash of path), used as both Map key and Hocuspocus room name. All MCP tools accept optional `documentId` param, defaulting to the active document.
- Server broadcasts `openDocuments` list via Y.Map('documentMeta') on each doc's Y.Doc. Client listens and syncs tabs.
- Files can be opened from the browser via HTTP API (`POST /api/open` for path, `POST /api/upload` for content) or via MCP `tandem_open`. Both paths converge in `file-opener.ts`. Documents can be closed from the browser via `POST /api/close` or via MCP `tandem_close`; both use `closeDocumentById()` in `document-service.ts`. Uploaded files get synthetic `upload://` paths and are read-only (no disk path to save to).
- `tandem_getTextContent` always uses `extractText()` (flat text format with heading prefixes) regardless of file format. It does NOT use `extractMarkdown()` for .md files. This ensures offsets returned by `tandem_getTextContent` match the annotation coordinate system exactly.
- E2E tests use `data-testid` attributes (kebab-case, e.g. `data-testid="accept-btn"`). Key elements: annotation cards, accept/dismiss buttons, review mode button, tab items, edit button.

## Implementation Status (as of 2026-03-31)

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
- [x] Phase 1 - New tools: tandem_listDocuments, tandem_switchDocument, tandem_flag
- [x] Phase 1.5 - Chat Sidebar: session-scoped chat via Y.Map('chat'), tandem_reply tool, ChatPanel UI
- [x] Phase 1.5 - Edit sync fix: afterUnloadDocument hook cleans up stale Y.Doc references
- [x] Browser file open: "+" button in tab bar, path input + upload dialog, drag-and-drop on editor, HTTP API (`/api/open`, `/api/upload`)
- [x] Playwright E2E test suite: 13+ tests, McpTestClient helper, data-testid attrs, CI integration

**Infrastructure fixes (2026-03-20 — 2026-03-24):**
- [x] Switch browser provider from `y-websocket` → `@hocuspocus/provider` (protocol-incompatible with Hocuspocus v2)
- [x] MCP starts before Hocuspocus to beat Claude Code's initialize timeout (stdio mode only)
- [x] `freePort()` evicts stale processes on startup; narrowed uncaughtException handler for known WS errors
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
- [x] refactor: unify position/coordinate system into deep modules (Issue #68)

**Done (Channel push — Issue #106):**
- [x] Claude Code Channel (Issue #106): channel shim (`src/channel/`), SSE event bridge, origin-tagged Y.Map writes (10 callsites across 6 files), permission relay, Claude launcher, awareness endpoints, 8 event types, two tsup bundles
- [x] Channel review fixes: ref-counted dedup, error handling across pipeline (subscriber dispatch, SSE write, MCP notification, permission relay), HTTP status checks, separated JSON parse vs transport errors, launcher cleanup, doc fixes, 35 new tests (676 total)
- [x] feat(server): force-reload open documents from disk via `force` param on `tandem_open` / `POST /api/open` (Issue #128, 684 tests)

**Done (Stability + Features — 2026-03-30):**
- [x] fix(server): replace fixed sleep with port availability polling via `waitForPort()` in `platform.ts` (Issue #117)
- [x] fix(e2e): stabilize flaky tab switching test using `tandem_switchDocument` + `data-active` selector (Issue #116)
- [x] feat(server): auto-reopen documents on server restart via `listSessionFilePaths()` + `restoreOpenDocuments()` (Issue #102)
- [x] feat(ui): undo accept/dismiss on annotations — 10s undo window, "Undo" link, Z key in review mode, atomic suggestion revert (Issue #88)
- [x] feat(mcp): expose `interruptionMode` to Claude via `tandem_status` and `tandem_checkInbox` responses (Issue #98)
- [x] feat(file-io): import Word comments (`<w:comment>`) as Tandem annotations on .docx open, `author: "import"`, "Imported" filter (Issue #85)

**Done (UI polish — 2026-03-29):**
- [x] feat(client): Claude typing indicator in ChatPanel — animated dots + status text (Issue #90)
- [x] feat(client): bulk accept/dismiss confirmation — inline confirm step, respects active filters (Issue #95)
- [x] fix(client): persist annotation filters across panel toggle — CSS display toggling (Issue #94)

**Done (UX + Annotation Editing — 2026-03-30):**
- [x] feat(ui): tab overflow scroll, drag-and-drop reorder, Alt+Left/Right keyboard reorder, filename ellipsis with tooltip, useTabOrder hook (Issue #99, 19 new tests + 5 E2E)
- [x] feat(ui): toast notifications via SSE — `notifications.ts` ring buffer, `GET /api/notify-stream`, `useNotifications` hook, `ToastContainer`, type-differentiated auto-dismiss, dedup with count badge (Issue #101, 7 new tests)
- [x] feat(ui): connection error messages — three-state ConnectionStatus, reconnect attempt count + elapsed time in StatusBar, 30s prolonged disconnect banner (Issue #105)
- [x] feat(ui): inline annotation editing — pencil button, two textareas for suggestions, `tandem_editAnnotation` MCP tool (27 total), `editedAt` timestamp, "(edited)" indicator (Issue #97, 9 new tests)
- [x] feat(ui): onboarding tutorial — `injectTutorialAnnotations` (3 pre-placed on welcome.md), `useTutorial` hook (3-step progression), `OnboardingTutorial` floating card, localStorage persistence (Issue #86)

**Done (Bug fixes — 2026-03-31):**
- [x] fix(ui): closing a tab now actually closes the document — `closeDocumentById()` shared helper in `document-service.ts`, `POST /api/close` endpoint, client `handleTabClose` calls HTTP API with optimistic adjacent-tab selection, close button debounced via `closingIdsRef` (Issue #149, 765 tests)
- [x] fix(server): `tandem_getTextContent` uses `extractText()` instead of `extractMarkdown()` for .md files — fixes offset drift after blockquotes that broke annotation coordinate consistency (Issue #148, 765 tests)

**Remaining — see [docs/roadmap.md](docs/roadmap.md):**
- [ ] Phase 2: Cowork integration — configurable port/URL, cross-platform sessions, MCP registration
- [ ] Phase 3: .docx comments export — Word-native `<w:comment>` export via JSZip (import done, export remaining)
- [ ] Phase 4: Distribution — launch channels, positioning, pricing
- [ ] Phase 5: Discovery sprint — CLI mode, VS Code extension, tracked changes, etc.

## Known Issues
- **MCP stdio disconnect (Issue #8):** Resolved by migrating to Streamable HTTP transport. Stdio fallback (`TANDEM_TRANSPORT=stdio`) still has this issue — use HTTP mode (default).
- **MCP session re-initialization (Issue #18):** Resolved. Transport is now rotated per session — Claude Code's `/mcp` restart works without restarting the Tandem server.
- **Y.js "Invalid access" warnings:** Harmless stderr noise during session restore. Data syncs correctly.
- **Exception handler is narrowed, not blanket.** `uncaughtException` and `unhandledRejection` handlers in `index.ts` only swallow known Hocuspocus/ws protocol errors (via `isKnownHocuspocusError` in `error-filter.ts`). Unknown errors log full details and call `process.exit(1)`. If the server starts crashing on a new Hocuspocus error pattern, add the pattern to the discriminator.
- **Server must be running before Claude Code connects.** HTTP transport means Claude Code doesn't auto-spawn the server. Run `npm run dev:standalone` (or `npm run dev:server`) first. Port availability is verified via `waitForPort()` polling (no more fixed-sleep race conditions).

## Documentation
- [MCP Tool Reference](docs/mcp-tools.md) -- All 27 MCP tools + channel API endpoints
- [Architecture](docs/architecture.md) -- Diagrams, data flows, coordinate systems
- [Workflows](docs/workflows.md) -- Real-world usage patterns
- [Roadmap](docs/roadmap.md) -- Phase 2+ roadmap, known issues, future extensions
- [Design Decisions](docs/decisions.md) -- ADRs (001-021)
- [Lessons Learned](docs/lessons-learned.md) -- 31 lessons including E2E testing gotchas

## Gotchas (save yourself time)
- **stdout is still redirected.** Even though MCP now uses HTTP by default, `console.log`, `console.warn`, and `console.info` are ALL redirected to stderr in index.ts (defense-in-depth for stdio fallback). If you add a dependency that logs to stdout, it will corrupt the MCP wire in stdio mode.
- **Y.XmlText must be attached before populating.** Inserting formatted text into a detached Y.XmlText reverses segment order. Always attach to Y.Doc first, then insert text (two-pass pattern in mdast-ydoc.ts). See Lesson 9.
- **Y.XmlElement.setAttribute needs `as any` for numbers.** TypeScript types say string-only but Tiptap stores numeric heading levels. Cast with `as any`.
- **Start the server before connecting Claude Code.** `npm run dev:server` starts both Hocuspocus (:3478) and MCP HTTP (:3479). Claude Code connects via the `url` in `.mcp.json`. To test server changes, restart `dev:server` then `/mcp` in Claude Code. Vite hot-reloads client code automatically.
- **Hocuspocus rooms = document IDs.** The room name IS the document ID from `docIdFromPath()`. `CTRL_ROOM` (exported from `shared/constants.ts`) is reserved for the bootstrap coordination channel. Never use it as a document ID.
- **Session files live in a platform-appropriate directory** (via `env-paths`): `%LOCALAPPDATA%\tandem\Data\sessions\` on Windows, `~/Library/Application Support/tandem/sessions/` on macOS, `~/.local/share/tandem/sessions/` on Linux. Note the `Data` subdirectory on Windows — `env-paths` adds it. Keyed by URL-encoded file path. Delete them to force a fresh load (useful when debugging session restore issues). See `src/server/platform.ts`.
- **Stale browser tabs merge old CRDT state back.** If you change a file on disk and restart the server, an already-open browser tab will sync its old Y.Doc state back on WebSocket reconnect, reverting your changes. Use `force: true` to reload cleanly (see next), or close all Tandem tabs before restarting.
- **Force-reload clears everything.** `tandem_open` with `force: true` reloads from disk, but also clears annotations, awareness, and session state. Don't use it mid-review — wait for Claude to finish active edits first.
- **Auto-open `sample/welcome.md`** on first run (no restored session). Set `TANDEM_NO_SAMPLE=1` to disable. Uses `openFileByPath` from `file-opener.ts`.
- **`APP_VERSION` is read from `package.json`** via `createRequire` in `src/server/mcp/server.ts`. Used in MCP server name, `/health` response, and startup banner. Don't hardcode version strings.
- **The `freePort()` function kills stale processes on ports 3478 and 3479 at startup.** Cross-platform: `netstat`/`taskkill` on Windows, `lsof`/`process.kill` on macOS/Linux, `ss` fallback on Linux. Intentional — clears zombie instances from crashed servers. But it means you can't run two Tandem instances simultaneously.
- **Coordinate system conversion is centralized in position modules.** Server uses flat text offsets (includes `## ` heading prefixes + `\n` separators). Client uses ProseMirror positions (structural, no prefixes). All conversions go through `src/server/positions.ts` (server) and `src/client/positions.ts` (client). If annotations appear in the wrong place, check `annotationToPmRange`'s `method` field to see which path resolved.
- **CRDT fallback logging.** `buildDecorations()` emits `console.warn('[annotation] relRange-equipped annotation <id> fell back to flat offsets')` when an annotation has `relRange` but resolved via flat offsets. Check the browser console for these — they indicate CRDT degradation (e.g., mid-sync or after content mismatch).
- **Uploaded files (`upload://` paths) are read-only.** `tandem_save` returns a session-only save for these. `sourceFileChanged()` returns false (no disk file to check). Sessions still persist normally — the synthetic path is the session key.
- **E2E tests require no running dev server.** `npm run test:e2e` starts both servers via Playwright's `webServer` config. `freePort()` will kill any existing server on :3478/:3479. Running E2E alongside `dev:server` will terminate your dev server.
- **`data-testid` naming convention:** kebab-case, descriptive. Examples: `accept-btn`, `dismiss-btn`, `edit-btn`, `review-mode-btn`, `annotation-card-{id}`, `tab-{id}`, `file-open-dialog`, `file-path-input`, `open-file-btn`, `toast-container`.
- **MCP Y.Map writes must be origin-tagged.** All server-side writes to observed Y.Maps (`annotations`, `chat`, `userAwareness`, `documentMeta`) must use `doc.transact(() => { ... }, 'mcp')`. This prevents the event queue from emitting echo events when Claude's own tool calls modify Y.Maps. If you add a new MCP tool that writes to any Y.Map, tag it.
- **Channel meta keys use underscores only.** The Channels API silently drops meta keys containing hyphens. Use `document_id`, `annotation_id`, `event_type` — not `document-id`.
- **Channel shim uses low-level `Server`, not `McpServer`.** The Channels spec requires `import { Server } from '@modelcontextprotocol/sdk/server/index.js'` with explicit `setRequestHandler()` calls. The existing HTTP MCP server uses the high-level `McpServer` wrapper. These are separate processes with different SDK classes.
- **Word comment offsets need re-anchoring.** `.docx` comment ranges reference the original HTML-converted content. After Y.Doc population, the flat text offsets may drift from heading prefix insertion. `docx-comments.ts` re-resolves ranges via `anchoredRange()` to create CRDT-anchored positions. If imported annotations appear misplaced, check the comment's `w:commentRangeStart`/`w:commentRangeEnd` alignment.
- **Undo timer cleanup on unmount.** The 10-second undo window for accept/dismiss uses `setTimeout`. All pending timers are cleared on component unmount to prevent state updates on unmounted components. The Z key in review mode undoes the most recent resolution.
- **`waitForPort()` timeout defaults to 5 seconds.** If Hocuspocus fails to bind within this window (e.g., another process holds the port), startup fails with a clear error instead of silently racing. The polling interval is 100ms.
- **Session auto-restore on startup.** `restoreOpenDocuments()` scans the session directory and reopens all previously-open files. Stale sessions (file deleted from disk) are cleaned up with ENOENT handling. The `sample/welcome.md` fallback only fires if zero sessions were restored.
- **Toast notifications use SSE, not Y.Map.** `GET /api/notify-stream` pushes ephemeral notifications (annotation range failures, save errors) via Server-Sent Events. This is intentionally separate from the channel SSE (`GET /api/events`) which pushes Y.Map-based events to Claude. Toast SSE is browser-only. Don't route toast data through Y.Map — it would pollute the CRDT with transient state.
- **Tutorial annotations are injected idempotently.** `injectTutorialAnnotations()` checks for existing tutorial annotation IDs before inserting. Safe to call multiple times (e.g., on server restart with session restore). The tutorial only activates on `sample/welcome.md` — other documents skip injection.
- **localStorage access needs try-catch.** The `useTutorial` hook wraps all `localStorage.getItem`/`setItem` calls in try-catch blocks. Some browsers (incognito, storage-disabled) throw on access. Without the guard, the tutorial component crashes the entire app.
- **`tandem_editAnnotation` only works on pending annotations.** Attempting to edit an accepted or dismissed annotation returns an error. The `editedAt` timestamp is set on the annotation to track modification time.
- **`tandem_getTextContent` always returns `extractText()` format.** Even for .md files, it uses the flat text extractor (with heading prefixes like `## `) rather than `extractMarkdown()`. This is intentional -- `extractMarkdown()` produces markdown syntax (e.g., `> ` for blockquotes) that shifts character offsets relative to the annotation coordinate system. If you need actual markdown, use `tandem_save` and read the file. See Issue #148.
- **Tab close goes through `POST /api/close`.** The client's `handleTabClose` calls the server HTTP endpoint rather than manipulating Y.Map state directly. This ensures `closeDocumentById()` in `document-service.ts` runs the full cleanup (session save, doc removal, broadcast). The close button is debounced via `closingIdsRef` to prevent double-close from rapid clicks.

## Security
- Server binds to 127.0.0.1 only
- DNS rebinding protection: `/mcp` routes via `createMcpExpressApp({ host })`; `/api` routes via Host-header validation in `apiMiddleware` (both reject non-localhost Host headers)
- CORS on `/api` routes reflects any `http://localhost:*` origin — no hardcoded port
- Rejects UNC paths on Windows (prevents NTLM hash leakage)
- HTTP API validates file extensions against `SUPPORTED_EXTENSIONS` (.md, .txt, .html, .htm, .docx)
- File size limit: 50MB (enforced in both `openFileByPath` via `fs.stat` and `openFileFromContent` via content length)
- Atomic file saves (write to temp, then rename)
