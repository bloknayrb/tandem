---
name: tandem
version: 13
description: >
  Use before the first tandem_* call in a session — including a lone status
  check — or when the user asks about Tandem document editing or iterating on
  text collaboratively. Covers being woken while idle so the user's comments
  and chat reach you between turns, plus annotation strategy, editing
  workflow, and tool usage patterns for the Tandem collaborative editor.
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
5. **`.docx` files are editable, but only an explicit save writes them.** Edit them like any other document; edits are held in the Y.Doc and written back to the original `.docx` only when the user saves (or you call `tandem_save`). Auto-save deliberately skips `.docx`, so unsaved edits persist in the session and never silently overwrite the user's file. Conversion is lossy at the edges: `tandem_save` returns `fidelityWarnings` when the export downgraded anything, and the user sees a fidelity banner in the editor. Report those warnings rather than claiming a clean round-trip. A document can still be read-only for other reasons: uploads, an explicit `readOnly` flag, or a format with no way back to disk — `.html` opens read-only for exactly that reason. When it is, `tandem_edit` returns `FORMAT_ERROR` and annotations are the right surface. `tandem_save` on such a document answers `saved: false` with a `reason`; only the session is written.

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

**Before responding, check whether you already did.** Neither `tandem_reply` nor `tandem_comment` is idempotent — replying twice leaves two chat bubbles or two annotation cards on the same text, which the user sees. Your own memory of the conversation is the primary check: if you recognize the comment's text, you have probably already answered it.

`alreadyPushed: true` is a weak secondary hint, not a verdict. It means the server handed the item to a real-time consumer — not that the consumer's host showed it to you, and not that you saw it. It is also dropped once the event leaves the channel buffer, so its absence proves nothing either. Never skip a comment on the strength of this flag alone. To check for a prior *annotation* reply, read the thread via `tandem_getAnnotations`; a prior `tandem_reply` is a chat message and won't appear there.

## Collaboration Mode

Check `mode` from `tandem_status` or `tandem_checkInbox` and adapt:

- **Tandem** (`"tandem"`, default) — Full collaboration. Annotate freely and react to selections and document changes.
- **Solo** (`"solo"`) — The user wants to write undisturbed. Only respond when the user sends a chat message. Do not proactively annotate or react to document activity.

## Reacting to Document Events

Selections are **not** sent as standalone events. Instead, when the user sends a chat message, any buffered selection is attached as a `selection` field on the `chat:message` payload. This gives you context about what text the user was looking at when they wrote their message. When polling via `tandem_checkInbox`, the current selection shows up under `activity.selectedText`. Use `tandem_reply` for any document-context reaction (chat messages, question annotations); reserve terminal output for non-document work the user explicitly requests. In Solo mode, hold reactions until the user sends a chat message.

## Collaboration Etiquette

- Check `tandem_getActivity()` before annotating near the user's cursor. If `isTyping` is true, wait for typing to stop before annotating that area.
- Use `tandem_status({ text: "..." })` to show what you're working on — the user sees it in the editor status bar.
- **Call `tandem_checkInbox` every 2-3 tool calls**, not just at the end of a task. You cannot tell from your side whether real-time push is reaching you — the channel is often not connected, and Tandem can only tell you when *nothing at all* is subscribed, not whether the thing that is subscribed reaches you — so steady polling is the reliable path, always. It's cheap: repeat polls de-duplicate against what you've already been shown, so frequent calls don't double-report. An item that also went out as a real-time push carries `alreadyPushed: true` and still appears — the server can't confirm a push reached you, so it shows you everything rather than risk dropping it. See "User comments" above before acting on a flagged item twice. When in doubt, poll.
- Reply to chat messages with `tandem_reply`, not annotations.

## Getting Woken While Idle

Polling is the reliable path and stays the authority on what you see. But between your turns nothing polls, so a comment the user leaves while you sit idle waits until your next turn — which may never come.

In a **hand-started session**, after the first successful read-mode `tandem_status`, if your host offers a `Monitor` tool, read `wakeUrl` from that response and arm one persistent watch. **Arm it at most once per session. Do not use Tandem's process-global subscriber count to decide whether this session is covered.** Other sessions and inert channel shims appear in that count, and the plugin monitor triggered by this skill can attach after the status response, so the count is stale by construction.

If the Monitor tool is absent or the attempt fails, say so once and stop trying. The tool is enabled per account rather than per version, so upgrading may not add it, and Tandem's server cannot see whether you have it. On Windows, the built-in Monitor tool additionally requires Git Bash. The plugin monitor shares the same per-account feature gate, so it cannot help when that gate is off. But the plugin monitor does not require Git Bash on Windows and can fall back to PowerShell, so it can help when Git Bash is the missing precondition. Tell the user that the channel shim is the setup that does not need Monitor (`tandem setup --apply --with-channel-shim`), then keep polling. Asking Claude to watch is recovery only: if this first-use attempt was skipped, make the same attempt when asked, but never start a second watch.

**Read the URL from `tandem_status`, don't assume it.** Read mode returns `wakeUrl` — the live address of the wake stream, reported by the server that is running it. It is usually `ws://127.0.0.1:3479/api/wake`, but the port is configurable and guessing it is a *silent* failure: you would open a socket to whatever unrelated service holds 3479 and sit there believing you were armed. If `wakeUrl` is absent, this Tandem has no wake transport and there is nothing to arm — keep polling.

```
Monitor({ ws: { url: <wakeUrl from tandem_status> }, persistent: true })
```

Three things to know before you do:

- **Do not arm one if Tandem launched you.** A launcher-spawned session is already woken directly on its input, and the wake turn says so explicitly. A second watch double-wakes every message.
- **A wake tells you *that* something happened, never *what*.** Frames carry an id, a type and a timestamp — no message text, by design. Always call `tandem_checkInbox` to find out what actually arrived. Answering from the notification is how the same item gets replied to twice: the inbox never marks it seen, so it comes back.
- **Wakes are best-effort and can be dropped.** A burst of activity is rate-limited by the host, so some notifications never arrive even though every event reached the server. This is exactly why the point above matters — the inbox has all of them; the wake stream may not. Keep polling every 2-3 tool calls regardless.
- **If every wake arrives twice, you are the second consumer — stand down.** A subscriber count of zero at the moment you check is not a promise it stays zero. If the user has the Tandem plugin installed, dispatching this skill is what starts its monitor, and that takes some seconds to connect — so a count you read in your first tool call can be stale by the time your watch is open. Nothing on Tandem's side can tell the two apart; doubled wakes are the signal. Stop your watch with `TaskStop` and keep polling, rather than leaving both running. No item is lost either way: the inbox de-duplicates, so the cost is a wasted turn, not a duplicate reply.

If `ws` is unavailable, the equivalent stream is `GET /api/events?filter=wake` on the same host and port as `wakeUrl` (so `ws://127.0.0.1:3479/api/wake` → `http://127.0.0.1:3479/api/events?filter=wake`), which is payload-free in the same way. It needs a shell with `curl` — fine on macOS and Linux, absent on a stock Windows install.

## .docx Review Workflow

1. `tandem_open` — opens editable, like any other document
2. `tandem_getAnnotations({ author: "import" })` — check for imported Word comments; read and act on them
3. Annotate with findings (comment, comment with suggestedText)
4. `tandem_exportAnnotations` — generate a review summary the user can share

Then pick an ending, and say which one you're doing:

- **Leave it to the user.** Annotations stay in the session; the file is untouched until someone saves.
- **`tandem_save`** — writes your edits back into the original `.docx`, and writes shared comments back as native Word comments. Check `fidelityWarnings` in the response and pass anything it reports on to the user.
- **`tandem_applyChanges`** — writes accepted suggestions into the `.docx` as Word **tracked changes** (`w:del` + `w:ins`), so the recipient reviews them in Word. Takes an optional `author` (default `"Tandem Review"`). Only works on a `.docx` opened from disk, and returns `NO_SUGGESTIONS` if nothing was accepted.
- **`tandem_convertToMarkdown`** — still the right call if the user wants a Markdown copy rather than a Word file.

Tandem snapshots the file's bytes before its first write each run, so a save is reversible: `tandem_restoreBackup` with no `backup` lists snapshots, and with `backup` set restores one in place (annotations preserved and re-anchored). If something else changed the file on disk meanwhile, the save is refused and a conflict banner asks the user to keep or reload — `tandem_save` reports that instead of claiming a save that didn't happen.

## When the tandem_* Tools Are Absent

**If this session has no `tandem_*` tools at all, do not work around it — read this.** Claude Code
resolves `mcpServers.tandem` once at session start over direct HTTP, so the whole toolset is
missing whenever that resolution did not produce a live connection. There is no failing tool call
to read, because there is no tool — which is why this needs saying rather than being obvious
(#1463).

**Two causes, and they take different fixes** — step 2 is almost always the right one, and step 3
tells you when it was not, without guessing.

**1. Do not edit the target file by any other means.** Not `Edit`, not `Write`, not "I'll just make
the change directly," and do not offer to. The user asked for their document in Tandem: an edit
made outside it is invisible in the editor, unreviewable, and looks like success. **Absence of the
toolset means stop.** This holds even when the file is right there and the change is trivial.

**2. Tandem is not running (the common cause). Tell the user, in these terms:**

> Tandem server not running. Start the Tauri app or run `tandem start`, then run `/mcp` to
> reconnect this session.

Say all three parts. Naming Tandem without naming the remedy leaves the user guessing, and the
remedy has a second half people miss: **launching Tandem does not repair a session already
running.** Connection state is fixed at session start, so `/mcp` is required.

**3. If the tools are still absent after that, Tandem was never configured for this client.** The
skill installs on any `tandem setup --apply`, including runs that wrote no MCP config at all, so it
can be loaded in a session whose `~/.claude.json` has no `mcpServers.tandem` entry to resolve. Step
2 cannot fix that — there is nothing to reconnect to. Say:

> Tandem isn't set up for Claude Code on this machine. Run `tandem setup --apply`, or open Tandem
> and use **Settings → AI Assistant**, then restart Claude Code.

Those two are the whole set. Do not invent a third — there is no per-chat connector toggle to
enable and no MCP setting to hand-edit.

**Do not go looking for the tools first.** No amount of `ToolSearch`, connector listing, or plugin
listing will surface a server that never connected; it only adds latency before the user hears
anything. One check is enough, and the answer is conclusive.

The wording above matches what the stdio bridge (`src/cli/mcp-stdio.ts`) already returns as JSON-RPC
`-32000` for Claude Desktop and Cowork, so every integration says the same thing.

## Error Recovery

- **`RANGE_MOVED`** — Text shifted since you read it. The response includes `resolvedFrom`/`resolvedTo` — use those coordinates for your next call.
- **`RANGE_GONE`** — The text was deleted. Re-read the section with `tandem_getTextContent` and re-assess.
- **`INVALID_RANGE`** — You hit heading markup (e.g., `## `). Target text content only, not the heading prefix.
- **`FORMAT_ERROR`** — The operation doesn't apply to this document. Most often the document is genuinely read-only (an upload, an explicit `readOnly` flag, or an `.html`, which opens read-only because no save path exists for it) — use annotations instead. Also returned by `tandem_appendContent` on a non-Markdown document, and by `tandem_applyChanges` on anything that isn't a `.docx` opened from disk. Note `.docx` alone no longer causes this: those open editable.

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

Tandem auto-launches you in a single working directory (the user's home by default, or whatever they configured under Settings → AI Assistant → Working directory). The document the user opens may live elsewhere — a different project, a different repo. When you're working on a file outside your launch cwd:

1. **Read `<docDir>/CLAUDE.md`** if it exists — it's the project's own playbook.
2. **Walk up** the directory tree from `<docDir>` looking for `CLAUDE.md`, `.claude/`, `README.md`, or `package.json`/`Cargo.toml`/`pyproject.toml` to identify the project root.
3. **Surface a relaunch nudge** when you detect project-scoped Claude tools you can't load mid-session:
   - `.claude/skills/`, `.claude/agents/`, `.claude/hooks/`, or a `.mcp.json` you haven't loaded
   - Tell the user: *"I see project-specific Claude tools at `<path>`. I can't load them in this session — open the command palette and run `Relaunch Claude in this folder` if you'd like me to pick them up."*

The user is in control: relaunch ends the current conversation, so only suggest it when the project-scoped tools materially change what you can help with.
