# Tandem -- Collaborative AI-Human Document Editor

## Quick Reference
- `npm run dev:server` -- Backend: Hocuspocus on :3478 + MCP HTTP on :3479
- `npm run dev:client` -- Frontend: Vite on :5173
- `npm run dev:standalone` -- Both frontend + backend (via concurrently)
- `npm run dev` -- Alias for `vite` (frontend only)
- `npm run build` -- Production build: typecheck + vite build + tsup -> `dist/server/`, `dist/channel/`, `dist/cli/`, `dist/client/`
- `npm run build:server` -- Bundle server + channel + CLI via tsup only
- `npm run start:server` -- Run bundled server (`node dist/server/index.js`)
- `npm run typecheck` -- Type-check server + client without emitting
- `npm run doctor` -- Diagnose setup issues (Node version, .mcp.json, server health, ports)
- `npm test` -- Run vitest (unit tests)
- `npm run test:e2e` -- Run Playwright E2E tests (auto-starts servers via webServer config)
- `npm run test:e2e:ui` -- Playwright UI mode for interactive E2E debugging
- **Start the server before connecting Claude Code.** `npm run dev:standalone` runs both. Vite hot-reloads client code; restart `dev:server` then `/mcp` in Claude Code for server changes.

## Documentation
- [MCP Tool Reference](docs/mcp-tools.md) -- All 30 MCP tools + channel API endpoints
- [Architecture](docs/architecture.md) -- Diagrams, data flows, coordinate systems, file map
- [Workflows](docs/workflows.md) -- Real-world usage patterns
- [Roadmap](docs/roadmap.md) -- Phase 2+ roadmap, future extensions
- [Design Decisions](docs/decisions.md) -- ADRs (001-021)
- [Lessons Learned](docs/lessons-learned.md) -- 31 lessons including E2E testing gotchas

## Architecture

Three layers: Browser (Tiptap) <-> Tandem Server (Hocuspocus on :3478 + MCP HTTP on :3479) <-> Claude Code. Channel shim (`src/channel/`) pushes real-time events to Claude Code via SSE, replacing polling.

Key files for navigation:
- `src/cli/index.ts` -- CLI entrypoint (`tandem` command), arg parsing, dispatches to start/setup
- `src/cli/setup.ts` -- `tandem setup`: auto-detect Claude installs, write MCP config atomically
- `src/cli/start.ts` -- `tandem start`: spawn server with `TANDEM_OPEN_BROWSER=1`
- `src/server/index.ts` -- Entry point, port binding, console redirect
- `src/server/open-browser.ts` -- Cross-platform browser launcher (execFile-based)
- `src/server/mcp/` -- Tool definitions, `api-routes.ts`, `channel-routes.ts`, `file-opener.ts`, `document-service.ts`
- `src/server/positions.ts` -- Server coordinate conversions (`validateRange`, `anchoredRange`, `resolveToElement`, `refreshRange`)
- `src/server/events/` -- Channel event infrastructure (Y.Map observers, SSE)
- `src/client/` -- Tiptap editor, React components, hooks (`useYjsSync`, `useTabOrder`, `useTutorial`, `useNotifications`)
- `src/shared/` -- Types (`types.ts`), constants (`constants.ts`), offsets (`offsets.ts`), position types (`positions/`)

Full file-level detail: [docs/architecture.md](docs/architecture.md#file-map)

## Key Patterns
- All document mutations go through the server's Y.Doc -> changes sync to browser via Hocuspocus
- Annotations stored in Y.Map('annotations'), not in document content. `author` field: `"user" | "claude" | "import"` (import = Word comments from .docx files)
- Three coordinate systems: flat text offsets (server, includes heading prefixes), ProseMirror positions (client, structural), Yjs RelativePositions (CRDT-anchored, survive edits). Modules: `src/server/positions.ts`, `src/client/positions.ts`, shared types in `src/shared/positions/`
- Multi-document: each file gets a documentId (hash of path) = Hocuspocus room name. All MCP tools accept optional `documentId`, defaulting to active document. `CTRL_ROOM` is reserved -- never use as a document ID. Server broadcasts `openDocuments` via Y.Map('documentMeta')
- Communication: `tandem_checkInbox` (poll for user actions + chat) and `tandem_reply` (Claude's chat responses). **Call `tandem_checkInbox` between tasks.** `tandem_status` and `tandem_checkInbox` include the user's current `interruptionMode` so Claude can adapt behavior
- File open/close converge in `file-opener.ts` / `document-service.ts`; tab close goes through `POST /api/close`

## Critical Rules

These WILL break things if violated:

1. **Y.Map key strings from constants only.** Use `Y_MAP_ANNOTATIONS`, `Y_MAP_AWARENESS`, etc. from `shared/constants.ts` -- never raw string literals for Y.Map keys.
2. **Origin-tag MCP writes.** All server-side Y.Map writes must use `doc.transact(() => { ... }, 'mcp')` to prevent the event queue from emitting echo events.
3. **stdout is reserved.** `console.log/warn/info` all redirect to stderr in `index.ts` (defense-in-depth for stdio fallback). If you add a dependency that logs to stdout, it will corrupt the MCP wire in stdio mode.
4. **Ranges use `validateRange()` + `anchoredRange()`**, not raw offsets. `anchoredRange()` creates both flat + Yjs RelativePosition in one call.
5. **`tandem_getTextContent` uses `extractText()`, never `extractMarkdown()`.** Even for .md files. `extractMarkdown()` shifts character offsets relative to the annotation coordinate system. If you need actual markdown, use `tandem_save` and read the file.
6. **`tandem_edit` rejects heading markup ranges.** Ranges that overlap heading prefixes (e.g., `## `) return INVALID_RANGE -- target text content only.
7. **E2E tests use `data-testid` attributes** (kebab-case). Key selectors: `accept-btn`, `dismiss-btn`, `edit-btn`, `review-mode-btn`, `annotation-card-{id}`, `tab-{id}`, `file-open-dialog`, `file-path-input`, `open-file-btn`, `toast-container`.

## Gotchas

### Y.js / CRDT
- **Y.XmlText must be attached before populating.** Inserting formatted text into a detached Y.XmlText reverses segment order. Always attach to Y.Doc first, then insert (two-pass pattern in `mdast-ydoc.ts`).
- **Y.XmlElement.setAttribute needs `as any` for numbers.** TypeScript types say string-only but Tiptap stores numeric heading levels.
- **Stale browser tabs merge old CRDT state back.** If you change a file on disk and restart the server, an already-open browser tab will sync its old Y.Doc state back on reconnect, reverting your changes. Close all tabs before restarting, or use `force: true` to reload.
- **Force-reload clears in-place.** `tandem_open` with `force: true` clears annotations, awareness, and content, then repopulates from disk in a single Y.js transaction. Client connections and client-side observers survive; server event queue observers are defensively re-attached. Don't use mid-review -- annotations are still lost. See observer ownership table in [architecture.md](docs/architecture.md#y-map-observer-ownership).
- **CRDT fallback logging.** `buildDecorations()` emits `console.warn` when a relRange-equipped annotation falls back to flat offsets. Check the browser console -- these indicate CRDT degradation.
- **Hocuspocus replaces Y.Doc in `onLoadDocument`.** Server-side observers on pre-existing docs get destroyed. Re-attach observers after the hook. Related: force-reload avoids this by clearing in-place (see above). See #178 for audit of remaining destroy-recreate patterns.
- **Y.js "Invalid access" warnings** during session restore are harmless stderr noise. Data syncs correctly.

### MCP / Server
- **Channel shim uses low-level `Server`, not `McpServer`.** The Channels spec requires `import { Server } from '@modelcontextprotocol/sdk/server/index.js'` with explicit `setRequestHandler()` calls. The HTTP MCP server uses the high-level `McpServer` wrapper. Separate processes, different SDK classes.
- **Channel meta keys use underscores only.** The Channels API silently drops meta keys containing hyphens. Use `document_id`, `annotation_id`, `event_type` -- not `document-id`.
- **`freePort()` kills stale processes** on :3478/:3479 at startup. Can't run two Tandem instances simultaneously.
- **`waitForPort()` timeout defaults to 5 seconds** (100ms polling). If Hocuspocus fails to bind, startup fails with a clear error.
- **`APP_VERSION` is read from `package.json`** via `createRequire` in `src/server/mcp/server.ts`. Don't hardcode version strings.

### Client / UI
- **ChatPanel + SidePanel are always mounted** (CSS display toggle, not conditional rendering) so local state persists across panel switches.
- **localStorage access needs try-catch.** Some browsers (incognito, storage-disabled) throw on access. Without the guard, the tutorial component crashes the app.
- **Undo timer cleanup on unmount.** The 10-second undo window uses `setTimeout`. All pending timers are cleared on unmount to prevent state updates on unmounted components. Z key in review mode undoes the most recent resolution.
- **Tutorial annotations are injected idempotently.** `injectTutorialAnnotations()` checks for existing IDs before inserting. Safe to call multiple times. Tutorial only activates on `sample/welcome.md`.
- **`tandem_editAnnotation` only works on pending annotations.** Attempting to edit an accepted or dismissed annotation returns an error. `editedAt` timestamp tracks modification time.

### Files, Sessions & Lifecycle
- **Uploaded files (`upload://` paths) are read-only.** `tandem_save` returns a session-only save. Sessions persist normally -- the synthetic path is the session key.
- **Session files at platform-appropriate dir** via `env-paths`: `%LOCALAPPDATA%\tandem\Data\sessions\` on Windows (note `Data` subdir), `~/Library/Application Support/tandem/sessions/` on macOS, `~/.local/share/tandem/sessions/` on Linux. Delete to force fresh load.
- **Auto-open `sample/welcome.md`** on first run (no restored session). `TANDEM_NO_SAMPLE=1` to disable. On upgrade (version change detected via `last-seen-version` file in data dir), `CHANGELOG.md` opens as the active tab instead — the welcome tutorial is suppressed since `getOpenDocs().size > 0`. Both open **before** Hocuspocus/MCP start — if they ran after, a stale browser tab reconnecting could CRDT-merge an old `openDocuments` list that lacks the new tab.
- **Word comment offsets need re-anchoring.** `.docx` comment ranges reference the original HTML-converted content. After Y.Doc population, flat text offsets drift from heading prefix insertion. `docx-comments.ts` re-resolves via `anchoredRange()`.
- **Session auto-restore on startup.** `restoreOpenDocuments()` scans the session directory, reopens all previously-open files, cleans stale sessions (ENOENT handling). `sample/welcome.md` fallback only fires if zero sessions restored.
- **Exception handler is narrowed, not blanket.** `uncaughtException`/`unhandledRejection` in `index.ts` only swallow known Hocuspocus/ws errors (via `isKnownHocuspocusError` in `error-filter.ts`). Unknown errors log details and call `process.exit(1)`. If the server starts crashing on a new Hocuspocus error pattern, add the pattern to the discriminator.

### Testing & E2E
- **E2E tests start their own server** via Playwright `webServer`. `freePort()` kills existing :3478/:3479. Running E2E alongside `dev:server` will terminate your dev server.
- **Hocuspocus rooms = document IDs** from `docIdFromPath()`. `CTRL_ROOM` (from `shared/constants.ts`) is reserved for the bootstrap coordination channel -- never use it as a document ID.

## Status

Core complete: 30 MCP tools, multi-doc tabs, CRDT-anchored annotations, chat sidebar, channel push, .md/.docx/.txt/.html support, npm global install (`tandem-editor`), 776 tests. See [docs/roadmap.md](docs/roadmap.md) for remaining phases (2-5: cowork integration, .docx export, distribution, discovery).

## Security
- Server binds to 127.0.0.1 only
- DNS rebinding protection on all routes (`apiMiddleware` Host-header validation + `createMcpExpressApp`)
- CORS reflects `http://localhost:*` origins. Rejects UNC paths (Windows NTLM). Extension + 50MB size limits. Atomic saves
