# User Guide

A complete guide to using Tandem — from first launch to advanced workflows.

> **Scope:** Examples use Claude Code as the default AI, per [ADR-038](decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration). The editor itself is AI-client-agnostic — any MCP-capable client connecting to `http://127.0.0.1:3479/mcp` gets the same MCP tools. The Claude-specific transports (channel push, cowork, auto-launcher) don't apply to other clients.

> **Setting up an AI integration rather than learning the editor?** Skip to [Working with Claude Code](#working-with-claude-code) for the Claude default, or see [README → The MCP integration policy](../README.md#the-mcp-integration-policy) for the generic MCP path.

## Overview

Tandem lets you work on documents with an AI without the constant copy-paste. You open a document — an essay, a report, a proposal, a contract you're reviewing, or any prose — highlight the text you want to discuss, and the AI sees it directly. The AI can suggest rewrites, leave comments, and edit text alongside you in real time. Because the AI connects through MCP, it brings all its knowledge, tools, and conversation context to the document — it's not working in isolation. Each annotation is a first-class object you can accept, dismiss, edit, or discuss. The original file is never modified unless you save.

Tandem runs as a local server with two surfaces: an **editor** where you read and edit documents, and an **MCP client** (Claude Code by default) where the AI connects via MCP tools. Changes sync instantly between them through Yjs CRDT collaboration.

Tandem is available as a [desktop app](https://github.com/bloknayrb/tandem/releases/latest) (macOS, Linux, Windows) or as an [npm package](https://www.npmjs.com/package/tandem-editor) (`npm install -g tandem-editor`). The desktop app manages the server automatically; the npm install requires starting it from the terminal. Once running, the editor experience is identical either way.

## First Launch

On first run, Tandem opens `sample/welcome.md` automatically. Four tutorial annotations appear in the document — a highlight, a comment, a comment with replacement text, and a private note — so you have something to interact with immediately.

A floating tutorial card appears at the bottom-left of the editor with three steps:

1. **Review an annotation** — Accept or dismiss one of the tutorial annotations from the side panel, or turn on the margin view to see them beside the text.
2. **Ask Claude a question** — Select text, click Annotate, and send your question to your AI assistant. Or type in the Chat panel.
3. **Try editing** — Click in the document and type something.

The tutorial dismisses after all three steps and won't appear again (progress is saved to localStorage).

**Tip:** Start the Tandem server first, then open Claude Code with the channel flag. Having Claude connected before the tutorial means you'll see real responses when you ask a question in step 2.

**Desktop app users:** The server starts automatically when you open Tandem. On first run, the integration wizard walks you through connecting Claude Code — no need to run `tandem setup` from a terminal.

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

### Selection Popup

When text is selected, a floating popup appears with two parts:

- **Highlight swatches** — One-click highlighting in 4 colors (yellow, green, blue, pink), plus a "no highlight" swatch that clears an existing highlight.
- **Annotate** — Opens a small composer anchored to the selection. Type your text, then choose the audience:
  - **Note to self** (`Alt+Enter`) — A private note. Never sent to the AI.
  - **Send to Claude** (`Ctrl+Enter`) — An outbound comment. Claude sees the selected passage and your text, and can respond with annotations, chat messages, or both.

The popup also includes a toggle to show or hide the formatting bar.

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
- **Review Only badge** — Appears when the active document is read-only (e.g. an uploaded file, or the changelog opened via View Changelog).
- **Claude's activity** — What Claude is doing ("Working on Cost Summary...", idle, etc.).

Claude collaboration mode (**Solo** / **Tandem**) lives in the title bar at the top of the window, not the status bar. See [Solo / Tandem Mode](#solo--tandem-mode).

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
- **Word** (`.docx`) — Read-write. Saving writes your edits back to the `.docx` body, and pending comments are written back as real Word comments. Existing Word comments (`<w:comment>` elements) are imported as annotations with author "import". External edits (e.g. from Word) are detected: a clean document reloads in place, while a document with unsaved edits shows a keep-vs-reload banner instead of losing anything. A **Convert to Markdown** option is also available if you prefer working in Markdown.
- **Plain text** (`.txt`) — Full read-write support.
- **HTML** (`.html`, `.htm`) — Read support.

### Multi-Document Tabs

Each open file gets its own tab and its own collaboration room. Tabs scroll horizontally when they overflow. Reorder tabs by dragging or with `Alt+Left` / `Alt+Right`.

### Saving

Press `Ctrl+S` to save the active document to disk. Claude can also save via `tandem_save`. A dot on the tab title indicates unsaved changes. Saves are atomic (write to temp file, then rename) to prevent partial writes.

## Annotations

Annotations are how feedback — yours and Claude's — shows up in the document. There are three types, each with distinct visual styling:

### Highlight

Colored background on the annotated text. User-only — Claude never creates highlights. Choose from 4 colors (yellow, green, blue, pink) via the selection popup's swatches. Use highlights to mark notable passages — green for good, yellow for problems, pink for style/tone.

### Comment

Dashed underline on the annotated text. Comments are the shared channel: you create them to send observations or questions to Claude, and Claude creates them to give feedback on your text. The comment text appears in the side panel card.

Claude's comments may carry a **replacement suggestion** (`suggestedText`) — a proposed text change. The side panel card shows a diff view: the original text in red with strikethrough, an arrow, and the replacement text in green. When a reason is provided, it appears below the diff. Accepting the comment applies the text change automatically. Suggestions are Claude-only — your own comments are plain text; if you want a rewrite, ask for one in the comment and Claude responds with a suggestion you can accept.

### Note

A private note to yourself. Notes are never sent to Claude — it cannot read them through any MCP tool or event ([ADR-027](decisions.md#adr-027)). Use them for personal reminders while you work. A note can later be **promoted** to a comment if you decide Claude should see it (imported Word comments arrive as notes too, and can be batch-promoted).

### Creating Annotations

Select text in the editor to reveal the selection popup. Click a highlight swatch for a highlight, or click **Annotate**, type your text, and choose **Note to self** (private) or **Send to Claude** (comment).

### Editing Annotations

Click the **✎ Edit** button on any pending annotation card to edit its text. For a comment with replacement text, a second textarea appears for the proposed replacement.

Click **Save** to apply or **Cancel** to discard. Edited cards show "(edited)" with a timestamp. Only pending annotations can be edited — accepted or dismissed annotations are immutable.

## Reviewing Annotations

### One at a Time

Each annotation card in the side panel has **Accept** and **Dismiss** buttons. Accepting a comment with replacement text applies the text change. Accepting other annotations simply marks them as resolved.

### Undo

After accepting or dismissing, the resolved card briefly offers an **Undo** action. For accepted comments with replacement text, undo atomically reverts both the text change and the annotation status.

### Keyboard Review

Annotations can be reviewed without leaving the keyboard:

| Key | Action |
|-----|--------|
| `Alt+]` | Jump to next annotation |
| `Alt+[` | Jump to previous annotation |
| `Ctrl+Enter` | Accept the selected annotation (or the first pending one if none is selected) |
| `Ctrl+Shift+Enter` | Dismiss the selected annotation (or the first pending one) |
| `Escape` | Deselect the current annotation |

You can also enable the **margin view** (decorations menu) to see annotation cards beside the text they reference instead of in the side panel list.

### Bulk Actions

**Accept All** and **Dismiss All** buttons appear in the side panel header when multiple annotations are pending. A confirmation step is required before executing. When filters are active, bulk actions only affect the filtered annotations (e.g., "Accept 3 of 12 pending?").

### Solo / Tandem Mode

The title bar includes a **Solo / Tandem** toggle (`Ctrl+Shift+M`). It holds work back in *both* directions — Claude's annotations are held from you, and your own comments are held from Claude.

- **Tandem** (default) — Claude's annotations appear immediately as they arrive, and the comments and replies you write are visible to Claude.
- **Solo** — Claude's pending annotations are held back from the document. Resolved annotations (accepted/dismissed) are always visible regardless of mode.

Since v0.19.0 the server, not the client, enforces the other direction: while you are in Solo, the comments and replies **you** author are withheld from Claude. Each held item shows an amber **Held** pill, and the status bar shows a running count of what is being withheld. Switching back to Tandem releases the whole set at once — Claude picks them up on its next check, and a one-time nudge wakes a push-connected session to look.

**Exactly what the Solo hold covers.** Held comments and replies are withheld from three surfaces:

| Surface | Held in Solo? |
|---|---|
| `tandem_checkInbox` (what Claude is told) | Yes |
| `tandem_getAnnotations` (Claude reading the annotation list) | Yes |
| Real-time push (channel shim and plugin monitor) | Yes — annotation events only; chat messages always deliver |
| `tandem_exportAnnotations` (generating a review report) | **No** — an export is an explicit "give Claude everything" action and includes held comments |
| `tandem_getTextContent`, `tandem_getContext`, `tandem_search` | Not applicable — these return document text only, never annotation records |

Personal **notes** are private in both modes and are never surfaced to Claude through any tool ([ADR-027](decisions.md)).

Use **Solo** during focused writing to avoid interruption, or when you want to mark up a draft without Claude reacting to each comment. Switch to **Tandem** when you're ready — all held annotations appear at once, in both directions.

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

Press `?` to open the in-app shortcuts reference at any time — it always reflects your effective bindings. Most app-level shortcuts are remappable in **Settings → Shortcuts** (click-to-record); the defaults are listed below.

### Editor

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` | Bold |
| `Ctrl+I` | Italic |
| `Ctrl+K` | Insert/remove link |
| `Ctrl+S` | Save document |
| `Ctrl+Shift+S` | Save As (e.g. promote a scratchpad to a file) |
| `Ctrl+F` | Find / replace |
| `Alt+L` | Select containing block |

> **Note:** Undo/redo is not yet available in collaborative mode (tracked as a future enhancement).

### Annotations & Review

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Accept selected (or first pending) annotation |
| `Ctrl+Shift+Enter` | Dismiss selected (or first pending) annotation |
| `Alt+]` | Next annotation |
| `Alt+[` | Previous annotation |
| `Ctrl+Alt+M` | Comment on current selection |
| `Ctrl+Alt+A` | Toggle authorship colors |
| `Escape` | Deselect annotation / close overlays |

### Navigation & General

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+N` | New scratchpad |
| `Ctrl+O` | Open file |
| `Ctrl+T` | New-tab menu (recent files / browse) |
| `Ctrl+W` | Close tab |
| `Ctrl+Alt+T` | Reopen closed tab |
| `Ctrl+1`–`Ctrl+9` | Jump to tab 1–9 |
| `Alt+Left` / `Alt+Right` | Reorder the focused tab |
| `Alt+Shift+Left` / `Alt+Shift+Right` | Toggle left / right panel |
| `Ctrl+Shift+M` | Toggle Solo / Tandem mode |
| `Ctrl+,` | Settings |
| `Enter` | Send message (chat panel) |
| `?` | Show/hide keyboard shortcuts |

## Working with Claude Code

Tandem connects to Claude Code through MCP (Model Context Protocol). Claude gets Tandem's full MCP tool surface for reading documents, creating annotations, searching text, managing files, and communicating with you.

### Connection

Start the Tandem server first (`tandem` for global install, or `npm run dev:standalone` for development). Then start Claude Code. Claude's tools become available via the MCP configuration written by the integration wizard (or `tandem setup --apply` for a scripted setup), or `.mcp.json` (development).

**Desktop app:** The server is already running. On first run the integration wizard configures Claude Code; once connected, your `tandem_*` tools are available immediately. You can re-open the wizard any time from the tray "Setup AI Assistant" item or Settings. Skip to [Real-Time Push](#real-time-push-recommended) if you want channel notifications.

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

- [MCP Tool Reference](mcp-tools.md) — Full documentation for all MCP tools
- [Workflows](workflows.md) — Advanced Claude Code patterns: cross-referencing documents, multi-model collaboration, RFP drafting, session handoff details
- [Architecture](architecture.md) — System design, coordinate systems, data flows

## Troubleshooting

### "Cannot reach the Tandem server"

The editor couldn't connect to the server via WebSocket. Make sure the server is running:
- **Global install:** Run `tandem` in a terminal
- **Development:** Run `npm run dev:standalone`

The message appears after 3 seconds of failed connection. If the server was restarted, refresh the page.

### Annotations not appearing

Check the connection indicator in the status bar. If it shows "Reconnecting...", the WebSocket connection dropped — it will auto-reconnect.

If connected but annotations still aren't showing, check your **mode** in the toolbar. **Solo** mode holds Claude's pending annotations. Switch to **Tandem** to see everything.

Check the developer console for CRDT fallback warnings (`buildDecorations()` warnings indicate annotations falling back from CRDT-anchored to flat offsets).

### Document won't load

Verify the file path exists and is readable. The server logs (terminal where you started Tandem) will show errors for missing files or permission issues.

For `.docx` files, mammoth.js handles the conversion. Corrupted or password-protected `.docx` files will fail to open.

### Claude isn't responding

Make sure Claude Code is running and connected. Check `tandem_status` from Claude Code — if it returns an error, Claude can't reach the server. Run `/mcp` in Claude Code to reconnect.

If using channels, the server must be running before Claude Code starts. If you restarted the server, restart Claude Code or run `/mcp`. Channel timeout messages such as `/api/events timed out after 10000ms`, `SSE inactivity timeout`, or `/api/channel-reply timed out after 5000ms` mean the server accepted a connection but stopped responding; restart Tandem and reconnect Claude.

For server-side and MCP troubleshooting, see the [README](../README.md#troubleshooting).

### Desktop app: server won't start

The desktop app runs the server as a background sidecar process. Check the system tray — if Tandem's icon is there, the server is running. If the icon is missing or the app shows an error dialog, the sidecar failed to start (port conflict, missing resources, or crash). Restart the app. For persistent issues, check the Tauri log output in the system console.
