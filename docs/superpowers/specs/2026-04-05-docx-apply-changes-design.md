# Apply Accepted Suggestions to .docx

**Issue:** #162
**Date:** 2026-04-05
**Status:** Design approved

## Problem

When reviewing a .docx file in Tandem, Claude creates suggestions with replacement text, and the user accepts or dismisses them. Today there's no way to apply those accepted changes back to the original Word document — the user must make the edits manually in Word.

## Solution

A batch-apply feature that writes accepted suggestions back to the original .docx as **tracked changes** (`<w:ins>`/`<w:del>` revision markup), marks corresponding Word comments as resolved, and saves a backup of the original file.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| XML manipulation approach | Parallel Walker (direct XML via JSZip) | Reuses proven offset-tracking logic from `docx-comments.ts`. No viable Node.js library for in-place .docx editing with tracked changes. |
| Output format | Tracked changes in original file | Preserves OneDrive/SharePoint version history (tied to file path). User can Accept/Reject individual changes in Word afterward. |
| Original file handling | Backup copy saved, edits applied to original path | `{name}.backup.docx` alongside the original. Restore available via MCP tool. |
| Word comments | Marked as resolved, never deleted | Preserves history. Uses `word/commentsExtended.xml` with `w15:done="1"`. |
| Change attribution | Configurable author name (default: "Tandem Review") | Lets users attribute changes to themselves for SharePoint workflows. |
| Entry points | MCP tool + browser button, both from day one | Same backend logic, two thin entry points. |
| Pending annotations | Soft gate — warn, don't block | User may want to apply what they've accepted so far and keep reviewing. |
| Cross-run formatting | Inherit `<w:rPr>` from first deleted run | Deterministic, matches Word's own behavior for typed-over selections. |
| Complex elements in range | Reject individual suggestion, apply the rest | Footnote refs, drawings, field codes produce malformed XML if wrapped in `<w:del>`. Skip with clear error. |

## Architecture

### New Files

- **`src/server/file-io/docx-walker.ts`** — Shared offset-tracking walker extracted from `docx-comments.ts`. Walks `document.xml` via htmlparser2 in xmlMode, tracks flat-text offsets through `<w:t>` elements (including heading prefixes, paragraph separators, tabs, breaks). Calls back at registered target offsets with the DOM node reference and character index. Skips `<w:del>` subtrees and field instruction text. Descends into `<w:hyperlink>` elements.

- **`src/server/file-io/docx-apply.ts`** — Core apply logic. Three exports:
  - `buildOffsetMap(xml, targetOffsets)` — runs the walker, returns `Map<offset, {element, textNode, charIndex}>`
  - `applyTrackedChanges(zip, suggestions, options)` — orchestrates the full apply: offset map → validate → split runs → emit `<w:del>`/`<w:ins>` → resolve comments → serialize
  - `resolveWordComments(zip, commentIds)` — creates/updates `commentsExtended.xml` with resolved state

- **`src/server/mcp/docx-apply.ts`** — MCP tool definitions for `tandem_applyChanges` and `tandem_restoreBackup`.

- **`src/client/components/ApplyChangesButton.tsx`** — Browser button in the side panel toolbar. Visible only for .docx files with accepted suggestions.

### Modified Files

- **`src/server/file-io/docx-comments.ts`** — Refactored to use the shared walker from `docx-walker.ts`. No behavior change.
- **`src/server/mcp/api-routes.ts`** — New `POST /api/apply-changes` endpoint.
- **`src/server/file-io/index.ts`** — Export the apply function.

## Data Flow

```
1. Collect accepted suggestions
   Y.Map('annotations') → filter(status=accepted, type=suggestion)
   → parse content JSON → [{id, from, to, newText, relRange, textSnapshot}]

2. Resolve CRDT positions to current flat offsets
   relRange → resolveRelativePosition(ydoc), fallback to range.from/range.to
   Sort descending by offset (apply from end to avoid shifting)

3. Load original .docx from disk
   Read file buffer → JSZip.loadAsync()
   Extract: document.xml, comments.xml, commentsExtended.xml (if exists),
            [Content_Types].xml, word/_rels/document.xml.rels

4. Build offset map
   docx-walker walks document.xml with target offsets
   → Map<offset, {element: w:r, textNode: w:t, charIndex}>

5. Validate ranges against XML structure
   Reject ranges spanning: footnote/endnote refs, drawings, field codes
   Collect valid + rejected lists

6. Apply replacements (reverse offset order)
   For each valid suggestion:
   a. Verify textSnapshot matches text at resolved position (skip on mismatch)
   b. Split <w:r> at range boundaries if offset falls mid-run
   c. Wrap original runs in <w:del> (w:delText, unique w:id, author, date)
   d. Insert <w:ins> with new <w:r> containing newText (inherits first run's w:rPr)

7. Resolve Word comments
   Match annotation IDs (import-{commentId}-*) to comment IDs
   Create/update commentsExtended.xml with w15:done="1"
   Add .rels entry + content type if file is new

8. Assign revision IDs
   Scan existing w:id values → start from max + 1
   Assign sequential IDs to all new <w:del>/<w:ins>

9. Serialize & write
   Serialize modified XML back into JSZip
   Copy original → {name}.backup.docx
   Write modified zip → original path (atomicWrite)

10. Return summary
    {applied, rejected, rejectedDetails, backupPath, outputPath,
     pendingWarning, commentsResolved}
```

## Tracked Changes XML

### Single-run replacement

```xml
<!-- Before -->
<w:r><w:rPr><w:b/></w:rPr><w:t>He said teh quick fox</w:t></w:r>

<!-- After (split + del/ins) -->
<w:r><w:rPr><w:b/></w:rPr><w:t>He said </w:t></w:r>
<w:del w:id="50" w:author="Tandem Review" w:date="2026-04-05T12:00:00Z">
  <w:r><w:rPr><w:b/></w:rPr><w:delText>teh quick</w:delText></w:r>
</w:del>
<w:ins w:id="51" w:author="Tandem Review" w:date="2026-04-05T12:00:00Z">
  <w:r><w:rPr><w:b/></w:rPr><w:t>the quick</w:t></w:r>
</w:ins>
<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"> fox</w:t></w:r>
```

### Cross-run replacement

```xml
<!-- Before -->
<w:r><w:rPr><w:b/></w:rPr><w:t>bold part</w:t></w:r>
<w:r><w:t> plain part</w:t></w:r>

<!-- After -->
<w:del w:id="52" w:author="Tandem Review" w:date="2026-04-05T12:00:00Z">
  <w:r><w:rPr><w:b/></w:rPr><w:delText>bold part</w:delText></w:r>
  <w:r><w:delText> plain part</w:delText></w:r>
</w:del>
<w:ins w:id="53" w:author="Tandem Review" w:date="2026-04-05T12:00:00Z">
  <w:r><w:rPr><w:b/></w:rPr><w:t>replacement text</w:t></w:r>
</w:ins>
```

### Partial-run boundaries

When an offset falls mid-run, the run is split first: clone the `<w:r>`, divide the `<w:t>` text at the character index, insert both halves as siblings. Then treat the fully-spanned portion as the cases above.

### Key XML rules

- `<w:del>` uses `<w:delText>`, not `<w:t>`
- `<w:t>` and `<w:delText>` starting/ending with spaces need `xml:space="preserve"`
- Each `<w:del>` and `<w:ins>` gets a unique `w:id` (integer, no collisions with existing markup)
- `w:author` (string) and `w:date` (ISO 8601 UTC) required on both
- XML serialization via `dom-serializer` (transitive dependency of htmlparser2, already in the bundle)

## Comment Resolution

Word comments imported into Tandem have annotation IDs like `import-{commentId}-{timestamp}`. When an accepted suggestion overlaps a Word comment's range, that comment is marked as resolved.

Resolution lives in `word/commentsExtended.xml`:

```xml
<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
  <w15:commentEx w15:paraId="3A2B1C00" w15:done="1"/>
</w15:commentsEx>
```

The `w15:paraId` must match the `w14:paraId` on the paragraph containing the comment anchor.

Three scenarios:
1. **File exists** — parse, append new entries, serialize back
2. **File doesn't exist** — create from scratch + add `.rels` entry + content type
3. **No `w14:paraId` on paragraphs** — skip resolution with warning (don't inject paraId attributes)

## MCP Tool Interface

### tandem_applyChanges

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | No | Target document (defaults to active) |
| `author` | string | No | Attribution for tracked changes (defaults to `"Tandem Review"`) |
| `outputPath` | string | No | Override output path (defaults to overwrite original) |
| `backupPath` | string | No | Override backup path (defaults to `{name}.backup.docx`) |

**Returns:**
```json
{
  "applied": 5,
  "rejected": 1,
  "rejectedDetails": [{"id": "ann-xyz", "reason": "Range spans footnote reference"}],
  "backupPath": "C:\\...\\report.backup.docx",
  "outputPath": "C:\\...\\report.docx",
  "pendingWarning": "3 annotations are still pending review",
  "commentsResolved": 2
}
```

**Preconditions** (checked in order):
1. Document must be .docx → `FORMAT_ERROR`
2. At least one accepted suggestion required → descriptive error
3. File must be writable → `PERMISSION_DENIED`
4. Pending annotations → warning in response, no block

### tandem_restoreBackup

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | No | Target document (defaults to active) |

Copies `{name}.backup.docx` back to original path. Returns error if no backup exists. Reloads document in editor via `force: true`.

## Browser Button

"Apply Changes" button in the side panel toolbar, adjacent to the export button.

- **Visible:** only when active document is .docx and at least one accepted suggestion exists
- **Greyed out:** when no accepted suggestions (with tooltip explaining why)
- **Click flow:** confirmation dialog → `POST /api/apply-changes` → success toast with summary / partial failure toast with details
- **Author:** defaults to "Tandem Review" (no UI picker in v1; MCP tool covers the attribution case)

## Error Handling

### Blocking errors (entire apply fails, no file modified)

| Condition | Error |
|-----------|-------|
| Not a .docx | `FORMAT_ERROR` |
| No accepted suggestions | Descriptive error |
| Original file deleted/moved | `FILE_NOT_FOUND` |
| Original file locked by Word | `FILE_LOCKED` |
| File permission denied | `PERMISSION_DENIED` |
| Backup path exists and is locked | Error, suggest manual rename |

### Per-suggestion rejections (apply continues for remaining)

| Condition | Reported reason |
|-----------|----------------|
| Range spans footnote/endnote ref | "Range spans footnote reference" |
| Range spans drawing/embedded object | "Range spans embedded object" |
| Range spans field code markers | "Range spans field code" |
| textSnapshot mismatch at XML position | "Text at range doesn't match expected content" |
| Offset can't be resolved in document.xml | "Range could not be located in original document" |

### Warnings (included in response)

| Condition | Warning |
|-----------|---------|
| Pending annotations remain | Count included in `pendingWarning` |
| Backup file overwritten | Noted in response |
| Comment resolution skipped (no paraId) | "Word comments could not be marked as resolved" |

### Atomicity

Backup is written first. Modified file is written via `atomicWrite` (temp file + rename). If the process crashes between backup and apply, the original is untouched.

## Testing Strategy

### Unit tests — `docx-walker.ts`

- Offset counting matches `docx-comments.ts` for identical inputs (regression guard)
- Heading prefixes, tabs, breaks, paragraph separators counted correctly
- Skips `<w:del>` subtrees and field instruction text
- Descends into `<w:hyperlink>` elements
- Returns correct DOM node + character index at target offsets

### Unit tests — `docx-apply.ts`

- Single-run replacement: correct `<w:del>`/`<w:ins>` structure, `w:delText`, `xml:space="preserve"`, `w:rPr` inheritance
- Cross-run replacement: multiple runs in one `<w:del>`, first-run formatting on `<w:ins>`
- Partial-run split: boundary mid-run, both halves correct, no text lost
- Reverse-order application: two suggestions in same paragraph, both apply without offset shift
- Complex element rejection: footnote ref in range → rejection, other suggestions still apply
- textSnapshot mismatch: suggestion skipped
- Revision ID uniqueness: no collisions with existing IDs
- Comment resolution: `commentsExtended.xml` created/updated, `.rels` and content types correct

### Integration tests — JSZip round-trip

- Load `.docx` fixture → apply suggestion → repack → re-extract `document.xml` → verify tracked change markup
- Repacked `.docx` parseable by mammoth without errors (structural integrity)

### MCP tool tests

- Precondition checks (not .docx, no accepted suggestions, file locked)
- Backup created before modifications
- Pending annotation warning
- `tandem_restoreBackup` copies back and reloads

### E2E test (Playwright)

- Open `.docx` fixture → create suggestion via MCP → accept in browser → click Apply Changes → verify toast + backup file on disk

### Test fixtures

Small hand-crafted `.docx` files in `tests/fixtures/`:
- Simple text (single paragraph, one run)
- Mixed formatting (bold/italic across runs)
- Existing tracked changes
- Footnotes and field codes
