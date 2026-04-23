# Roadmap — Remaining Implementation Steps

Steps 0-6 are complete. Phase 1 (document groups + polish) is complete. Sprint 5 (file open + E2E tests) is complete. Channel push (Issue #106) is complete. Step 8 polish items (undo, interruption mode, Word comment import, port polling, session auto-restore) are complete. UX features (tab overflow, toast notifications, connection errors, annotation editing, onboarding tutorial) are complete. Tab close fix (Issue #149) and getTextContent offset fix (Issue #148) are complete. npm global install (Step 9, PR #161) is complete. This document contains the design spec for remaining work.

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
Close the editor, restart the server, reopen — document and annotations are still there.

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
  - On `tandem_close()` — delete session file (so closed docs don't reopen on restart)
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
- **Per-tab Y.Doc**: Editor manages separate Y.Doc + HocuspocusProvider per open document
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
- **Editor tab discovery requires `/mcp` restart:** After restarting the Tandem MCP server, the editor must reload to reconnect its bootstrap provider. No auto-reconnect logic yet.

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

- Pre-loaded sample document (`sample/welcome.md`) with 3 pre-placed tutorial annotations (highlight, comment, comment with replacement) via `injectTutorialAnnotations()`
- `OnboardingTutorial` floating card at bottom-left with 3-step progression
- Three interactions: (1) accept/dismiss an annotation, (2) create a user annotation, (3) focus editor and type
- `useTutorial` hook detects step completion via annotation status observers + editor focus events
- Progress persisted to localStorage (try-catch guarded for incognito/restricted browsers)
- Idempotent injection — safe across server restarts with session restore
- Tutorial only activates on `sample/welcome.md`, suppressed for other documents

### 8c: Review Mode — PARTIALLY DONE

Keyboard review mode (Tab/Y/N/Z) is implemented. Annotation filtering (type/author/status), bulk accept/dismiss, review summary overlay, and 10-second undo window (with Z key in review mode) are implemented. Accepted replacement suggestions are reverted atomically on undo. Inline annotation editing (pencil button, Issue #97) is implemented with `tandem_editAnnotation` MCP tool.

Remaining:
- Configurable threshold banner ("Claude has 14 annotations to review. Review in sequence or filter by type.")
- Document dimming in review mode

### 8d: Interruption Model — DONE

Superseded by the Wave 4 Solo/Tandem redesign (PRs #226, #227). The All/Urgent/Paused three-mode model was retired in favor of a binary Solo/Tandem toggle exposed in the toolbar:

- Claude never interrupts while the user is actively typing (3-second debounce)
- Two modes in the toolbar toggle: **Tandem** (default; full collaboration) and **Solo** (hold all pending Claude annotations; only respond to chat)
- Client broadcasts `mode` to `CTRL_ROOM`'s Y.Map('userAwareness') — Claude reads it via `tandem_status` and `tandem_checkInbox`, both of which return `mode: "solo" | "tandem"`
- Held annotations surface via the side panel banner (`{n} annotation(s) held`) with a one-click "Show all" affordance that flips back to Tandem

### 8e: Error Handling — PARTIALLY DONE

- Toast notifications (Issue #101): SSE-based notification system via `GET /api/notify-stream`. Server pushes annotation range failures, save errors. Editor renders via `ToastContainer` with type-differentiated auto-dismiss (error 8s, warning 6s, info 4s), dedup with count badge, max 5 visible.
- Connection error messages (Issue #105): Three-state `ConnectionStatus` (connected/connecting/disconnected), reconnect attempt count + elapsed time in StatusBar, 30s prolonged disconnect banner (dismissible, auto-clears on reconnect).
- File lock detection: clear message telling user to close Word
- WebSocket reconnection: automatic, no data loss (Yjs handles this)

Remaining:
- `RANGE_MOVED` / `RANGE_GONE` auto-retry: re-resolve range automatically when text has shifted
- Large file warnings: alert at 50+ pages about potential slowness

### 8f: Toolbar Enhancements — PARTIALLY DONE

- ~~Highlight button~~ — implemented (yellow default)
- ~~Comment button~~ — implemented (unified with Replace toggle and @Claude toggle)
- Flag markers (red/yellow/green)
- ~~Accept All / Dismiss All buttons~~ — implemented in SidePanel
- ~~Review Mode toggle~~ — implemented (Ctrl+Shift+R)
- ~~"+" File Open button~~ — implemented in DocumentTabs (opens FileOpenDialog)
- ~~Tab overflow + reorder~~ — implemented: horizontal scroll with arrow buttons, HTML5 drag-and-drop reorder, Alt+Left/Right keyboard reorder, filename ellipsis with tooltip (Issue #99)
- ~~Tab cycling~~ — implemented: Ctrl+Tab / Ctrl+Shift+Tab to cycle through tabs (Issue #266)
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
- **13+ tests**: document load, annotation decoration, annotation card, accept, dismiss, replacement apply, tab switching, review mode keyboard, tab overflow, tab reorder, tab scroll

Run: `npm run test:e2e` (auto-starts servers) or `npm run test:e2e:ui` (Playwright UI mode)

---

## Channel Push (Issue #106) — DONE

**Files:** `src/channel/index.ts`, `src/channel/event-bridge.ts`, `src/server/events/queue.ts`, `src/server/events/sse.ts`, `src/server/events/types.ts`

Real-time push notifications from editor to Claude Code via the Channels API, replacing polling.

- **Channel shim** (`src/channel/`): Separate stdio subprocess spawned by Claude Code. Low-level MCP `Server` class (not `McpServer`) with `claude/channel` + `claude/channel/permission` capabilities. Exposes `tandem_reply` tool.
- **Event queue** (`src/server/events/queue.ts`): Y.Map observers on annotations, chat, user awareness, and document metadata. Circular buffer (200 events / 60s). Origin tagging filters MCP-initiated changes.
- **SSE endpoint** (`GET /api/events`): Server-Sent Events stream with `Last-Event-ID` reconnection replay and 15s keepalive.
- **Channel API endpoints**: `/api/channel-awareness`, `/api/channel-reply`, `/api/channel-error`, `/api/channel-permission`, `/api/channel-permission-verdict`, `/api/launch-claude`, `DELETE /api/chat`
- **Build**: tsup produces three bundles — `dist/server/index.js` + `dist/channel/index.js` + `dist/cli/index.js`
- **7 event types**: `annotation:created`, `annotation:accepted`, `annotation:dismissed`, `chat:message`, `document:opened`, `document:closed`, `document:switched`

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

Closing a tab in the editor now actually closes the document on the server. Previously, tab close only affected the client UI without cleaning up the server-side document state.

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

- **`tandem`** — Starts the server and opens the editor at `http://localhost:3479`
- **`tandem setup`** — Auto-detects Claude Code and Claude Desktop, writes MCP config entries with absolute paths to `~/.claude/mcp_settings.json` and/or `claude_desktop_config.json`
- **`tandem setup --force`** — Writes config to default paths regardless of auto-detection
- **Static file serving** — Express serves the Vite-built client from `dist/client/` on `:3479`, eliminating the need for a separate Vite dev server in production
- **Package rename** — Published as `tandem-editor` (npm name availability); `tandem-doc` is a reserved alias stub
- **Version baked in at build time** — tsup `define` injects `__TANDEM_VERSION__` (no runtime `package.json` lookup in CLI)
- **Atomic config writes** — `atomicWrite()` with EXDEV fallback for Windows cross-drive scenarios
- **Doctor updated** — `npm run doctor` checks user-level MCP registration (`~/.claude/mcp_settings.json`)
- **12 tests** for `buildMcpEntries`, `detectTargets`, and `applyConfig`

---

## Tauri Desktop — DONE (v0.4.0, PR #257)

Native desktop distribution via Tauri v2. The Node.js server runs as a bundled sidecar; the WebView loads the existing web client unchanged.

### Step 1: Scaffold + sidecar wiring — DONE

Tauri project scaffolded (`src-tauri/`), Node.js bundled as `node-sidecar` via `externalBin`, server resources bundled (`dist/server/`, `dist/channel/`, `dist/client/`, `sample/`). Sidecar spawned on launch; `TANDEM_OPEN_BROWSER=0` prevents double browser open.

### Step 2: Origin + permissions — DONE

Production WebView uses `tauri://localhost` origin. Server CORS and DNS-rebinding middleware updated to accept it. CSP configured in `tauri.conf.json`. Capabilities split: `default.json` (core + shell + fs + dialog), `desktop.json` (single-instance + window-state + updater).

### Step 3: Sidecar lifecycle hardening — DONE

Health polling (200ms interval, 15s timeout), exponential backoff restart (up to 3 attempts), early-exit if sidecar dies before healthy, error dialog on exhausted retries. `kill_sidecar()` on `RunEvent::Exit` prevents orphan processes.

### Step 4: MCP auto-setup — DONE

`run_setup()` POSTs to `/api/setup` with bundled `nodeBinary` + `channelPath` after health check. Runs on every launch (idempotent). Shows "Claude not found" dialog if no Claude installation detected. Tray "Setup Claude" item re-runs setup on demand with result dialog.

### Step 5: System tray + window management — DONE

Window hide-on-close (tray "Quit" is the exit path). Tray menu: Open Editor, Setup Claude, Check for Updates (separator), About, Quit. Left-click tray icon shows window. Single-instance plugin: second launch focuses existing window instead of spawning a new one.

### Step 6: Auto-updater — DONE

`tauri-plugin-updater` checks GitHub Releases `latest.json` on launch and every 8 hours. Ed25519-signed artifacts (`TAURI_SIGNING_PRIVATE_KEY` secret). `bundle.createUpdaterArtifacts: true` generates `.sig` files in CI. Before `app.restart()`, kills sidecar and waits for port to clear.

### Step 7: Build pipeline + CI — DONE

GitHub Actions workflow (`.github/workflows/tauri-release.yml`) — builds on Windows/macOS/Linux, signs with `tauri-action`, publishes installers + `latest.json` to GitHub Releases. Cross-platform basename fix and CodeQL security hardening applied post-merge.

Future hardening (not blocking release):
- Verify end-to-end update flow (download → install → restart) on all three platforms
- Code-sign macOS `.app` (requires Apple Developer certificate)
- Windows MSIX / NSIS installer smoke test

### Future Tauri Enhancements

- **File association**: Register `.md`/`.docx`/`.txt` file extensions so double-clicking opens in Tandem
- **Deep link / open-with**: Pass file path from second-instance launch into the running server via `POST /api/open`
- **macOS notarization**: Required for Gatekeeper-clean distribution outside the App Store
- **Linux tray fallback**: Improve UX when `libappindicator3-dev` is absent (currently logs and continues)

---

## Durable Annotations + Cowork Auto-Setup — PHASE 1 DONE, PHASE 2 PARTIAL

Plan doc: [`docs/superpowers/plans/2026-04-16-durable-annotations-cowork.md`](superpowers/plans/2026-04-16-durable-annotations-cowork.md). Roadmap issues #313–#322.

### Phase 1 — Durable Annotations in App Data (T1–T8) — DONE

Moves annotation storage from in-memory Y.Doc + session snapshots to explicit per-document durable JSON under `env-paths` app data. Survives editor/tab loss, tandem-editor reinstalls, OS restarts.

- **T1–T6 (PR #323, merged):** Per-doc on-disk store, migration from session snapshots, load/save wiring, in-memory cache, tests.
- **T7 + T8 (PR #337, merged):** Content-hashed import annotation IDs for idempotent .docx re-import with dedup, plus `npm run doctor` annotation-health checks and CLAUDE.md Rule #2 rewrite.
- **Retrospective follow-ups (v0.6.3, merged):** GC race fix (#334), annotation module internals (#324, #327, #328, #332), legacy-type sanitization (#329), drop-counter (#330), test coverage (#331, #335), CI gate (#310), settings popover (#306), dark-mode tokens (#307), a11y sweep (#309, #311 partial), stdio bridge silent-failure paths (#336 partial).

### Phase 2 — Tauri Multi-Surface Auto-Setup (PRs a–f)

Each release targets **one coherent concern** so that a bad PR is bisectable and the CHANGELOG entry is unambiguous. Time-to-ship is secondary to blast-radius containment.

#### Completed releases

| Release | Concern | Status |
|---------|---------|--------|
| v0.6.4 | Silent-failure patch + flaky E2E (#336 partial, #281) | **DONE** |
| v0.7.0 | Cowork foundation: auth token storage, auth middleware, `TANDEM_BIND_HOST` bind mode, `tandem rotate-token`, token forwarding in stdio/monitor/channel | **DONE** (PRs a–d) |
| v0.7.1 | MSIX Claude Desktop detection + stdio entry generation (#372) | **DONE** |

- **PR a (DONE)** — Token storage (`env-paths` data directory, `O_EXCL` file creation, Tauri sidecar passthrough via `TANDEM_AUTH_TOKEN`).
- **PR b (DONE)** — Auth middleware + OAuth protected-resource metadata. Loopback-exempt, `crypto.timingSafeEqual`, SHA-256 length oracle elimination, rate-limit (5/min) with LRU eviction.
- **PR c (DONE)** — Bind mode selection (`TANDEM_BIND_HOST`): default `127.0.0.1`, Cowork mode binds `0.0.0.0`. Hocuspocus stays loopback-only. Fail-closed on LAN bind without token.
- **PR d (DONE)** — `tandem rotate-token` CLI subcommand with 60s grace window; re-runs setup across detected MCP configs.
- **PR e** — Cowork per-workspace installer (read-modify-write `installed_plugins.json` / `known_marketplaces.json` / `cowork_settings.json`), Windows firewall scoping to detected Hyper-V VM subnet, NSIS uninstaller cleanup. Implementation done (draft PR #370, reviewed); merge targeting v0.9.0.
- **PR f** — Settings UI + onboarding in Tauri. Enable/disable Cowork mode, show detected VM subnet, surface plugin status. Implementation done in React (draft PR #371); merge timing depends on Svelte probe outcome — if Svelte Go, rebuild in Svelte for v0.13.0.

### Cowork integration status

Cowork integration is **verified end-to-end** as of v0.7.1 (2026-04-20). Both Claude Code CLI and Claude Desktop Cowork workspaces surface `tandem_*` tools via the stdio bridge (`npx -y tandem-editor mcp-stdio`). The Cowork plugin bridge was introduced in tandem-editor@0.6.0 and first cross-platform working in @0.6.2 (Windows `workspaces` packaging bug). See [ADR-023](decisions.md#adr-023-cowork-plugin-bridge--stdio-via-npx-not-http-prs-301-304) for the decision trail.

Remaining Cowork work (PRs e-f, #316, #317, #322) is polish — making the installer turnkey and adding cross-platform firewall scoping. Not a capability blocker.

---

## v1.0 Release Plan

Core features are complete (31 MCP tools, multi-doc tabs, CRDT annotations, chat, channel push, npm global install, Tauri desktop, Cowork integration). Remaining work: codebase audit remediation, correctness foundations, API cleanup, framework decision, dark theme, desktop UI polish, and first-run UX.

Guiding principle: "Code is cheap, so the only thing that matters is doing things RIGHT."

> **Bug-fix phase is done.** #268, #267, #266 fixed in PR #278.

### Pre-Release: Codebase Audit Remediation

Full quality sweep documented in [`docs/audit-v1.md`](audit-v1.md). Three independent review agents verified all findings against actual source code. Runs before v0.8.0 to ensure the foundation is clean before adding more features.

**Summary:** 24,370 LOC source, 23,548 LOC tests. 8 god-files needing decomposition, 2 layer boundary violations (now fixed), missing file-opener lifecycle tests, unused Tauri JS deps (now removed), tsconfig drift (now fixed). Strengths: architecture is sound, security is thorough, durability layer is well-tested, position system uses branded types correctly.

**Phases (detail in audit doc):**

| Phase | Scope | Effort | Status |
|-------|-------|--------|--------|
| 1 | Foundation: wire-protocol types to shared, token-store extraction, awareness.ts #355, Editor CSS extraction, tsconfig tightening, dead Tauri deps | ~2 days | **DONE** (PRs #384–#389, merged 2026-04-22) |
| 2 | Server splits: api-routes.ts → per-route modules, file-opener.ts → phased helpers + lifecycle tests | ~2 days | Next |
| 3 | Event queue observer split (highest-risk, sequential) | ~1.5 days | — |
| 4 | Client splits: App.tsx hooks, SidePanel decomposition, Toolbar/Settings/AnnotationCard sub-components | ~3 days | — |
| 5 | Prop-drilling evaluation (conditional, post-Phase 4) | ~0.5 day | — |
| 6 | Polish: accessibility, E2E error recovery, Tauri integration tests (post-v1.0) | incremental | — |

**Deferrals (with rationale in audit doc):** useYjsSync.ts (350 LOC, tight coupling makes splitting fragile), mcp/server.ts (331 LOC, manageable), shared/types.ts (274 LOC, reasonable for barrel), React.memo (measure with Profiler first), Biome linter (conflicts with ESLint).

**Phases 1-3 are the minimum viable audit remediation** (~5.5 days). Phases 4-5 improve client maintainability but don't affect correctness. Phase 6 is post-v1.0 polish.

### Decision Gate: Svelte Probe (#312)

Time-boxed to 1-2 weeks, runs alongside v0.8.0 work. Success criteria are **behavioral, not volumetric:**

1. `svelte-tiptap` renders with Yjs collaboration extensions (rendering gate)
2. Svelte equivalent of `useYjsSync` handles tab switch, Y.Doc swap, observer cleanup, and reconnect without memory leaks or orphaned WebSocket connections (lifecycle gate)
3. Mount → unmount → remount → swap → close cycle without observer lifecycle bugs (stress gate)
4. CRDT RelativePosition resolution works in Svelte reactivity model

**Go:** All four gates pass. Observer lifecycle management is genuinely simpler — not just syntactically shorter — than the React `useRef` + cleanup ceremony.

**No-go:** svelte-tiptap collaboration fails; observer lifecycle requires equivalent manual management; Y.Doc swap produces bugs from the same class as Lessons 5, 10, 14, 16, 34, 44.

The probe produces a decision document filed as an ADR. The result determines the client-side path for v0.10.0 onward.

### Release Cadence

`#269 §X.Y` refers to the Tiered breakdown in the "Issue #269 Revision" comment on that issue.

#### Framework-independent (safe regardless of Svelte decision)

| Release | Concern | Scope |
|---------|---------|-------|
| v0.8.0 | Token hygiene + annotation correctness | #313, #318, #340, #355, #356, #308, #344, #351, #364, #369, #376, #377, #379, #381, #382, #396 |
| v0.9.0 | MCP API cleanup + distribution | #259, PR e, #316, #317, #322, #341, ADR-023 CI smoke test |

**v0.8.0** — Token hygiene (#340, #355, #356) is a quality gate for dark theme: dark mode CAN function without them, but shipping with hardcoded rgba decorations and no lint enforcement means regressions. Annotation correctness (#313, #318) is data integrity. #369 (dark-mode scrollbars) is a standalone visual fix that lands here as a prerequisite, not part of the full dark theme release. #377 (annotation offset resolving to wrong text) is a position-related bug — if investigation reveals it's systemic rather than a one-off, #260 moves into scope per the deferral criterion. #376 (monitor not pushing events) is a usability bug in the event push pipeline. #379 (Tiptap markdown round-trip drops tables and mangles formatting) is a data integrity issue — opening a file with tables and saving it silently destroys content. #381 (remove Accept/Reject from user annotations) and #382 (remove Replace/@Claude checkboxes from user toolbar) simplify the annotation UX — settle this before any framework migration so the simpler UI is what gets ported. #396 (HTTP API silent-failure gaps) is pre-v1.0 observability hardening — continuation of v0.6.4's #336 work but for the HTTP route layer instead of the stdio bridge; 1-3 line fixes per site, lands as one small PR.

**v0.9.0** — #259 is the **last breaking-change window before semver lock**. Before landing tool removals, grep the full test suite for each removed tool name and update/delete tests in the same PR. Keep tool stubs for one release that return structured errors pointing to the replacement; hard-remove in v0.10.0.

**Distribution coordination:** v0.9.0 is the first release where three surfaces (npm tarball, Cowork plugin via npx, Tauri desktop) must stay version-coherent. npm publish (GitHub Release trigger) before Tauri build. Document rollback strategy per surface.

#### If Svelte Go

| Release | Concern | Scope |
|---------|---------|-------|
| v0.10.0 | Svelte core migration | #312 Phase 2 (Vite plugin, `useYjsSync` rune, core hooks, Editor, DocumentTabs) |
| v0.11.0 | Svelte complete | #312 Phase 3-4 (remaining panels, React removal, `<svelte:boundary>` error recovery) |
| v0.12.0 | Dark theme | #59, `editor.css` dark overrides, #311, WCAG AA contrast, #369 verification |
| v0.13.0 | Desktop UI Tier 1 | #269 §1.1-1.5, PR f, #319, #378, #380 |
| v0.14.0 | Desktop UI Tier 2 + first-run | #265, #103, #269 §2.1-2.4/§3.1/§3.4 |
| v1.0.0 | Verification + bump | Soak test, notarization, update flow, accessibility gate, version bump |

**v0.10.0 test strategy:** E2E tests (`data-testid` selectors) survive unchanged. Unit tests rewritten against `@testing-library/svelte` per ported component, same PR. Floor: no net behavioral coverage loss. React and Svelte coexist during this release (transitional); dual-framework state MUST NOT persist beyond v0.11.0.

**v0.11.0:** Each new Svelte component includes ARIA attributes as definition-of-done (accessibility is continuous, not a v1.0 audit). CLI is structurally unaffected by the migration — verify with server tests + manual CLI smoke test.

**v0.12.0 dark theme completeness:** #355 landed (v0.8.0), `editor.css` has dark overrides for all content-area rules, awareness decorations verified in dark mode, WCAG AA contrast on annotation highlights against dark surface. Test in both Tauri WebView and browser.

#### If Svelte No-Go

| Release | Concern | Scope |
|---------|---------|-------|
| v0.10.0 | Dark theme | #59, `editor.css` dark overrides, #311, ErrorBoundary audit, WCAG AA |
| v0.11.0 | Desktop UI Tier 1 | #269 §1.1-1.5, PR f, #319, #378, #380 |
| v0.12.0 | First-run + desktop polish | #265, #103, #269 §2.1-2.4/§3.1/§3.4 |
| v1.0.0 | Verification + bump | Same as Svelte Go path |

**No Tailwind migration.** The `--tandem-*` CSS custom-property system is already semantically correct. Dark mode works via `[data-theme="dark"]` token switching, which keeps dark logic in CSS rather than markup. The ~290 inline styles are a code-style preference, not a correctness issue. Evaluate Tailwind post-1.0 if inline styles become a contribution barrier.

### MCP Tool Consolidation (#259)

| Tool | Action |
|------|--------|
| `tandem_suggest` | Deprecate (keep error-returning stub for one release, hard-remove in v0.10.0) |
| `tandem_getContent` | Hard-remove (superseded by `tandem_getTextContent`) |
| `tandem_getSelections` | Hard-remove (redundant with `tandem_checkInbox.activity.selectedText`) |
| `tandem_setStatus` | Merge into `tandem_status` (read/write with optional params) |
| `tandem_getActivity` | Keep |
| `tandem_getContext` | Keep |
| `tandem_removeAnnotation` | Keep |

Net result: ~28 tools (down from 31).

### v1.0.0 Exit Criteria

- **Windows:** Fresh profile → install Tauri → Claude Desktop Cowork workspace → `tandem_*` tools surface, no terminal
- **macOS:** Same flow, notarized `.app`, Gatekeeper-clean
- **Linux:** Same flow (Cowork if available, CLI otherwise)
- **Claude Code CLI:** Loopback-exempt, zero-config, tools work unchanged
- **Tauri update flow:** Download → install → restart verified on all three platforms
- **Tutorial:** Completes end-to-end on `sample/welcome.md`
- **Dark/light toggle:** Works in both desktop and browser
- **Accessibility:** ARIA verified with Windows Narrator + macOS VoiceOver, forced-colors mode, WCAG AA contrast
- **Observer soak test:** 6 concurrent documents, rapid tab switching, Y.Doc swaps, reconnect after network drop — no leaks
- **Uninstaller:** Strips all integration entries cleanly
- **npm tarball:** `npm pack` → install → `npx -y tandem-editor --version` on Linux + Windows
- **Zero open position-related bugs** (#260 deferral criterion)

### Deferred to Post-v1.0

| Item | Reason |
|------|--------|
| #260 — Coordinate system refactoring | All known position bugs fixed, tests solid, abstraction stable. Refactoring pre-1.0 risks regression. **Deferral criterion:** zero open position-related bugs at v1.0 branch cut. If any surface, #260 moves into scope. |
| #24 — Tailwind CSS 4 | Token system is correct. Tailwind is a code-style question, not correctness. |
| #153 — Inline images | Nice-to-have |
| #244 — Windows Playwright deadlock | CI workaround exists |
| Three-way merge / conflict UI (5c partial) | Complex; reload behavior acceptable for v1.0 |
| RANGE_MOVED auto-retry | Edge case |
| Flag markers / highlight color picker | Minor toolbar gaps |
| #312 (if no-go) | Svelte deferred to v2 |
| #321 — WS LAN auth | Only if WS exposed to LAN |
| #315 — DocumentStore interface | Architecture cleanup |
| #320 — Annotation schema v2 framework | Can wait |
| #314 — Export annotations as sharable file | Enhancement |
| #269 §2.5 — Disconnection/offline resilience | Sidecar health indicator; graceful degradation. Low risk, but not a v1.0 gate. |
| Desktop UI Tier 3 remainder (§3.2 tray, §3.3 context menus) | Polish |
| Desktop UI deferred (frameless window, vibrancy, multi-window, file explorer sidebar) | Identity decisions |
| Smaller follow-ups (#282, #283, #284, #287, #292, #299, #300) | Rolling maintenance; not blocking v1.0 quality |

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

---

## Future Extensions (v2+)

- **Progressive Web App (PWA)** — Lower priority now that the desktop app ships. Would still be useful as a lighter-weight alternative for users who prefer not to install a native app.
- Spreadsheet component (Handsontable/AG Grid)
- Claude Desktop support (MCP server already exists)
- Drawing/freeform annotation layer
- Exportable annotated documents (PDF with annotations)
- LibreOffice headless for high-fidelity .docx round-trip
- Code editing mode (CodeMirror 6)
- Standalone mode with direct Anthropic API connection
