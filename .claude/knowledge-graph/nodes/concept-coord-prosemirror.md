---
id: concept-coord-prosemirror
type: concept
name: ProseMirror position
last_verified: 2026-05-18
sources:
  - src/client/positions.ts
  - src/shared/positions/
---

# ProseMirror position

Client-side structural coordinate used by Tiptap. Tracks block boundaries (paragraph open/close tokens count as positions), not raw character index — so a `pos` of 5 may be "inside paragraph 1, character 4" rather than "5 chars from doc start."

Conversion to flat offsets happens at the client/server boundary (`src/client/positions.ts`). Decorations and selection anchors use ProseMirror positions internally because that's Tiptap's native coordinate; everything that crosses the wire to the server gets converted.

The three-coordinate-system design (flat / ProseMirror / Y.RelativePosition) is unified by the position modules — see `concept-coord-flat-offset` and `concept-coord-yjs-relative`, both decided by `adr-018`.
