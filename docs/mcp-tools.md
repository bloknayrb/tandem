# MCP Tool Reference

These tools are exposed over the MCP protocol. **Claude Code is Tandem's default and most-tested client** ([ADR-038](decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration)), but the tools are available to any MCP-capable client connecting to `http://127.0.0.1:3479/mcp`.

Tandem exposes 33 tools via MCP HTTP (30 active, 3 deprecated stubs that return MCP error responses with code `DEPRECATED`). The channel shim also exposes `tandem_reply` for real-time push contexts — the shim itself is a Claude-specific stdio transport on top of the MCP contract; other MCP clients discover the HTTP transport automatically and subscribe to `/api/events` directly for the same real-time stream. All tools use flat text character offsets for positions — use `tandem_resolveRange` to get safe offsets from text patterns.

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

### Structured Output (`outputSchema` / `structuredContent`)

Seven data-returning tools additionally advertise an MCP `outputSchema` and emit `structuredContent` so typed clients can validate responses end-to-end:

- `tandem_status`
- `tandem_getTextContent`
- `tandem_getAnnotations`
- `tandem_checkInbox`
- `tandem_listDocuments`
- `tandem_search`
- `tandem_diagnostics`

**No dialect is advertised (#1564).** The SDK converts every `inputSchema` and `outputSchema` with `zod-to-json-schema` at its default target, which stamps `"$schema": "http://json-schema.org/draft-07/schema#"` on each one. Claude Code's MCP client validates output schemas as JSON Schema **2020-12 only** and rejects a tool declaring any other dialect *client-side*, so all seven of these vanished from live sessions while the same calls succeeded over raw JSON-RPC. MCP fixes the dialect rather than leaving it to the client — the SDK's own wire types document `inputSchema`/`outputSchema` as "a JSON Schema 2020-12 object" — so the stamp is a spec violation on the SDK's side, and it reaches the wire only because the wire schema passes unknown keys through. `src/server/mcp/schema-dialect.ts` wraps the SDK's `tools/list` handler and removes `$schema` from both halves. That is sound only while nothing emitted is dialect-sensitive, which `tests/server/mcp-schema-dialect.test.ts` checks rather than assumes.

**A consequence worth knowing before editing `output-schemas.ts`:** until #1564 the client rejected these seven outright and so never validated their `structuredContent`. It does now, against schemas carrying `additionalProperties: false` — and the SDK's server-side check does not protect you, because it `safeParse`s in strip mode (an undeclared key passes) and then sends the *original* result rather than the parsed one. A schema that drifts from its handler's payload used to be harmless; it now fails the tool call in the client. `tests/server/mcp-output-schemas.test.ts` already catches this by deep-equalling the strip-parsed payload against the emitted one — keep it that way.

For these tools, `structuredContent` carries the exact same object as the text envelope's `data` field — the text content is unchanged for backward compatibility. Error responses from these tools are marked with the MCP-level `isError: true` flag (and carry no `structuredContent`); the text content still holds the `{ "error": true, ... }` JSON envelope above. Schemas live in `src/server/mcp/output-schemas.ts`. Per ADR-027, the annotation schemas deliberately omit `type: "note"` — user-private notes can never appear in structured payloads.

### Error Codes

| Code | Trigger |
|------|---------|
| `NO_DOCUMENT` | Tool called before `tandem_open`, or specified `documentId` not found. |
| `FILE_NOT_FOUND` | File doesn't exist or is a UNC path. |
| `FILE_LOCKED` | File is open in another program (e.g., Word). Close it first. |
| `FORMAT_ERROR` | Unsupported format, read-only / non-markdown document, file too large (>50MB), or invalid regex. |
| `FILE_TOO_LARGE` | Inline content exceeds the tool's size cap (e.g. `tandem_appendContent`). |
| `INVALID_RANGE` | Offset out of bounds, non-integer, inverted, zero-length, splitting a surrogate pair, text not found, or a range overlapping heading markup. **Usually — not always — carries `details.reason`** (see `tandem_edit`): the two rejections that come from somewhere other than the range validator carry none, namely `tandem_resolveRange`'s "pattern not found" and `tandem_edit`'s heading-markup overlap. Treat `details.reason` as optional. |
| `EMPTY_DOCUMENT` | `tandem_edit` called on an empty document — seed content with `tandem_appendContent` / `tandem_scratchpad({ content })` first. |
| `RANGE_MOVED` | Target text has moved. Response includes `resolvedFrom`/`resolvedTo` with relocated coordinates. |
| `RANGE_GONE` | Target text was deleted from the document. |
| `PERMISSION_DENIED` | File path is not accessible (OS-level permission denied, e.g., `EACCES`). |
| `DEPRECATED` | A removed tool or parameter was used — the deprecated stubs (`tandem_highlight`, `tandem_suggest`, `tandem_flag`) and `tandem_comment`'s `directedAt`. |
| `READ_ONLY` | The document is read-only, so the mutation was refused. |
| `EXTERNAL_CONFLICT` | The file changed on disk since Tandem loaded it. Saving is blocked until the user answers the keep-vs-reload banner, so a save reports this rather than claiming success. |
| `RELOAD_IN_PROGRESS` | A reload from disk is mid-flight; retry once it settles. |
| `LICENSE_REQUIRED` | The license gate is active and restricted. Reads, plain `tandem_open`, saves and exports still work; content mutations do not. `tandem_open` with `force: true` **is** gated -- it runs `clearAndReload`, which wipes the durable annotation file. Never returned while the gate ships dark. |
| `NO_SUGGESTIONS` | `tandem_applyChanges` found no accepted suggestions to write. |
| `BACKUP_FAILED` | `tandem_applyChanges` could not write its backup, so it refused to touch the original. |
| `INVALID_NAME` | `tandem_rename` was given a name that is empty, path-separated, or otherwise unusable. |
| `INVALID_PATH` | A supplied path was relative where an absolute one is required, or used a UNC / extended-length / device-namespace prefix. |

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
| `authoredBy` | `"claude"` | no | Pass when you wrote the file wholesale before opening it, to stamp Claude authorship across its content. Idempotent, and only ever stamps Claude — it cannot forge user attribution. |

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
- Supported formats: `.md`, `.markdown`, `.txt`, `.html`, `.htm`, `.docx`. All open editable; `.docx` is written back only on an explicit save (auto-save skips it). `.markdown` and `.htm` are aliases — `detectFormat` folds them into `md` and `html`, and the file keeps its own extension on save.
- Editor opens automatically in the Tauri WebView (desktop) or at `http://127.0.0.1:5173` (development) on the first call.
- Opening a file that's already open switches to its tab (returns `alreadyOpen: true`).
- **Auto-reload:** Open documents are automatically reloaded when the file changes on disk (e.g., Claude's Edit tool, `git pull`). Annotations are preserved. A toast notification appears in the editor.
- **Exception — unsaved edits:** if the document has body edits that haven't reached disk, the reload is held and the editor raises a keep-vs-reload banner instead (#1238). Until the user answers it, every save path is blocked, including `tandem_save`, which returns `EXTERNAL_CONFLICT`. Note that `tandem_edit` marks a document dirty, so editing through Tandem and then through your own file-editing tool raises this banner rather than auto-reloading. Read-only documents still reload unconditionally.
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

Read document as plain text whose offsets match the annotation coordinate system.

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

Get document structure without full content. Headings only by default (low token cost); pass `includeBlocks` to also list every block with the character offsets `tandem_edit` and `tandem_editList` take.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `includeBlocks` | boolean | no | Also return every block: node type, flat `[from, to)` range, nesting path and depth, position within its list, and checkbox state. Roughly one entry per block -- omit on large documents unless you need to edit inside a list or a table. |
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

**With `includeBlocks: true`**, a `blocks` array is added. For `- [ ] todo one` / `- [x] done two`:
```json
{
  "blocks": [
    { "from": 0, "to": 8,  "node": "paragraph", "path": [0, 0, 0], "depth": 2,
      "container": "listItem", "listType": "bullet", "listItemIndex": 1, "checked": false },
    { "from": 9, "to": 17, "node": "paragraph", "path": [0, 1, 0], "depth": 2,
      "container": "listItem", "listType": "bullet", "listItemIndex": 2, "checked": true }
  ]
}
```

**Why this exists:** the flat text those offsets index is structurally blind -- the list above reads as `"todo one\ndone two"`, with no markers, no nesting and no checkbox state. Without `blocks` there is no way to tell a list item from a paragraph, so the list-editing tools are undiscoverable.

Two details worth knowing, because they are asymmetries in the coordinate system rather than in this tool:
- A **top-level** heading's `from` points *past* its `"## "` prefix; a **nested** heading (`- # Section`) starts at its text, because the flat projection emits a prefix only at top level.
- `checked` is **absent** for a plain bullet rather than `false` -- a plain bullet stores no attribute, and reporting `false` would claim an unticked checkbox that is not in the document.

**Best practice:** Call this first on large documents to understand structure, then use `getTextContent(section)` for targeted reads. Call it with `includeBlocks: true` before any `tandem_editList` call, and re-read after an edit rather than reusing stale offsets.

---

### tandem_edit

Replace text at a specific range. Single-paragraph replacements only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | number | yes | Start position (flat text character offset) |
| `to` | number | yes | End position (flat text character offset) |
| `newText` | string | yes | Replacement text. Single-block only: a newline is inserted literally in markdown/`.docx` and **refused** in a plaintext document (see Notes) |
| `documentId` | string | no | Target document ID (defaults to active document) |
| `textSnapshot` | string | no | The text you expect to find at `[from, to]`. Strongly recommended: on mismatch the edit is refused rather than applied to whatever moved into that range. **Do not pass back a `textSnapshot` read from an annotation whose `textSnapshotTruncated` is `true`** — it is only the first 200 characters, so it relocates to a 200-character range and the edit lands on a shorter span than the annotation covers (#1486). Read the current text instead. |

**Returns:**
```json
{ "edited": true, "from": 42, "to": 67, "newTextLength": 31 }
```

**Errors:** `INVALID_RANGE`, `FORMAT_ERROR` (read-only document), `INVALID_ARGUMENT` (`newText` contains a line break in a plaintext document — see below, or a `textSnapshot` on a point insertion), and — only when `textSnapshot` is supplied — `RANGE_MOVED` (the text shifted; the error carries the relocated `resolvedFrom` / `resolvedTo`) or `RANGE_GONE` (the text was deleted)

An `INVALID_RANGE` carries `details.reason`, a closed enum you can branch on rather than parse:

| `details.reason` | Meaning |
|---|---|
| `non-integer` | `from` or `to` is not an integer. (The schema also rejects this, so you normally see a protocol error first.) |
| `inverted` | `from > to`. |
| `out-of-bounds` | `from < 0`, or `to` past the end of the document. `to === length` is valid. |
| `empty` | For `tandem_edit`, `from === to` **and** an empty `newText` — the one genuine no-op. **Point insertion is supported:** `tandem_edit({ from: n, to: n, newText: "X" })` inserts at `n`, and it is the only mid-document insert path. Two things to know about it: **omit `textSnapshot`** (a zero-length range matches no text, so a snapshot always looks stale — the call is refused with `INVALID_ARGUMENT` rather than letting the `RANGE_MOVED` retry turn your insert into a replacement), and `from: 0` on a document that opens with a heading is `HEADING_OVERLAP`, since offset 0 sits inside the `# ` prefix — insert after the prefix, or at the start of the first body block. For `tandem_comment` / `tandem_suggest` / `tandem_flag`, `from === to` alone, since an annotation needs a span to anchor to. |
| `surrogate` | An offset falls between the two halves of a surrogate pair (inside an emoji or other astral character). Move it to either side of the character. |
| `unresolvable` | The offsets could not be resolved against the document structure. Only `tandem_edit` can reach it, only at `(0, 0)`, and only on a document whose top-level children are not block elements — a shape no writer in Tandem produces. An actually-empty document answers `EMPTY_DOCUMENT` instead. |

**With a mismatched `textSnapshot`, a staleness outcome wins over `out-of-bounds`.** The staleness check runs first by design — after an external edit shortens the file, stale offsets past the new end must relocate rather than be refused — so the `reason` set above is exhaustive only for a call that supplies no `textSnapshot`.

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
- Newlines in `newText` are inserted as literal characters, not new paragraphs — **in a markdown or `.docx` document. In a plaintext one (`.txt`, `.html`, `.log`, `.csv`, any unknown extension) a newline is REFUSED with `INVALID_ARGUMENT` (#1460).** Those formats spell a paragraph boundary and an intra-paragraph break identically, so a literal newline would save to bytes that reopen as two paragraphs — the document coming back a different shape than the one written. Issue one `tandem_edit` per line instead. (`tandem_appendContent` is not a substitute — it refuses any non-markdown document outright.) The refusal is deliberate rather than a silent split: this tool is a single-paragraph replacement and `RANGE_MOVED`'s retry contract assumes the range stays inside one block.
- Cross-element edits (spanning multiple paragraphs) are supported but merge into one paragraph.
- Edits appear instantly in the editor.
- Read-only documents (uploads, and files opened with `readOnly`) reject edits -- use annotations instead. A disk-opened `.docx` is **not** read-only (#576).
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
- Markdown documents only. Non-markdown documents are rejected with `FORMAT_ERROR` -- the check is the document's format, not its read-only flag.
- To add an item **inside** an existing list rather than at the end of the document, use `tandem_editList`.
- For arbitrary mid-document insertion of a **non-list** block, there is still no direct path: use `tandem_edit` per block, or open the file after writing it. `tandem_editList` closes this gap for list items only -- its `insertAfter`/`insertBefore`/`remove` machinery is general, but the tool deliberately refuses a target outside a list.

---

### tandem_editList

Change the **shape** of a list: add an item, remove one, or tick a checkbox. Does not change the wording of an item -- `tandem_edit` does that, and since it resolves to the textblock owning an offset it reaches inside list items, blockquotes and table cells.

Target an item by a flat offset anywhere inside it. Flat text is structurally blind (`- [ ] task item` reads as bare `task item`), so call `tandem_getOutline({ includeBlocks: true })` first to see which lines are items, their nesting, and their checkbox state.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `at` | number | yes | Flat offset anywhere inside the target list item. |
| `op` | string | yes | `insertAfter` \| `insertBefore` \| `remove` \| `setChecked`. |
| `markdown` | string | insert only | The NEW item(s), one per line (`- text`); indent two spaces to nest. A non-list block is wrapped as an item. Never re-send the target item's own text. |
| `checked` | boolean \| null | `setChecked` only | `true` ticks, `false` unticks, `null` removes the checkbox and leaves a plain bullet. |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{ "edited": true, "op": "insertAfter", "insertedCount": 1, "atItemIndex": 2 }
```

**Errors:** `FORMAT_ERROR` (read-only; a plaintext format, which has no list structure; or `setChecked` on a `.docx`, since Word lists have no checkbox state), `INVALID_RANGE` (offset is not inside a list -- the message names `tandem_edit` and `tandem_appendContent` as the alternatives), `INVALID_ARGUMENT` (missing `markdown` or `checked`), `FILE_TOO_LARGE`, `EMPTY_DOCUMENT`, `NO_DOCUMENT`

**Format support:** markdown **and `.docx`** -- Word documents hold real bulleted and numbered lists and Tandem writes them back on save, so the ops apply there too; only `setChecked` is markdown-only. Plaintext formats (`.txt`, `.csv`, `.html`, unknown extensions) have no list model at all.

**No `move` or list-type conversion, deliberately -- and reordering by hand is lossy.** Yjs has no move primitive and `nodeName` is immutable, so relocating an item or switching a list between bulleted and numbered means delete-and-rebuild, which destroys the annotations, authorship and CRDT anchors on everything it touches -- the same loss the range-replace design was rejected for. Composing `remove` + `insertAfter` to reorder has exactly that cost: **the moved item's annotations and authorship do not survive**, and nothing warns you. Prefer leaving the item where it is, or accept the loss knowingly.

**Why path-addressed rather than range-replacing:** a `replaceBlock(from, to, markdown)` shape was drafted and withdrawn. It would make the caller re-emit every block it touched, but `extractText` strips inline marks and there is no per-block markdown reader -- so every call that meant to *preserve* a sibling would have silently deleted that sibling's bold, links and code spans. Each op here touches only what changes: `setChecked` is a single attribute write, and an insert never rebuilds a neighbour.

**Example:**
```
// See the list, then add an item after the second one:
tandem_getOutline({ includeBlocks: true })
tandem_editList({ at: 42, op: "insertAfter", markdown: "- A new point" })

// Tick a task off:
tandem_editList({ at: 42, op: "setChecked", checked: true })
```

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

**Notes:**
- Read-only documents save their session only (annotations persist), not the source file.
- Writable `.docx` documents save on **explicit save only** (never auto-save). The save writes the document body **plus pending `comment`-type annotations as Word comments** (`comments.xml` + range markers), anchored to their current ranges (#1068). `note` and `highlight` annotations are never written to the file (ADR-027), so un-promoted imported Word comments — which live as private notes until batch-promoted — are dropped from the saved file. Accepted/dismissed comments are dropped too (Word has no resolved-state channel we can write). Threaded replies flatten into the comment body with attribution lines; private replies (including imported Word reply threads) are never written.

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
  "mode": "tandem",
  "storeReadOnly": false,
  "wakeUrl": "ws://127.0.0.1:3479/api/wake"
}
```

`storeReadOnly` reports whether the durable annotation store could take its lock; when `true`, annotations live only for this run. `wakeUrl` is the `/api/wake` WebSocket endpoint ([ADR-049](decisions.md)) -- where the client can hold a persistent watch, arming one there is the push path that needs no install and no flag. It is omitted when no endpoint is available (stdio mode). See [architecture.md](architecture.md) for how it relates to the other push paths.

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

**Notes:** Only on-disk files (`source: "file"`) are renamable — scratchpads/uploads use Save As, and read-only docs (uploads, `readOnly` opens) are rejected. A disk-opened `.docx` is renamable (#576). The basename is validated against path separators, `..`, Windows-illegal characters (`< > : " | ? *`, the `:` NTFS alternate-data-stream vector), reserved device names (`CON`/`NUL`/`COM1`…), trailing dots/spaces, and UNC/symlink targets.

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
| `outputPath` | string | no | Custom output **directory** for the `.md` file, which must already exist (defaults to the `.docx`'s own directory). The filename is always derived from the source document — a caller cannot name the file that gets created ([#1654](https://github.com/bloknayrb/tandem/issues/1654)). |

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

**Notes:** The source document must be a `.docx` file. The converted Markdown file opens as a new editable tab alongside the original `.docx`.

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
| `textSnapshot` | string | no | Expected text at range — returns `RANGE_MOVED` with relocated range on mismatch, or `RANGE_GONE` if deleted. Same caveat as `tandem_edit`: never pass back a snapshot flagged `textSnapshotTruncated`. |
| `directedAt` | `"claude"` | no | **Deprecated (ADR-027).** Still accepted by the schema, but passing it returns `DEPRECATED` — omit it. |

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

Read annotations, optionally filtered by author/type/status. For checking new user actions, prefer `tandem_checkInbox`.

User notes are **always excluded** — they are private to the user (ADR-027) and cannot be requested via any filter. Imported `.docx` reviewer comments land as private notes (`author: "import"`, `type: "note"`) and stay excluded until the user batch-promotes them via the side rail, at which point they surface as `author: "user"`, `type: "comment"`. The `notesExcluded` response field reports how many notes were filtered out (including not-yet-promoted imports). Each returned annotation includes a `replies` array (comment parents only; user-private replies are stripped).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `author` | enum | no | `user`, `claude`, or `import` |
| `type` | enum | no | `highlight`, `comment` |
| `status` | enum | no | `pending`, `accepted`, `dismissed` |
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{
  "annotations": [
    {
      "id": "ann_1710936000000_a1b2c3",
      "author": "claude",
      "type": "comment",
      "range": { "from": 42, "to": 67 },
      "content": "This figure doesn't match the invoice",
      "status": "pending",
      "timestamp": 1710936000000,
      "audience": "outbound",
      "textSnapshot": "the $42,500 figure",
      "replies": []
    }
  ],
  "count": 1,
  "notesExcluded": 2
}
```

`notesExcluded` reports how many `note`-type annotations were filtered out (only present when > 0). Notes cannot be read via MCP — they are user-private (ADR-027).

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

Export all annotations as a formatted summary. Useful for review reports.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `format` | enum | no | `markdown` (default) or `json` |
| `documentId` | string | no | Target document ID (defaults to active document) |
| `writeToDisk` | boolean | no | Also write the export to a sharable sidecar next to the document (`<docPath>.annotations.{json\|md}`). Overwrites any existing sidecar. |
| `outputPath` | string | no | Custom sidecar path for `writeToDisk` — a file path, or an existing directory the default filename is appended to. Must be **absolute** (a relative path would silently resolve against the server's CWD), and UNC / extended-length / device-namespace prefixes are rejected. The final filename must end in `.annotations.md` or `.annotations.json`, matching `format`; the destination **directory** is unrestricted ([#1654](https://github.com/bloknayrb/tandem/issues/1654)). |

Solo mode applies here: while Solo is on, held comments and replies are withheld from the export and the count is disclosed as `heldFromExport` rather than being silently omitted.

**Errors:** `INVALID_PATH` — `outputPath` is relative, carries a UNC / extended-length / device-namespace prefix, contains a colon in the filename (NTFS alternate data stream), or names a file whose suffix is not `.annotations.md` / `.annotations.json` matching `format`. `FILE_NOT_FOUND` — the destination directory does not exist.

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

Restore a document from a backup. Tandem copies a document's on-disk bytes to `{APP_DATA}/doc-backups/` before its first overwrite each server run (`.md`/`.txt` verbatim text, `.docx` verbatim binary — byte-identical), up to 3 snapshots per document. Call without `backup` to list the available snapshots (newest first), then call again with `backup` set to a snapshot name to restore it.

- **`.docx` fallback** — when no pre-overwrite snapshots exist yet, calling without `backup` restores the `{name}.backup.docx` sidecar written by `tandem_applyChanges`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | no | Target document ID (defaults to active document) |
| `backup` | string | no | Snapshot filename to restore. Omit to list available snapshots. |

**Returns (list mode — `.md`/`.txt` without `backup`):**
```json
{
  "filePath": "/home/user/docs/thesis.md",
  "backups": [
    { "name": "thesis-20260609-141500-ab12cd34.md", "timestamp": "2026-06-09T14:15:00.000Z", "size": 18234 }
  ],
  "message": "Snapshots listed newest first. Call tandem_restoreBackup again with `backup` set to one of these names to restore it."
}
```

**Returns (restore mode):**
```json
{ "message": "Restored thesis.md from backup thesis-20260609-141500-ab12cd34.md.", "restoredFrom": "…/doc-backups/<hash>/thesis-20260609-141500-ab12cd34.md", "filePath": "/home/user/docs/thesis.md" }
```

**Errors:** `FILE_NOT_FOUND` if no backup exists for the document (or the named snapshot doesn't exist); `FORMAT_ERROR` for upload-source documents or unsupported formats; `READ_ONLY` for read-only documents; `RELOAD_IN_PROGRESS` when a concurrent reload holds the per-document guard.

**Notes:**
- `.docx`: copies the sidecar back over the modified file, undoing `tandem_applyChanges`. The sidecar is not deleted after restore — you can restore multiple times.
- `.md`/`.txt`: the restore routes through the file-watcher reload lifecycle — the open document reloads in place, annotations are preserved and re-anchored, and Tandem's own write is not misread as an external edit. The pre-restore on-disk bytes are snapshotted first (when the once-per-run gate allows), so a restore is itself reversible.
- The command palette action "Restore a backup of this document…" is a thin client of the same machinery (`GET /api/backups` + `POST /api/backups/restore`); it restores the most recent snapshot.

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

**Errors:** `INVALID_RANGE` — the range is validated against the document rather than clamped (`details.reason` as for `tandem_edit`). A zero-length range is accepted here: reading context around a cursor position is a legitimate query.

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

Check for user actions you haven't seen yet -- new comments, chat messages, and responses to your annotations. You cannot tell whether real-time push is reaching you, so poll at a steady cadence: every 2-3 tool calls, after completing any task, between steps, and whenever you pause. Items already returned by a previous poll are de-duplicated, so frequent calls are cheap. An item flagged `alreadyPushed` was also emitted as a real-time event -- if you recognize it and already responded, don't respond twice. Low token cost.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | no | Target document ID (defaults to active document) |

**Returns:**
```json
{
  "summary": "1 new: 1 comment. 1 accepted. 1 new chat message.",
  "hasNew": true,
  "mode": "tandem",
  "storeReadOnly": false,
  "userActions": [ { ...annotation, "textSnippet": "...", "edited": true, "alreadyPushed": true } ],
  "userReplies": [ { "id": "r_...", "annotationId": "ann_...", "author": "user", "text": "...", "timestamp": 1710936000000, "textSnippet": "...", "alreadyPushed": true } ],
  "userResponses": [ { ...annotation, "textSnippet": "..." } ],
  "chatMessages": [ { "id": "msg_...", "text": "...", "timestamp": 1710936000000 } ],
  "activity": {
    "isTyping": false,
    "cursor": 142,
    "lastEdit": 1710936000000,
    "selectedText": null
  }
}
```

**Notes:**
- Each annotation is surfaced only once -- subsequent calls return only new items (edited annotations re-surface with `edited: true`).
- `userActions`: new or edited user comments. User notes and highlights never surface here (ADR-027).
- `userResponses`: the user's accept/dismiss decisions on Claude's annotations.
- **Channel push never suppresses an inbox item.** An item is always returned; when it was also handed to a real-time consumer it carries `alreadyPushed: true` (`userActions` and `userReplies` only -- `userResponses` never carries the flag). The server can observe that it pushed an event to a consumer, but not that any model received it: an attached channel shim whose host never negotiated the channel accepts the notification and discards it. The flag is advisory in **both** directions -- it can be set for an item no model saw, and it is dropped once the event leaves the channel buffer, so its absence is not evidence the item wasn't pushed. (Buffer eviction is size- and age-triggered but runs only when a *later* event is pushed -- there is no timer -- so on a quiet document the flag can outlive the nominal 60s age bound by an unbounded margin. Ids are also process-global rather than per-document; the same imported Word comment promoted in two files shares one id.) Never skip an item on the strength of this flag. (This was previously a suppression, which silently dropped user comments and replies for any client without a working channel -- the default configuration.)
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

## Diagnostics Tools

### tandem_diagnostics

Read connection and boot health as a structured report: Node version, `.mcp.json` / `~/.claude.json` registration, port probes (3478 WebSocket + 3479 MCP HTTP), the `/health` endpoint, and the SSE event stream. Wraps the same `runDoctor()` collector that backs `GET /api/diagnostics`, but rides the MCP transport — so an MCP-connected agent (including a Cowork VM that **cannot** reach `localhost:3479`, see [ADR-023](decisions.md)) can self-diagnose a broken connection without a loopback HTTP round-trip it may not be able to make.

Read-only, takes **no parameters**, and is **not** license-gated — diagnostics stay available even when the license gate is restricted.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| _(none)_ | | | |

**Returns** (the cwd-filtered `DoctorReport` plus runtime environment fields — identical payload shape to `GET /api/diagnostics`, advertised via `outputSchema`):
```json
{
  "ok": true,
  "crashed": false,
  "failures": 0,
  "warnings": 1,
  "summary": "1 warning(s) — Tandem should work, but check the items above.",
  "error": null,
  "results": [
    { "check": "health", "status": "pass", "message": "MCP HTTP /health responded", "data": { "port": 3479, "hasSession": true } },
    { "check": "user-mcp-config", "status": "warn", "message": "No active MCP session — Claude Code hasn't connected yet", "fix": "Restart Claude and run /mcp" }
  ],
  "version": "0.22.1",
  "transport": "http",
  "platform": "win32",
  "arch": "x64",
  "nodeVersion": "v22.13.0",
  "tauriSidecar": true,
  "osRelease": "10.0.26100",
  "osVersion": "Windows 11 Pro",
  "cpuModel": "AMD Ryzen 7 5800X 8-Core Processor",
  "cpuCount": 16,
  "totalMemoryMb": 32768,
  "freeMemoryMb": 6247
}
```

Everything from `osRelease` down is **optional and best-effort** (`collectHostInfo()` in `src/server/mcp/host-info.ts`): `os.cpus()` returns `[]` on some cgroup-restricted hosts and `os.version()` can throw, so any of these keys may be absent. They are deliberately non-identifying — no hostname, username, home path, network interfaces, locale or timezone — because this payload is what "Copy Diagnostics" puts on the clipboard and what the Report-a-bug link prefills into a public issue.

**Notes:**
- The five source-checkout-only checks (`node-modules`, `dev-repo`, `npm-staleness`, `mcp-json`, `orphaned-vite`) are filtered out and `ok`/`failures`/`warnings`/`summary` recomputed — they read `process.cwd()`, which is arbitrary for a desktop or npm-global install. (`tandem doctor` on the CLI keeps them; there the cwd is meaningful.)
- The report embeds absolute paths and PIDs in per-check `data` bags — surfaced only over the loopback-gated MCP transport, the same posture that makes `GET /api/diagnostics` loopback-only.
- Use this instead of asking the user to run `tandem doctor` when an MCP call fails unexpectedly.

---

## HTTP API

In addition to MCP tools, the server exposes REST endpoints on the same port (:3479). These are NOT MCP tools — they use standard HTTP request/response with JSON bodies. The routes below are the ones the editor UI calls for file opening; the index that follows covers the rest.

### Route index

Registered in `src/server/mcp/api-routes.ts` (`registerApiRoutes`), plus `/health` and the `/api/wake` upgrade registered in `src/server/mcp/server.ts`. The **Gate** column names what each route holds *beyond* the two path-wide controls every `/api` route gets — `authMiddleware` (Bearer for non-loopback callers) and, since #1320, `enforceLoopbackMutation` (non-GET/HEAD/OPTIONS is loopback-only). "one layer" marks the nine mutating routes that call neither `assertOriginAllowlisted` nor `assertLoopbackForMutation` and rely solely on that invariant — the review inventory enumerated in [security.md](security.md).

| Route | Purpose | Gate beyond the path-wide controls |
|---|---|---|
| `GET /health` | Liveness + version. Auth-exempt, payload scrubbed for non-loopback. | public |
| `GET /api/info` | App metadata for the About panel. | scrubs non-public fields |
| `GET /api/diagnostics` | `tandem doctor` report + host info. | loopback-only by hand (403) |
| `GET /api/notify-stream` | SSE stream of server notifications. | — |
| `GET /api/mode` · `POST /api/mode/release` | Read / release Solo mode. | origin + loopback |
| `GET /api/license/status` · `POST /api/license/activate` | License status and activation. | origin + loopback |
| `POST /api/open` | Open a file by absolute path. | **one layer** |
| `POST /api/close` | Close a document by id. | **one layer** |
| `POST /api/save` | Save / Save As. | **one layer** |
| `POST /api/rename` | Rename an on-disk file. | origin + loopback |
| `POST /api/upload` | Open uploaded content (no disk path). | **one layer** |
| `POST /api/scratchpad` | New Scratchpad tab. | origin + loopback + license gate |
| `POST /api/convert` | Convert `.docx` to Markdown. | **one layer** |
| `POST /api/apply-changes` | Write accepted suggestions into a `.docx`. | **one layer** + license gate |
| `GET /api/document/raw` | Raw document bytes. | loopback-only by hand |
| `POST /api/document/reload` | Reload the document from disk. | origin + loopback + license gate |
| `GET /api/backups` · `POST /api/backups/restore` | List / restore pre-overwrite snapshots. | origin + loopback (restore also license-gated); list scrubs paths |
| `POST /api/external-conflict/resolve` | Answer the keep-vs-reload banner. | origin + loopback + license gate |
| `POST /api/annotation-reply` | Post a reply to an annotation. | **one layer** + license gate |
| `POST /api/remove-annotation` | Delete an annotation. | **one layer** + license gate |
| `POST /api/store/reclaim-lock` | Reclaim the annotation-store lock. | origin + loopback |
| `GET /api/sessions` · `POST /api/sessions/delete` · `POST /api/sessions/clear` | Session management. | origin + loopback; list scrubs paths |
| `POST /api/rotate-token` | Rotate the auth token. | **one layer** |
| `POST /api/shutdown` | Graceful shutdown. | hand-rolled `isLoopback` (must accept an absent `Origin`) |
| `GET/POST /api/launcher/*` | Claude launcher status, nonce, relaunch, working directory. | origin + loopback + nonce |
| `/api/channel-*`, `DELETE /api/chat` | Channel shim + monitor transport. | carved out of the loopback invariant by name |
| `/api/wake` | WebSocket upgrade for the self-armed idle watch (ADR-049). | own Origin guard; never reaches Express |

The channel routes and `GET /api/events` are documented in [Channel API](#channel-api-real-time-push) below.

`/api/open` and `/api/upload` converge with `tandem_open` in `documents/open.ts`, so the resulting Y.Doc and Hocuspocus sync behave identically regardless of how the file was opened.

### GET /api/info

Returns app metadata for the client's About panel and version indicator. All fields are returned for loopback (127.0.0.1) callers; sensitive fields are omitted for non-loopback callers.

**Response (200) — loopback caller:**
```json
{
  "version": "0.22.1",
  "toolCount": 32,
  "mcpSdkVersion": "1.27.1",
  "transport": "http",
  "storagePath": "C:\\Users\\user\\AppData\\Local\\tandem\\Data\\sessions",
  "tokenRotatedAt": 1710936000000
}
```

**Response (200) — non-loopback caller (public fields only):**
```json
{
  "version": "0.22.1",
  "toolCount": 32,
  "mcpSdkVersion": "1.27.1",
  "transport": "http",
  "bindHost": "127.0.0.1",
  "bindPort": 3479
}
```

| Field | Type | Loopback only | Description |
|-------|------|--------------|-------------|
| `version` | string | no | Running app version (from `package.json`) |
| `toolCount` | number \| null | no | MCP tools registered at startup; `null` if SDK private field shape drifted |
| `mcpSdkVersion` | string | no | `@modelcontextprotocol/sdk` version, baked at build time |
| `transport` | `"http"` | no | Always `"http"` for HTTP mode |
| `bindHost` | string | no | Present only when the server was given an explicit bind host |
| `bindPort` | number | no | Present only when the server was given an explicit bind port |
| `changelogPath` | string | no | Absolute path to `CHANGELOG.md`; present only when the file exists. Drives the changelog auto-open on upgrade. |
| `workflowsPath` | string | no | Absolute path to the bundled `docs/workflows.md`; present only when the file exists |
| `welcomePath` | string | no | Absolute path to `sample/welcome.md`; present only when the file exists |
| `storagePath` | string | yes | Absolute path to session storage directory |
| `tokenRotatedAt` | number \| null | yes | Auth token file mtime in epoch ms; `null` if token file absent or unreadable |
| `generationId` | string \| null | yes | Identifies this server run. Browser clients pin it as their Hocuspocus auth token so a tab that survived a restart is rejected instead of CRDT-merging stale state. Loopback-only because Hocuspocus binds `127.0.0.1`, so no one else could use it. |

**Errors:** `403 FORBIDDEN` (Host header is not `127.0.0.1` or `tauri.localhost` — DNS-rebinding protection, narrowed in PR #637)

---

### GET /api/diagnostics

Runs the embedded `tandem doctor` collector and returns the report plus environment metadata. Backs the client's **Settings → About → Copy Diagnostics** button.

**Loopback-only, unconditionally** — non-loopback callers get `403` regardless of auth, because the report embeds absolute paths and PIDs. It never contains token material or document content. Home-directory paths are `~`-redacted before they reach the wire (`redactHomePaths`), since this payload also prefills the Report-a-bug issue body; that narrows what leaks into a public issue but does not change the loopback posture. The five source-checkout-only checks (`node-modules`, `dev-repo`, `npm-staleness`, `mcp-json`, `orphaned-vite`) are filtered out of the report with `ok`/`failures`/`warnings`/`summary` recomputed — they read `process.cwd()`, which is arbitrary for a desktop or npm-global install. Concurrent requests share one in-flight collector run (single-flight).

**Response (200):**
```json
{
  "report": { "ok": true, "crashed": false, "failures": 0, "warnings": 0, "summary": "All checks passed. Tandem is ready.", "error": null, "results": [ { "check": "node-version", "status": "pass", "message": "Node.js v22.13.0 (>= 22.12.0 required)" } ] },
  "version": "0.22.1",
  "transport": "http",
  "platform": "win32",
  "arch": "x64",
  "nodeVersion": "v22.13.0",
  "tauriSidecar": true,
  "osRelease": "10.0.26100",
  "osVersion": "Windows 11 Pro",
  "cpuModel": "AMD Ryzen 7 5800X 8-Core Processor",
  "cpuCount": 16,
  "totalMemoryMb": 32768,
  "freeMemoryMb": 6247
}
```

The `osRelease`/`osVersion`/`cpu*`/`*MemoryMb` fields are optional and best-effort — see the `tandem_diagnostics` section above for why, and for what is deliberately excluded.

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
| `force` | boolean | no | Reload from disk even if already open (clears annotations + session). Gated by the license gate; plain open is not. |
| `readOnly` | boolean | no | Force read-only mode. Used by the View Changelog button. |

**Response (200):**
```json
{ "data": { "documentId": "report-a1b2c3", "fileName": "report.md", "format": "md", "readOnly": false, "source": "file", ... } }
```

**Errors:** `400 BAD_REQUEST` (missing/non-string `filePath`, and unsupported format -- `UNSUPPORTED_FORMAT` is mapped to `BAD_REQUEST` by `errorCodeToLabel`), `404 NOT_FOUND` (the wire label; `FILE_NOT_FOUND`/`ENOENT` map to it), `400 INVALID_PATH`, `413 FILE_TOO_LARGE`, `423 FILE_LOCKED`, `403 PERMISSION_DENIED`, `403 LICENSE_REQUIRED` (on `force: true`)

### POST /api/scratchpad

Create and open a Scratchpad tab. Equivalent to `tandem_scratchpad` but callable from the editor UI (used by the `Ctrl+N` shortcut and the `+` button's "New Scratchpad" option). Gated by `licenseGateMiddleware` (#1318).

**Request:** Body optional. When present it must be exactly `{ "content"?: string }` -- any other key is rejected.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | no | Initial Scratchpad content. Capped at 1 MiB. |

**Response (200):**
```json
{ "data": { "documentId": "abc123", "fileName": "Scratchpad.md", "format": "md", "readOnly": false, "source": "upload", ... } }
```

**Errors:** `400 BAD_REQUEST` (unknown key, or non-string `content`), `413 PAYLOAD_TOO_LARGE` (content over 1 MiB), `403 LICENSE_REQUIRED`

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
{ "data": { "closedPath": "C:\\Users\\bkolb\\docs\\report.md", "activeDocumentId": "invoice-d4e5f6" } }
```

`closedPath` is scrubbed to a basename for non-loopback callers (#1294).

**Errors:** `400 BAD_REQUEST` (missing documentId), `404 NOT_FOUND` (document not found)

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

**Errors:** `400 BAD_REQUEST` -- covers both a malformed body and an unsupported format (`UNSUPPORTED_FORMAT` is mapped to `BAD_REQUEST` by `errorCodeToLabel`)

### CORS

Every `/api/*` route registered today passes the CORS + Host middleware explicitly as its `mw` argument. It is threaded **per route**, not mounted path-wide — only `enforceLoopbackMutation` is `app.use("/api", …)` — so a registration that omits `mw` loses both the CORS allowlist and the Host-header DNS-rebinding check (`isHostAllowed`). True by convention, not by construction.

The allowlist is three origins: `http(s)://127.0.0.1` and `http(s)://tauri.localhost` with any port, plus the Linux Tauri scheme `tauri://localhost` matched as an **exact string, never a `tauri://*` wildcard**. Bare `localhost` was narrowed out in PR #637. Absence of `Access-Control-Allow-Origin` is the denial — never `null` (#1291). Full posture: [security.md](security.md#cors-allowlist). The body size limit is 70MB to accommodate base64-encoded .docx files (50MB file → ~67MB base64).

---

## Channel API (Real-Time Push)

The channel API endpoints expose real-time events from the editor as an SSE stream. The Tandem **channel shim** (a Claude-specific stdio MCP transport per [ADR-038](decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration) §extras) consumes these endpoints and forwards events as `notifications/claude/channel` to Claude Code. **Other MCP clients subscribe to `/api/events` directly** — same stream, no shim. These are NOT MCP tools — they are HTTP endpoints on port 3479.

### GET /api/events

SSE (Server-Sent Events) stream of `TandemEvent` objects. The channel shim connects here and forwards events to Claude Code as `notifications/claude/channel`; the plugin monitor is a second consumer of this same stream, writing a payload-free wake line — the event's `type` and nothing else — to stdout as a plugin notification (#1354). It reads the full stream rather than `?filter=wake` only because its awareness flush needs `event.documentId`; the payload never leaves the monitor process.

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

Push-consumer heartbeat: a channel shim or plugin monitor reports that it received an SSE event. Recorded server-side for diagnostics (`/health`'s loopback-only `push` field, and `tandem doctor`) and **never rendered as Claude's presence**.

Not literally one post per event: the consumer debounces (a burst collapses to one), and it is skipped entirely for annotation traffic that Solo mode suppresses, because that filter sits above the heartbeat. So a healthy attached consumer in Solo reports no events until a chat message arrives.

It used to write `ClaudeAwareness` into the document's awareness map, which drove the status pill. That was wrong: the caller posts on event *receipt*, not on Claude doing anything, so a channel shim whose host never negotiated the channel kept stamping `processing: …` and then `idle` for a process no model was attached to — the editor read "AI connected · idle" while nothing the user did reached Claude. Claude's real presence comes from `tandem_status` and the per-tool-call typing-presence marker, both written by Claude's own dispatches.

The heartbeat proves the server→consumer leg works. It does **not** prove delivery to a model, and nothing may gate on it.

Unknown keys in the body are ignored. Worth stating because this line previously claimed `focusParagraph` / `focusOffset` were kept for compatibility with pinned shim versions — no shim has ever sent them (a full-history `git log --all -S` across `src/channel/`, `src/monitor/` and `sse-consumer.ts` returns nothing). They described Claude's cursor, which this caller has never had first-hand knowledge of. The server also retains no `documentId` from this route: a document id is a filename slug, not an opaque hash, and nothing read it.

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

SSE (Server-Sent Events) stream of toast notifications for the editor. Separate from `GET /api/events` (which pushes Y.Map events to the channel shim and the plugin monitor). Used for ephemeral notifications like annotation range failures and save errors.

**Headers:**
- `Accept: text/event-stream`

**Stream format:**
```
data: {"type":"error","title":"Range Error","message":"Annotation target text has moved","timestamp":1710936000000}

data: {"type":"warning","title":"Save Warning","message":"File is read-only","timestamp":1710936001000}
```

**Notification types:** `error` (auto-dismiss 8s), `warning` (auto-dismiss 6s), `info` (auto-dismiss 4s). The ring buffer holds up to 50 notifications. Duplicate notifications within a short window are deduplicated with a count badge in the editor.

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
