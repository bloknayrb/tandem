---
id: rule-edit-rejects-heading-markup
type: rule
name: tandem_edit rejects heading markup ranges
last_verified: 2026-05-18
sources:
  - src/server/mcp/document.ts
  - src/server/positions.ts
---

# Rule: tandem_edit rejects heading markup ranges

Ranges that overlap heading prefixes (e.g., the `## ` at the start of a level-2 heading) return `INVALID_RANGE`. Target text content only — never the markup characters.

**Why this matters:** flat offsets include heading prefixes (see `concept-coord-flat-offset`) because that's the user-visible view. But editing the `## ` itself would corrupt the block structure — Y.XmlElement heading nodes carry the level as an attribute, not as inline characters. An edit that "deletes" the prefix would leave a malformed heading element.

The validator detects overlap with the prefix range during `validateRange()` and short-circuits before any Y.Doc write happens.

**Practical implication for Claude:** when computing an edit range that starts at the beginning of a heading line, advance past the prefix (count `# ` characters) before issuing the call. The error message includes the offending range so the next attempt can correct.
