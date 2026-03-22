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
- Connects to Hocuspocus via WebSocket (y-websocket)
- Y.Doc and provider created in App.tsx, passed down to Editor
- Annotations observed from Y.Map('annotations') on the shared Y.Doc
- AnnotationExtension renders highlights/comments/suggestions as ProseMirror Decorations
- AwarenessExtension renders Claude's focus paragraph + broadcasts user selection to Y.Map('userAwareness')

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

## Implementation Status (as of 2026-03-20)

**Done (Steps 0-4):**
- [x] Step 0: Repo scaffolding, npm install, TypeScript compiles, Vite builds
- [x] Step 1: Hocuspocus on :3478, Tiptap editor with Yjs Collaboration, Y.Doc sync
- [x] Step 2: 20 MCP tools registered and functional (document, annotation, navigation, awareness)
- [x] Step 3: Annotations — server-side Y.Map storage + client-side ProseMirror Decoration rendering
- [x] Step 4: Awareness — Claude's focus paragraph, status text, user selection/typing broadcast

**Infrastructure fixes (2026-03-20):**
- [x] Switch browser provider from `y-websocket` → `@hocuspocus/provider` (protocol-incompatible with Hocuspocus v2)
- [x] MCP starts before Hocuspocus to beat Claude Code's initialize timeout
- [x] `freePort()` evicts stale processes on startup; uncaughtException handler survives malformed WS frames
- [x] `console.log = console.error` + `quiet: true` prevent stdout pollution of the MCP wire

**Remaining (Steps 5-8) — see [docs/roadmap.md](docs/roadmap.md) for full spec:**
- [x] Step 5a: Markdown round-trip — remark-based MDAST↔Y.Doc conversion, .md load/save, extractMarkdown for readable output
- [x] Step 5b: .docx review-only mode — mammoth.js→HTML→Y.Doc, read-only guards, tandem_exportAnnotations
- [ ] Step 6: Session persistence — save/resume Y.Doc + annotations across server restarts
- [ ] Step 7: Document groups — multi-document tabs, cross-reference tools
- [ ] Step 8: Polish — onboarding, auto-start, error handling, review mode UI

## Documentation
- [MCP Tool Reference](docs/mcp-tools.md) -- All 21 tools with params, returns, examples
- [Architecture](docs/architecture.md) -- Diagrams, data flows, coordinate systems
- [Workflows](docs/workflows.md) -- Real-world usage patterns
- [Roadmap](docs/roadmap.md) -- Full spec for Steps 5-8 (file I/O, sessions, groups, polish)
- [Design Decisions](docs/decisions.md) -- ADRs
- [Lessons Learned](docs/lessons-learned.md)

## Security
- Server binds to 127.0.0.1 only
- Rejects UNC paths (prevents NTLM hash leakage)
- File size limit: 50MB
- Atomic file saves (write to temp, then rename)
