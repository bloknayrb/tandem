---
name: tandem
version: 3
description: >
  Use when tandem_* MCP tools are available, the user asks about Tandem
  document editing, or iterating on text collaboratively. Provides workflow
  guidance, annotation strategy, and tool usage patterns for the Tandem
  collaborative editor.
---

# Tandem — Collaborative Document Editor

> **Scope:** This skill teaches Claude Code how to use Tandem effectively. Tandem's integration contract is MCP, and **Claude is the default integration** per [ADR-038](https://github.com/bloknayrb/tandem/blob/master/docs/decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration). This skill is a Claude-Code-specific resource shipped via the npm `skills/` folder; other MCP clients receive the tool descriptions directly through MCP and don't need this file.

Tandem lets you annotate and edit documents alongside the user in real time. The user sees your changes in the editor; you interact via the tandem_* MCP tool suite.

## Hard Rules

These prevent the most common failures. Follow them always.

1. **Resolve before mutating.** Call `tandem_resolveRange` (or `tandem_search`) to get offsets before calling `tandem_edit` or `tandem_comment`. Never compute offsets by counting characters in previously-read text — they go stale when the user edits.
2. **Pass `textSnapshot`.** Include the matched text as `textSnapshot` on mutations and annotations. If the text moved, the server returns `RANGE_MOVED` with relocated coordinates instead of corrupting the document.
3. **Use `tandem_getTextContent` for document reads.** Use `getTextContent({ section: "Section Name" })` for targeted reads. The `section` parameter is case-insensitive.
4. **`tandem_edit` cannot create paragraphs.** Newlines become literal characters. For multi-paragraph changes, use multiple `tandem_edit` calls or `tandem_comment` with `suggestedText`.
5. **`.docx` files are read-only.** Use annotations instead of `tandem_edit`. Offer `tandem_convertToMarkdown` if the user wants an editable copy.

## Workflow

Standard workflow:

1. `tandem_status` — check for already-open documents (sessions restore automatically)
2. `tandem_getOutline` — understand document structure
3. `tandem_status({ text: "Working on [section]...", focusParagraph: N })` — show progress (use `index` from outline)
4. `tandem_getTextContent({ section: "..." })` — read one section at a time
5. Annotate or edit as needed (see annotation guide below)
6. `tandem_checkInbox` — check for user messages and actions
7. Repeat steps 3-6 for each section
8. `tandem_save` — persist edits to disk when done

## Authoring a New Document

When you write a document wholesale (create the file on disk yourself, then open it in Tandem), pass `authoredBy: "claude"` to `tandem_open`:

```
tandem_open({ filePath: "/abs/path/draft.md", authoredBy: "claude" })
```

This attributes the document's text to Claude so the editor shows authorship correctly — otherwise a wholesale-written document looks unattributed, because authorship is normally stamped only by `tandem_edit`. The flag is idempotent (safe to re-pass on re-open) and only ever stamps Claude authorship — it never forges user attribution. Authorship is not durably persisted across server restarts, so if you re-open a document you created in an earlier session and want it re-attributed, pass `authoredBy: "claude"` again.

## Annotation Guide

Choose the right type for each finding:

- **`tandem_comment`** — Observation or question. Use for any finding that needs explanation or a text replacement.
- **`tandem_comment` with `suggestedText`** — Specific text replacement. **Prefer when you can provide replacement text** — the user gets one-click accept/reject. Cannot create new paragraphs. Pass replacement text as `suggestedText`; the comment text explains the reason.

**Note annotations** (`type: "note"`) are user-personal — `tandem_checkInbox` does not surface them to you. Don't act on notes unless the user explicitly mentions one in chat. Highlights are also user-only; `tandem_highlight` is deprecated and returns an error.

**User comments.** When scanning `tandem_checkInbox` or `tandem_getAnnotations`, user-authored `type: "comment"` annotations are the ones you should respond to. Respond with `tandem_reply` for conversational answers, or a new `tandem_comment` on the same range for a textual annotation.

## Collaboration Mode

Check `mode` from `tandem_status` or `tandem_checkInbox` and adapt:

- **Tandem** (`"tandem"`, default) — Full collaboration. Annotate freely and react to selections and document changes.
- **Solo** (`"solo"`) — The user wants to write undisturbed. Only respond when the user sends a chat message. Do not proactively annotate or react to document activity.

## Reacting to Document Events

Selections are **not** sent as standalone events. Instead, when the user sends a chat message, any buffered selection is attached as a `selection` field on the `chat:message` payload. This gives you context about what text the user was looking at when they wrote their message. When polling via `tandem_checkInbox`, the current selection shows up under `activity.selectedText`. Use `tandem_reply` for any document-context reaction (chat messages, question annotations); reserve terminal output for non-document work the user explicitly requests. In Solo mode, hold reactions until the user sends a chat message.

## Collaboration Etiquette

- Check `tandem_getActivity()` before annotating near the user's cursor. If `isTyping` is true, wait for typing to stop before annotating that area.
- Use `tandem_status({ text: "..." })` to show what you're working on — the user sees it in the editor status bar.
- **Call `tandem_checkInbox` every 2-3 tool calls**, not just at the end of a task. The real-time channel is often not connected; polling is the reliable path.
- Reply to chat messages with `tandem_reply`, not annotations.

## .docx Review Workflow

1. `tandem_open` — opens in read-only mode (`readOnly: true`)
2. `tandem_getAnnotations({ author: "import" })` — check for imported Word comments; read and act on them
3. Annotate with findings (comment, comment with suggestedText)
4. `tandem_exportAnnotations` — generate a review summary the user can share
5. If the user wants editable text, offer `tandem_convertToMarkdown`

## Error Recovery

- **`RANGE_MOVED`** — Text shifted since you read it. The response includes `resolvedFrom`/`resolvedTo` — use those coordinates for your next call.
- **`RANGE_GONE`** — The text was deleted. Re-read the section with `tandem_getTextContent` and re-assess.
- **`INVALID_RANGE`** — You hit heading markup (e.g., `## `). Target text content only, not the heading prefix.
- **`FORMAT_ERROR`** — Attempted `tandem_edit` on a read-only `.docx`. Use annotations instead.

## Session Handoff

When starting a new Claude session with Tandem already running:

1. `tandem_status()` — check `openDocuments` array for restored sessions
2. `tandem_listDocuments()` — see all open docs with details
3. `tandem_getOutline()` — orient on the active document
4. `tandem_getAnnotations()` — see what was already reviewed
5. Continue where the previous session left off

## Multi-Document

When multiple documents are open, always pass `documentId` explicitly — omitting it targets the active document, which may have changed since your last call. Use `tandem_listDocuments` to see what's available. Cross-reference by reading both docs via `tandem_getTextContent({ documentId: "..." })` and annotating the relevant one.

## Project Context Discovery

Tandem auto-launches you in a single working directory (the user's home by default, or whatever they configured under Settings → Claude Code → Working directory). The document the user opens may live elsewhere — a different project, a different repo. When you're working on a file outside your launch cwd:

1. **Read `<docDir>/CLAUDE.md`** if it exists — it's the project's own playbook.
2. **Walk up** the directory tree from `<docDir>` looking for `CLAUDE.md`, `.claude/`, `README.md`, or `package.json`/`Cargo.toml`/`pyproject.toml` to identify the project root.
3. **Surface a relaunch nudge** when you detect project-scoped Claude tools you can't load mid-session:
   - `.claude/skills/`, `.claude/agents/`, `.claude/hooks/`, or a `.mcp.json` you haven't loaded
   - Tell the user: *"I see project-specific Claude tools at `<path>`. I can't load them in this session — open the command palette and run `Relaunch Claude in this folder` if you'd like me to pick them up."*

The user is in control: relaunch ends the current conversation, so only suggest it when the project-scoped tools materially change what you can help with.
