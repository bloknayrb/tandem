---
id: concept-coord-yjs-relative
type: concept
name: Y.RelativePosition
last_verified: 2026-05-18
sources:
  - src/shared/positions/
  - src/server/positions.ts
---

# Y.RelativePosition

CRDT-anchored position that survives concurrent edits and reorderings. Stored alongside flat offsets in `AnchoredRange` (created by `anchoredRange()`); the relative position is the durable anchor, the flat offset is the cached value at write time.

Created in one call with the flat offset via `anchoredRange(start, end)` — never construct one manually. The `relRange` survives normal edits but **dies when the Y.Doc instance is replaced** (e.g., after `reloadFromDisk`).

`refreshRange` (in `src/server/positions.ts`) strips dead `relRange` anchors and re-anchors from the cached flat offset. Critical: a stale `relRange` that resolves to `null` blocks the lazy re-attachment recovery path — deletion is better than preservation. See lessons-learned for the case study.

When `buildDecorations()` (client) falls back to flat offsets because the `relRange` failed to resolve, it emits `console.warn` — check the browser console for CRDT degradation signals.
