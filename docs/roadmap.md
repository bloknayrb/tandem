# Roadmap — Remaining Implementation Steps

Steps 0-6 are complete. Phase 1 (document groups + polish) is complete. Sprint 5 (browser file open + E2E tests) is complete. Channel push (Issue #106) is complete. Step 8 polish items (undo, interruption mode, Word comment import, port polling, session auto-restore) are complete. UX features (tab overflow, toast notifications, connection errors, annotation editing, onboarding tutorial) are complete. Tab close fix (Issue #149) and getTextContent offset fix (Issue #148) are complete. npm global install (Step 9, PR #161) is complete. This document contains the design spec for remaining work.

## Step 5: File I/O

### Goal
Load files into Y.Doc and save Y.Doc back to source files. Lossless for .md/.txt, review-only for .docx.

### 5a: Markdown (lossless round-trip) — DONE

**Files:** `src/server/file-io/markdown.ts`, `src/server/file-io/mdast-ydoc.ts`

Implemented via unified/remark with MDAST↔Y.Doc conversion:

- **Load:** `loadMarkdown()` parses markdown via remark into an MDAST tree, then `mdastToYDoc()` converts it to Y.XmlFragment elements with Tiptap-compatible nodeNames and formatted Y.XmlText for inline marks.
- **Save:** `saveMarkdown()` converts Y.Doc back to MDAST via `yDocToMdast()`, then serializes with remark-stringify. Round-trip preserves headings, bold/italic/strikethrough, links, inline code, lists (ordered/unordered/nested), blockquotes, code blocks, images, horizontal rules, and hard breaks.
- **Read:** `extractText()` returns flat text (with heading prefixes) for `tandem_getTextContent` on all file formats, ensuring offset consistency with the annotation coordinate system. `extractMarkdown()` is available for markdown serialization (e.g., `tandem_save`) but is NOT used for `tandem_getTextContent` (see Issue #148).
- **Key constraint:** Y.XmlText must be attached to the Y.Doc before populating text content — detached nodes reverse insert order (see ADR-009, Lesson 9).

### 5b: .docx (review-only mode) — DONE

**Files:** `src/server/file-io/docx.ts`, `src/server/file-io/docx.worker.ts`

- **Import:** Use mammoth.js to convert .docx to HTML, then parse HTML into Y.Doc via Tiptap's HTML parser (or manual conversion to Y.XmlElements).
- **Worker thread:** mammoth.js is synchronous and blocks the event loop. Run in `worker_threads` to prevent WebSocket stalls (100-page doc takes 1-3 seconds).
- **Review-only:** Never overwrite the original .docx. Outputs are:
  - Change list (Markdown) — what was reviewed, what changed, what was flagged
  - Annotation export (Markdown/JSON) — all highlights, comments, suggestions with document context
- **Opt-in lossy save:** For users who explicitly request it, save as .docx with pre-flight warnings about formatting loss.
- **Known limitations:** Complex tables, tracked changes, footnotes, headers/footers, custom styles do not survive round-trip.

### 5c: File change detection — PARTIAL (v0.2.11, PR #184)

**Implemented:**
- `fs.watch()` on source `.md`/`.txt`/`.html` files while open in Tandem
- On external change: auto-reload content, preserve annotations via CRDT re-anchoring + textSnapshot relocation
- Self-write suppression prevents reload loops when Tandem saves
- Toast notification on reload
- Dead `relRange` recovery in `refreshRange` (strips broken CRDT anchors, re-anchors from flat offsets)

**Not yet implemented:**
- Three-way merge (original snapshot, external change, Tandem edits)
- Conflict UI: show both versions side-by-side
- Dirty-document guard (if user has unsaved Tandem edits when external change occurs)
- `.docx` auto-reload (binary format, `fs.watch` unreliable)
- Flag annotations on externally-changed text

### Verification
- Open a .md file, edit in Tandem, save, reopen — content preserved exactly
- Open a .docx file — content appears, annotations work, original .docx unchanged
- Edit a .md file externally while open in Tandem — content updates, annotations preserved, toast appears

---

## Step 6: Session Persistence — DONE

### Goal
Close the browser, restart the server, reopen — document and annotations are still there.

**Files:** `src/server/session/manager.ts`

### Design

- **Storage location:** `%LOCALAPPDATA%\tandem\sessions\` (not project directory — avoids syncing document content to OneDrive)
- **Session key:** Hash of the source file's absolute path
- **What's persisted:**
  - Y.Doc state (full Yjs state vector — `Y.encodeStateAsUpdate()`)
  - Annotation Y.Map contents
  - Source file path, format, last-accessed timestamp
- **What's NOT persisted:**
  - Awareness state (ephemeral by design)
  - Browser-open tracking
- **Save triggers:**
  - On `tandem_save()` — save session alongside file save
  - On `tandem_close()` — save session before clearing state
  - Auto-save every 60 seconds while a document is open
  - On server shutdown (SIGTERM/SIGINT handler)
- **Resume flow:**
  1. `tandem_open("file.md")` checks for existing session
  2. If session exists and source file hasn't changed: restore Y.Doc from session
  3. If source file changed since session: load fresh from file, warn that annotations may be stale
  4. If no session: load fresh from file (current behavior)
- **Cleanup:** Delete sessions older than 30 days (`SESSION_MAX_AGE` in constants.ts)

### Verification
- Open file, add annotations, restart server, reopen — annotations still there
- Open file, edit externally, restart server, reopen — fresh load with warning
- Sessions older than 30 days are cleaned up on startup

---

## Step 7: Document Groups — Phase 1 DONE

### 7a: Multi-Document Tabs (DONE)

Implemented in Phase 1:

- **docIdFromPath**: Stable, readable document IDs from file paths (used as Map key + Hocuspocus room name)
- **openDocs Map**: Server tracks all open documents; `activeDocId` determines tool defaults
- **documentId parameter**: All 22 existing MCP tools accept optional `documentId` (backward compatible)
- **New tools**: `tandem_listDocuments`, `tandem_switchDocument` (24 tools total)
- **DocumentTabs**: Tab bar UI with format icons, active indicator, close buttons
- **Per-tab Y.Doc**: Browser manages separate Y.Doc + HocuspocusProvider per open document
- **broadcastOpenDocs**: Server writes open document list to Y.Map('documentMeta') on active doc

### 7b: Document Groups (Future)

Deferred — only if demand appears:

- Named groups (e.g., "February DRPA Review") with `tandem_createGroup`
- Cross-reference tools (`tandem_crossReference`, `tandem_searchGroup`)
- Split-pane UI for side-by-side documents
- Tab drag-to-split functionality

### Known Issues from Phase 1

- **MCP stdio disconnect (Issue #8):** Resolved. Migrated from stdio to Streamable HTTP transport (ADR-012). MCP HTTP on :3479, Hocuspocus WS on :3478. Stdio fallback via `TANDEM_TRANSPORT=stdio`.
- **Y.js "Invalid access" warnings:** Appear in stderr during session restore when the browser connects to a room before the MCP-populated Y.Doc is merged. Harmless (data still syncs correctly) but noisy. Could be silenced by deferring session restore until after `onLoadDocument` merge.
- **Browser tab discovery requires `/mcp` restart:** After restarting the Tandem MCP server, the browser must reload to reconnect its bootstrap provider. No auto-reconnect logic yet.

---

## Step 8: Polish

### Goal
First-run experience, error handling, and UX refinements.

### 8a: Launch Experience — PARTIALLY DONE

- Server auto-starts when Claude Code calls any Tandem tool (check PID in `.tandem/.server-info`)
- Server auto-stops after 30 min idle (`IDLE_TIMEOUT` in constants.ts)
- Browser auto-open (removed — `open` package wrote to stdout, corrupting the MCP wire; user opens http://localhost:5173 manually)
- ~~Browser file open~~ — implemented: "+" button in tab bar opens FileOpenDialog (path input or drag-and-drop upload), HTTP API endpoints (`/api/open`, `/api/upload`)

### 8b: Onboarding — DONE

**Files:** `src/server/file-io/tutorial.ts`, `src/client/hooks/useTutorial.ts`, `src/client/components/OnboardingTutorial.tsx`

Implemented in PR #147:

- Pre-loaded sample document (`sample/welcome.md`) with 3 pre-placed tutorial annotations (highlight, comment, suggestion) via `injectTutorialAnnotations()`
- `OnboardingTutorial` floating card at bottom-left with 3-step progression
- Three interactions: (1) accept/dismiss an annotation, (2) create a user annotation, (3) focus editor and type
- `useTutorial` hook detects step completion via annotation status observers + editor focus events
- Progress persisted to localStorage (try-catch guarded for incognito/restricted browsers)
- Idempotent injection — safe across server restarts with session restore
- Tutorial only activates on `sample/welcome.md`, suppressed for other documents

### 8c: Review Mode — PARTIALLY DONE

Keyboard review mode (Tab/Y/N/Z) is implemented. Annotation filtering (type/author/status), bulk accept/dismiss, review summary overlay, and 10-second undo window (with Z key in review mode) are implemented. Accepted suggestions are reverted atomically on undo. Inline annotation editing (pencil button, Issue #97) is implemented with `tandem_editAnnotation` MCP tool (28 tools total).

Remaining:
- Configurable threshold banner ("Claude has 14 suggestions. Review in sequence or filter by type.")
- Document dimming in review mode

### 8d: Interruption Model — PARTIALLY DONE

- Claude never interrupts while user is actively typing (3-second debounce — already implemented)
- Three modes implemented in StatusBar: All, Urgent, Paused
- Client broadcasts `mode` to `CTRL_ROOM`'s Y.Map('userAwareness') — Claude reads it via `tandem_status` and `tandem_checkInbox`
- Queued annotations delivered on pause via side panel badge
- High-priority findings (factual errors) use distinct yellow caution indicator

### 8e: Error Handling — PARTIALLY DONE

- Toast notifications (Issue #101): SSE-based notification system via `GET /api/notify-stream`. Server pushes annotation range failures, save errors. Browser renders via `ToastContainer` with type-differentiated auto-dismiss (error 8s, warning 6s, info 4s), dedup with count badge, max 5 visible.
- Connection error messages (Issue #105): Three-state `ConnectionStatus` (connected/connecting/disconnected), reconnect attempt count + elapsed time in StatusBar, 30s prolonged disconnect banner (dismissible, auto-clears on reconnect).
- File lock detection: clear message telling user to close Word
- WebSocket reconnection: automatic, no data loss (Yjs handles this)

Remaining:
- `RANGE_MOVED` / `RANGE_GONE` auto-retry: re-resolve range automatically when text has shifted
- Large file warnings: alert at 50+ pages about potential slowness

### 8f: Toolbar Enhancements — PARTIALLY DONE

- ~~Highlight button~~ — implemented (yellow default)
- ~~Comment button~~ — implemented
- Flag markers (red/yellow/green)
- ~~Ask Claude: select text → floating input → response as annotation~~ — implemented (Ctrl+Shift+A)
- Suggest: propose a change for Claude to evaluate
- ~~Accept All / Dismiss All buttons~~ — implemented in SidePanel
- ~~Review Mode toggle~~ — implemented (Ctrl+Shift+R)
- ~~"+" File Open button~~ — implemented in DocumentTabs (opens FileOpenDialog)
- ~~Tab overflow + reorder~~ — implemented: horizontal scroll with arrow buttons, HTML5 drag-and-drop reorder, Alt+Left/Right keyboard reorder, filename ellipsis with tooltip (Issue #99)
- Highlight color picker (5 colors available server-side, UI picker not yet built)

### Verification
- First launch shows sample document with annotations
- Keyboard shortcuts work in review mode
- Error messages are clear and actionable
- Server auto-starts and auto-stops correctly

---

## E2E Testing — DONE

**Files:** `playwright.config.ts`, `tests/e2e/`

Playwright E2E tests cover the critical annotation lifecycle path. Infrastructure:

- **McpTestClient** (`tests/e2e/helpers.ts`): wraps MCP SDK's `Client` + `StreamableHTTPClientTransport` for tool calls from tests
- **Fixture management**: `createFixtureDir()` copies sample files to a temp dir per test, `cleanupFixtureDir()` removes it
- **Config**: `workers: 1` (server supports one MCP session), `webServer` starts `dev:standalone`, `reuseExistingServer` for local dev
- **CI**: Playwright Chromium install + E2E step after build, report artifact uploaded on failure
- **13+ tests**: document load, annotation decoration, annotation card, accept, dismiss, suggestion apply, tab switching, review mode keyboard, tab overflow, tab reorder, tab scroll

Run: `npm run test:e2e` (auto-starts servers) or `npm run test:e2e:ui` (Playwright UI mode)

---

## Channel Push (Issue #106) — DONE

**Files:** `src/channel/index.ts`, `src/channel/event-bridge.ts`, `src/server/events/queue.ts`, `src/server/events/sse.ts`, `src/server/events/types.ts`

Real-time push notifications from browser to Claude Code via the Channels API, replacing polling.

- **Channel shim** (`src/channel/`): Separate stdio subprocess spawned by Claude Code. Low-level MCP `Server` class (not `McpServer`) with `claude/channel` + `claude/channel/permission` capabilities. Exposes `tandem_reply` tool.
- **Event queue** (`src/server/events/queue.ts`): Y.Map observers on annotations, chat, user awareness, and document metadata. Circular buffer (200 events / 60s). Origin tagging filters MCP-initiated changes.
- **SSE endpoint** (`GET /api/events`): Server-Sent Events stream with `Last-Event-ID` reconnection replay and 15s keepalive.
- **Channel API endpoints**: `/api/channel-awareness`, `/api/channel-reply`, `/api/channel-error`, `/api/channel-permission`, `/api/channel-permission-verdict`, `/api/launch-claude`, `DELETE /api/chat`
- **Build**: tsup produces three bundles — `dist/server/index.js` + `dist/channel/index.js` + `dist/cli/index.js`
- **8 event types**: `annotation:created`, `annotation:accepted`, `annotation:dismissed`, `chat:message`, `selection:changed`, `document:opened`, `document:closed`, `document:switched`

### Known Issues from Channel Implementation

- **E2E tab switching test stabilized (Issue #116):** Previously flaky due to timing issues with Yjs sync. Rewritten to use `tandem_switchDocument` for deterministic active doc state and `data-active='false'` attribute selector.
- **`dev:standalone` server startup fixed (Issue #117):** Previously unreliable due to fixed sleep before Hocuspocus bind. Now uses `waitForPort()` polling in `platform.ts` to verify port availability before proceeding. Both HTTP and stdio startup branches updated.

---

## Word Comment Import (Issue #85) — DONE

**Files:** `src/server/file-io/docx-comments.ts`

Extracts `<w:comment>` elements from .docx XML (via JSZip) during file open and creates Tandem annotations with `author: "import"` and CRDT-anchored ranges. The SidePanel author dropdown includes an "Imported" filter. This is the import half of Phase 3 (.docx comments) — export (`<w:comment>` generation) is not yet implemented.

---

## Session Auto-Restore (Issue #102) — DONE

**Files:** `src/server/session/manager.ts`, `src/server/index.ts`

On server startup, `listSessionFilePaths()` scans the session directory for previously-open files. `restoreOpenDocuments()` calls `openFileByPath()` for each, and `restoreCtrlSession()` returns the previous active document ID. After restore, the version check opens `CHANGELOG.md` on upgrade, or the `sample/welcome.md` fallback opens if zero documents are open — both before servers start. Stale sessions (ENOENT) are cleaned up automatically.

---

## Tab Close Fix (Issue #149) — DONE

**Files:** `src/server/mcp/document-service.ts`, `src/server/mcp/api-routes.ts`, `src/server/mcp/document.ts`, `src/client/components/DocumentTabs.tsx`

Closing a tab in the browser now actually closes the document on the server. Previously, tab close only affected the client UI without cleaning up the server-side document state.

- **`closeDocumentById()`** shared helper in `document-service.ts` — single source of truth for document close logic (session save, doc removal, broadcast), used by both `tandem_close` MCP tool and `POST /api/close` HTTP endpoint
- **`POST /api/close`** HTTP endpoint in `api-routes.ts` — browser-callable close, parallel to `/api/open`
- **Client `handleTabClose`** calls `POST /api/close` with optimistic adjacent-tab selection
- **Close button debounced** via `closingIdsRef` in `DocumentTabs.tsx` to prevent double-close from rapid clicks
- **`saveSession` wrapped in try-catch** so save failure doesn't block close
- 7 new unit tests for `closeDocumentById`

---

## getTextContent Offset Fix (Issue #148) — DONE

**Files:** `src/server/mcp/document.ts`

`tandem_getTextContent` was using `extractMarkdown()` for .md files, which produces markdown syntax (e.g., `> ` prefixes for blockquotes) that differs from the flat text format used by the annotation coordinate system. This caused offset drift — annotations placed using offsets from `tandem_getTextContent` would land in the wrong location after blockquotes.

- Changed `tandem_getTextContent` to always use `extractText()` regardless of file format
- `extractText()` produces the same flat text format (with heading prefixes like `## ` and `\n` separators) used by all annotation tools
- 2 new unit tests for blockquote offset consistency

---

## Step 9: npm Global Install (PR #161) — DONE

**Files:** `src/cli/index.ts`, `src/cli/setup.ts`, `src/cli/start.ts`, `src/server/open-browser.ts`, `packages/tandem-doc/`

`npm install -g tandem-editor` makes Tandem available as a global CLI command:

- **`tandem`** — Starts the server and opens the browser at `http://localhost:3479`
- **`tandem setup`** — Auto-detects Claude Code and Claude Desktop, writes MCP config entries with absolute paths to `~/.claude/mcp_settings.json` and/or `claude_desktop_config.json`
- **`tandem setup --force`** — Writes config to default paths regardless of auto-detection
- **Static file serving** — Express serves the Vite-built client from `dist/client/` on `:3479`, eliminating the need for a separate Vite dev server in production
- **Package rename** — Published as `tandem-editor` (npm name availability); `tandem-doc` is a reserved alias stub
- **Version baked in at build time** — tsup `define` injects `__TANDEM_VERSION__` (no runtime `package.json` lookup in CLI)
- **Atomic config writes** — `atomicWrite()` with EXDEV fallback for Windows cross-drive scenarios
- **Doctor updated** — `npm run doctor` checks user-level MCP registration (`~/.claude/mcp_settings.json`)
- **12 tests** for `buildMcpEntries`, `detectTargets`, and `applyConfig`

---

## Known Limitations (v1)

These are intentional scope boundaries, not bugs:

- .docx is review-only — use Word for final formatting/production
- No formula support in tables
- No .xlsx/.csv support (deferred to v2)
- No drawing/freeform annotation (deferred to v2)
- Single user + Claude only (no multi-human collaboration)
- Documents over ~50 pages may be slow to render
- No plugin/extension architecture — custom extensions require code changes
- No synchronized scrolling between split panes

## Future Extensions (v2+)

- **Progressive Web App (PWA)** — Add a web app manifest + service worker so users can "install" Tandem from the browser. Gives a real app window (no browser chrome), taskbar icon, and offline-capable shell. Vite has `vite-plugin-pwa` for zero-config setup. Pairs well with auto-start — user clicks the PWA icon, server starts, editor opens.
- Spreadsheet component (Handsontable/AG Grid)
- Claude Desktop support (MCP server already exists)
- Drawing/freeform annotation layer
- Exportable annotated documents (PDF with annotations)
- LibreOffice headless for high-fidelity .docx round-trip
- Code editing mode (CodeMirror 6)
- Standalone mode with direct Anthropic API connection
