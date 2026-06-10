# MCP Tool Reference

These tools are exposed over the MCP protocol. **Claude Code is Tandem's default and most-tested client** ([ADR-038](decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration)), but the tools are available to any MCP-capable client connecting to `http://127.0.0.1:3479/mcp`.

Tandem exposes 31 tools via MCP HTTP (28 active, 3 deprecated stubs that return structured errors). The channel shim also exposes `tandem_reply` for real-time push contexts — the shim itself is a Claude-specific stdio transport on top of the MCP contract; other MCP clients discover the HTTP transport automatically and subscribe to `/api/events` directly for the same real-time stream. All tools use flat text character offsets for positions — use `tandem_resolveRange` to get safe offsets from text patterns.

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
| `FORMAT_ERROR` | Unsupported format, read-only / non-markdown document, file too large (>50MB), or invalid regex. |
| `FILE_TOO_LARGE` | Inline content exceeds the tool's size cap (e.g. `tandem_appendContent`). |
| `INVALID_RANGE` | Offset out of bounds, text not found, or range overlaps heading markup. |
| `EMPTY_DOCUMENT` | `tandem_edit` called on an empty document — seed content with `tandem_appendContent` / `tandem_scratchpad({ content })` first. |
| `RANGE_MOVED` | Target text has moved. Response includes `resolvedFrom`/`resolvedTo` with relocated coordinates. |
| `RANGE_GONE` | Target text was deleted from the document. |
| `PERMISSION_DENIED` | File path is not accessible (OS-level permission denied, e.g., `EACCES`). |

## Coordinate System

All MCP tools use **flat text offsets** -- the same positions you'd get from the document rendered as plain text with heading prefixes (`# `, `## `) and `\n` between paragraphs. Example:

```
# Title\nSome paragraph text\n## Section Two
^0     ^7^8                  ^28^29
```

Offsets 0-1 are `# ` (heading prefix), 2-6 are `Title`, 7 is `\n`, etc. The editor uses ProseMirror positions internally (which differ), but you never need to know that -- MCP tools handle the conversion.

**Important:** Edit ranges that overlap heading markup (e.g., targeting offset 0-1 which is `# `) are rejected with `INVALID_RANGE`. Always target the text content, not the markdown prefix.

---

## Multi-Document Support

All tools that operate on a document accept an optional `documentId` parameter. If omitted, the tool targets the **active document** (the most recently opened or switched-to document). Use `tandem_listDocuments` to see all open documents and their IDs, and `tandem_switchDocument` to change the default target.

Document IDs are stable -- the same file path always produces the same ID across sessions.

---

## Document Tools

### tandem_open

Open a file in the Tandem editor. Returns a `documentId` for multi-document workflows. Auto-opens the editor on first call.

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
- Editor opens automatically in the Tauri WebView (desktop) or at `http://127.0.0.1:5173` (development) on the first call.
- Opening a file that's already open switches to its tab (returns `alreadyOpen: true`).
- **Auto-reload:** Open documents are automatically reloaded when the file changes on disk (e.g., Claude's Edit tool, `git pull`). Annotations are preserved. A toast notification appears in the editor.
- Pass `force: true` to manually reload from disk. Clears annotations and session. Returns `forceReloaded: true`. Typically unnecessary now that auto-reload handles external changes.
- Multiple documents can be open simultaneously -- each gets its own tab.
- If a session exists for this file (and the source hasn't changed), annotations are restored.

---

### tandem_scratchpad

Create and open a new Scratchpad tab, optionally seeded with markdown content. Scratchpads are ephemeral — content is lost when the tab is closed. Useful for drafting, brainstorming, or working on throwaway content without touching the filesystem.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | no | Optional initial markdown. Block structure (headings, lists, blank-line-separated paragraphs) is parsed into real blocks. |

**Returns:**
```json
{
  "documentId": "scratchpad-a1b2c3",
  "fileName": "Scratchpad.md",
  "format": "md"
}
```

**Example:**
```
tandem_scratchpad({ content: "# Test plan\n\n- Step one\n- Step two" })
```

**Notes:**
- Each call creates a new scratchpad with a unique ID.
- Scratchpads use `upload://` synthetic paths — they are not saved to disk.
- Seeded content parses real block structure; to add more later, use `tandem_appendContent`.
- Also available via `Ctrl+N` in the editor or the `+` button in the tab bar.

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
- Edits appear instantly in the editor.
- Read-only documents (.docx) reject edits -- use annotations instead.
- On an **empty** document `tandem_edit` returns `EMPTY_DOCUMENT` -- seed content with `tandem_appendContent` or `tandem_scratchpad({ content })` first.

---

### tandem_appendContent

Append **structured** markdown to the end of the document. Unlike `tandem_edit` (single-paragraph, literal newlines), this parses headings, lists, and blank-line-separated paragraphs into real blocks. Non-destructive -- existing content and annotations are untouched. Also seeds an empty document.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | yes | Markdown to append. Block structure (headings, lists, blank-line-separated paragraphs) is parsed into real blocks. |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{ "appended": true, "blockCount": 3 }
```

**Errors:** `FORMAT_ERROR` (read-only, or non-markdown document), `FILE_TOO_LARGE` (content over the 1 MB inline cap), `NO_DOCUMENT`

**Example:**
```
// Seed an empty scratchpad, then add a section:
tandem_scratchpad()
tandem_appendContent({ content: "# Notes\n\n- First point\n- Second point\n\nA closing paragraph." })
```

**Notes:**
- Content is **appended at the end** — it never deletes or overwrites existing content. To replace text, use `tandem_edit`; to reload a file wholesale, use `tandem_open({ force: true })`.
- Appending shifts no existing offsets, so existing annotations and authorship ranges stay valid.
- Appended text is attributed to Claude (authorship overlay), matching `tandem_edit`.
- Markdown documents only in v1. Read-only (.docx) and non-`md` documents are rejected with `FORMAT_ERROR`.
- For arbitrary mid-document insertion (not just append), use `tandem_edit` per block, or open the file after writing it.

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

Check editor status (running state, open documents, active document) and optionally update the AI's status text shown in the editor (Claude's, in the default integration; any connected MCP client can set it).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | no | Status text to show in the editor status bar (e.g., `"Reviewing cost figures..."`). When omitted, read-only mode. |
| `focusParagraph` | number | no | Index of paragraph Claude is focusing on (renders blue tint + animated gutter bar). Only used when `text` is provided. |
| `focusOffset` | number | no | Flat text offset alternative to `focusParagraph` for paragraph targeting. Only used when `text` is provided. |
| `documentId` | string | no | Target document ID for status display (defaults to active document). Only used when `text` is provided. |

**Returns (read mode — no `text` param):**
```json
{
  "running": true,
  "activeDocument": { "documentId": "report-a1b2c3", "filePath": "...", "format": "md" },
  "openDocuments": [
    { "documentId": "report-a1b2c3", "filePath": "...", "format": "md", "readOnly": false },
    { "documentId": "invoice-d4e5f6", "filePath": "...", "format": "docx", "readOnly": true }
  ],
  "documentCount": 2,
  "mode": "tandem"
}
```

**Returns (write mode — with `text` param):**
```json
{ "status": "Reviewing cost figures..." }
```

**Example (show progress while reviewing):**
```
tandem_status({ text: "Reviewing cost figures...", focusParagraph: 8 })
```

**Example (clear status when done):**
```
tandem_status({ text: "Done" })
```

**Notes:**
- `mode` (read mode) reflects the user's current collaboration mode: `"tandem"` (active collaboration — annotate freely) or `"solo"` (focused work — hold annotations until mode switches back to `"tandem"`).
- Status text appears in the bottom bar of the editor as "Claude — [text]".
- `focusParagraph` index highlights that paragraph with a soft blue tint and animated gutter bar.
- Returns a `warning` field (write mode) if no document is open.

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

### tandem_rename

Rename an open on-disk document's file, keeping the same directory and extension (no format conversion, no move). The documentId / collaboration room stays stable — only the path and tab label change, and annotations follow the file. Renames the active document if no `documentId` is given.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `newName` | string | yes | New basename only (e.g. `"notes.md"`). Must keep the same extension. |
| `documentId` | string | no | Document ID to rename (defaults to active document) |

**Returns:**
```json
{ "renamed": true, "from": "C:\\Users\\bkolb\\docs\\draft.md", "to": "C:\\Users\\bkolb\\docs\\final.md", "fileName": "final.md" }
```

**Notes:** Only on-disk files (`source: "file"`) are renamable — scratchpads/uploads use Save As, and read-only docs (incl. `.docx`) are rejected. The basename is validated against path separators, `..`, Windows-illegal characters (`< > : " | ? *`, the `:` NTFS alternate-data-stream vector), reserved device names (`CON`/`NUL`/`COM1`…), trailing dots/spaces, and UNC/symlink targets.

**Errors:** `NOT_FOUND`, `READ_ONLY`, `NOT_RENAMABLE`, `INVALID_NAME`, `EXTENSION_MISMATCH`, `ALREADY_EXISTS`, `RENAME_IN_PROGRESS`, `INVALID_PATH`, `PATH_REJECTED`

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

> **Deprecated.** Highlights are user-only. Use `tandem_comment` for AI-authored text annotations (the `author` field carries the literal string `"claude"` today as a pre-ADR-038 data-model artifact; see roadmap deferred-milestones for the provider-keyed refactor). Always returns a `DEPRECATED` error.

---

### tandem_comment

Add a comment attached to a text range. Appears in the side panel. Use `suggestedText` for replacement proposals.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | number | yes | Start position |
| `to` | number | yes | End position |
| `text` | string | yes | Comment text |
| `suggestedText` | string | no | Proposed replacement text. When set, the comment renders as a tracked-change suggestion with accept/reject controls. |
| `documentId` | string | no | Target document ID (defaults to active document) |
| `textSnapshot` | string | no | Expected text at range — returns `RANGE_MOVED` with relocated range on mismatch, or `RANGE_GONE` if deleted |

**Returns:**
```json
{ "annotationId": "ann_1710936000000_d4e5f6" }
```

**Example (plain comment):**
```
tandem_comment({ from: 42, to: 67, text: "This section needs more detail" })
```

**Example (replacement suggestion):**
```
tandem_comment({
  from: 180, to: 193,
  text: "Q3 revenue was updated in the latest financial report",
  suggestedText: "$13.1 million"
})
```

---

### tandem_suggest

> **Deprecated.** Always returns a `DEPRECATED` error. Use `tandem_comment` with the `suggestedText` parameter instead.

---

### tandem_flag

> **Deprecated.** Always returns a `DEPRECATED` error. Use `tandem_comment` instead.

---

### tandem_getAnnotations

Read all annotations, optionally filtered. For checking new user actions, prefer `tandem_checkInbox`.

By default, results exclude `note`-type annotations (user-private). Pass `type: "note"` to read user-authored notes addressed to Claude. Imported `.docx` reviewer comments surface as `author: "import"`, `type: "comment"` and are included by default — filter via `author: "import"` if you want to scope to them.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `author` | enum | no | `user`, `claude`, or `import` |
| `type` | enum | no | `highlight`, `comment`, `note` |
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
      "color": "yellow"
    }
  ],
  "count": 1,
  "notesExcluded": 0
}
```

`notesExcluded` reports how many `note`-type annotations were filtered out (only present when > 0). If you need user notes, re-call with `type: "note"`.

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
| `content` | string | no | New comment/note text |
| `reason` | string | no | Alias for content (legacy compat) |
| `newText` | string | no | Sets the `suggestedText` field on a comment (replacement proposal) |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{ "id": "ann_1710936000000_a1b2c3", "content": "Updated: ...", "suggestedText": "replacement text if set", "editedAt": 1710936500000 }
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
- At least one of `content`, `reason`, or `newText` must be provided.
- `reason` is an alias for `content` — if both are provided, `content` takes precedence.
- Only pending annotations can be edited — accepted or dismissed annotations return an error.
- Sets `editedAt` timestamp on the annotation. The editor shows an "(edited)" indicator.
- `newText` sets the `suggestedText` field directly on the annotation, turning a plain comment into a replacement suggestion (or updating an existing one).

---

### tandem_annotationReply

Reply to an annotation thread. Only works on pending annotations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `annotationId` | string | yes | The annotation ID to reply to |
| `text` | string | yes | Reply text |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{ "replyId": "reply_1710936500000_x1y2z3", "annotationId": "ann_1710936000000_a1b2c3" }
```

**Errors:** `NO_DOCUMENT` (document not found), `NOT_FOUND` (annotation not found), `ANNOTATION_RESOLVED` (annotation already resolved).

**Example:**
```
tandem_annotationReply({
  annotationId: "ann_1710936000000_a1b2c3",
  text: "Good point — I'll revise the wording in the next edit."
})
```

**Notes:**
- Replies are threaded under the parent annotation. The editor renders them as a conversation.
- Only pending annotations accept replies — resolved annotations return `ANNOTATION_RESOLVED`.
- The reply author is set to `"claude"` when called via MCP.

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

## Apply Tools

### tandem_applyChanges

Apply all accepted suggestions back to the `.docx` file as tracked changes. The original file is backed up before modification.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | no | Target document ID (defaults to active document) |
| `author` | string | no | Attribution for tracked changes (defaults to `"Tandem Review"`) |
| `backupPath` | string | no | Override backup file path (defaults to `{name}.backup.docx`) |

**Returns:**
```json
{
  "applied": 5,
  "rejected": 1,
  "rejectedDetails": [{"id": "ann-xyz", "reason": "..."}],
  "backupPath": "C:\\Users\\bkolb\\docs\\report.backup.docx",
  "outputPath": "C:\\Users\\bkolb\\docs\\report.docx",
  "pendingWarning": "3 annotations are still pending review",
  "commentsResolved": 2
}
```

**Errors:** `FORMAT_ERROR` (not a `.docx` file, or uploaded document), `NO_DOCUMENT` (document not found)

**Example:**
```
tandem_applyChanges({ author: "Claude Review" })
```

**Notes:**
- Document must be `.docx` format (`FORMAT_ERROR` otherwise).
- Document must be a local file, not uploaded (`FORMAT_ERROR` for `upload://` paths).
- At least one accepted suggestion is required — returns an error if none exist.
- Applies changes as Word tracked revisions (`<w:ins>`/`<w:del>`), not silent edits. Reviewers in Word see the changes as tracked changes they can accept or reject.
- Creates a backup of the original file before modifying. Override the backup path with `backupPath`.
- Warns if pending annotations remain (`pendingWarning`), but does not block the operation.
- Word comments that overlap applied suggestions are marked as resolved (`commentsResolved` count).

---

### tandem_restoreBackup

Restore a `.docx` file from its backup created by `tandem_applyChanges`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{ "restored": true, "backupPath": "C:\\Users\\bkolb\\docs\\report.backup.docx", "outputPath": "C:\\Users\\bkolb\\docs\\report.docx" }
```

**Errors:** Error if no backup file exists for the document.

**Notes:**
- Copies the backup file back over the modified `.docx`, undoing `tandem_applyChanges`.
- The backup file is not deleted after restore — you can restore multiple times.

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

Check for user actions you haven't seen yet -- new highlights, comments, and responses to your annotations. Low token cost. Call this after completing any task, between steps, and whenever you pause.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{
  "summary": "2 new: 1 comment, 1 comment (for Claude). 1 accepted.",
  "hasNew": true,
  "userActions": [ { ...annotation, "textSnippet": "..." } ],
  "userResponses": [ { ...annotation, "textSnippet": "..." } ],
  "activity": {
    "isTyping": false,
    "cursor": 142,
    "lastEdit": 1710936000000,
    "selectedText": null
  },
  "mode": "tandem"
}
```

**Notes:**
- Each annotation is surfaced only once -- subsequent calls return only new items.
- `userActions`: annotations created by the user (highlights, comments, flags).
- `userResponses`: the user's accept/dismiss decisions on Claude's annotations.
- `chatMessages`: new chat messages from the user via the ChatPanel sidebar. Each entry has `id`, `author`, `text`, `timestamp`, and optionally `documentId` (the document that was active when the message was sent).
- `mode`: the user's current collaboration mode (`"tandem"` or `"solo"`). In `"solo"` mode, hold annotations and wait for the mode to switch to `"tandem"` before resuming.

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

## HTTP API (Editor File Opening)

In addition to MCP tools, the server exposes REST endpoints on the same port (:3479) for editor-initiated file opening. These are NOT MCP tools — they use standard HTTP request/response with JSON bodies.

Both endpoints converge with `tandem_open` in `file-opener.ts`, so the resulting Y.Doc and Hocuspocus sync behave identically regardless of how the file was opened.

### GET /api/info

Returns app metadata for the client's About panel and version indicator. All fields are returned for loopback (127.0.0.1) callers; sensitive fields are omitted for non-loopback callers.

**Response (200) — loopback caller:**
```json
{
  "version": "0.8.0",
  "toolCount": 28,
  "mcpSdkVersion": "1.27.1",
  "transport": "http",
  "storagePath": "C:\\Users\\user\\AppData\\Local\\tandem\\Data\\sessions",
  "tokenRotatedAt": 1710936000000
}
```

**Response (200) — non-loopback caller (public fields only):**
```json
{
  "version": "0.8.0",
  "toolCount": 28,
  "mcpSdkVersion": "1.27.1",
  "transport": "http"
}
```

| Field | Type | Loopback only | Description |
|-------|------|--------------|-------------|
| `version` | string | no | Running app version (from `package.json`) |
| `toolCount` | number \| null | no | MCP tools registered at startup; `null` if SDK private field shape drifted |
| `mcpSdkVersion` | string | no | `@modelcontextprotocol/sdk` version, baked at build time |
| `transport` | `"http"` | no | Always `"http"` for HTTP mode |
| `storagePath` | string | yes | Absolute path to session storage directory |
| `tokenRotatedAt` | number \| null | yes | Auth token file mtime in epoch ms; `null` if token file absent or unreadable |

**Errors:** `403 FORBIDDEN` (Host header is not `127.0.0.1` or `tauri.localhost` — DNS-rebinding protection, narrowed in PR #637)

---

### GET /api/diagnostics

Runs the embedded `tandem doctor` collector and returns the report plus environment metadata. Backs the client's **Settings → About → Copy Diagnostics** button.

**Loopback-only, unconditionally** — non-loopback callers get `403` regardless of auth, because the report embeds absolute paths (which include the username) and PIDs. It never contains token material or document content. The two dev-repo-only checks (`node-modules`, `mcp-json`) are filtered out of the report with `ok`/`failures`/`warnings`/`summary` recomputed — they read `process.cwd()` and would fail for every desktop/npm-global install. Concurrent requests share one in-flight collector run (single-flight).

**Response (200):**
```json
{
  "report": { "ok": true, "crashed": false, "failures": 0, "warnings": 0, "summary": "All checks passed. Tandem is ready.", "error": null, "results": [ { "check": "node-version", "status": "pass", "message": "Node.js v22.0.0 (>= 22 required)" } ] },
  "version": "0.13.6",
  "transport": "http",
  "platform": "win32",
  "arch": "x64",
  "nodeVersion": "v22.0.0",
  "tauriSidecar": true
}
```

**Errors:** `403 FORBIDDEN` (non-loopback caller, or disallowed Host header), `500 diagnostics failed` (collector crash — detail goes to the server log, never the wire)

---

### POST /api/open

Open a file by its absolute path on disk. Equivalent to `tandem_open` but callable from the editor UI.

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

### POST /api/scratchpad

Create and open a new empty Scratchpad tab. Equivalent to `tandem_scratchpad` but callable from the editor UI (used by the `Ctrl+N` shortcut and the `+` button's "New Scratchpad" option).

**Request:** No body required.

**Response (200):**
```json
{ "data": { "documentId": "abc123", "fileName": "Scratchpad.md", "format": "md", "readOnly": false, "source": "upload", ... } }
```

### POST /api/close

Close an open document by its document ID. Equivalent to `tandem_close` but callable from the editor UI. Used by the client's tab close button.

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

Open a file from uploaded content (no disk path). Used by the editor's drag-and-drop and file picker UI.

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

Both `/api/*` endpoints include CORS headers reflecting any `http://127.0.0.1:*` origin (dynamic port; bare `localhost` was narrowed out in PR #637). The body size limit is 70MB to accommodate base64-encoded .docx files (50MB file → ~67MB base64).

---

## Channel API (Real-Time Push)

The channel API endpoints expose real-time events from the editor as an SSE stream. The Tandem **channel shim** (a Claude-specific stdio MCP transport per [ADR-038](decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration) §extras) consumes these endpoints and forwards events as `notifications/claude/channel` to Claude Code. **Other MCP clients subscribe to `/api/events` directly** — same stream, no shim. These are NOT MCP tools — they are HTTP endpoints on port 3479.

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

Events are only emitted for editor-originated Y.Map changes (MCP-originated writes are filtered via origin tagging). Keepalives are sent every 15 seconds. The event buffer holds up to 200 events or 60 seconds of history for reconnection replay.

**Channel shim bounds:** The shim gives the SSE handshake a 10-second deadline, then clears that handshake timer once response headers arrive. The long-lived response body is governed separately by a 60-second inactivity watchdog. Incoming SSE data is capped at 1 MB without a frame boundary; exceeding the cap is treated as a connection failure and retried.

### POST /api/channel-awareness

Channel shim reports Claude's current processing status for the editor StatusBar.

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

The channel shim applies a 5-second request deadline. If the upstream hangs after response headers but before the JSON body completes, the shim returns a structured tool error to Claude instead of treating the response as successful non-JSON output.

### DELETE /api/chat

Clear all chat messages from the CTRL_ROOM Y.Map. The change syncs to connected editors in real time.

**Request body:** none

**Response:** `{ "ok": true, "cleared": 5 }`

### POST /api/channel-error

Channel shim reports connection errors.

**Request:**
```json
{ "error": "CHANNEL_CONNECT_FAILED", "message": "Lost connection after 5 retries" }
```

**Response:** `{ "ok": true }`

The shim gives this best-effort report a 3-second deadline before exiting after retry exhaustion.

### POST /api/channel-permission

Channel shim forwards Claude Code's tool approval prompt for editor-side permission UI.

**Request:**
```json
{ "requestId": "req_1", "toolName": "tandem_edit", "description": "Edit paragraph 1", "inputPreview": "..." }
```

**Response:** `{ "ok": true }`

The permission relay has a 5-second deadline; failures are logged because the browser may not see the approval prompt.

### GET /api/channel-permission

Poll pending permission requests (for editor UI).

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

SSE (Server-Sent Events) stream of toast notifications for the editor. Separate from `GET /api/events` (which pushes Y.Map events to the channel shim). Used for ephemeral notifications like annotation range failures and save errors.

**Headers:**
- `Accept: text/event-stream`

**Stream format:**
```
data: {"type":"error","title":"Range Error","message":"Annotation target text has moved","timestamp":1710936000000}

data: {"type":"warning","title":"Save Warning","message":"File is read-only","timestamp":1710936001000}
```

**Notification types:** `error` (auto-dismiss 8s), `warning` (auto-dismiss 6s), `info` (auto-dismiss 4s). The ring buffer holds up to 50 notifications. Duplicate notifications within a short window are deduplicated with a count badge in the editor.

---

### POST /api/launch-claude

Spawn a Claude Code process with the channel shim connected. No request body required.

**Response:** `{ "status": "launched", "pid": 12345 }` or `{ "status": "already_running", "pid": 12345 }`

---

## Claude Code CLI Runtime Contract

Claude is Tandem's default integration ([ADR-038](decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration)), so the Claude Code CLI runtime is part of Tandem's effective MCP wire contract. This section records the contract surfaces and how Tandem behaves against recent CLI changes (issue #1043, reviewing CLI releases 2.1.141–2.1.165).

### Streaming tool execution

As of CLI **2.1.154**, "Streaming tool execution is now always enabled, including when telemetry is disabled or on Bedrock/Vertex/Foundry." This was previously opt-in.

Tandem's MCP tools each return a **single discrete result** — there is no partial-result emission, no progress streaming, and no inter-call ordering dependency between tools. Streaming tool execution governs how the CLI *invokes and renders* tool calls (it can dispatch a tool before fully rendering the prior turn); it does **not** change the request/response shape an MCP server sees. So enabling it everywhere does not alter Tandem's contract.

**What "always enabled" can change in practice:** the CLI may issue tool calls more eagerly and with more concurrency. The HTTP MCP server (`McpServer`) and the stdio proxy (`src/cli/mcp-stdio.ts`) already tolerate concurrent in-flight requests — the proxy tracks each request id independently in `pendingRequests` and matches responses by id, so out-of-order completion is already handled.

**Smoke test (manual — not part of the automated suite).** Run against a current Claude Code CLI with the Tandem server up (`npm run dev:standalone`), connect via `/mcp`, then exercise the long-running / mutating tools and confirm each returns exactly one well-formed result with no partial output, truncation, or ordering surprise:

1. `tandem_edit` on a multi-paragraph document (verify the edit lands once, ranges resolve).
2. `tandem_save` (verify a single save result, file written once).
3. `tandem_open` with `force: true` (force-reload; verify content/annotations clear-and-repopulate in one result).
4. Issue two tool calls back-to-back (e.g. `tandem_getOutline` then `tandem_edit`) and confirm responses are correctly correlated to their requests.

Expected result: no behavioral change versus the pre-2.1.154 opt-in path. Record the observed CLI version and outcome on issue #1043 when run.

### Session correlation env vars (`CLAUDE_CODE_SESSION_ID` / `CLAUDECODE`)

CLI **2.1.157** began injecting `CLAUDE_CODE_SESSION_ID` and `CLAUDECODE=1` into the environment of stdio MCP server subprocesses the CLI spawns; **2.1.163** extended this to `--resume`. The session id mirrors the `session_id` passed to hooks/Bash (a UUID).

**Decision: consume it as an opaque correlation tag, forwarded as an HTTP header.** Both stdio entry points Tandem ships are exactly such subprocesses — the channel shim (`src/channel/`) and the stdio proxy (`src/cli/mcp-stdio.ts`). `resolveClaudeSessionId()` in `src/shared/cli-runtime.ts` reads the id, but **only when `CLAUDECODE === "1"`** (so a value a user happened to export in their own shell is never forwarded), trims it, and applies a printable-ASCII length-bounded guard (header-injection / oversize defense). The id is then attached as the `X-Claude-Session-Id` header on outbound requests to the Tandem server:

- `authFetch` (channel/monitor SSE path: awareness, mode, error-report POSTs) attaches it unconditionally.
- The channel shim's `tandem_reply` and permission-relay POSTs attach it via `withClaudeSessionHeader`.
- The stdio proxy attaches it to every forwarded JSON-RPC POST via the transport's `requestInit.headers`.

This is deliberately a **read-only metadata header**, not a route schema change: server routes that don't read it ignore it, so no server-side change was required to start emitting the correlation data onto the wire. The header gives the server (and host logs) the raw material to disambiguate concurrent Claude sessions in the channel queue. Wiring the server to *act* on the header (e.g. tagging channel-queue entries or scoping inbox traffic per session) is deferred until a concrete multi-session disambiguation need lands — the value is captured at the boundary now so that follow-up doesn't require touching every call site again.

### `claude mcp` secret redaction

CLI **2.1.141** fixed `claude mcp` list/get/add printing secrets to the terminal: `${VAR}` references are no longer expanded, and credential headers and URL secrets are redacted. Tandem writes a bearer token into the `.mcp.json` MCP-server entry headers (`src/server/integrations/apply.ts`), so on CLI ≥ 2.1.141 `claude mcp get tandem` no longer echoes that token to the terminal. See [troubleshooting.md](troubleshooting.md) for the operator-facing note.
