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

### Shared (src/shared/)
- `types.ts` -- TypeScript interfaces shared between server and client
- `constants.ts` -- Colors, annotation types, defaults

## Key Patterns
- All document mutations go through the server's Y.Doc
- Claude's MCP tools mutate Y.Doc directly -> changes sync to browser via Hocuspocus
- Annotations stored in Y.Map('annotations'), not in the document content
- Server logs use console.error (stdout reserved for MCP protocol)
- Ranges use `resolveRange()` for safe targeting (not raw offsets)

## Security
- Server binds to 127.0.0.1 only
- Rejects UNC paths (prevents NTLM hash leakage)
- File size limit: 50MB
- Atomic file saves (write to temp, then rename)
