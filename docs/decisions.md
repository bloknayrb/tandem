# Design Decisions

## ADR-001: Tiptap over ProseMirror Direct
**Decision:** Use Tiptap (React wrapper) instead of raw ProseMirror.
**Rationale:** Tiptap provides React bindings, extension system, and built-in collaboration support. Reduces boilerplate significantly.

## ADR-002: Hocuspocus for Yjs WebSocket, @hocuspocus/provider on the Client
**Decision:** Use Hocuspocus (MIT) as the Yjs WebSocket server and `@hocuspocus/provider` as the browser WebSocket provider.
**Rationale:** Same team as Tiptap. Built-in document management, persistence hooks. `@hocuspocus/provider` is required — `y-websocket` is protocol-incompatible with Hocuspocus v2, which prepends a `writeVarString(documentName)` to every message frame. `y-websocket` misreads that length byte as the outer message type, silently routing the browser to a phantom `""` document instead of `"default"`.

## ADR-003: MCP over REST for Claude Integration
**Decision:** Expose tools via MCP (stdio) instead of REST API.
**Rationale:** Claude Code discovers MCP tools natively. No curl wrappers needed. Tools appear in Claude's tool list automatically.

## ADR-004: .docx Review-Only by Default
**Decision:** .docx files open in review-only mode. Never overwrite the original.
**Rationale:** mammoth.js import is lossy (no complex tables, tracked changes, footnotes). Review-only prevents accidental data loss.

## ADR-005: Node-Anchored Ranges for Overlays
**Decision:** Overlays use node-relative anchors (nodeId + offset) instead of character offsets.
**Rationale:** Character offsets break under concurrent editing. Node anchors survive edits to other paragraphs.

## ADR-006: Console.error for Server Logs
**Decision:** Use console.error for all server-side logging.
**Rationale:** MCP stdio transport uses stdin/stdout for protocol messages. Any console.log output would corrupt the MCP protocol stream.

## ADR-007: Y.Map for Annotations
**Decision:** Store annotations in a Y.Map on the Y.Doc rather than in the document content.
**Rationale:** Annotations are metadata, not content. Storing them separately means they sync independently and don't pollute the document structure.

## ADR-008: Shared MCP Response Helpers
**Decision:** Extract `mcpSuccess`, `mcpError`, `noDocumentError` into `response.ts` instead of inlining the response envelope in every tool.
**Rationale:** 16+ tools each needed the same 3-line wrapping pattern. Centralizing it eliminated 267 lines of boilerplate and ensures consistent error shape across all tools.
