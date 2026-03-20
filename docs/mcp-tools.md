# MCP Tool Reference

Tandem exposes 20 tools via MCP (Model Context Protocol) that Claude Code discovers automatically. All tools use flat text character offsets for positions -- use `tandem_resolveRange` to get safe offsets from text patterns.

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
| `NO_DOCUMENT` | Tool called before `tandem_open`. |
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

## Document Tools

### tandem_open

Open a file in the Tandem editor. Auto-opens the browser on first call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | yes | Absolute path to the file to open |

**Returns:**
```json
{
  "filePath": "C:\\Users\\bkolb\\docs\\report.md",
  "fileName": "report.md",
  "format": "md",
  "tokenEstimate": 1250,
  "pageEstimate": 2,
  "message": "Document opened: report.md"
}
```

**Errors:** `FILE_NOT_FOUND` (doesn't exist, UNC path), `FILE_LOCKED` (open in Word), `FORMAT_ERROR` (>50MB, .docx not yet supported)

**Example:**
```
tandem_open({ filePath: "C:\\Users\\bkolb\\Documents\\progress-report-feb.md" })
```

**Notes:**
- Supported formats: `.md`, `.txt`, `.html`. `.docx` returns an error in v1.
- Browser opens automatically to `http://localhost:5173` on the first call.
- Opening a new file replaces the current document.

---

### tandem_getContent

Read full document content as ProseMirror JSON structure.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

**Returns:**
```json
{
  "content": [ ... ProseMirror JSON nodes ... ],
  "filePath": "C:\\Users\\bkolb\\docs\\report.md"
}
```

**Warning:** Token-heavy. A 20-page doc produces ~50K tokens. Use `tandem_getOutline` or `tandem_getTextContent` instead for large documents.

---

### tandem_getTextContent

Read document as plain text. ~60% fewer tokens than `getContent`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `section` | string | no | Heading text to read only that section (case-insensitive) |

**Returns (full document):**
```json
{
  "text": "# Title\nFirst paragraph...\n## Section\nMore text...",
  "filePath": "C:\\Users\\bkolb\\docs\\report.md"
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

**Notes:** Section extraction reads from the matching heading until the next heading at the same or higher level.

---

### tandem_getOutline

Get document structure (headings only) without full content. Low token cost.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

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

**Returns:**
```json
{ "edited": true, "from": 42, "to": 67, "newTextLength": 31 }
```

**Errors:** `INVALID_RANGE` (offsets out of bounds, overlaps heading markup)

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

---

### tandem_save

Save the current document back to disk. Uses atomic write (temp file + rename).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

**Returns:**
```json
{ "saved": true, "filePath": "C:\\Users\\bkolb\\docs\\report.md" }
```

**Errors:** `FILE_LOCKED` (file open in another program)

---

### tandem_status

Check if the editor is running and what file is open.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

**Returns:**
```json
{
  "running": true,
  "currentDocument": "C:\\Users\\bkolb\\docs\\report.md",
  "format": "md"
}
```

---

### tandem_close

Close the current document.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

**Returns:**
```json
{ "closed": true, "was": "C:\\Users\\bkolb\\docs\\report.md" }
```

---

## Annotation Tools

Annotations are metadata stored in `Y.Map('annotations')` on the shared document -- they don't modify the document text itself. Each annotation has an `id`, `author` (claude/user), `type`, `range`, `content`, `status` (pending/accepted/dismissed), and `timestamp`.

### tandem_highlight

Highlight text with a color and optional note.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | number | yes | Start position |
| `to` | number | yes | End position |
| `color` | enum | yes | `yellow`, `red`, `green`, `blue`, `purple` |
| `note` | string | no | Optional note for the highlight |

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

### tandem_getAnnotations

Read all annotations, optionally filtered.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `author` | enum | no | `user` or `claude` |
| `type` | enum | no | `highlight`, `comment`, `suggestion`, `overlay` |
| `status` | enum | no | `pending`, `accepted`, `dismissed` |

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

**Returns:**
```json
{ "removed": true, "id": "ann_1710936000000_a1b2c3" }
```

---

## Navigation Tools

### tandem_search

Search for text in the document. Returns all matching positions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query |
| `regex` | boolean | no | Treat query as regex (default: false) |

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
| *(none)* | | | |

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
| *(none)* | | | |

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
