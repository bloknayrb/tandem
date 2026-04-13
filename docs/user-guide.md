# User Guide

A complete guide to using Tandem — from first launch to advanced workflows.

> **Using Claude Code?** If you're setting up Claude Code integration rather than learning the browser UI, skip to [Working with Claude Code](#working-with-claude-code).

## Overview

Tandem lets you work on documents with an LLM without the constant copy-paste. You open a document — a progress report, RFP response, compliance filing, or any prose — highlight the text you want to discuss, and Claude sees it directly. Claude can suggest rewrites, leave comments, flag issues, and edit text alongside you in real time. Because Claude connects through MCP, it brings all its knowledge, tools, and conversation context to the document — it's not working in isolation. Each annotation is a first-class object you can accept, dismiss, edit, or discuss. The original file is never modified unless you save.

Tandem runs as a local server with two surfaces: a **browser editor** where you read and edit documents, and **Claude Code** where Claude connects via MCP tools. Changes sync instantly between them through Yjs CRDT collaboration.

Tandem is available as a [desktop app](https://github.com/bloknayrb/tandem/releases/latest) (macOS, Linux, Windows) or as an [npm package](https://www.npmjs.com/package/tandem-editor) (`npm install -g tandem-editor`). The desktop app manages the server automatically; the npm install requires starting it from the terminal. Once running, the browser experience is identical either way.

## First Launch

On first run, Tandem opens `sample/welcome.md` automatically. Three tutorial annotations appear in the document — a highlight, a comment, and a comment with replacement text — so you have something to interact with immediately.

A floating tutorial card appears at the bottom-left of the editor with three steps:

1. **Review an annotation** — Accept or dismiss one of the tutorial annotations from the side panel, or press `Ctrl+Shift+R` to enter Review Mode and use `Y`/`N` keys.
2. **Ask Claude a question** — Select text, click Comment, toggle "@Claude", and send your question. Or type in the Chat panel.
3. **Try editing** — Click in the document and type something.

The tutorial dismisses after all three steps and won't appear again (progress is saved to localStorage).

**Tip:** Start the Tandem server first, then open Claude Code with the channel flag. Having Claude connected before the tutorial means you'll see real responses when you ask a question in step 2.

**Desktop app users:** The server starts automatically when you open Tandem. Claude Code is configured on every launch — no need to run `tandem setup`.

## The Editor

![Toolbar with annotation buttons, document tabs, and side panel header](screenshots/04-toolbar-actions.png)

### Document Area

The main editing area is a rich text editor powered by Tiptap. You can type, select, format, and edit just like any document editor. When Claude is connected, its focus paragraph gets a subtle blue highlight so you can see where Claude is reading.

### Tab Bar

Open documents appear as tabs along the top. Each tab shows the file name and a format indicator: **M** for Markdown, **W** for Word (.docx), **T** for plain text.

- Drag tabs to reorder them, or use `Alt+Left` / `Alt+Right`
- A dot appears on the tab title when a document has unsaved changes
- Click the **+** button at the end of the tab bar to open a new file

### Formatting Toolbar

Select text to reveal formatting buttons: **Bold**, **Italic**, **Headings** (H1/H2/H3), **Bullet List**, **Ordered List**, **Blockquote**, **Code**, **Link** (`Ctrl+K`), **Horizontal Rule**, and **Code Block**. Standard keyboard shortcuts also work (`Ctrl+B`, `Ctrl+I`, etc.). The toolbar wraps to a second row on narrow windows.

### Annotation Toolbar

When text is selected, annotation buttons appear alongside the formatting toolbar:

- **Highlight** — Mark text with a colored background. A dropdown lets you pick from 5 colors: yellow, red, green, blue, or purple. An explicit ✕ button closes the color picker.
- **Comment** — Attach a note to the selected text. Two optional toggles appear:
  - **Replace** — Propose replacement text. A text input appears for the new wording. Accepting the annotation applies the replacement automatically.
  - **@Claude** — Direct the comment to Claude as a question. Claude sees the selected text and your comment, and can respond with annotations, chat messages, or both.
- **Flag** — Mark text for urgent attention.

When no text is selected, annotation buttons show a "Select text first" tooltip explaining why they're disabled.

### Side Panel

The right panel toggles between two views:

**Annotations** — Lists all annotations with filtering by type, author, and status. Each card shows a preview of the annotated text, the annotation content, author badge, and timestamp. Bulk **Accept All** / **Dismiss All** buttons appear when multiple annotations are pending. When filters are active, bulk actions only affect the filtered subset.

**Chat** — Freeform messaging with Claude. See the [Chat](#chat) section for details.

### Status Bar

![Status bar showing connection state, document count, and Claude's activity](screenshots/06-claude-presence.png)

The bottom bar shows:

- **Connection state** — Green when connected, with reconnect attempt count and elapsed time during disconnects. A prominent banner appears after 30 seconds of continuous disconnect.
- **Document count** — How many documents are currently open.
- **Display name** — Your name as it appears to Claude. Click to change it (stored in localStorage).
- **Review Only badge** — Appears when the active document is read-only (e.g. an imported `.docx`).
- **Claude's activity** — What Claude is doing ("Working on Cost Summary...", idle, etc.).

Claude collaboration mode (**Solo** / **Tandem**) lives in the toolbar at the top of the window, not the status bar. See [Solo / Tandem Mode](#solo--tandem-mode).

### Toast Notifications

![Toast notification with dismiss button](screenshots/07-toast-notification.png)

Annotation failures and save errors surface as dismissible toast notifications at the bottom of the screen. Toasts auto-dismiss by severity (errors linger longest) and show a count badge when the same message repeats.

### Help Modal

Press `?` at any time to open the keyboard shortcuts reference. Press `?` or `Esc` to close it.

## Working with Documents

### Opening Files

There are three ways to open a file:

**Path input** — Click the **+** button in the tab bar, type an absolute file path, and click **Open**.

**Drag-and-drop** — Drag a file from your file manager onto the editor. A dashed border appears as a drop indicator.

**Upload** — Click **+**, switch to **Upload** mode, and browse or drag a file into the drop zone. Uploaded files get a synthetic `upload://` path and are always read-only — `Save` preserves the session (annotations) but cannot write back to disk.

### Supported Formats

- **Markdown** (`.md`) — Full read-write support with lossless round-trip formatting.
- **Word** (`.docx`) — Opens in review-only mode. A banner explains that edits aren't saved back to the original `.docx`. Existing Word comments (`<w:comment>` elements) are imported as annotations with author "import". A **Convert to Markdown** button is available to create an editable copy.
- **Plain text** (`.txt`) — Full read-write support.
- **HTML** (`.html`, `.htm`) — Read support.

### Multi-Document Tabs

Each open file gets its own tab and its own collaboration room. Tabs scroll horizontally when they overflow. Reorder tabs by dragging or with `Alt+Left` / `Alt+Right`.

### Saving

Press `Ctrl+S` to save the active document to disk. Claude can also save via `tandem_save`. A dot on the tab title indicates unsaved changes. Saves are atomic (write to temp file, then rename) to prevent partial writes.

## Annotations

Annotations are how Claude's feedback shows up in the document. There are three types, each with distinct visual styling:

### Highlight

Colored background on the annotated text. Choose from 5 colors (yellow, red, green, blue, purple) via the toolbar's color picker dropdown. Use highlights to mark notable passages — green for good, red for problems, yellow for "check this."

### Comment

Dashed underline on the annotated text. Attach observations, questions, or notes. The comment text appears in the side panel card.

Comments support two optional behaviors:

- **Replacement suggestions** — A comment with a `suggestedText` field proposes a text replacement. The side panel card shows a diff view: the original text in red with strikethrough, an arrow, and the replacement text in green. When a reason is provided, it appears below the diff. Accepting the comment applies the text change automatically.
- **Questions directed at Claude** — A comment with `directedAt: "claude"` sends the comment to Claude as a question about the selected text. Claude sees the annotated passage and your comment, and can respond with annotations, chat messages, or both. These comments render with an indigo border and light tint.

### Flag

Marks text for urgent attention. Use flags for items that need immediate action rather than just review.

### Creating Annotations

Select text in the editor to reveal the annotation toolbar. Click the desired type. For highlights, pick a color from the dropdown. For comments, type your note — then optionally toggle "Replace" to propose replacement text, or "@Claude" to direct the comment to Claude as a question. For flags, type your note.

### Editing Annotations

Click the **✎ Edit** button on any pending annotation card to edit it:

- **Highlights and flags** — A textarea appears with the current note.
- **Comments** — A textarea appears for the comment text. If the comment has replacement text, a second textarea appears for the proposed replacement.

Click **Save** to apply or **Cancel** to discard. Edited cards show "(edited)" with a timestamp. Only pending annotations can be edited — accepted or dismissed annotations are immutable.

## Reviewing Annotations

### One at a Time

Each annotation card in the side panel has **Accept** and **Dismiss** buttons. Accepting a comment with replacement text applies the text change. Accepting other annotations simply marks them as resolved.

### Undo

After accepting or dismissing, a 10-second undo window opens. An "Undo" link appears on the card with a shrinking progress bar showing the remaining time. In review mode, press `Z`. For accepted comments with replacement text, undo atomically reverts both the text change and the annotation status.

### Review Mode

![Review mode with dimmed editor and active annotation highlighted](screenshots/05-review-mode.png)

Press `Ctrl+Shift+R` or click "Review" to enter review mode. Shortcut hints (`Y / N / ↑↓ / Z`) appear below the button. The editor dims non-annotated text so annotations stand out. The side panel tracks your position ("Reviewing 3 / 15").

| Key | Action |
|-----|--------|
| `Tab` | Jump to next pending annotation |
| `Shift+Tab` | Jump to previous annotation |
| `Y` | Accept current annotation |
| `N` | Dismiss current annotation |
| `E` | Examine — scroll to annotation and exit review mode |
| `Z` | Undo last accept/dismiss (within 10-second window) |
| `Escape` | Exit review mode |

### Bulk Actions

**Accept All** and **Dismiss All** buttons appear in the side panel header when multiple annotations are pending. A confirmation step is required before executing. When filters are active, bulk actions only affect the filtered annotations (e.g., "Accept 3 of 12 pending?").

### Review Summary

When all annotations are resolved, a summary overlay appears showing: total reviewed, accepted count, dismissed count, and accept rate.

### Solo / Tandem Mode

The toolbar includes a **Solo / Tandem** toggle that controls whether Claude's annotations appear as they arrive.

- **Tandem** (default) — Claude's annotations appear immediately as they arrive.
- **Solo** — Claude's pending annotations are held back. Resolved annotations (accepted/dismissed) are always visible regardless of mode.

Use **Solo** during focused writing to avoid interruption. Switch to **Tandem** when you're ready to see Claude's suggestions — all held annotations appear at once.

## Chat

![Chat sidebar with messages and typing indicator](screenshots/02-chat-sidebar.png)

Toggle between the **Annotations** and **Chat** views using the tabs at the top of the side panel.

### Sending Messages

Type in the input box and press `Enter` to send. Messages go to Claude via the server.

### Text Anchors

If you have text selected in the editor when you send a message, the selection is attached as a clickable anchor. The anchor quote shows a preview that expands on hover to reveal the full text. Clicking the anchor scrolls the editor back to that passage.

### Claude's Responses

Claude's replies are rendered as Markdown in the chat panel. Claude can respond to chat messages with text, annotations on the document, or both.

### Unread Badge

An unread badge appears on the Chat tab when Claude replies while you're viewing the Annotations panel. Switch to Chat to clear it.

## Keyboard Shortcuts

Press `?` to open the in-app shortcuts reference at any time.

### Editor

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` | Bold |
| `Ctrl+I` | Italic |
| `Ctrl+K` | Insert/remove link |
| `Ctrl+S` | Save document |

> **Note:** Undo/redo is not yet available in collaborative mode (tracked as a future enhancement).

### Annotations & Review

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+R` | Toggle review mode |
| `Tab` | Next annotation (review mode) |
| `Shift+Tab` | Previous annotation (review mode) |
| `Y` | Accept annotation (review mode) |
| `N` | Dismiss annotation (review mode) |
| `E` | Examine — scroll to annotation and exit (review mode) |
| `Z` | Undo last accept/dismiss (review mode) |
| `Escape` | Exit review mode |

### Navigation & General

| Shortcut | Action |
|----------|--------|
| `Alt+Left` | Previous tab |
| `Alt+Right` | Next tab |
| `Enter` | Send message (chat panel) |
| `?` | Show/hide keyboard shortcuts |

## Working with Claude Code

Tandem connects to Claude Code through MCP (Model Context Protocol). Claude gets 31 tools for reading documents, creating annotations, searching text, managing files, and communicating with you.

### Connection

Start the Tandem server first (`tandem` for global install, `npm run dev:standalone` for development). Then start Claude Code. Claude's tools become available automatically via the MCP configuration written by `tandem setup` (global) or `.mcp.json` (development).

**Desktop app:** The server is already running. Claude Code is auto-configured on every launch — your `tandem_*` tools are available immediately. Skip to [Real-Time Push](#real-time-push-recommended) if you want channel notifications.

Claude can check the connection with `tandem_status`, which reports open documents, connection state, and your current mode (Solo or Tandem).

### Real-Time Push (Recommended)

Start Claude Code with the channel flag for instant push notifications:

```bash
claude --dangerously-load-development-channels server:tandem-channel
```

Chat messages, annotation accepts/dismisses, and text selections push to Claude in real time — no polling needed. The `--dangerously-load-development-channels` flag is required until Tandem is added to the official channel allowlist.

### Polling Fallback

If channels aren't available, use the `/loop` skill in Claude Code to poll for messages:

```
/loop 30s check tandem inbox and respond to any new messages
```

This polls every 30 seconds. Token cost is minimal when there are no new messages.

### The Communication Loop

Two tools form the core of how Claude and the user communicate:

- **`tandem_checkInbox`** — Claude calls this to see user actions: chat messages, annotation accepts/dismisses, text selections, and document switches. Returns everything since the last check.
- **`tandem_reply`** — Claude sends a chat message back to the user. Appears in the Chat panel.

With channel push active, Claude receives events automatically without needing to poll `tandem_checkInbox`.

### Session Handoff

**What persists** across server restarts:
- Document content (Y.Doc state)
- All annotations (stored alongside Y.Doc in session files)
- File paths, formats, and metadata

**What doesn't persist:**
- Claude's awareness state (status text, focus paragraph)
- User awareness state (selection, typing indicator)

**How a new Claude session picks up:**
1. Call `tandem_status()` to see open documents
2. Call `tandem_listDocuments()` for details
3. Call `tandem_getOutline()` on the active document to orient
4. Call `tandem_getAnnotations()` to see existing annotation state
5. Continue where the previous session left off

Previously-open documents are auto-restored when the server starts — no manual `tandem_open` needed.

### Further Reading

- [MCP Tool Reference](mcp-tools.md) — Full documentation for all 31 tools
- [Workflows](workflows.md) — Advanced Claude Code patterns: cross-referencing documents, multi-model collaboration, RFP drafting, session handoff details
- [Architecture](architecture.md) — System design, coordinate systems, data flows

## Troubleshooting

### "Cannot reach the Tandem server"

The browser couldn't connect to the server via WebSocket. Make sure the server is running:
- **Global install:** Run `tandem` in a terminal
- **Development:** Run `npm run dev:standalone`

The message appears after 3 seconds of failed connection. If the server was restarted, refresh the browser tab.

### Annotations not appearing

Check the connection indicator in the status bar. If it shows "Reconnecting...", the WebSocket connection dropped — it will auto-reconnect.

If connected but annotations still aren't showing, check your **mode** in the toolbar. **Solo** mode holds Claude's pending annotations. Switch to **Tandem** to see everything.

Check the browser console for CRDT fallback warnings (`buildDecorations()` warnings indicate annotations falling back from CRDT-anchored to flat offsets).

### Document won't load

Verify the file path exists and is readable. The server logs (terminal where you started Tandem) will show errors for missing files or permission issues.

For `.docx` files, mammoth.js handles the conversion. Corrupted or password-protected `.docx` files will fail to open.

### Claude isn't responding

Make sure Claude Code is running and connected. Check `tandem_status` from Claude Code — if it returns an error, Claude can't reach the server. Run `/mcp` in Claude Code to reconnect.

If using channels, the server must be running before Claude Code starts. If you restarted the server, restart Claude Code or run `/mcp`.

For server-side and MCP troubleshooting, see the [README](../README.md#troubleshooting).

### Desktop app: server won't start

The desktop app runs the server as a background sidecar process. Check the system tray — if Tandem's icon is there, the server is running. If the icon is missing or the app shows an error dialog, the sidecar failed to start (port conflict, missing resources, or crash). Restart the app. For persistent issues, check the Tauri log output in the system console.
