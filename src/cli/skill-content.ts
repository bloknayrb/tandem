/**
 * SKILL.md content installed to ~/.claude/skills/tandem/ by `tandem setup`.
 * Claude Code auto-discovers this and uses it when tandem_* tools are present.
 */
export const SKILL_CONTENT = `---
name: tandem
description: >
  Use when tandem_* MCP tools are available, the user asks about Tandem
  document editing, or collaborative document review. Provides workflow
  guidance, annotation strategy, and tool usage patterns for the Tandem
  collaborative editor.
---

# Tandem — Collaborative Document Editor

Tandem lets you annotate and edit documents alongside the user in real time. The user sees your changes in a browser editor; you interact via 28 tandem_* MCP tools.

## Hard Rules

These prevent the most common failures. Follow them always.

1. **Resolve before mutating.** Call \`tandem_resolveRange\` (or \`tandem_search\`) to get offsets before calling \`tandem_edit\`, \`tandem_highlight\`, \`tandem_comment\`, \`tandem_suggest\`, or \`tandem_flag\`. Never compute offsets by counting characters in previously-read text — they go stale when the user edits.
2. **Pass \`textSnapshot\`.** Include the matched text as \`textSnapshot\` on mutations and annotations. If the text moved, the server returns \`RANGE_MOVED\` with relocated coordinates instead of corrupting the document.
3. **Use \`tandem_getTextContent\`, not \`tandem_getContent\`.** \`getContent\` returns ProseMirror JSON and burns tokens. Use \`getTextContent({ section: "Section Name" })\` for targeted reads. The \`section\` parameter is case-insensitive.
4. **\`tandem_edit\` cannot create paragraphs.** Newlines become literal characters. For multi-paragraph changes, use multiple \`tandem_edit\` calls or \`tandem_suggest\`.
5. **\`.docx\` files are read-only.** Use annotations instead of \`tandem_edit\`. Offer \`tandem_convertToMarkdown\` if the user wants an editable copy.

## Workflow

Standard review sequence:

1. \`tandem_status\` — check for already-open documents (sessions restore automatically)
2. \`tandem_getOutline\` — understand document structure
3. \`tandem_setStatus("Reviewing [section]...", { focusParagraph: N })\` — show progress (use \`index\` from outline)
4. \`tandem_getTextContent({ section: "..." })\` — read one section at a time
5. Annotate findings (see annotation guide below)
6. \`tandem_checkInbox\` — check for user messages and actions
7. Repeat steps 3-6 for each section
8. \`tandem_save\` — persist edits to disk when done

## Annotation Guide

Choose the right type for each finding:

- **\`tandem_highlight\`** — Visual marker with a short note. Colors: green (verified/good), red (problem), yellow (needs attention). Use when the finding is self-evident from the color and a brief note.
- **\`tandem_comment\`** — Observation requiring explanation. Use when you need more than one sentence to convey reasoning.
- **\`tandem_suggest\`** — Specific text replacement. **Prefer over comment when you can provide replacement text** — the user gets one-click accept/reject. Cannot create new paragraphs.
- **\`tandem_flag\`** — Blocking issue the user must address before the document ships. Factual errors, compliance risks, missing required content. Always visible in urgent-only interruption mode.

**Priority:** Set \`priority: 'urgent'\` on any annotation type when the finding is critical and the user may be in urgent-only mode.

**User-created types:** \`question\` and \`overlay\` annotations are created by users, not Claude. When you see a \`question\` in \`tandem_checkInbox\` or \`tandem_getAnnotations\`, respond with a \`tandem_comment\` on the same range or \`tandem_reply\` for conversational answers.

## Interruption Modes

Check \`interruptionMode\` from \`tandem_status\` or \`tandem_checkInbox\` and adapt:

- **All** (default) — Annotate freely.
- **Urgent** — Only create \`tandem_flag\` and annotations with \`priority: 'urgent'\`. Continue reading and preparing findings, but hold non-urgent annotations until the mode changes.
- **Paused** — Hold all new annotations. Keep working (read, outline, prepare) but don't push findings until the mode changes.

## Collaboration Etiquette

- Check \`tandem_getActivity()\` before annotating near the user's cursor. If \`isTyping\` is true, wait for typing to stop before annotating that area.
- Use \`tandem_setStatus\` to show what you're working on — the user sees it in the browser status bar.
- **Call \`tandem_checkInbox\` every 2-3 tool calls**, not just at the end of a task. The real-time channel is often not connected; polling is the reliable path.
- Reply to chat messages with \`tandem_reply\`, not annotations.

## .docx Review Workflow

1. \`tandem_open\` — opens in read-only mode (\`readOnly: true\`)
2. \`tandem_getAnnotations({ author: "import" })\` — check for imported Word comments; read and act on them
3. Annotate with findings (highlight, comment, suggest, flag)
4. \`tandem_exportAnnotations\` — generate a review summary the user can share
5. If the user wants editable text, offer \`tandem_convertToMarkdown\`

## Error Recovery

- **\`RANGE_MOVED\`** — Text shifted since you read it. The response includes \`resolvedFrom\`/\`resolvedTo\` — use those coordinates for your next call.
- **\`RANGE_GONE\`** — The text was deleted. Re-read the section with \`tandem_getTextContent\` and re-assess.
- **\`INVALID_RANGE\`** — You hit heading markup (e.g., \`## \`). Target text content only, not the heading prefix.
- **\`FORMAT_ERROR\`** — Attempted \`tandem_edit\` on a read-only \`.docx\`. Use annotations instead.

## Session Handoff

When starting a new Claude session with Tandem already running:

1. \`tandem_status()\` — check \`openDocuments\` array for restored sessions
2. \`tandem_listDocuments()\` — see all open docs with details
3. \`tandem_getOutline()\` — orient on the active document
4. \`tandem_getAnnotations()\` — see what was already reviewed
5. Continue where the previous session left off

## Multi-Document

When multiple documents are open, always pass \`documentId\` explicitly — omitting it targets the active document, which may have changed since your last call. Use \`tandem_listDocuments\` to see what's available. Cross-reference by reading both docs via \`tandem_getTextContent({ documentId: "..." })\` and annotating the relevant one.
`;
