# Tandem -- Collaborative AI-Human Document Editor

## Quick Reference
- `npm run dev` -- Start both frontend (Vite on :5173) and backend (Hocuspocus on :3478 + MCP on stdio)
- `npm run dev:server` -- Backend only
- `npm run dev:client` -- Frontend only
- `npm test` -- Run vitest

## Architecture
Three layers: Browser (Tiptap) <-> Tandem Server (Hocuspocus + MCP) <-> Claude Code

### Server (src/server/)
- `index.ts` -- Entry point, starts both MCP (stdio) and Hocuspocus (WebSocket on port 3478)
- `mcp/` -- MCP tool definitions (document, annotations, navigation, awareness)
- `yjs/` -- Y.Doc management, the authoritative document state
- `file-io/` -- File format converters (markdown, plaintext, docx)
- `session/` -- Session persistence to %LOCALAPPDATA%\tandem\sessions\

### Client (src/client/)
- Tiptap editor with collaboration extensions
- Connects to Hocuspocus via WebSocket (@hocuspocus/provider)
- App.tsx manages multiple OpenTab objects (one per open document), each with its own Y.Doc + provider
- DocumentTabs shows tab bar; tab switching passes different ydoc/provider to Editor (key-based remount)
- Annotations observed from Y.Map('annotations') on the active tab's Y.Doc
- AnnotationExtension renders highlights/comments/suggestions as ProseMirror Decorations
- AwarenessExtension renders Claude's focus paragraph + broadcasts user selection to Y.Map('userAwareness')
- SidePanel: annotation filtering (type/author/status), bulk accept/dismiss, keyboard review mode (Tab/Y/N)
- ReviewSummary overlay shown when all pending annotations are resolved

### Shared (src/shared/)
- `types.ts` -- TypeScript interfaces shared between server and client
- `constants.ts` -- Colors, annotation types, defaults

## Key Patterns
- All document mutations go through the server's Y.Doc
- Claude's MCP tools mutate Y.Doc directly -> changes sync to browser via Hocuspocus
- Annotations stored in Y.Map('annotations'), not in the document content
- Claude's status stored in Y.Map('awareness') key 'claude'; user's selection in Y.Map('userAwareness')
- Server logs use console.error (stdout reserved for MCP protocol)
- Ranges use `resolveRange()` for safe targeting (not raw offsets)
- Two coordinate systems: "flat text offsets" (server side, includes heading prefixes) and "ProseMirror positions" (client side, structural). Extensions convert between them.
- tandem_edit rejects ranges that overlap heading markup (e.g., "## ") — target text content only
- User→Claude communication via `tandem_checkInbox`: user actions (highlights, comments, questions) and responses (accepted/dismissed) are surfaced once per call. Call between tasks.
- Multi-document: each open file gets a unique documentId (hash of path), used as both Map key and Hocuspocus room name. All MCP tools accept optional `documentId` param, defaulting to the active document.
- Server broadcasts `openDocuments` list via Y.Map('documentMeta') on each doc's Y.Doc. Client listens and syncs tabs.

## Implementation Status (as of 2026-03-22)

**Done (Steps 0-6 + Phase 1):**
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
- [x] Phase 1 - New tools: tandem_listDocuments, tandem_switchDocument (24 total MCP tools)

**Infrastructure fixes (2026-03-20):**
- [x] Switch browser provider from `y-websocket` → `@hocuspocus/provider` (protocol-incompatible with Hocuspocus v2)
- [x] MCP starts before Hocuspocus to beat Claude Code's initialize timeout
- [x] `freePort()` evicts stale processes on startup; uncaughtException handler survives malformed WS frames
- [x] `console.log = console.error` + `quiet: true` prevent stdout pollution of the MCP wire

**Remaining — see [docs/roadmap.md](docs/roadmap.md):**
- [ ] Phase 2: Cowork integration — configurable port/URL, cross-platform sessions, MCP registration
- [ ] Phase 3: .docx comments export — Word-native `<w:comment>` elements via JSZip
- [ ] Phase 4: Distribution — launch channels, positioning, pricing
- [ ] Phase 5: Discovery sprint — CLI mode, VS Code extension, tracked changes, etc.

## Known Issues
- **MCP stdio disconnect (Issue #8):** MCP transport drops after first `tandem_open` under Claude Code. Server code works correctly in standalone testing. Root cause is in Claude Code's transport, not Tandem.
- **Y.js "Invalid access" warnings:** Harmless stderr noise during session restore. Data syncs correctly.
- Never call Tandem MCP tools in parallel — stdio transport disconnects immediately.

## Documentation
- [MCP Tool Reference](docs/mcp-tools.md) -- All 24 tools with params, returns, examples
- [Architecture](docs/architecture.md) -- Diagrams, data flows, coordinate systems
- [Workflows](docs/workflows.md) -- Real-world usage patterns
- [Roadmap](docs/roadmap.md) -- Phase 2+ roadmap, known issues, future extensions
- [Design Decisions](docs/decisions.md) -- ADRs (001-011)
- [Lessons Learned](docs/lessons-learned.md) -- 13 lessons including multi-doc gotchas

## Gotchas (save yourself time)
- **stdout is sacred.** The MCP stdio transport owns stdout. `console.log`, `console.warn`, and `console.info` are ALL redirected to stderr in index.ts. If you add a dependency that logs to stdout, it will corrupt the MCP wire and the server will silently disconnect. Always verify with `node -e "require('new-dep')"` and check stdout is clean.
- **Y.XmlText must be attached before populating.** Inserting formatted text into a detached Y.XmlText reverses segment order. Always attach to Y.Doc first, then insert text (two-pass pattern in mdast-ydoc.ts). See Lesson 9.
- **Y.XmlElement.setAttribute needs `as any` for numbers.** TypeScript types say string-only but Tiptap stores numeric heading levels. Cast with `as any`.
- **`npm run dev` only starts Vite (client).** The MCP server is a separate process managed by Claude Code. To test server changes, you must restart the MCP server (via `/mcp` in Claude Code). Vite hot-reloads client code automatically.
- **Hocuspocus rooms = document IDs.** The room name IS the document ID from `docIdFromPath()`. `__tandem_ctrl__` is reserved for the bootstrap coordination channel. Never use it as a document ID.
- **Session files live at `%LOCALAPPDATA%\tandem\sessions\`.** Keyed by URL-encoded file path. Delete them to force a fresh load (useful when debugging session restore issues).
- **The `freePort()` function kills stale processes on port 3478 at startup.** This is intentional — it clears zombie Hocuspocus instances from crashed servers. But it means you can't run two Tandem instances simultaneously.
- **Coordinate system mismatch is the #1 source of annotation bugs.** Server uses flat text offsets (includes `## ` heading prefixes + `\n` separators). Client uses ProseMirror positions (structural, no prefixes). `flatOffsetToPmPos` and `pmPosToFlatOffset` convert between them. If annotations appear in the wrong place, check the conversion.

## Security
- Server binds to 127.0.0.1 only
- Rejects UNC paths (prevents NTLM hash leakage)
- File size limit: 50MB
- Atomic file saves (write to temp, then rename)
