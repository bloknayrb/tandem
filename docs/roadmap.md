# Roadmap — Remaining Implementation Steps

Steps 0-6 are complete. Phase 1 (document groups + polish) is complete. Sprint 5 (file open + E2E tests) is complete. Channel push (Issue #106) is complete. Step 8 polish items (undo, interruption mode, Word comment import, port polling, session auto-restore) are complete. UX features (tab overflow, toast notifications, connection errors, annotation editing, onboarding tutorial) are complete. Tab close fix (Issue #149) and getTextContent offset fix (Issue #148) are complete. npm global install (Step 9, PR #161) is complete. This document contains the design spec for remaining work.

## Active — Toward v1.0

The v0.12.0 prep batch (8 parallel units, PRs #634–#641) shipped 2026-05-14. With the foundation in place, all subsequent work is scoped against the **v1.0 thesis** (Bryan, 2026-05-14):

> Every core feature rock-solid + redesign complete + pending decisions finalized. Quality > speed. Date floats; ~2026-06-10 target is soft.

**Triage source of truth:**

- `docs/v10-triage.md` — every row marked Core / Defer / Cut
- `~/.claude/plans/it-occurs-to-rustling-newt.md` (Bryan-local; not in repo) — wave structure, exit criteria, verification gates, risk register

**Working wave plan** (each ~2–5 days; one Bryan-review pass at end of each wave; max 2 CRITICAL/HIGH PRs per wave):

| Wave | Focus | Notes |
|------|-------|-------|
| 0 | Apple Developer cert procurement (Bryan-led calendar gate); §1H verification audit (done, zero hits) | Done — #428 closed; per-release hardware verification lives in [release-smoke-checklist.md](release-smoke-checklist.md) |
| 1 | Stability bug-bash + redesign chrome + editor surfaces (shipped 2026-05-15; released in v0.13.0) | #631 #616 #244 done; SettingsModal, status-bar held-count, ConnectionBanner polish, updater banner+dot, slash menu, paged docx, ReplyThreadOverlay, margin view PR1+PR2 shipped via #662–#674, #679. D11 bundled fonts reverted (#678) — see #680 |
| 1b | Wave-1 follow-ups (released in v0.13.0) | **#680** re-land D11 fonts with BubbleMenu positioning fix; **#681** retrofit `/api/open` callers to `openServerPath`; **#682** strict `SettingsTabContext` registry typing; **#683** #649 margin view PR 3 of 3 (rail-collapse + narrow viewport) |
| 2 | Settings → Network panel + multi-provider models registry (D4) — released in v0.13.0 | Two-tier UX (Connection visible + Advanced collapsed); models registry CRUDs Anthropic + #477 local + others |
| 3 | Annotation migration (single coordinated release) | **Shipped:** #313 content-hash identity (v0.13.5); AR5 Word-import batch-promote (v0.13.0, #756); AR6 tutorial annotations (v0.13.0); the **hardening pass** (promote-path + channel-emit + import→promote test coverage; AR6 live-anchor freshness guard) landed early, in **v0.13.6** (not v0.14.0 as planned). The user-visible upgrade-toast and the ADR-034 lifecycle-module refactor remain deferred (not in the hardening tier). |
| 4 | #477 remainder + #576 | **Shipped in v0.14.0:** PR 3c-ii-c (auto-config removal) + #576 docx body export (plus #1069 conflict detection and #1068 comment writeback beyond plan). #477 PRs 1/3a/3b/3c-i/3c-ii-a/3c-ii-b + auto-launcher 4a/4b had shipped default-on in v0.13.0. The non-MCP-provider adapter (unshipped half of PR 5) moved to **v1.1** per the D4 amendment (2026-06-11, below). |
| 5 | Cross-platform install + #316 Cowork macOS/Linux | Install matrix, observer soak, accessibility gate. (#428 cert/notarization itself closed in v0.14.0 — what remains here is the real-hardware install verification per the smoke checklist.) |
| 5L | Licensing (#1116, ADR-040 §3/§4/§6) — releases as v0.16.0 | Scope owned by §"v1.0 Licensing (ADR-040)" below. Parallelizable with Wave 5 (which is hardware-bound); commercial infra runs alongside as a Bryan-led calendar gate (#1117). |
| 5M | Local models (#1123, ADR-039) — releases as v0.17.0 | D4 amendment (b), Bryan 2026-06-11: local-provider slice (Ollama/LM Studio) returns to v1.0 at full-collaborator depth. Canonical scope: ADR-039. **The M0 capability spike (kill-gate, quote-anchored quantified bar, kill date 2026-07-02) runs NOW, parallel with Wave 5** — its GO/FALLBACK/NO-GO verdict returns to Bryan before M1–M4 ship as v0.17.0. Cloud BYO keys stay v1.1. |
| 6 | Final | Gate-flag flip (requires Commercial-readiness criterion), version bump, CHANGELOG `[1.0.0]`, npm publish, Tauri release |

**v1.0 Core scope** (full table in §"v1.0 Release Plan" below): #477 + #576 + #316 are all Core (was Defer); #313 + #244 + #616 promoted; new surfaces from D-decisions: full-screen first-run modal (D4), ~~multi-provider models registry (D4)~~ (amended twice 2026-06-11 — **local slice back in v1.0** as Wave 5M/#1123; cloud BYO keys v1.1; canonical record in ADR-039), settings-icon update-dot (D6). Licensing (ADR-040, #1116/#1117) added to Core 2026-06-11 as Wave 5L.

**Out of scope for v1.0:** authorship gutter (D2 picked per-character only), annotation thread reactions (D5), inline diff hunk-staging UI (D3 surface deferred — option B locked for v1.1 revisit), mobile/responsive (D7), author chip/avatar (D8), compact density (D9), most §1D refactors except #313, **cloud BYO-models (OpenAI/Gemini API keys) + their adapter — v1.1 per the D4 amendments (the *local*-model slice is back in v1.0 as Wave 5M/#1123; cloud rows stay behind `BYO_MODELS_ENABLED` until v1.1; canonical record in [ADR-039](decisions.md#adr-039-non-mcp-model-providers-local-slice-v10-cloud-slice-v11))**, concurrent multi-agent (Claude + local simultaneously — #438/#452).

## Integration Policy (ADR-038)

> Tandem's integration contract is **MCP**. The default integration is **Claude** (Claude Code + Claude Desktop) — it's what we recommend, what we test against, and it ships with the channel push, cowork, plugin monitor, and auto-launcher features. Any MCP-capable client can connect to the same MCP HTTP endpoint and use the same 28 tools, but the Claude-specific transports don't apply. Other clients are **best-effort, MCP-contract-compatible, not validated** today.
>
> **Integration setup** runs through the integration setup wizard (#477 PR 3). Silent auto-configuration of Claude's MCP config on startup was removed in #477 PR 3c-ii-c; setup is now wizard-driven and explicit.

See [ADR-038](decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration) for the full policy, the four-term glossary, the auto-launch and auto-configuration sub-decisions, and the list of Claude-specific extras vs Claude-side dev tooling. The integration picker work below (#477) is the materialization of this policy in code, not a new direction.

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
- **documentId parameter**: All 26 existing MCP tools accept optional `documentId` (backward compatible)
- **New tools**: `tandem_listDocuments`, `tandem_switchDocument` (24 tools total)
- **DocumentTabs**: Tab bar UI with format icons, active indicator, close buttons
- **Per-tab Y.Doc**: Editor manages separate Y.Doc + HocuspocusProvider per open document
- **broadcastOpenDocs**: Server writes open document list to Y.Map('documentMeta') on active doc

### 7b: Document Groups (Future)

Deferred — only if demand appears:

- Named groups (e.g., "February Report Review") with `tandem_createGroup`
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
- Server auto-stop on idle was planned but not wired up
- Browser auto-open (removed — `open` package wrote to stdout, corrupting the MCP wire; user opens http://localhost:5173 manually)
- ~~Browser file open~~ — implemented: "+" button in tab bar opens FileOpenDialog (path input or drag-and-drop upload), HTTP API endpoints (`/api/open`, `/api/upload`)

### 8b: Onboarding — DONE

**Files:** `src/server/file-io/tutorial.ts`, `src/client/hooks/useTutorial.ts`, `src/client/components/OnboardingTutorial.svelte`

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
- ~~Version indicator in the UI (#435)~~ — **SHIPPED** (PR #460, 2026-04-28). About footer in Settings popover showing version + MCP SDK version via `useAppInfo` hook fetching `/api/info`.
- ~~"View Changelog" button in Settings panel (#437)~~ — **SHIPPED** (PR #463, 2026-04-28). Opens bundled `CHANGELOG.md` as a read-only document tab via `POST /api/open` with `readOnly: true`.
- ~~Highlight color picker~~ — **SHIPPED** (`HighlightColorPicker.svelte`; 4-color palette yellow/green/blue/pink)

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
- **8 event types**: `annotation:created`, `annotation:accepted`, `annotation:dismissed`, `annotation:reply`, `chat:message`, `document:opened`, `document:closed`, `document:switched`

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

**Files:** `src/server/mcp/document-service.ts`, `src/server/mcp/api-routes.ts`, `src/server/mcp/document.ts`, `src/client/components/DocumentTabs.svelte`

Closing a tab in the editor now actually closes the document on the server. Previously, tab close only affected the client UI without cleaning up the server-side document state.

- **`closeDocumentById()`** shared helper in `document-service.ts` — single source of truth for document close logic (session save, doc removal, broadcast), used by both `tandem_close` MCP tool and `POST /api/close` HTTP endpoint
- **`POST /api/close`** HTTP endpoint in `api-routes.ts` — browser-callable close, parallel to `/api/open`
- **Client `handleTabClose`** calls `POST /api/close` with optimistic adjacent-tab selection
- **Close button debounced** via `closingIdsRef` in `DocumentTabs.svelte` to prevent double-close from rapid clicks
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

- **`tandem`** — Starts the server and opens the editor (Tauri WebView in desktop, or `http://127.0.0.1:5173` in dev)
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

Tauri project scaffolded (`src-tauri/`), Node.js bundled as `node-sidecar` via `externalBin`, server resources bundled (`dist/server/`, `dist/channel/`, `dist/client/`, `sample/`). Sidecar spawned on launch; `TANDEM_TAURI_SIDECAR=1` toggles production-only suppression for noisy dependency logs.

### Step 2: Origin + permissions — DONE

Production WebView uses `tauri://localhost` origin. Server CORS and DNS-rebinding middleware updated to accept it. CSP configured in `tauri.conf.json`. Capabilities split: `default.json` (core + shell + fs + dialog), `desktop.json` (single-instance + window-state + updater).

### Step 3: Sidecar lifecycle hardening — DONE

Health polling (200ms interval, 15s timeout), exponential backoff restart (up to 3 attempts), early-exit if sidecar dies before healthy, error dialog on exhausted retries. `kill_sidecar()` on `RunEvent::Exit` prevents orphan processes.

### Step 4: MCP auto-setup — SUPERSEDED (removed in #477 PR 3c-ii-c)

Originally `run_setup()` POSTed to `/api/setup` with bundled `nodeBinary` + `channelPath` after health check, on every launch. **Removed in #477 PR 3c-ii-c** (ADR-038 §2b): setup is now wizard-driven, the channel-shim path is injected into the sidecar as `TANDEM_CHANNEL_DIST` on spawn, the "no AI client detected" nudge lives in the wizard's connect step (the #1084 "Install Claude Code" empty state), and the tray "Setup AI Assistant" item re-opens the wizard. The non-interactive CLI equivalent is `tandem setup --apply`.

### Step 5: System tray + window management — DONE

Window hide-on-close (tray "Quit" is the exit path). Tray menu: Open Editor, Setup Claude, Check for Updates (separator), About, Quit. Left-click tray icon shows window. Single-instance plugin: second launch focuses existing window instead of spawning a new one.

### Step 6: Auto-updater — DONE

`tauri-plugin-updater` checks GitHub Releases `latest.json` on launch and every 8 hours. Ed25519-signed artifacts (`TAURI_SIGNING_PRIVATE_KEY` secret). `bundle.createUpdaterArtifacts: true` generates `.sig` files in CI. Before `app.restart()`, kills sidecar and waits for port to clear.

### Step 7: Build pipeline + CI — DONE

GitHub Actions workflow (`.github/workflows/tauri-release.yml`) — builds on Windows/macOS/Linux, signs with `tauri-action`, publishes installers + `latest.json` to GitHub Releases. Cross-platform basename fix and CodeQL security hardening applied post-merge.

Future hardening (not blocking release):
- Verify end-to-end update flow (download → install → restart) on all three platforms — procedure documented in [release-smoke-checklist.md](release-smoke-checklist.md)
- Code-sign macOS `.app` + notarization (#428) — requires Apple Developer certificate; without it, Gatekeeper shows "damaged" error on download. v1.0 gate. Per-release hardware verification lives in [release-smoke-checklist.md](release-smoke-checklist.md).
- Windows installer smoke test — NSIS covered per-release by [release-smoke-checklist.md](release-smoke-checklist.md); the MSI artifact (`targets: "all"` also builds one) is not covered
- ~~Node.js 20 → 24 GitHub Actions migration (CI-wide, all workflow files) — deadline June 2, 2026~~ **Done 2026-06-11.** This was about the GitHub Actions *runtime* (JS actions), not the project's Node: GitHub forced the node24 default on 2026-06-02 and removes node20 entirely 2026-09-16. First-party actions bumped to node24 majors (`checkout@v6`, `setup-node@v6`, `upload-artifact@v7`) across all five workflow files; `node-version: 22` is unchanged and correct (matches `engines` + the bundled sidecar Node).

### Future Tauri Enhancements

- **File association**: Register `.md`/`.docx`/`.txt` file extensions so double-clicking opens in Tandem
- **Deep link / open-with**: Pass file path from second-instance launch into the running server via `POST /api/open`
- **Linux tray fallback**: Improve UX when `libappindicator3-dev` is absent (currently logs and continues)
- **Linux/KDE title bar button placement** (#552): `tauri-plugin-decorum` positions window controls on the right (GNOME convention); KDE Plasma users with left-side decoration preference will see a mismatch. No per-platform config knob in decorum — fix requires a CSS-only `[data-platform="linux"]` mirror or a KDE-specific adjustment. Needs a KDE tester to confirm the issue and validate any fix. Tagged `needs-tester`.
- **Updater dialog theming** (#561): dialogs now parented to main window (`MessageDialogBuilder::parent()`) so they center over the app and inherit Windows 11 dark-mode chrome from decorum. v1.0 direction (D6, locked 2026-05-14) is an in-app banner + small dot badge on the titlebar settings gear (filed as #660), not a full modal.

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
- **PR e (DONE)** — Cowork per-workspace installer (read-modify-write `installed_plugins.json` / `known_marketplaces.json` / `cowork_settings.json`), Windows firewall scoping to detected Hyper-V VM subnet, NSIS uninstaller cleanup (includes #436 PREUNINSTALL binary-name fix). Merged 2026-04-26 (PR #370, v0.8.0).
- **PR f (DONE)** — Settings UI + onboarding in Tauri. Enable/disable Cowork mode, show detected VM subnet, surface plugin status. Merged 2026-04-26 (PR #371, v0.8.0). ADR-025 decided Svelte Go; the React implementation ships now, Svelte rebuild in v0.13.0.

### Cowork integration status

Cowork integration is **verified end-to-end** as of v0.7.1 (2026-04-20). Both Claude Code CLI and Claude Desktop Cowork workspaces surface `tandem_*` tools via the stdio bridge (`npx -y tandem-editor mcp-stdio`). The Cowork plugin bridge was introduced in tandem-editor@0.6.0 and first cross-platform working in @0.6.2 (Windows `workspaces` packaging bug). See [ADR-023](decisions.md#adr-023-cowork-plugin-bridge--stdio-via-npx-not-http-prs-301-304--claude-default-integration) for the decision trail.

Remaining Cowork work (#316, #317, #322) is polish — making the installer turnkey on macOS/Linux and adding cross-platform firewall scoping. Not a capability blocker. Deferred from v0.9.0 to v0.15.0 (requires macOS/Linux validation hardware).

---

## Integration Picker + Browser Deprecation (#477) — v1.0 Wave 6

First-run wizard that lets users choose their AI integration, plus dropping the browser distribution path entirely (Tauri-only going forward). The integration choice drives startup behavior, auto-launch strategy, and default layout. Triaged **Core** for v1.0 on 2026-05-14.

**Motivation:** The integration picker materializes [ADR-038](decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration) — Tandem speaks MCP; Claude is the default. **The default integration's depth is a flagship feature**, not a constraint to route around: Claude's continuity features (CLAUDE.md, hooks, skills, memory) ride on top of the same `--session-id` + `--resume` spawn primitive Spike A validated, and the wizard's one-click Claude setup is what makes them accessible to non-developers. The wizard also exposes additional integration slots (Claude Desktop, local LLM, OpenAI, Gemini) per D4. The browser distribution path also added ongoing maintenance overhead (CORS, Host-header allowlist, `TANDEM_OPEN_BROWSER` branches, npm global install) without serving the primary Tauri user base.

### Phase 0: Required Spikes

All three Phase 0 spikes shipped. The two CLI integration spikes resolved 2026-05-17 (PR #712); the sidecar launcher spike resolved 2026-05-14 (PR #640).

- **Spike A — session resume round-trip: SHIPPED (GO with caveats).** PR #712 (merged 2026-05-17). Validates `--session-id <uuid>` + `--resume <uuid>` against Claude Code v2.1.143 (6/6 scenarios pass). Full report at `docs/spikes/cli-session-resume-spike.md`. PR-4 caveats: launcher must pin `cwd` deterministically (Claude auto-loads CLAUDE.md from parent dir); catch non-zero exit on stale `--resume` and fall back to fresh `--session-id` spawn; session ID is non-secret (visible in `ps aux`); use `crypto.randomUUID()` (RFC 4122 v4) only. anthropics/claude-code#44607 referenced in the original plan is about the *opposite* problem (reading session ID from within a running session) — not relevant to PR 4.
- **Spike B — plugin monitor viability: SHIPPED (NO-GO on dropping the flag in v1.0).** PR #712 (merged 2026-05-17). `--plugin-dir <path>` does NOT activate `experimental.monitors[].command` in Claude Code v2.1.143 under any tested mode (`-p` print, faked-TTY interactive startup, `claude plugin install` from path-source). `--dangerously-load-development-channels` remains functional in v2.1.143 despite being hidden from `--help`. Full report at `docs/spikes/plugin-monitor-viability-spike.md`. **Decision below at line 442 is overridden by this empirical finding.**
- **Spike C — sidecar launcher validation: SHIPPED.** PR #640 (merged 2026-05-14). Validates the sidecar launcher path. Review findings addressed in commit cfb154d; #642–#645 filed as the PR-4 hardening quartet (atomic write, mandatory backup, schema validation, backup-or-prompt UX). #646 (`TANDEM_TAURI_SIDECAR` migration cleanup) is a separate Defer per triage.

### PR Sequence (5 PRs)

| PR | Concern | Prerequisite | Status |
|----|---------|--------------|--------|
| 1 | Schema + storage + migration framework (`IntegrationConfig` discriminated union, zod validator, atomic writes) | — | **SHIPPED** PR #728 (2026-05-17). Scaffolding only (no production consumer); subsequent PR 3 sub-PRs wire it up. Two integration kinds (`claude-code`, `claude-desktop`); LM Studio / Ollama / `other-mcp` and `tokenSecretRef` deferred to PR 3 migrations per adversarial review. |
| 2 | **Browser deprecation** — remove `TANDEM_OPEN_BROWSER`, `open-browser.ts`, npm CLI start path, CORS localhost wildcard | — (independent) | **SHIPPED** PR #637 |
| 3 | First-run wizard UI — integration picker (D4 picked **option a, full-screen modal**), existing-user detection via `last-seen-version`, pre-selection from existing MCP config. **Replaces auto-configuration of Claude** per ADR-038 §2b — every integration (Claude included) is configured via the wizard, never silently. `tandem setup` CLI becomes a TTY-mode wrapper around the wizard; auto-configuration code in `src-tauri/src/lib.rs` and `src/cli/setup.ts` is removed in the final sub-PR. **Broken into sub-PRs for review tractability** — each ships independently. | PR 1 | v1.0 wave 6 |
| 3a | Existing-MCP-config introspection (`readExistingTandemEntries` — reads `~/.claude.json` + Claude Desktop config without mutating them). Foundation for the wizard's pre-population + migration UX. **SHIPPED** PR #729 (2026-05-17). | PR 1 | v1.0 wave 6 |
| 3b | v1→v2 schema migration: re-adds `tokenSecretRef` to integration kinds + `other-mcp` kind (cut from PR 1 per adversarial review). Keychain backend: `@napi-rs/keyring` (lazy-loaded via `createRequire` so headless CI does not crash on import; dependency-injectable for tests). **SHIPPED** PR #730 (2026-05-17). | PR 3a | v1.0 wave 6 |
| 3c-i | Wizard UI (full-screen modal, Svelte 5) behind a Settings toggle. Wizard consumes `readExistingTandemEntries` (PR 3a), `IntegrationsStore` (PR 1), and `Keychain` (PR 3b); keychain features gracefully degrade on Tauri (`KeychainUnavailableError` → env-var fallback guidance) pending the Rust bridge follow-up. **SHIPPED** PR #731 (2026-05-17). | PR 3a + PR 3b | v0.13.0 (shipped; first-run auto-open default-on via 3c-ii-b) |
| 3c-ii | Auto-configuration removal from `src-tauri/src/lib.rs` and `src/cli/setup.ts` per ADR-038 §2b. **Split into three sub-PRs after adversarial review** — see `docs/plans/477-pr-3c-ii-auto-config-removal.md`. ≥1-week soak gate on PR 3c-i was waived by user decision (2026-05-18). | PR 3c-i (soak waived) | v0.13.0 |
| 3c-ii-a | Server library factor: move `applyConfig`, `applyConfigWithToken`, `detectTargets`, `buildMcpEntries`, `installSkill`, `validateChannelShimPrereq` from `src/cli/setup.ts` to `src/server/integrations/apply.ts`. Pure refactor, zero behavior change. `src/cli/setup.ts` keeps back-compat re-exports until 3c-ii-c. **SHIPPED** PR #747 (2026-05-18). | PR 3c-i | v0.13.0 |
| 3c-ii-b | Wizard apply path + first-run auto-open. Schema bump v2→v3 (adds `apply: "create" \| "update" \| "skip"` field). New `POST /api/integrations/apply` endpoint separate from persistence. Path-traversal hardening per security review B1 (apply validates `configPath` against `detectTargets()` enumeration, ignores request-body paths; UNC rejected). Existing-entry re-validation per security review B3 (HTTP `url` must be loopback; stdio `command` allowlisted). First-run auto-open driven by `integrations.json` state — transport-agnostic, covers both Tauri AND npm-browser per contrarian review B3. Settings toggle becomes "Reopen wizard" affordance. Channel-shim removal surfaced as confirmation diff item, not silent delete. **Gated on redesign-wave settling** — touches `src/client/App.svelte` and wizard UI surfaces in motion. | PR 3c-ii-a + redesign-wave settling | v0.13.0 |
| 3c-ii-c | Delete `/api/setup` route, `src-tauri/src/lib.rs:run_setup()`, `SETUP_URL` const. Rewrite `tandem setup` as non-interactive `tandem setup --apply [--target=…]` (per contrarian review S2 — amends ADR-038 §2b wording from "TTY-mode wrapper" to "non-interactive `--apply`"; ADR amendment landed in this PR). Drop back-compat re-exports from `src/cli/setup.ts` (rotate-token repointed to `apply.ts`). Adds `TANDEM_CHANNEL_DIST` sidecar injection so desktop channel-push survives the `/api/setup` deletion, and relocates the "no AI client detected" nudge into the wizard. Full doc sweep across README / architecture / user-guide / workflows / CLAUDE.md / ADR-038 §2b status / CHANGELOG. | PR 3c-ii-a + PR 3c-ii-b + manual Tauri-build confirmation | **SHIPPED** v0.14.0 |
| 3c-tauri-keychain | `src-tauri/src/keychain.rs` exposes `keychain_get` / `keychain_set` / `keychain_delete` Tauri commands backed by the `keyring` crate (already in `Cargo.toml`). Client-side `ClientKeychainBackend` abstraction picks Tauri commands when `isTauriRuntime()` is true and HTTP loopback otherwise — secrets never traverse the loopback HTTP boundary on the desktop app. **SHIPPED** PR #732 (2026-05-17). | PR 3c-i | v1.0 wave 6 |
| Phase-3-docs | MCP-first reframe of marketing surfaces per ADR-038: README audience-tier restructure (Just want to use it / Power-user setup / Connecting other MCP clients); `docs/positioning.md` policy quote + distribution-risk resolution; `docs/architecture.md` Integration Compatibility section + four-term glossary + "Claude-default" prefixes on channel-specific sections; framing sentences on `docs/mcp-tools.md` / `docs/user-guide.md` / `docs/workflows.md`; scope note on `docs/lessons-learned.md` and `skills/tandem/SKILL.md`. Pure docs sweep — no code risk. **Post-merge manual task:** update the GitHub repo description and "About" sidebar (set via `gh repo edit` outside the source tree) to match the new framing — neither is in the source tree so this PR cannot do it automatically. **SHIPPED** PR #734 (2026-05-17). | PR 3c-i | v0.13.0 |
| 4 | Auto-launch + supervisor — spawn Claude Code CLI with correct flags, hook point after `Promise.all([startMcpServerHttp, startHocuspocus])`. **PR-4 quartet (#642–#645) hardens:** atomic `O_EXCL` temp+rename, mandatory `.claude.json` backup, schema validation, "backup-or-prompt" UX. **Claude-specific by design** per ADR-038 §2 — other providers in the registry are user-driven startup for v1.0; per-provider auto-launchers are future work. | PR 1 + #642–#645 quartet | v0.13.0 (shipped; default-on, opt-out via `TANDEM_DISABLE_LAUNCHER=1`) |
| 5 | Multi-provider model registry (D4) — Anthropic + local LLM (#477) + OpenAI / Gemini / others; CRUD with per-model config; new Settings → Models page beyond the wizard. Non-MCP providers (OpenAI, Gemini) integrate via Tandem's Agent SDK adapter per ADR-038 §3, not as direct MCP clients — adapter design owned by a future ADR (likely ADR-039); ~~whether the adapter ships in v1.0 wave 6 or slips to v1.1 is open~~ **resolved 2026-06-11, twice — canonical record in [ADR-039](decisions.md#adr-039-non-mcp-model-providers-local-slice-v10-cloud-slice-v11):** the **local slice ships v1.0** (Wave 5M / v0.17.0, #1123); the cloud slice (OpenAI/Gemini) ships **v1.1**. | PR 4 | **local: v0.17.0 (#1123) · cloud: v1.1** |

### Key Decisions (locked)

- `IntegrationConfig`: discriminated union, zod validator, atomic writes, migration framework
- Tauri permissions use `core:` prefix
- Hook point: AFTER `Promise.all([startMcpServerHttp, startHocuspocus])` fires, not at line 255
- `TANDEM_OPEN_BROWSER` replaced with `TANDEM_TAURI_SIDECAR`
- ~~Plugin monitor is canonical; launcher drops `--dangerously-load-development-channels`~~ **Overridden by Spike B (PR #712, 2026-05-17) and grounded in [ADR-038](decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration) §extras (auto-launcher is Claude-specific by design).** `--plugin-dir` does not activate `experimental.monitors[]` in Claude Code v2.1.143; the dev-channels flag remains functional. PR 4 keeps `--dangerously-load-development-channels server:tandem-channel` for v1.0. Revisit when Claude Code surfaces monitor activation via `--plugin-dir` or another zero-marketplace path (see `docs/spikes/plugin-monitor-viability-spike.md` "Follow-up issues", including F5 — the GitHub-marketplace install path validation promoted from a deferred item to a v1.0-blocking spike by the docs reframe).
- Layout coupling server-side via extended `/api/info`; no client-side race
- Existing users detected via `last-seen-version` file; wizard pre-selects based on existing MCP config
- **D4 (2026-05-14):** first-run wizard is option (a) full-screen modal **with multi-provider model registry**. Anthropic + #477 local + OpenAI/Gemini/etc.; user CRUDs models with per-model config; the registry lives at Settings → Models, beyond the wizard. Per [ADR-038](decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration) §2, the wizard explicitly surfaces the auto-launch asymmetry — Claude auto-launches in v1.0; other providers require user-driven startup. Per ADR-038 §2b, the wizard *replaces* today's silent auto-configuration of Claude; auto-config code is removed in PR 3. **Amended 2026-06-11:** the multi-provider registry half of D4 moves to **v1.1**. The registry UI shipped in v0.13.0 but was deliberately hidden in v0.14.0 (`BYO_MODELS_ENABLED=false`, #1018/#1022) because no server-side LLM client consumes the stored keys — configuring a model did nothing and users concluded the app was broken. This resolves the question the PR-5 row left open ("whether the adapter ships in v1.0 wave 6 or slips to v1.1 is open"). The wizard half of D4 (one-click Claude Code connect) is v1.0 and shipped. ~~Stated consequence: v1.0 charges (ADR-040) while the reachable audience is Claude-Code users; the multi-provider breadth mechanism of ADR-040 §1 arrives in v1.1.~~ **Amended again same day (b), Bryan: the local-model slice returns to v1.0** (full-collaborator depth, M0 kill-gate + fallback clause, license applies identically with local models) — **canonical record: [ADR-039](decisions.md#adr-039-non-mcp-model-providers-local-slice-v10-cloud-slice-v11)**; tracker #1123. Net consequence: v1.0's reachable audience is Claude users + local-model users; cloud BYO keys arrive v1.1.

### Deferred milestones (post-reframe)

Tracked here so #477 PRs know what they inherit; not v1.0-blocking unless noted:

- **Data-model refactor (PR 1):** when `IntegrationConfig` lands, `author: "claude" | "user" | "import"` becomes provider-keyed (or a `provider` sidecar field is added). `src/cli/setup.ts` `TargetKind` becomes registry-driven. CSS tokens `--tandem-author-claude` / `--tandem-claude-focus-bg` renamed when a second provider's authorship color is needed. See ADR-038 §consequences.
- **Auto-configuration removal (PR 3):** `src-tauri/src/lib.rs` Tauri-startup auto-write + `src/cli/setup.ts` `tandem setup` command both removed in the PR that ships the wizard, per ADR-038 §2b. **Migration UX gap:** existing users have stale Tandem entries in `~/.claude.json` written by earlier Tandem versions; the wizard's first-run flow must detect pre-existing entries and either preserve them as "Claude Code: already configured" or re-prompt. Design decision owned by PR 3.
- **F5 / F2 — GitHub-marketplace install validation:** ~~Phase 0-extended spike by the docs reframe.~~ **Complete 2026-05-17 — see `docs/spikes/marketplace-install-spike.md`. NO-GO on monitor activation.** Marketplace install delivers MCP servers + skill but does NOT activate `experimental.monitors[]` in v2.1.143. Implication for the v1.0 marketing rewrite: the README leads non-developers with the Tauri desktop app (auto-configures Claude with `--dangerously-load-development-channels` silently); marketplace install is documented as the "MCP + skill" baseline, not the channel-push path. Source-form correction: `claude plugin marketplace add bloknayrb/tandem` (the `github:` prefix is rejected by v2.1.143).
- **Per-provider auto-launchers:** ADR-038 §2 commits to Claude-only auto-launch for v1.0. If we add auto-launchers for Claude Desktop, local LLM, or OpenAI (via Agent SDK adapter), each gets its own ADR.
- **MCP-bridge for non-MCP providers:** ADR-038 §3 commits to Agent SDK adapter for OpenAI/Gemini. ~~Whether it ships in v1.0 wave 6 or slips to v1.1 is open~~ **resolved 2026-06-11, twice:** local slice → v1.0 (Wave 5M, #1123; mechanism owned by ADR-039, may diverge from the adapter wording); cloud slice → v1.1.
- **Other MCP-client validation:** Cursor, Continue.dev, Claude Desktop standalone (not via cowork) — none validated today. Tracked as follow-up; ADR-038 acknowledges the gap.

---

## v1.0 Release Plan

**Thesis (Bryan, 2026-05-14):** every core feature rock-solid + redesign complete + pending decisions finalized. Quality > speed. Date is soft (~2026-06-10 target floats).

Triage source of truth: `docs/v10-triage.md` (per-row Core/Defer marks). Wave plan: see "Active — Toward v1.0" section at the top of this doc, and `~/.claude/plans/it-occurs-to-rustling-newt.md` (Bryan-local; not in repo).

### Locked Design Decisions (2026-05-14)

| #   | Decision                                       | Locked outcome                                                                                                                            |
| --- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Density × textSize collision                   | Density controls **interface chrome only**; font-size controls **editor body only**. Verified 2026-05-14 — `useDensity.ts` writes only `[data-density]` (→ `--tandem-space-*`); `App.svelte` writes only `--tandem-editor-font-size`. No collision. |
| D2  | Authorship visual                              | **Per-character only**. Gutter and hybrid rejected. Defers the §1G gutter row in `docs/v10-triage.md`.                                    |
| D3  | Diff/Apply-edit hunk staging                   | Option **B (modal-based)** locked for the v1.1 revisit; the surface itself defers from v1.0.                                              |
| D4  | First-run wizard                               | Option **(a) full-screen modal** + ~~**multi-provider model registry**~~ (Anthropic + #477 local + OpenAI/Gemini/etc.). Settings → Models page beyond the wizard. Per [ADR-038](decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration) §2/§2b: wizard replaces silent auto-configuration of Claude; Claude is the only provider auto-launched in v1.0; non-MCP providers via Agent SDK adapter (ADR-039 TBD). **Amended 2026-06-11 (a): registry half → v1.1; (b) same day: local slice → back in v1.0** (Wave 5M / v0.17.0, #1123). Wizard half shipped v0.13.0–v0.14.0. Canonical record: [ADR-039](decisions.md#adr-039-non-mcp-model-providers-local-slice-v10-cloud-slice-v11). |
| D5  | Annotation reply thread                        | **Expanded thread, no reactions.**                                                                                                        |
| D6  | Updater UX                                     | **Banner (#561) + small colored dot badge** on titlebar settings gear.                                                                    |
| D7  | Mobile / narrow-window                         | **Defer.**                                                                                                                                |
| D8  | Author chip/avatar on cards                    | **Defer.** Current text label is fine.                                                                                                    |
| D9  | Compact density                                | **Defer.**                                                                                                                                |
| D10 | Selection mini-toolbar suppression             | Suppress when slash-query active, find bar focused, palette open (per HANDOFF).                                                           |
| D11 | Editor body fonts                              | **Bundle locally** in `dist/client/fonts/` (Tauri offline-friendly).                                                                      |
| D12 | macOS / Linux distribution                     | **Full parity** for v1.0 (notarized macOS + AppImage Linux + Windows). Fallbacks: notarized macOS only → Windows-only with macOS in v1.0.1. |

### v1.0 Core Scope Summary

Full per-row table is in `docs/v10-triage.md`. Highlights:

**Strategic (all Core; were TBD in original plan):**
- **#477 Local LLM** — PR-2 + all three Phase 0 spikes (A/B/C) merged; PRs 1/3a/3b/3c-i/3c-ii-a/3c-ii-b + auto-launcher 4a/4b shipped **default-on in v0.13.0** (no feature-flag soak). PR 3c-ii-c (auto-config removal) landed v0.14.0; the non-MCP-provider work (PR 5) split on 2026-06-11: **local slice → v0.17.0 (#1123), cloud slice → v1.1** (ADR-039). Spike B's NO-GO means PR 4 retains `--dangerously-load-development-channels server:tandem-channel`.
- **#576 .docx write-back** — body export shipped v0.14.0, and the comment round-trip (planned v1.1) shipped early in the same release (#1068, with #1069 external-conflict detection). The 2026-05-28 kill date was met; LibreOffice fallback never needed.
- **#316 Cowork macOS/Linux auto-setup** — Core (was Defer). Couples to #428 cert work.

**Bug-bash Core:** #428 macOS install, #631 sidecar restart silent failure, #616 Y.Doc cleanup eviction, #244 E2E Windows Playwright deadlock.

**Polish promoted to Core:** #539 (custom keyboard shortcut UI), #596 (toggle text decorations), #597 (document statistics in status bar), #265 (welcome tutorial update — bundle into AR6), #313 (content-hash annotation identity — sequence with AR5).

**Redesign Core surfaces (§1G in `docs/v10-triage.md`):** selection mini-toolbar (#653 — BubbleMenu in PR #656 awaiting review), slash command menu, editor body fonts (D11 bundle locally), paged .docx layout, annotation reply thread expansion, solo-mode held-count badge → status bar, `SettingsModal.svelte` sibling (sibling-component pattern), Settings → Network panel (two-tier: Connection visible + Advanced collapsed), Settings → Models registry (D4 multi-provider — built in v0.13.0, flag-gated off in v0.14.0; local slice re-enables in v0.17.0 per #1123 M2/M4, cloud rows in v1.1), AR5 Word-import batch-promote (shipped v0.13.0; v0.14.0 hardening pass), AR6 tutorial annotations (shipped v0.13.0; v0.14.0 hardening pass), connection-degradation banner polish, first-run wizard (D4), shortcuts modal (⌘/), settings-icon update-dot (D6 sub-piece), empty-state with slash menu.

**Cross-platform Core:** Apple Developer cert + macOS notarization (calendar gate; start NOW), full-parity install matrix (D12), updater banner (#561 — D6 banner direction locked; supersedes PR #647).

### v1.0 Licensing (ADR-040) — Wave 5L / v0.16.0

[ADR-040](decisions.md#adr-040-audience-and-monetization-individuals-same-canvas-moat-free-beta-to-one-time-license) §3/§4/§6 (Accepted) commit v1.0 to license-to-run: the public build self-trials, requires a valid offline Ed25519-signed license past the trial, and auto-updates from a license-checked endpoint. Previously this work was decided but untracked (the #394 row sat in the Deferred table while declaring itself v1.0 work). Now tracked:

- **#1116** — engineering tracker (PR sequence L1 license format/verify → L2 trial gate + activation UX, dark behind a build flag → L3 license-checked update endpoint → L4 grandfathering + docs). Ships as **v0.16.0**, parallel to Wave 5 hardware work; with v0.17.0 (local models) now between v0.16.0 and v1.0.0, the updater's license-checked endpoint transition gets exercised **twice** before launch (v0.16.0→v0.17.0, then v0.17.0→v1.0.0).
- **#1117** — commercial infra, Bryan-led calendar gate (MoR checkout, issuance webhook, LLC + accountant, **ADR-040 §5 BUSL re-scope by counsel — still Proposed; prerequisite for charging**). Mirrors the Wave-0 Apple-cert pattern: external parties own the timeline, so it starts now.
- The flip rule is owned by the **Commercial-readiness exit criterion** (below) — see it for the conditions and the not-ready fallback. Landing the gate code dark in v0.16.0 needs nothing from §5 counsel.

### Release Cadence

Historical compressed (full detail in CHANGELOG + git log):

| Release   | Concern                                                            | Status              |
| --------- | ------------------------------------------------------------------ | ------------------- |
| v0.8.0    | Token hygiene + annotation correctness + Cowork PRs e–f            | Released 2026-04-26 |
| v0.9.0    | MCP API cleanup + redesign data model + UX polish                  | Released 2026-04-28 |
| v0.9.1    | ADR-027 surface cleanup + Tiptap round-trip fixes                  | Released 2026-05-01 |
| v0.10.0   | React → Svelte 5 conversion (39 .tsx files replaced)               | Released 2026-05-03 |
| v0.10.1   | Plugin URL + auth resolution (hotfix)                              | Released 2026-05-04 |
| v0.10.2   | Cowork real-time push + `plugin.json` userConfig                   | Released 2026-05-05 |
| v0.11.0   | Dark theme + toolbar redesign + AR1–AR3 + scratchpad/palette/find/outline | Released 2026-05-11 |
| v0.11.1   | Titlebar consolidation                                             | Released 2026-05-13 (superseded by v0.11.2) |
| v0.11.2   | Hotfix: Svelte effect_update_depth_exceeded on Tauri launch        | Released 2026-05-13 |
| v0.12.0   | 8-unit prep batch (#634–#641): #477 PR-2 browser deprecation, #477 Phase 0 sidecar spike, #576 spikes A+B, AR4, anchor-drift test, release scaffolding | Shipped 2026-05-14 |

v1.0 series (concrete waves; see "Active — Toward v1.0" for the wave-structure table):

| Release    | Concern                                                                                          | Status              |
| ---------- | ------------------------------------------------------------------------------------------------ | ------------------- |
| v0.13.0    | Stability bug-bash + redesign chrome + editor surfaces + Settings (Network + Models registry)    | Released 2026-05-25 |
| v0.13.5    | Design-system re-skin umbrella (`feat/design-system-impl` #939) + customizable keyboard shortcuts (ADR-041) + annotation GC/content-hash rename recovery (#313/#318) | Released 2026-05-29 |
| v0.13.6    | Motion language (#798 Ph 1–4) + native context menus (#923) + markdown fidelity (#981) + inline images (#153) + `tandem_appendContent` (#979) + Word reply threads (#1000) + `tandem doctor` (#319-partial, incl. `--json`) + **AR5/AR6 annotation-migration hardening (landed here, ahead of the v0.14.0 plan)** | Released 2026-06-04 |
| v0.14.0    | #477 PR 3c-ii-c (auto-config removal) + #576 docx body export (+ #1069 conflict detection, #1068 comment writeback) + MCP structured output (#1080) + backup restore (#1086) + uninstall scrub + Copy Diagnostics + generation gate + BYO-models flag-off (#1018/#1022) | Released 2026-06-10 |
| v0.15.0    | Cross-platform install matrix + #316 Cowork macOS/Linux (real-hardware verification of the closed #428 notarization work) | Planned             |
| v0.16.0    | Licensing (#1116, ADR-040 — scope in §"v1.0 Licensing"); commercial infra (#1117) in parallel    | Planned             |
| v0.17.0    | Local models (#1123, ADR-039): outbound client + tool-use loop + registry re-enable (local slice) + provider-keyed attribution. M0 spike runs earlier, parallel with v0.15.0 (kill date 2026-07-02) | Planned             |
| v1.0.0     | Final verification, observer soak, security + performance + commercial-readiness + local-model gates, accessibility gate, gate-flag flip, version bump | Planned             |

The wave-structure table (top of "Active — Toward v1.0") owns wave numbering and membership; this cadence table maps versions to concerns. Waves recombine across versions based on review bandwidth and merge cadence — Waves 3–4 landed across v0.13.6/v0.14.0, v0.15.0 is Wave 5, v0.16.0 is Wave 5L (licensing), v0.17.0 is Wave 5M (local models; its M0 spike runs during Wave 5), v1.0.0 is Wave 6. The original soft v1.0 target (~2026-06-10) has passed by design — the date floats per the thesis (quality > speed); no new date is set. Source of truth for wave membership remains the wave plan in `~/.claude/plans/it-occurs-to-rustling-newt.md` (Bryan-local; not in repo — **note: neither the 5L/v0.16.0 nor the 5M/v0.17.0 insertion (both 2026-06-11) is reflected there yet**).

### v1.0.0 Exit Criteria

**Install matrix (D12 = full parity):**
- Windows 10 22H2 + Windows 11 23H2 (verify both — older WebView2 may differ)
- macOS 14 Sonoma (Intel + Apple Silicon) — notarized .app, no Gatekeeper warning
- macOS 26.1 Apple Silicon (M1 — explicit #428 verification)
- Ubuntu 22.04 LTS (.AppImage + .deb)
- Fedora 39 (.rpm)

**Functional gates:**
- Claude Code CLI: loopback-exempt, zero-config, tools work unchanged
- Tauri update flow: download → install → restart verified on all three platforms; sidecar restart succeeds; no data loss
- Tutorial: completes end-to-end on `sample/welcome.md`; tutorial annotation anchors hold (anchor-drift regression test)
- Dark/light toggle: works in both desktop and browser
- ~~Multi-provider models registry (D4): user can add/remove/edit Anthropic + #477 local + at least one third-party provider~~ **Replaced per D4 amendment (2026-06-11):** first-run wizard one-click Claude Code connect works on all three platforms (detect → connect → `/mcp` shows Tandem tools); **cloud** BYO-models surfaces remain hidden until v1.1 (local surfaces re-enable in v0.17.0 per #1123 M4); **and** the keychain secrets layer (shipped v0.13.0, still holding live v0.13.x user keys) passes a store→read round-trip against the real OS keychain (Windows Credential Manager + macOS Keychain) on the smoke-checklist machines — CI cannot cover this (no libsecret/keychain in runners), and the struck criterion was previously the only release-time check that touched it
- Updater: banner appears; settings-icon dot badge clears on settings open or update install
- **Local model (added 2026-06-11, gated on #1123 M0):** with the M0-named model+quantization via Ollama on smoke-checklist hardware, fully offline — connect via wizard/Models → model reads the document → places a comment on user-selected text → proposes a replacement the user accepts → chat round-trip. An M0 FALLBACK verdict swaps in the structured-output criterion; either way the verdict + evidence go to Bryan first (ADR-039 depth bar).

**Soak gates:**
- Observer soak: 6 docs open, rapid tab switching, Y.Doc swap (load + close), network drop + reconnect — zero leaks, zero broken observers; 1-hour session: 50+ annotations, 20+ tab opens/closes, 5+ network blips
- Annotation upgrade soak: fresh install of v0.11.2, create 50 annotations across 6 docs, close, upgrade to v1.0 RC, reopen — zero loss, no migration error toasts; AR5 batch-promote tested end-to-end with .docx file containing legacy Word reviewer comments
- `.claude.json` shapes corpus (PR-4): empty, named-pipe transport, `tandem-channel` block, non-Tandem MCP servers, multiple workspace entries, concurrent Claude Desktop write, 5MB+ size

**Security gate (added 2026-06-11):**
- `security-reviewer` agent sweep over **all HTTP routes added since v0.13.0**, enumerated at RC time by diffing route registrations in `src/shared/api-paths.ts` / `src/server/mcp/api-routes.ts` / `src/server/mcp/routes/` / `src/server/integrations/api-routes.ts` — the enumerated diff is the floor, not a fixed list. Initial floor (v0.13.6–v0.14.0): store/reclaim-lock, diagnostics, backups + backups/restore, rename, document/raw, document/reload, docx-conflict/resolve, integrations/install-claude-code, integrations/claude-cli-status, sessions + sessions/delete + sessions/clear, shutdown, plus the `/api/info` generationId and `/health` hasSession fields.
- Method: the three-surface audit pattern from lessons-learned (CORS allowlist × Host-header validation × loopback-vs-LAN exposure), plus path validation on filesystem-touching routes. **Outbound surfaces are explicitly in scope even though the route-diff enumeration cannot produce them** — at RC this means the v0.17.0 outbound LLM client (#1123 M1: user-supplied endpoint SSRF posture, redirect/DNS handling, response size/time bounds).
- Threshold: **zero unresolved HIGH findings**; findings recorded as linked issues. Self-graded by the security-reviewer agent — accepted at two-person scale.
- **First run 2026-06-11: PASS** — zero HIGH/MEDIUM; two LOW consistency findings + one INFO filed as #1121 (loopback-gate uniformity on four document-mutation routes; path disclosure to token-authenticated LAN on `GET /api/sessions`). Close #1121 before the RC re-run.

**Performance gate (added 2026-06-11):**
- Fixture: a ~50-page markdown document produced by a checked-in generator script (to be added with the gate's first run; until then, generate ad hoc and note the seed).
- Pass conditions on the smoke-checklist machines (the same hardware set as §1–§3 of [release-smoke-checklist.md](release-smoke-checklist.md)): open-to-interactive < 3s; annotation create/accept reflects in the editor < 500ms; no frame stall > 100ms during a scripted top-to-bottom scroll (DevTools performance trace).
- Existing partial coverage acknowledged: annotation-store perf is pinned by `tests/server/annotations/perf.test.ts` (#335) and the #609 atomic-update freeze fix has a regression pin — this gate covers the *render/scroll/interaction* path those don't.
- Risk, stated: this gate is **unvalidated until RC** (no measurement has been run against it yet); if the fixture fails today, that is a finding to fix, not a reason to relax the numbers. Verifies the "~50 pages" Known-Limitations envelope.

**Commercial readiness (added 2026-06-11; gates the license flag flip — see #1116/#1117):**
- ADR-040 §5 (BUSL re-scope) **Accepted** — counsel-drafted text landed in `LICENSE` + `docs/decisions.md`
- MoR checkout live end-to-end: test purchase → issuance webhook → signed license delivered → activates a gate-ON build
- Grandfather licenses issued to known beta users
- If any of these are not ready at code-complete: the date floats (per thesis); **the gate flag does NOT ship enabled**. A v1.0 demanding a license nobody can buy is a brick.

**Accessibility:**
- Windows Narrator full editor walkthrough
- macOS VoiceOver full editor walkthrough
- Forced-colors mode (Windows high-contrast)
- axe-core scan zero CRITICAL findings
- Keyboard-only navigation (Tab through all surfaces)
- WCAG AA contrast verified across all status colors and themes (re-verify post-redesign)

**Cleanup gates:**
- Uninstaller strips all integration entries cleanly (Windows + macOS .app removal — no orphan `.claude.json` entries)
- Zero open position-related bugs (#260 completed in v0.8.0; residual issues #425, #426 stay non-blocking)
- Inline annotation decorations visible on pending annotations after MCP creates them — verified in Tauri build

**Documentation gates:**
- CHANGELOG `[1.0.0]` section finalized with every Core item linked to the row in `docs/v10-triage.md`
- BSL LICENSE present + change-date confirmed (per `project_bsl_license_decision.md`)
- All redesign artboards from HANDOFF either shipped or explicitly deferred to v1.1+ with reason
- All §2 D-decisions linked to ADR or PR comment

### Deferred to Post-v1.0

Per Bryan's 2026-05-14 triage marks. Rows not listed here are Core (see "v1.0 Core Scope Summary" above and `docs/v10-triage.md` for full per-row detail).

| Item | Reason |
|------|--------|
| ~~#260 Coordinate system refactoring~~ | **Completed v0.8.0** (PR #423). Residual #425, #426 stay non-blocking. |
| #24 Tailwind CSS 4 | Token system is correct. Tailwind is a code-style question. |
| #153 Inline images | Nice-to-have. |
| #299 "Show in file explorer" | Bryan triage Defer. |
| #314 Export annotations as sharable file | Bryan triage Defer. |
| #319 Diagnostics dashboard | Bryan triage Defer. |
| #103 Session management browser | Bryan triage Defer. |
| #269 §2.1-2.4/§3.1/§3.4 desktop UI tier 2 polish | Identity decisions; v1.1+. |
| Three-way merge / conflict UI | Complex; reload behavior acceptable for v1.0. |
| RANGE_MOVED auto-retry | Edge case. |
| #321 WS LAN auth | Rare use case. |
| #315 DocumentStore interface | Architecture cleanup; refactor for refactor. |
| #320 Annotation schema v2 framework | Bryan triage Defer. |
| #318 Tombstone / GC for annotation store | "Year+ scale" per issue body; not v1.0-relevant. |
| #438 Per-client identity (Code + Cowork) | Prereq for #452 multi-Claude; v1.1+. |
| #452 Multi-Claude concurrent | Depends on #438. |
| #433 Cowork installer TOCTOU | Bryan triage Defer. |
| #552 Linux/KDE titlebar verification | Bryan triage Defer. |
| #378 Windows file picker | Current dialog works. |
| #560 tauri-driver E2E harness | Test-infra polish. |
| #632 Workflow-nudge perf | Hooks/CI polish. |
| #633 Extract `matchShortcut` helper | Refactor for refactor. |
| #282 Extract SSE consumer | Refactor for refactor. |
| #630 PR #628 follow-ups | Bryan triage Defer (originally bundled with #428). |
| #646 `TANDEM_TAURI_SIDECAR` migration cleanup | Bryan triage Defer. |
| Authorship gutter (per-paragraph thread) | D2 picked per-character only. |
| Authorship gutter pulses (Claude reading indicator) | D2-adjacent; defer. |
| Author chip/avatar on annotation cards | D8 defer. |
| Compact density artboard | D9 defer (depends on D1). |
| Mobile / narrow-window responsive | D7 defer. |
| Annotation thread emoji reactions | D5 — explicit cut, not just defer. |
| Diff/Apply-edit hunk staging surface | D3 option B locked for v1.1 revisit; surface defers from v1.0. |
| #316/#317 firewall scoping (#317 only) | #316 is now Core; #317 paired-defer. |
| ~~#394 Monetization~~ | **Moved out of this table 2026-06-11 — it was never post-v1.0 work.** This row's own text said "in-app license verification + server-side trial gate + license-checked updater are v1.0 features" while sitting in the deferred table, leaving the work decided ([ADR-040](decisions.md#adr-040-audience-and-monetization-individuals-same-canvas-moat-free-beta-to-one-time-license)) but untracked. Now scheduled as Wave 5L / v0.16.0 — see §"v1.0 Licensing (ADR-040)" above; tracked in #1116 (engineering) + #1117 (commercial infra, Bryan-led). |
| Desktop UI Tier 3 remainder (§3.2 tray, §3.3 context menus) | Polish. |
| Desktop UI deferred (frameless window, vibrancy, multi-window, file explorer sidebar) | Out of scope per HANDOFF. |
| Smaller follow-ups (#283, #284, #287, #292, #300) | Rolling maintenance; not blocking v1.0 quality. |

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
- **Additional model providers** — local providers (Ollama/LM Studio) ship in v1.0 (Wave 5M, #1123); cloud BYO keys (Anthropic API / OpenAI / Gemini) in **v1.1** per the D4 amendments (ADR-039 is the canonical record); v2 adds providers as needed via the same registry surface.
- Spreadsheet component (Handsontable/AG Grid)
- Claude Desktop support (MCP server already exists)
- Drawing/freeform annotation layer
- Exportable annotated documents (PDF with annotations)
- LibreOffice headless for high-fidelity .docx round-trip
- Code editing mode (CodeMirror 6)
- Standalone mode with direct Anthropic API connection (no MCP client required — an alternative to the MCP integration path, not a replacement)
