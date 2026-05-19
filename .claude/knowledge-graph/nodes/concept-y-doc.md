---
id: concept-y-doc
type: concept
name: Y.Doc
last_verified: 2026-05-18
sources:
  - src/server/yjs/
  - src/server/events/
  - docs/architecture.md#y-map-observer-ownership
---

# Y.Doc

Per-document Yjs CRDT instance; the authoritative collaborative state for one open file. The server owns the canonical Y.Doc, browser tabs sync to it via Hocuspocus over WebSocket.

Each open file gets exactly one Y.Doc keyed by `documentId` (hash of file path, see `concept-multi-doc`). Annotations, awareness, document metadata, and content all live as Y.Map / Y.XmlFragment subkeys on this root — see `Y_MAP_*` constants in `src/shared/constants.ts` (governed by `rule-ymap-key-constants`).

Every write to a Y.Doc — server-side or browser-side — must go through one of the five origin-tagged wrappers in `src/shared/origins.ts` (governed by `rule-origin-helpers`, decided by `adr-031`). The chosen origin determines which observers (channel events, durable-annotation sync, tombstone ledger) react to the change.

Hocuspocus replaces the Y.Doc instance on `onLoadDocument`. The `onDocSwapped` callback in `provider.ts` reattaches server event-queue observers to the new instance — a runtime warning fires if the callback is missing (see lessons-learned).

A reserved Y.Doc named `CTRL_ROOM` holds server-wide state (Solo/Tandem mode, open-documents list) — never use `CTRL_ROOM` as a document ID.
