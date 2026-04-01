# MCP Tool Reference

Tandem exposes 28 tools via MCP HTTP (Model Context Protocol). The channel shim also exposes `tandem_reply` for real-time push contexts; Claude Code discovers both transports automatically. All tools use flat text character offsets for positions -- use `tandem_resolveRange` to get safe offsets from text patterns.

## Response Format

All tools return responses in a standard envelope:

**Success:**
```json
{ "error": false, "data": { ... } }
```

**Error:**
```json
{ "error": true, "code": "ERROR_CODE", "message": "Human-readable description" }
```

### Error Codes

| Code | Trigger |
|------|---------|
| `NO_DOCUMENT` | Tool called before `tandem_open`, or specified `documentId` not found. |
| `FILE_NOT_FOUND` | File doesn't exist or is a UNC path. |
| `FILE_LOCKED` | File is open in another program (e.g., Word). Close it first. |
| `FORMAT_ERROR` | Unsupported format, file too large (>50MB), or invalid regex. |
| `INVALID_RANGE` | Offset out of bounds, text not found, or range overlaps heading markup. |
| `RANGE_STALE` | *(Planned)* Document changed between resolveRange and a mutation. |

## Coordinate System

All MCP tools use **flat text offsets** -- the same positions you'd get from the document rendered as plain text with heading prefixes (`# `, `## `) and `\n` between paragraphs. Example:

```
# Title\nSome paragraph text\n## Section Two
^0     ^7^8                  ^28^29
```

Offsets 0-1 are `# ` (heading prefix), 2-6 are `Title`, 7 is `\n`, etc. The browser uses ProseMirror positions internally (which differ), but you never need to know that -- MCP tools handle the conversion.

**Important:** Edit ranges that overlap heading markup (e.g., targeting offset 0-1 which is `# `) are rejected with `INVALID_RANGE`. Always target the text content, not the markdown prefix.

---

## Multi-Document Support

All tools that operate on a document accept an optional `documentId` parameter. If omitted, the tool targets the **active document** (the most recently opened or switched-to document). Use `tandem_listDocuments` to see all open documents and their IDs, and `tandem_switchDocument` to change the default target.

Document IDs are stable -- the same file path always produces the same ID across sessions.

---

## Document Tools

### tandem_open

Open a file in the Tandem editor. Returns a `documentId` for multi-document workflows. Auto-opens the browser on first call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | yes | Absolute path to the file to open |
| `force` | boolean | no | Force reload from disk even if already open. Clears annotations and session. |

**Returns:**
```json
{
  "documentId": "report-a1b2c3",
  "filePath": "C:\\Users\\bkolb\\docs\\report.md",
  "fileName": "report.md",
  "format": "md",
  "readOnly": false,
  "source": "file",
  "tokenEstimate": 1250,
  "pageEstimate": 2,
  "restoredFromSession": false,
  "alreadyOpen": false,
  "forceReloaded": false,
  "message": "Document opened: report.md"
}
```

**Errors:** `FILE_NOT_FOUND` (doesn't exist, UNC path), `FILE_LOCKED` (open in Word), `FORMAT_ERROR` (>50MB)

**Example:**
```
tandem_open({ filePath: "C:\\Users\\bkolb\\Documents\\progress-report-feb.md" })
```

**Notes:**
- Supported formats: `.md`, `.txt`, `.html`, `.docx` (review-only).
- Browser opens automatically to `http://localhost:5173` on the first call.
- Opening a file that's already open switches to its tab (returns `alreadyOpen: true`).
- Pass `force: true` to reload from disk when the file changed externally (git pull, external editor). Clears annotations and session. Returns `forceReloaded: true`.
- Multiple documents can be open simultaneously -- each gets its own tab.
- If a session exists for this file (and the source hasn't changed), annotations are restored.

---

### tandem_getContent

Read full document content as ProseMirror JSON structure.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{
  "content": [ ... ProseMirror JSON nodes ... ],
  "filePath": "C:\\Users\\bkolb\\docs\\report.md",
  "documentId": "report-a1b2c3"
}
```

**Warning:** Token-heavy. A 20-page doc produces ~50K tokens. Use `tandem_getOutline` or `tandem_getTextContent` instead for large documents.

---

### tandem_getTextContent

Read document as plain text. ~60% fewer tokens than `getContent`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `section` | string | no | Heading text to read only that section (case-insensitive) |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns (full document):**
```json
{
  "text": "# Title\nFirst paragraph...\n## Section\nMore text...",
  "filePath": "C:\\Users\\bkolb\\docs\\report.md",
  "documentId": "report-a1b2c3"
}
```

**Returns (section only):**
```json
{
  "text": "## Section\nMore text...",
  "filePath": "C:\\Users\\bkolb\\docs\\report.md",
  "section": "Section"
}
```

**Errors:** `INVALID_RANGE` if section heading not found.

**Example:**
```
tandem_getTextContent({ section: "Cost Summary" })
```

**Notes:**
- Always uses the flat text format (`extractText`) regardless of file format — offsets match the annotation coordinate system exactly. Does not return markdown syntax (no `> `, `- `, etc.).
- Section extraction reads from the matching heading until the next heading at the same or higher level.

---

### tandem_getOutline

Get document structure (headings only) without full content. Low token cost.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{
  "outline": [
    { "level": 1, "text": "Monthly Progress Report", "index": 0 },
    { "level": 2, "text": "Executive Summary", "index": 1 },
    { "level": 2, "text": "Cost Summary", "index": 5 },
    { "level": 3, "text": "Labor Costs", "index": 6 }
  ],
  "totalNodes": 24
}
```

**Best practice:** Call this first on large documents to understand structure, then use `getTextContent(section)` for targeted reads.

---

### tandem_edit

Replace text at a specific range. Single-paragraph replacements only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | number | yes | Start position (flat text character offset) |
| `to` | number | yes | End position (flat text character offset) |
| `newText` | string | yes | Replacement text (no newlines -- inserted literally) |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{ "edited": true, "from": 42, "to": 67, "newTextLength": 31 }
```

**Errors:** `INVALID_RANGE` (offsets out of bounds, overlaps heading markup), `FORMAT_ERROR` (read-only document)

**Example:**
```
// First, find the text you want to edit:
tandem_resolveRange({ pattern: "$12.4 million" })
// Returns: { from: 180, to: 193 }

// Then edit it:
tandem_edit({ from: 180, to: 193, newText: "$13.1 million" })
```

**Notes:**
- Always use `tandem_resolveRange` first to get safe offsets.
- Newlines in `newText` are inserted as literal characters, not new paragraphs.
- Cross-element edits (spanning multiple paragraphs) are supported but merge into one paragraph.
- Edits appear instantly in the browser.
- Read-only documents (.docx) reject edits -- use annotations instead.

---

### tandem_save

Save the current document back to disk. Uses atomic write (temp file + rename).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{ "saved": true, "filePath": "C:\\Users\\bkolb\\docs\\report.md" }
```

**Notes:** Read-only documents (.docx) save their session only (annotations persist), not the source file.

**Errors:** `FILE_LOCKED` (file open in another program)

---

### tandem_status

Check editor status: running state, open documents, active document.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

**Returns:**
```json
{
  "running": true,
  "activeDocument": { "documentId": "report-a1b2c3", "filePath": "...", "format": "md" },
  "openDocuments": [
    { "documentId": "report-a1b2c3", "filePath": "...", "format": "md", "readOnly": false },
    { "documentId": "invoice-d4e5f6", "filePath": "...", "format": "docx", "readOnly": true }
  ],
  "documentCount": 2,
  "interruptionMode": "all"
}
```

**Notes:**
- `interruptionMode` reflects the user's current interruption preference from the browser StatusBar: `"all"` (show everything), `"urgent"` (only flags, questions, and `priority: 'urgent'`), or `"paused"` (hold all new annotations). Adapt your annotation strategy accordingly — e.g., in `"urgent"` mode, prefer `tandem_flag` with `priority: 'urgent'` over `tandem_comment` for important findings.

---

### tandem_close

Close a document. Closes the active document if no `documentId` specified.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | no | Document ID to close (defaults to active document) |

**Returns:**
```json
{ "closed": true, "was": "C:\\Users\\bkolb\\docs\\report.md", "activeDocumentId": "invoice-d4e5f6" }
```

---

### tandem_listDocuments

List all open documents with their IDs, file paths, and formats.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

**Returns:**
```json
{
  "documents": [
    { "id": "report-a1b2c3", "filePath": "...", "fileName": "report.md", "format": "md", "readOnly": false, "isActive": true },
    { "id": "invoice-d4e5f6", "filePath": "...", "fileName": "invoice.docx", "format": "docx", "readOnly": true, "isActive": false }
  ],
  "activeDocumentId": "report-a1b2c3",
  "count": 2
}
```

---

### tandem_switchDocument

Switch the active document. Tools will operate on this document by default.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | yes | Document ID to switch to |

**Returns:**
```json
{ "activeDocumentId": "invoice-d4e5f6", "filePath": "...", "fileName": "invoice.docx" }
```

**Errors:** `NO_DOCUMENT` if document ID not found among open documents.

---

### tandem_convertToMarkdown

Convert a `.docx` document to an editable Markdown file. Writes the `.md` file to disk and opens it as a new tab.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | no | Document ID of the `.docx` to convert (defaults to active document) |
| `outputPath` | string | no | Custom output path for the `.md` file (defaults to same directory as the `.docx`) |

**Returns:**
```json
{
  "converted": true,
  "outputPath": "C:\\Users\\bkolb\\docs\\report.md",
  "documentId": "report-a1b2c3",
  "fileName": "report.md",
  "message": "Converted to Markdown: report.md"
}
```

**Notes:** The source document must be a `.docx` file. The converted Markdown file opens as a new editable tab alongside the original read-only `.docx`.

**Errors:** `NO_DOCUMENT` (no active document or `documentId` not found), `FORMAT_ERROR` (source is not `.docx`, invalid output path, or conversion produced empty result)

---

## Annotation Tools

Annotations are metadata stored in `Y.Map('annotations')` on the shared document -- they don't modify the document text itself. Each annotation has an `id`, `author` (claude/user/import), `type`, `range`, `content`, `status` (pending/accepted/dismissed), and `timestamp`. The `import` author is used for Word comments extracted from `.docx` files on open.

### tandem_highlight

Highlight text with a color and optional note.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | number | yes | Start position |
| `to` | number | yes | End position |
| `color` | enum | yes | `yellow`, `red`, `green`, `blue`, `purple` |
| `note` | string | no | Optional note for the highlight |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{ "annotationId": "ann_1710936000000_a1b2c3" }
```

**Example:**
```
tandem_highlight({ from: 42, to: 67, color: "red", note: "This figure doesn't match the invoice" })
```

---

### tandem_comment

Add a comment attached to a text range. Appears in the side panel.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | number | yes | Start position |
| `to` | number | yes | End position |
| `text` | string | yes | Comment text |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{ "annotationId": "ann_1710936000000_d4e5f6" }
```

---

### tandem_suggest

Propose a text replacement (tracked-change style). User sees it as accept/reject in the browser.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | number | yes | Start position |
| `to` | number | yes | End position |
| `newText` | string | yes | Suggested replacement text |
| `reason` | string | no | Reason for the suggestion |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{ "annotationId": "ann_1710936000000_g7h8i9" }
```

**Example:**
```
tandem_suggest({
  from: 180, to: 193,
  newText: "$13.1 million",
  reason: "Q3 revenue was updated in the latest financial report"
})
```

---

### tandem_flag

Flag a text range for attention (e.g., issues, concerns, or items needing review). Renders as a red underline decoration.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | number | Yes | Start position (character offset) |
| `to` | number | Yes | End position (character offset) |
| `note` | string | No | Reason for flagging |
| `documentId` | string | No | Target document ID (defaults to active document) |
| `priority` | `'normal'` \| `'urgent'` | No | Annotation priority. Set to 'urgent' for critical issues visible in urgent-only mode. Flags and questions are implicitly urgent. |
| `textSnapshot` | string | No | Expected text at range — returns RANGE_STALE if moved |

**Returns:** `{ annotationId: string }`

```js
tandem_flag({ from: 100, to: 120, note: "This claim needs a citation" })
```

---

### tandem_getAnnotations

Read all annotations, optionally filtered. For checking new user actions, prefer `tandem_checkInbox`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `author` | enum | no | `user` or `claude` |
| `type` | enum | no | `highlight`, `comment`, `suggestion`, `overlay`, `question` |
| `status` | enum | no | `pending`, `accepted`, `dismissed` |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{
  "annotations": [
    {
      "id": "ann_1710936000000_a1b2c3",
      "author": "claude",
      "type": "highlight",
      "range": { "from": 42, "to": 67 },
      "content": "This figure doesn't match the invoice",
      "status": "pending",
      "timestamp": 1710936000000,
      "color": "red"
    }
  ],
  "count": 1
}
```

---

### tandem_resolveAnnotation

Accept or dismiss an annotation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Annotation ID |
| `action` | enum | yes | `accept` or `dismiss` |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{ "id": "ann_1710936000000_a1b2c3", "status": "accepted" }
```

---

### tandem_removeAnnotation

Delete an annotation permanently.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Annotation ID |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{ "removed": true, "id": "ann_1710936000000_a1b2c3" }
```

---

### tandem_editAnnotation

Edit the content of an existing annotation. Only pending annotations can be edited.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Annotation ID |
| `content` | string | no | New comment/note text (for highlights, comments, flags) |
| `newText` | string | no | New suggested replacement text (for suggestions only) |
| `reason` | string | no | New reason text (for suggestions only) |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{ "id": "ann_1710936000000_a1b2c3", "edited": true, "editedAt": 1710936500000 }
```

**Errors:** `NO_DOCUMENT` (document not found), error if annotation not found or not pending.

**Example:**
```
tandem_editAnnotation({
  id: "ann_1710936000000_a1b2c3",
  content: "Updated: This figure is actually correct per the latest revision"
})
```

**Notes:**
- At least one of `content`, `newText`, or `reason` must be provided.
- Only pending annotations can be edited — accepted or dismissed annotations return an error.
- Sets `editedAt` timestamp on the annotation. The browser shows an "(edited)" indicator.
- For suggestions, `newText` updates the proposed replacement and `reason` updates the justification. For other types, use `content`.

---

### tandem_exportAnnotations

Export all annotations as a formatted summary. Useful for review reports, especially on read-only .docx files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `format` | enum | no | `markdown` (default) or `json` |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns (markdown):**
```json
{ "markdown": "# Review Report\n\n## Highlights\n...", "count": 5 }
```

**Returns (json):**
```json
{ "annotations": [ { ...annotation, "textSnippet": "..." } ], "count": 5 }
```

---

## Navigation Tools

### tandem_search

Search for text in the document. Returns all matching positions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query |
| `regex` | boolean | no | Treat query as regex (default: false) |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{
  "matches": [
    { "from": 42, "to": 55, "text": "$12.4 million" },
    { "from": 180, "to": 193, "text": "$12.4 million" }
  ],
  "count": 2
}
```

---

### tandem_resolveRange

Find text and return a safe position range. **Always use this before `tandem_edit`** -- raw offsets can go stale under concurrent editing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | yes | Text to find (literal match) |
| `occurrence` | number | no | Which occurrence, 1-based (default: 1) |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{ "from": 42, "to": 55, "text": "$12.4 million" }
```

**Errors:** `INVALID_RANGE` if text not found.

---

### tandem_setStatus

Update Claude's status text shown to the user in the editor status bar.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | yes | Status text (e.g., "Reviewing cost figures...") |
| `focusParagraph` | number | no | Index of paragraph Claude is focusing on (renders blue tint) |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{ "status": "Reviewing cost figures..." }
```

**Notes:**
- Status appears in the bottom bar of the editor as "Claude -- Reviewing cost figures..."
- `focusParagraph` index highlights that paragraph with a soft blue tint and animated gutter bar.
- Returns a `warning` field if no document is open (status not broadcast).

---

### tandem_getContext

Read content around a range without pulling the full document.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | number | yes | Start position |
| `to` | number | yes | End position |
| `windowSize` | number | no | Characters of context before/after (default: 500) |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{
  "context": "...surrounding text including the selection...",
  "selection": "the selected text",
  "contextRange": { "from": 0, "to": 120 },
  "selectionRange": { "from": 42, "to": 55 }
}
```

---

## Awareness Tools

### tandem_getSelections

Get text the user currently has selected in the browser editor.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns (text selected):**
```json
{
  "selections": [{ "from": 42, "to": 67 }],
  "timestamp": 1710936000000
}
```

**Returns (no selection):**
```json
{ "selections": [], "message": "No text selected" }
```

**Notes:** Positions are flat text offsets (same coordinate system as all other tools). The client converts ProseMirror positions before writing to the shared state.

---

### tandem_getActivity

Check if the user is actively editing and where their cursor is.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{
  "active": true,
  "isTyping": true,
  "cursor": 142,
  "lastEdit": 1710936000000
}
```

**Notes:**
- `active` is true if the user typed within the last 10 seconds.
- `isTyping` is true during active keystroke bursts (debounced at 3 seconds).
- Use this to avoid interrupting the user while they're typing.

---

### tandem_checkInbox

Check for user actions you haven't seen yet -- new highlights, comments, questions, and responses to your annotations. Low token cost. Call this after completing any task, between steps, and whenever you pause.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{
  "summary": "2 new: 1 comment, 1 question. 1 accepted.",
  "hasNew": true,
  "userActions": [ { ...annotation, "textSnippet": "..." } ],
  "userResponses": [ { ...annotation, "textSnippet": "..." } ],
  "activity": {
    "isTyping": false,
    "cursor": 142,
    "lastEdit": 1710936000000,
    "selectedText": null
  },
  "interruptionMode": "all"
}
```

**Notes:**
- Each annotation is surfaced only once -- subsequent calls return only new items.
- `userActions`: annotations created by the user (highlights, comments, questions).
- `userResponses`: the user's accept/dismiss decisions on Claude's annotations.
- `chatMessages`: new chat messages from the user via the ChatPanel sidebar. Each entry has `id`, `author`, `text`, `timestamp`, and optionally `documentId` (the document that was active when the message was sent).
- `interruptionMode`: the user's current interruption preference (`"all"`, `"urgent"`, or `"paused"`). When `"urgent"`, only use `tandem_flag` with `priority: 'urgent'` for critical findings. When `"paused"`, queue work and wait for the mode to change.

---

### tandem_reply

Send a chat message to the user via the ChatPanel sidebar. Session-scoped (lives on `__tandem_ctrl__`, not per-document).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | yes | Message text to send |
| `replyTo` | string | no | ID of the user message being replied to |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{ "sent": true, "messageId": "msg_1710936000000_a1b2c3" }
```

**Example:**
```
tandem_reply({ text: "I've finished reviewing the cost section. Two figures need updating.", replyTo: "msg_1710935000000_x9y8z7" })
```

**Notes:**
- Chat messages are stored in `Y.Map('chat')` on the `__tandem_ctrl__` Y.Doc, so they persist across the session but are not tied to a specific document.
- The `documentId` field captures which document was active for context, but the message itself lives on the control channel.
- New user messages appear in `tandem_checkInbox` via the `chatMessages` array.

---

## HTTP API (Browser File Opening)

In addition to MCP tools, the server exposes REST endpoints on the same port (:3479) for browser-initiated file opening. These are NOT MCP tools — they use standard HTTP request/response with JSON bodies.

Both endpoints converge with `tandem_open` in `file-opener.ts`, so the resulting Y.Doc and Hocuspocus sync behave identically regardless of how the file was opened.

### POST /api/open

Open a file by its absolute path on disk. Equivalent to `tandem_open` but callable from the browser.

**Request:**
```json
{ "filePath": "C:\\Users\\bkolb\\docs\\report.md" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `filePath` | string | yes | Absolute path to the file |
| `force` | boolean | no | Reload from disk even if already open (clears annotations + session) |

**Response (200):**
```json
{ "data": { "documentId": "report-a1b2c3", "fileName": "report.md", "format": "md", "readOnly": false, "source": "file", ... } }
```

**Errors:** `404 FILE_NOT_FOUND`, `400 UNSUPPORTED_FORMAT`, `400 INVALID_PATH`, `413 FILE_TOO_LARGE`, `423 FILE_LOCKED`, `403 PERMISSION_DENIED`

### POST /api/close

Close an open document by its document ID. Equivalent to `tandem_close` but callable from the browser. Used by the client's tab close button.

**Request:**
```json
{ "documentId": "report-a1b2c3" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `documentId` | string | yes | Document ID to close |

**Response (200):**
```json
{ "data": { "closed": true, "was": "C:\\Users\\bkolb\\docs\\report.md", "activeDocumentId": "invoice-d4e5f6" } }
```

**Errors:** `400 BAD_REQUEST` (missing documentId), `404 NO_DOCUMENT` (document not found)

---

### POST /api/upload

Open a file from uploaded content (no disk path). Used by the browser's drag-and-drop and file picker UI.

**Request:**
```json
{ "fileName": "notes.md", "content": "# My Notes\n\nSome content..." }
```

For binary formats (.docx), `content` is base64-encoded.

**Response (200):**
```json
{ "data": { "documentId": "notes-x1y2z3", "fileName": "notes.md", "format": "md", "readOnly": true, "source": "upload", "filePath": "upload://uuid/notes.md", ... } }
```

Uploaded files are always read-only — there is no disk path to save to. The synthetic `upload://` path is used as the session key. `tandem_save` on an uploaded file returns a session-only save.

**Errors:** `400 UNSUPPORTED_FORMAT`, `400 BAD_REQUEST`

### CORS

Both `/api/*` endpoints include CORS headers reflecting any `http://localhost:*` origin (dynamic, not hardcoded port). The body size limit is 70MB to accommodate base64-encoded .docx files (50MB file → ~67MB base64).

---

## Channel API (Real-Time Push)

The channel API endpoints support the Tandem channel shim, which pushes real-time events from the browser to Claude Code via the Channels API. These are NOT MCP tools — they are HTTP endpoints on port 3479.

### GET /api/events

SSE (Server-Sent Events) stream of `TandemEvent` objects. The channel shim connects here and forwards events to Claude Code as `notifications/claude/channel`.

**Headers:**
- `Accept: text/event-stream`
- `Last-Event-ID` (optional) — for reconnection replay

**Stream format:**
```
: connected

id: evt_1710936000000_a1b2c3
data: {"id":"evt_1710936000000_a1b2c3","type":"chat:message","timestamp":1710936000000,"documentId":"report-a1b2c3","payload":{"messageId":"msg_...","text":"Hello"}}

: keepalive
```

Events are only emitted for browser-originated Y.Map changes (MCP-originated writes are filtered via origin tagging). Keepalives are sent every 15 seconds. The event buffer holds up to 200 events or 60 seconds of history for reconnection replay.

### POST /api/channel-awareness

Channel shim reports Claude's current processing status for the browser StatusBar.

**Request:**
```json
{ "status": "processing: chat:message", "documentId": "report-a1b2c3", "active": true }
```

**Response:** `{ "ok": true }`

### POST /api/channel-reply

Channel shim forwards Claude's chat reply to the Y.Map('chat') on `__tandem_ctrl__`.

**Request:**
```json
{ "text": "I'll review that section.", "documentId": "report-a1b2c3", "replyTo": "msg_..." }
```

**Response:** `{ "sent": true, "messageId": "msg_1710936000000_x1y2z3" }`

### POST /api/channel-error

Channel shim reports connection errors.

**Request:**
```json
{ "error": "CHANNEL_CONNECT_FAILED", "message": "Lost connection after 5 retries" }
```

**Response:** `{ "ok": true }`

### POST /api/channel-permission

Channel shim forwards Claude Code's tool approval prompt for browser-side permission UI.

**Request:**
```json
{ "requestId": "req_1", "toolName": "tandem_edit", "description": "Edit paragraph 1", "inputPreview": "..." }
```

**Response:** `{ "ok": true }`

### GET /api/channel-permission

Poll pending permission requests (for browser UI).

**Response:**
```json
{ "pending": [{ "requestId": "req_1", "toolName": "tandem_edit", "description": "...", "createdAt": 1710936000000 }] }
```

Stale requests (>30s) are evicted automatically.

### POST /api/channel-permission-verdict

Browser submits allow/deny verdict for a permission request.

**Request:**
```json
{ "requestId": "req_1", "approved": true }
```

**Response:** `{ "ok": true, "requestId": "req_1", "behavior": "allow" }`

### GET /api/notify-stream

SSE (Server-Sent Events) stream of toast notifications for the browser. Separate from `GET /api/events` (which pushes Y.Map events to the channel shim). Used for ephemeral notifications like annotation range failures and save errors.

**Headers:**
- `Accept: text/event-stream`

**Stream format:**
```
data: {"type":"error","title":"Range Error","message":"Annotation target text has moved","timestamp":1710936000000}

data: {"type":"warning","title":"Save Warning","message":"File is read-only","timestamp":1710936001000}
```

**Notification types:** `error` (auto-dismiss 8s), `warning` (auto-dismiss 6s), `info` (auto-dismiss 4s). The ring buffer holds up to 50 notifications. Duplicate notifications within a short window are deduplicated with a count badge in the browser.

---

### POST /api/launch-claude

Spawn a Claude Code process with the channel shim connected. No request body required.

**Response:** `{ "status": "launched", "pid": 12345 }` or `{ "status": "already_running", "pid": 12345 }`
