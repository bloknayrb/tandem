---
id: concept-coord-flat-offset
type: concept
name: Flat text offset
last_verified: 2026-05-18
sources:
  - src/server/positions.ts
  - src/shared/positions/
  - docs/architecture.md
---

# Flat text offset

Server-side coordinate: an integer character index into the output of `extractText()`. **Includes heading prefixes** (e.g., `## ` counts as 3 characters), which is the user-visible view that MCP tools operate on.

This is the canonical input/output coordinate for all MCP range tools. Range inputs are validated by `validateRange()` and converted to `AnchoredRange` (flat offsets + Y.RelativePositions) via `anchoredRange()` in one call — see `rule-validate-range`.

Heading prefixes in flat offsets are why `tandem_edit` rejects ranges that overlap heading markup (`rule-edit-rejects-heading-markup`): editing the `## ` itself would corrupt block structure.

Conversion functions live in `src/server/positions.ts`:
- `resolveToElement(flatOffset)` — flat → Y.XmlElement + intra-element position
- `refreshRange(range)` — re-derives flat offsets from Y.RelativePositions after edits, strips dead `relRange` anchors

`tandem_getTextContent` uses `extractText()` — never `extractMarkdown()`, which would shift offsets out of the annotation coordinate system (`rule-extract-text-not-markdown`).
