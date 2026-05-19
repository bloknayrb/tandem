---
id: concept-multi-doc
type: concept
name: Multi-document (documentId)
last_verified: 2026-05-18
sources:
  - src/server/documents/
  - src/shared/constants.ts
  - docs/decisions.md#adr-010-docidfrompath-for-multi-document-room-names
  - docs/decisions.md#adr-033-document-registry-and-named-hocuspocus-lifecycle-interface
---

# Multi-document

Each open file gets a `documentId` (hash of absolute path via `docIdFromPath`) which becomes the Hocuspocus room name. All MCP tools accept an optional `documentId` parameter, defaulting to the active document.

The server broadcasts the open-documents list via `Y.Map('documentMeta')` on the `CTRL_ROOM` Y.Doc — clients render tabs from this. **`CTRL_ROOM` is reserved** — never use as a document ID.

**Startup ordering (HTTP mode):** documents that should appear on startup must be opened *before* Hocuspocus binds the WebSocket port. A stale browser tab that reconnects mid-startup can CRDT-merge an incomplete `openDocuments` list, removing tabs added after the bind. Stdio mode has no startup-document opens.

The document registry (`adr-033`) is the canonical lifecycle interface; file-open / close / switch all converge there. File-open specifically uses the named entry-point pipeline in `adr-034`.
