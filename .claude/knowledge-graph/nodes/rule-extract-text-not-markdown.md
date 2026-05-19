---
id: rule-extract-text-not-markdown
type: rule
name: tandem_getTextContent uses extractText
last_verified: 2026-05-18
sources:
  - src/server/mcp/document.ts
  - .claude/hooks/check-extract-markdown.sh
  - docs/decisions.md#adr-021-extracttext-for-tandem_gettextcontent-issue-148
---

# Rule: tandem_getTextContent uses extractText, never extractMarkdown

`tandem_getTextContent` uses `extractText()` for **all** files, including `.md`. Never use `extractMarkdown()` from a tool that returns offsets — it shifts character offsets relative to the annotation coordinate system.

**Why this matters:** annotation ranges are flat offsets into `extractText()` output (see `concept-coord-flat-offset`). If `getTextContent` returned `extractMarkdown()` instead, the offsets Claude saw wouldn't match the offsets the server expected back on writes — annotations would land at the wrong characters.

**If you need actual markdown:** use `tandem_save` and read the file directly. `extractMarkdown()` exists for the save path, not for the read path.

**Enforced by:** `.claude/hooks/check-extract-markdown.sh` warns on PostToolUse for any `extractMarkdown()` usage outside the save path.
