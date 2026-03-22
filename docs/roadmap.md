# Roadmap — Remaining Implementation Steps

Steps 0-6 are complete. Phase 1 (document groups + polish) is complete. This document contains the design spec for remaining work.

## Step 5: File I/O

### Goal
Load files into Y.Doc and save Y.Doc back to source files. Lossless for .md/.txt, review-only for .docx.

### 5a: Markdown (lossless round-trip) — DONE

**Files:** `src/server/file-io/markdown.ts`, `src/server/file-io/mdast-ydoc.ts`

Implemented via unified/remark with MDAST↔Y.Doc conversion:

- **Load:** `loadMarkdown()` parses markdown via remark into an MDAST tree, then `mdastToYDoc()` converts it to Y.XmlFragment elements with Tiptap-compatible nodeNames and formatted Y.XmlText for inline marks.
- **Save:** `saveMarkdown()` converts Y.Doc back to MDAST via `yDocToMdast()`, then serializes with remark-stringify. Round-trip preserves headings, bold/italic/strikethrough, links, inline code, lists (ordered/unordered/nested), blockquotes, code blocks, images, horizontal rules, and hard breaks.
- **Read:** `extractMarkdown()` returns readable markdown for `tandem_getTextContent` on .md files.
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

### 5c: File change detection

- `fs.watch()` on source files while open in Tandem
- On external change: three-way merge (original snapshot, external change, Tandem edits)
- For .md/.txt: text-based merge via `diff3` library
- For .docx: section-level merge using headings as boundaries
- Conflict UI: show both versions side-by-side, user picks or merges
- Flag annotations on externally-changed text: "The text this annotation referred to has been modified outside Tandem"

### Verification
- Open a .md file, edit in Tandem, save, reopen — content preserved exactly
- Open a .docx file — content appears, annotations work, original .docx unchanged
- Edit a file externally while open in Tandem — merge dialog appears

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

---

## Step 8: Polish

### Goal
First-run experience, error handling, and UX refinements.

### 8a: Launch Experience

- Server auto-starts when Claude Code calls any Tandem tool (check PID in `.tandem/.server-info`)
- Server auto-stops after 30 min idle (`IDLE_TIMEOUT` in constants.ts)
- Browser auto-open (removed — `open` package wrote to stdout, corrupting the MCP wire; user opens http://localhost:5173 manually)

### 8b: Onboarding

- Pre-loaded sample document (`sample/welcome.md`) with existing Claude annotations
- Claude sends one message on first launch: "I've left a few suggestions on this document. Try accepting one."
- Three interactions: (1) accept an annotation, (2) select text and Ask Claude, (3) make an edit
- Target: 90 seconds

### 8c: Review Mode — PARTIALLY DONE

Keyboard review mode (Tab/Y/N) is implemented. Annotation filtering (type/author/status), bulk accept/dismiss, and review summary overlay are implemented.

Remaining:
- Configurable threshold banner ("Claude has 14 suggestions. Review in sequence or filter by type.")
- Document dimming in review mode
- E (edit) keyboard shortcut

### 8d: Interruption Model

- Claude never interrupts while user is actively typing (3-second debounce — already implemented)
- Queued annotations delivered on pause via side panel badge
- High-priority findings (factual errors) use distinct yellow caution indicator
- Three modes: "Interrupt freely", "Hold until I pause" (default), "Review mode — hold everything"

### 8e: Error Handling

- `RANGE_STALE` error: auto-retry with re-resolved range (currently documented but not implemented)
- File lock detection: clear message telling user to close Word
- WebSocket reconnection: automatic, no data loss (Yjs handles this)
- Large file warnings: alert at 50+ pages about potential slowness

### 8f: Toolbar Enhancements — PARTIALLY DONE

- ~~Highlight button~~ — implemented (yellow default)
- ~~Comment button~~ — implemented
- Flag markers (red/yellow/green)
- ~~Ask Claude: select text → floating input → response as annotation~~ — implemented (Ctrl+Shift+A)
- Suggest: propose a change for Claude to evaluate
- ~~Accept All / Dismiss All buttons~~ — implemented in SidePanel
- ~~Review Mode toggle~~ — implemented (Ctrl+Shift+R)
- Highlight color picker (5 colors available server-side, UI picker not yet built)

### Verification
- First launch shows sample document with annotations
- Keyboard shortcuts work in review mode
- Error messages are clear and actionable
- Server auto-starts and auto-stops correctly

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
- No Windows installer — requires Node.js + Claude Code (PWA install planned for v2)

## Future Extensions (v2+)

- **Progressive Web App (PWA)** — Add a web app manifest + service worker so users can "install" Tandem from the browser. Gives a real app window (no browser chrome), taskbar icon, and offline-capable shell. Vite has `vite-plugin-pwa` for zero-config setup. Pairs well with auto-start — user clicks the PWA icon, server starts, editor opens.
- Spreadsheet component (Handsontable/AG Grid)
- Claude Desktop support (MCP server already exists)
- Drawing/freeform annotation layer
- Exportable annotated documents (PDF with annotations)
- LibreOffice headless for high-fidelity .docx round-trip
- Code editing mode (CodeMirror 6)
- Standalone mode with direct Anthropic API connection
