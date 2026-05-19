---
id: rule-validate-range
type: rule
name: Use validateRange + anchoredRange
last_verified: 2026-05-18
sources:
  - src/server/positions.ts
---

# Rule: Use validateRange + anchoredRange

Range inputs (from MCP tools, channel events, etc.) must pass through `validateRange()` before use, and any range stored on an annotation or used for re-anchoring must be produced by `anchoredRange()` — which creates the `{flat, relRange}` pair in one call.

**Why this matters:** raw flat offsets become invalid the moment the document changes. The `relRange` (Y.RelativePosition) is the durable anchor that survives edits. Storing only the flat offset means annotations drift on the next edit.

`anchoredRange()` is the single chokepoint that guarantees the invariant "every persisted range has both a flat offset and a relRange." Bypassing it produces annotations that look right until the document is edited and then silently misalign.

**Applies to:** every MCP tool that accepts a `range` parameter (`tandem_edit`, `tandem_comment`, `tandem_highlight`, `tandem_suggest`, `tandem_flag`, `tandem_resolveRange`, etc.) and every server-side range construction.
