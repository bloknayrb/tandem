# Claude Code Skill for Tandem Usage Guidance

Issue: #163

## Context

When a user installs Tandem globally (`npm install -g tandem-editor && tandem setup`), Claude gets 28 MCP tools registered but no context about how to use them effectively. Tool descriptions are sparse and task-focused ("Highlight a text range"). The channel shim provides 8 lines of event-handling instructions, but nothing about workflow sequencing, annotation strategy, interruption modes, or error recovery. Claude has to guess, and it guesses wrong often enough to matter.

## Design

### Delivery: User-level skill file

**Location**: `~/.claude/skills/tandem/SKILL.md`

Claude Code auto-discovers SKILL.md files in `~/.claude/skills/<name>/`. The `description` field in SKILL.md frontmatter controls auto-triggering — Claude reads it and invokes the skill when conditions match. This mechanism is already proven on Bryan's machine (bitwarden, small-screen-ui skills use it).

No plugin registry manipulation needed. No changes to `installed_plugins.json` or `settings.json`. Just a directory with a SKILL.md file.

**Frontmatter**:
```yaml
---
name: tandem
description: >
  Use when tandem_* MCP tools are available, the user asks about Tandem
  document editing, or collaborative document review. Provides workflow
  guidance, annotation strategy, and tool usage patterns for the Tandem
  collaborative editor.
---
```

### Installation via `tandem setup`

`tandem setup` already creates `~/.claude/` and writes MCP config there. Adding a skill file is one more write in the same flow.

**New function**: `installSkill(homeDir)` in `setup.ts`
- Resolves `~/.claude/skills/tandem/SKILL.md`
- `mkdir({ recursive: true })` for the directory
- `atomicWrite()` the skill content
- Logs success/failure like MCP config targets
- Failure does not block MCP setup (warn and continue)

**Console output** adds a new section:
```
Installing Claude Code skill...
  ✓ ~/.claude/skills/tandem/SKILL.md
```

**Updates**: Every `tandem setup` run overwrites the file with the latest version from the package. No version checking or user-modification detection — the file is managed by Tandem.

### Skill content (~125 lines)

The skill teaches Claude what tool descriptions and channel instructions do not cover. Content is structured as terse rules, not prose explanations.

#### Section 1: Identity (2 lines)
What Tandem is in one sentence. "28 MCP tools" pointer.

#### Section 2: Hard rules (15 lines)
The rules that prevent the most common failure modes:
- **Always `tandem_resolveRange` before mutations/annotations.** Never compute offsets by counting characters in previously-read text.
- **Pass `textSnapshot`** on `tandem_edit` and annotation tools for concurrency safety. Enables automatic `RANGE_MOVED` recovery.
- **Use `tandem_getTextContent`, never `tandem_getContent`.** `getContent` returns ProseMirror JSON and burns tokens. Use `getTextContent({ section: "..." })` for targeted reads.
- **`tandem_edit` cannot create paragraphs.** Newlines become literal `\n` characters. For multi-paragraph changes, use multiple edits or `tandem_suggest`.
- **`.docx` files are read-only.** Use annotations instead of `tandem_edit`. Offer `tandem_convertToMarkdown` if the user wants an editable copy.

#### Section 3: Workflow pattern (12 lines)
The standard review sequence:
1. `tandem_status` — check for open documents (session may have restored)
2. `tandem_getOutline` — understand document structure
3. `tandem_setStatus("Reviewing [section]...", { focusParagraph: N })` — show progress (use `index` from outline)
4. `tandem_getTextContent({ section: "..." })` — read one section at a time
5. Annotate findings (see annotation matrix)
6. `tandem_checkInbox` — check for user messages/actions
7. Repeat for each section
8. `tandem_save` — persist edits to disk

#### Section 4: Annotation decision matrix (20 lines)
When to use each type, with concrete decision rules:
- **`tandem_highlight`**: Visual marker. Green = good/verified. Red = problem. Yellow = needs attention. Use when the finding is self-evident from color + short note.
- **`tandem_comment`**: Observation or explanation requiring more than one sentence. Use when you need to explain reasoning.
- **`tandem_suggest`**: Specific text replacement. **Prefer over `tandem_comment` when you can provide replacement text** — gives the user one-click accept/reject.
- **`tandem_flag`**: Blocking issue requiring user action before document ships. Factual errors, compliance risks, missing required content. Always surfaces (flags and questions are exempt from Solo mode hold).
- **`question` and `overlay`**: User-created annotation types. Claude cannot create these. When you see a `question` in `tandem_checkInbox`, respond with a `tandem_comment` on the same range or `tandem_reply` for conversational answers.

Historical: the `priority` field on annotations has been removed. Urgency is now implicit in annotation `type` — flags and questions always surface; comments and suggestions are held in Solo mode and shown in Tandem mode.

#### Section 5: Solo/Tandem mode (10 lines)
Check `mode` from `tandem_status` or `tandem_checkInbox`:
- **Tandem** (default): Annotate freely.
- **Solo**: Hold all annotations until the user switches to Tandem. Flags and questions are exempt — they always surface regardless of mode.

#### Section 6: Collaboration etiquette (10 lines)
- Check `tandem_getActivity()` before annotating near the user's cursor. If `isTyping` is true, wait.
- Use `tandem_setStatus` to show what you're working on — the user sees it in the browser status bar.
- **Call `tandem_checkInbox` every 2-3 tool calls**, not just at end-of-task. The channel push is often not connected; polling is the reliable path.
- Reply to chat messages with `tandem_reply`. Don't create annotations as chat responses.

#### Section 7: .docx review workflow (10 lines)
- `.docx` opens in read-only mode. Edits are rejected.
- Check for imported Word comments: `tandem_getAnnotations({ author: "import" })`. Read and act on them.
- Annotate with findings (highlight, comment, suggest, flag).
- After review: `tandem_exportAnnotations` generates a summary the user can share.
- If user wants editable text: offer `tandem_convertToMarkdown`.

#### Section 8: Error recovery (15 lines)
- **`RANGE_MOVED`**: Text shifted since you read it. The response includes relocated `resolvedFrom`/`resolvedTo` — use those coordinates for your next call.
- **`RANGE_GONE`**: The text was deleted. Re-read the section with `tandem_getTextContent` and re-assess.
- **`INVALID_RANGE`**: You hit heading markup (e.g., `## `). Target text content only, not the heading prefix.
- **`FORMAT_ERROR`**: Attempted `tandem_edit` on a read-only `.docx`. Use annotations instead.

#### Section 9: Session handoff (10 lines)
On startup in a new Claude session:
1. `tandem_status()` — check `openDocuments` array
2. `tandem_listDocuments()` — see all open docs with details
3. `tandem_getOutline()` — orient on the active document
4. `tandem_getAnnotations()` — see what was already reviewed
5. Continue where the previous session left off

#### Section 10: Multi-document (8 lines)
- When multiple docs are open, always pass `documentId` explicitly. Omitting it targets the active document, which may have changed.
- Use `tandem_listDocuments` to see what's available.
- Cross-reference by reading both docs via `tandem_getTextContent({ documentId: "..." })` and annotating the relevant one.

### Source file

`src/cli/skill-content.ts` — exports the complete SKILL.md content (YAML frontmatter + markdown body) as a single string constant, ready to write to disk as-is. This avoids build pipeline changes (no need to bundle .md files with tsup) and matches the pattern of the channel shim's inline instructions.

### Files changed

| File | Change |
|------|--------|
| `src/cli/skill-content.ts` | **New.** SKILL.md content as string export. |
| `src/cli/setup.ts` | Add `installSkill()` function + call it in `runSetup()`. |
| `tests/cli/setup.test.ts` | Tests for `installSkill()` using `homeOverride`. |
| `docs/workflows.md` | Update Quick Start to mention the skill. |

### Files NOT changed

- MCP server (`server.ts`) — no `instructions` field added
- Channel shim (`channel/index.ts`) — no changes
- Client — no changes
- Build pipeline (`tsup.config.ts`) — no changes
- `package.json` — no changes (skill content is in TypeScript, not a bundled asset)

## Verification

1. Run `tandem setup` — confirm skill file appears at `~/.claude/skills/tandem/SKILL.md`
2. Run `tandem setup` again — confirm file is overwritten without error
3. Start a new Claude Code session with Tandem MCP connected — confirm the skill appears in Claude's available skills list
4. Ask Claude to review a document — confirm it follows the workflow pattern (status → outline → section → annotate → checkInbox)
5. Run `npm test` — confirm new setup tests pass
6. Delete `~/.claude/skills/tandem/` manually, re-run `tandem setup` — confirm it recreates the directory and file
