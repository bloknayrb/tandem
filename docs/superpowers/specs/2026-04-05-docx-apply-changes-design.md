# Apply Accepted Suggestions to .docx

**Issue:** #162
**Date:** 2026-04-05
**Status:** Design approved, revised after multi-agent review

## Problem

When reviewing a .docx file in Tandem, Claude creates suggestions with replacement text, and the user accepts or dismisses them. Today there's no way to apply those accepted changes back to the original Word document — the user must make the edits manually in Word.

## Solution

A batch-apply feature that writes accepted suggestions back to the original .docx as **tracked changes** (`<w:ins>`/`<w:del>` revision markup), marks corresponding Word comments as resolved, and saves a backup of the original file. The user opens the result in Word and uses Accept/Reject to finalize — Tandem does not silently modify text.

**Mental model:** "Export for Word review." The button label, tooltip, and confirmation dialog reinforce this: Tandem proposes changes as tracked revisions, Word is where they're finalized.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| XML manipulation approach | Parallel Walker (direct XML via JSZip) | Reuses proven offset-tracking logic from `docx-comments.ts`. No viable Node.js library for in-place .docx editing with tracked changes. |
| Output format | Tracked changes in original file | Preserves OneDrive/SharePoint version history (tied to file path). User can Accept/Reject individual changes in Word afterward. |
| Original file handling | Backup copy saved, edits applied to original path | `{name}.backup.docx` alongside the original. Restore available via MCP tool. |
| Word comments | Marked as resolved, never deleted | Preserves history. Uses `word/commentsExtended.xml` with `w15:done="1"`. |
| Change attribution | Configurable author name (default: "Tandem Review") | Lets users attribute changes to themselves for SharePoint workflows. Stored as a Tandem setting, shared by MCP tool and browser button. |
| Entry points | MCP tool + browser button, both from day one | Same backend logic, two thin entry points. |
| Pending annotations | Soft gate — warn, don't block | User may want to apply what they've accepted so far and keep reviewing. |
| Cross-run formatting | Inherit `<w:rPr>` from first deleted run | Deterministic, matches Word's own behavior for typed-over selections. |
| Complex elements in range | Reject individual suggestion, apply the rest | Footnote refs, drawings, field codes produce malformed XML if wrapped in `<w:del>`. Skip with clear error. |

## Architecture

### New Files

- **`src/server/file-io/docx-walker.ts`** — Shared offset-tracking walker extracted from `docx-comments.ts`. Walks `document.xml` via htmlparser2 in xmlMode, tracks flat-text offsets through `<w:t>` elements (including heading prefixes, paragraph separators, tabs, breaks). Calls back at registered target offsets with the DOM node reference, character index, and parent `<w:p>` metadata (including `w14:paraId` if present). **Skips `<w:del>` subtrees** (deleted tracked-change text is not in Tandem's flat-text space). **Traverses `<w:ins>` subtrees normally** (inserted tracked-change text is part of the accepted document). Skips field instruction text (`<w:instrText>`). Descends into `<w:hyperlink>` elements.

- **`src/server/file-io/docx-apply.ts`** — Core apply logic. Three exports:
  - `buildOffsetMap(xml, targetOffsets)` — runs the walker, returns `Map<offset, {element, textNode, charIndex, paragraphId?}>`
  - `applyTrackedChanges(zip, suggestions, options)` — orchestrates the full apply: offset map → validate ALL suggestions → clone DOM → apply mutations → resolve comments → serialize. No partial writes on failure.
  - `resolveWordComments(zip, commentIds, paragraphIds)` — creates/updates `commentsExtended.xml` with resolved state

- **`src/server/mcp/docx-apply.ts`** — MCP tool definitions for `tandem_applyChanges` and `tandem_restoreBackup`. CRDT resolution (relRange → flat offsets) happens here, NOT in the file-IO layer. Registers tools via `registerApplyTools(server)`.

- **`src/client/components/ApplyChangesButton.tsx`** — Browser button. Visible only for .docx files with accepted suggestions.

### Modified Files

- **`src/server/file-io/docx-comments.ts`** — Refactored to use the shared walker from `docx-walker.ts`. **Behavior change:** now correctly skips `<w:del>` subtrees, fixing a latent offset bug for documents with pre-existing tracked changes.
- **`src/server/mcp/server.ts`** — Add `registerApplyTools(server)` call in the tool registration block.
- **`src/server/mcp/api-routes.ts`** — New `POST /api/apply-changes` endpoint.
- **`src/server/file-io/index.ts`** — Export the apply function. Add `atomicWriteBuffer(filePath: string, content: Buffer)` for binary file writes (the existing `atomicWrite` only handles UTF-8 strings).
- **`package.json`** — Add `dom-serializer` as a direct dependency (currently transitive via htmlparser2 → domutils, but relying on transitive chains is fragile).

## Coordinate System Safety

### The invariant

.docx files are `readOnly: true` in Tandem — `tandem_edit` is blocked. The Y.Doc text should be identical to the text the walker computes from `document.xml`. Suggestions are annotations (stored in Y.Map), not edits to the Y.Doc content.

### The guard

Before applying, compare `extractText(ydoc)` against the walker's computed flat text from `document.xml`. If they diverge, abort with a clear error: *"The document content has changed since it was loaded. Close and reopen the file before applying changes."* This catches any scenario — stale browser tab merge, unexpected Y.Doc mutation, mammoth/walker disagreement — without needing to diagnose the cause.

### Heading prefix matching

The walker's `detectHeadingLevel` matches `w:pStyle` values via regex `/^heading\s*(\d)$/i`. Mammoth uses the same style names for its default heading mapping. For non-standard or localized heading styles (e.g., "Titre1" in French Word), both mammoth and the walker may disagree — but the text-comparison guard above catches this. Long-term, the walker should resolve styles via `styles.xml` inheritance chains, matching mammoth's approach.

### textSnapshot verification

`textSnapshot` is captured from `extractText(ydoc)` which includes heading prefixes. When comparing against XML text at a position, the comparison must strip heading prefix characters from the snapshot. The walker knows the prefix length at each paragraph boundary, so the strip offset is available.

## Data Flow

```
1. Collect accepted suggestions
   Y.Map('annotations') → filter(status=accepted, type=suggestion)
   → parse content JSON → [{id, from, to, newText, relRange, textSnapshot}]

2. Resolve CRDT positions to current flat offsets
   [IN MCP TOOL LAYER, not file-IO]
   relRange → resolveRelativePosition(ydoc), fallback to range.from/range.to
   Sort descending by offset (apply from end to avoid shifting)

3. Detect overlapping ranges
   Scan sorted suggestions for any overlapping [from, to) intervals
   Reject later-created suggestion in each overlap pair
   (Claude can create overlapping suggestions in separate tool calls)

4. Load original .docx from disk
   Read file buffer → JSZip.loadAsync()
   Extract: document.xml, comments.xml, commentsExtended.xml (if exists),
            [Content_Types].xml, word/_rels/document.xml.rels

5. Build offset map + text-comparison guard
   docx-walker walks document.xml with target offsets
   → Map<offset, {element: w:r, textNode: w:t, charIndex, paragraphId?}>
   Also produces full flat text for comparison against extractText(ydoc)
   ABORT if texts diverge (coordinate system mismatch)

6. Validate ALL suggestions before any DOM mutation
   For each suggestion:
   a. Check offset map resolution succeeded
   b. Verify textSnapshot matches (with heading prefix stripping)
   c. Check for complex elements in range (footnotes, drawings, fields)
   d. Check for overlapping ranges not caught in step 3
   Collect valid + rejected lists. No DOM mutation yet.

7. Clone DOM, apply replacements (reverse offset order)
   Clone the parsed document.xml DOM as rollback point
   For each valid suggestion (descending offset order):
   a. Split <w:r> at range boundaries if offset falls mid-run
   b. Wrap original runs in <w:del> (w:delText, unique w:id, author, date)
   c. Insert <w:ins> with new <w:r> containing newText (inherits first run's w:rPr)
   On ANY exception: discard mutated DOM, return error, no file written

8. Resolve Word comments
   Match annotation IDs (import-{commentId}-*) → extract numeric commentId
   Find <w:commentRangeStart w:id="X"> → parent <w:p> → read w14:paraId
   Create/update commentsExtended.xml with w15:done="1" for applied subset only
   Add .rels entry + content type if file is new
   Skip with warning if paragraphs lack w14:paraId

9. Assign revision IDs
   Scan ALL existing w:id values in document.xml (ins, del, comment,
   bookmark, permStart, permEnd) → start from max + 1
   Assign sequential IDs to all new <w:del>/<w:ins>

10. Serialize & write
    Serialize modified XML via dom-serializer back into JSZip
    Backup: fs.copyFile(original, {name}.backup.docx)
    Verify backup: fs.stat size matches original (abort on mismatch/ENOSPC)
    Write modified zip: atomicWriteBuffer(originalPath, buffer)

11. Return summary
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
- XML serialization via `dom-serializer` (added as direct dependency)
- Walker skips `<w:del>` subtrees, traverses `<w:ins>` subtrees normally
- Walker must explicitly handle `<w:tab>` (1 char), `<w:br>` (1 char), `<w:noBreakHyphen>` (1 char, U+2011), `<w:softHyphen>` (1 char, U+00AD), and `<w:sym>` (1 char) to match mammoth's output. These are zero-width in the catch-all recursive walk but produce characters in mammoth's HTML.
- `w:rsidR` (revision session ID) attributes are not added to new runs. Word adds its own on first save. No functional impact, cosmetic only.

## Comment Resolution

Word comments imported into Tandem have annotation IDs like `import-{commentId}-{timestamp}`. When an accepted suggestion overlaps a Word comment's range, that comment is marked as resolved.

Resolution lives in `word/commentsExtended.xml`:

```xml
<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
  <w15:commentEx w15:paraId="3A2B1C00" w15:done="1"/>
</w15:commentsEx>
```

The `w15:paraId` must match the `w14:paraId` on the paragraph containing `<w:commentRangeStart w:id="X">` (the comment anchor element, not `<w:commentReference>`).

### paraId resolution algorithm

1. During the walker pass (step 5), track the current `<w:p>` element and its `w14:paraId` attribute.
2. When a `<w:commentRangeStart>` is encountered, record the mapping: comment ID → current paragraph's `w14:paraId`.
3. In step 8, use this mapping to populate `commentsExtended.xml`.

### Scenarios

1. **File exists** — parse, append new entries, serialize back
2. **File doesn't exist** — create from scratch + add `.rels` entry (`http://schemas.microsoft.com/office/2011/relationships/commentsExtended`) + content type (`application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml`)
3. **No `w14:paraId` on paragraphs** — skip resolution with warning (don't inject paraId attributes)
4. **Only resolve comments for the *applied* subset** — suggestions that were rejected in step 6 do not trigger comment resolution

## MCP Tool Interface

### tandem_applyChanges

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | No | Target document (defaults to active) |
| `author` | string | No | Attribution for tracked changes (defaults to configured setting, then `"Tandem Review"`) |
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
2. Document source must be `"file"` (not `upload://`) → `FORMAT_ERROR` with message "Uploaded files cannot be modified on disk"
3. At least one accepted suggestion required → descriptive error
4. File must be writable → `PERMISSION_DENIED`
5. Pending annotations → warning in response, no block

### tandem_restoreBackup

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | No | Target document (defaults to active) |

Copies `{name}.backup.docx` back to original path. Returns error if no backup exists. Reloads document in editor via `force: true`.

## Browser Button

"Apply as Tracked Changes" button in the SidePanel, below the filter controls (new action row). Hidden on non-.docx documents.

- **Visible:** only when active document is .docx
- **Enabled:** when at least one accepted suggestion exists
- **Disabled state:** tooltip "No accepted suggestions to apply"
- **Click flow:** confirmation dialog → `POST /api/apply-changes` → success toast / partial failure toast
- **Author:** uses configured Tandem setting (prompted on first use if not set, defaults to "Tandem Review")

### Confirmation dialog

> **Apply N changes as tracked revisions?**
>
> Your original file will be backed up to:
> `report.backup.docx`
>
> The changes will appear as tracked revisions in Word — you can Accept or Reject each one individually.
>
> [Cancel] [Apply Changes]

If pending annotations exist, add a warning line:
> ⚠ M annotations are still pending review and will not be applied.

### Post-apply behavior

On success, show toast: *"N changes applied as tracked revisions. Open in Word to review. Backup saved to {path}."*

On partial failure, show expandable toast: *"N of M changes applied. K could not be applied:"* followed by the rejection reasons in plain language:
- "Range spans footnote reference" → *"1 suggestion overlaps a footnote and couldn't be applied"*
- "Text at range doesn't match expected content" → *"1 suggestion's target text has changed since it was created"*

### Contextual nudge

When the last annotation on a .docx document is resolved (accepted or dismissed), show a toast: *"All annotations resolved. Ready to apply changes to the Word document?"* with an "Apply Now" action button.

## Error Handling

### Blocking errors (entire apply fails, no file modified)

| Condition | Error | User-facing message |
|-----------|-------|---------------------|
| Not a .docx | `FORMAT_ERROR` | "Apply changes is only available for Word documents" |
| Uploaded file | `FORMAT_ERROR` | "Uploaded files cannot be modified on disk" |
| No accepted suggestions | Descriptive error | "No accepted suggestions to apply" |
| Original file deleted/moved | `FILE_NOT_FOUND` | "The original file could not be found at {path}" |
| Original file locked by Word | `FILE_LOCKED` | "The file is open in another program. Close it and try again." |
| File permission denied | `PERMISSION_DENIED` | "Permission denied. Check file permissions." |
| Backup write failed (ENOSPC, EACCES, EBUSY) | `FILE_LOCKED` or `PERMISSION_DENIED` | "Could not create backup file. Check disk space and permissions." |
| Backup size mismatch | New error | "Backup verification failed. The backup may be incomplete." |
| Text comparison guard failed | New error | "The document content has changed since it was loaded. Close and reopen the file." |
| Path too long (ENAMETOOLONG) | `FILE_NOT_FOUND` | "The file path is too long. Move the file to a shorter path." |

### Per-suggestion rejections (apply continues for remaining)

| Condition | User-facing message |
|-----------|---------------------|
| Range spans footnote/endnote ref | "Overlaps a footnote and couldn't be applied" |
| Range spans drawing/embedded object | "Overlaps an embedded object and couldn't be applied" |
| Range spans field code markers | "Overlaps a Word field and couldn't be applied" |
| textSnapshot mismatch | "Target text has changed since this suggestion was created" |
| Offset can't be resolved | "Could not locate this text in the original document" |
| Overlapping range with another suggestion | "Overlaps with another suggestion" |

### Warnings (included in response)

| Condition | Warning |
|-----------|---------|
| Pending annotations remain | Count included in `pendingWarning` |
| Backup file overwritten | Noted in response |
| Comment resolution skipped (no paraId) | "Word comments could not be marked as resolved" |

### Atomicity

1. Backup is written first via `fs.copyFile`.
2. Backup is verified: `fs.stat` size must match original.
3. Modified file is written via `atomicWriteBuffer` (temp file + rename).
4. If DOM mutation throws, the mutated DOM is discarded and no file is written.
5. If `atomicWriteBuffer` fails after backup, the original is untouched (temp file is cleaned up).

## Post-Apply State

After writing the modified .docx, the in-memory Y.Doc still reflects the pre-apply content (the original text loaded via mammoth). The apply feature modifies the source file on disk but does NOT update the Y.Doc.

**Stale browser tab risk:** If the server restarts, Hocuspocus reloads from the modified .docx on disk. But an already-open browser tab will sync its old Y.Doc state back, potentially reverting the changes. This is an existing Tandem gotcha (documented in CLAUDE.md).

**Mitigation:** After a successful apply, the MCP tool response includes a note recommending the user close the Tandem tab if they plan to reopen the file. `tandem_restoreBackup` uses `force: true` to reload cleanly. A future version could trigger a force-reload automatically after apply — deferred for v1 because force-reload clears all annotations and session state, which the user may want to preserve for reference.

**OneDrive sync:** The backup file (`{name}.backup.docx`) will be synced by OneDrive/SharePoint alongside the original. This is intentional for users who want backup versioning, but may be unwanted noise for others. The `backupPath` parameter allows redirecting the backup to a non-synced location (e.g., local temp directory). A future version could add a "don't sync backup" setting.

## Known Limitations (v1)

- **No selective apply.** All accepted suggestions are applied in one batch. To exclude specific suggestions, dismiss them before applying. May add selective apply in a future version.
- **No preview/diff.** The user cannot preview what the document will look like before applying. The confirmation dialog shows the count and type of changes. Word's tracked-changes view serves as the post-apply diff.
- **No automatic undo.** After applying, the only recovery path is the backup file. The confirmation dialog explicitly shows the backup path. `tandem_restoreBackup` automates the restore. A future version could integrate with Word's revision rejection for granular undo.
- **Heading style detection is English-only.** Localized Word style names (e.g., "Titre1" in French) may not be detected as headings. The text-comparison guard catches this and aborts rather than silently misaligning. Long-term fix: resolve styles via `styles.xml` inheritance chains.
- **Windows MAX_PATH.** Deeply nested OneDrive paths may exceed the 260-character limit for the backup file. The error is caught and reported. Workaround: move the file to a shorter path, or use the `backupPath` parameter to specify a shorter location.
- **`w:rsidR` not added.** Word tracks revision session IDs on every run. New `<w:ins>` runs don't include these. Word adds them on first save. No functional impact, cosmetic only.
- **`w15:paraIdParent` not included.** The `commentsExtended.xml` entries omit `w15:paraIdParent` (used for threaded comment replies). Some Word versions may require this for proper resolution display. If comment resolution appears ineffective in testing, add `paraIdParent` from the comment's reply chain.

## Testing Strategy

### Unit tests — `docx-walker.ts`

- Offset counting produces identical flat text to `extractText(htmlToYDoc(mammoth(docx)))` for each fixture (the real invariant, not just matching the old walker)
- Heading prefixes, tabs, breaks, paragraph separators counted correctly
- **Skips `<w:del>` subtrees** — fixture with pre-existing tracked changes
- **Traverses `<w:ins>` subtrees** — fixture with pre-existing insertions
- Descends into `<w:hyperlink>` elements
- Returns correct DOM node + character index at target offsets
- Returns `w14:paraId` for paragraphs containing comment anchors
- Handles special elements: `<w:tab>`, `<w:br>`, `<w:noBreakHyphen>`, `<w:softHyphen>`, `<w:sym>` — each counted as 1 character, matching mammoth's output
- Skips `<w:instrText>` (field instruction text) — not part of visible content

### Unit tests — `docx-apply.ts`

- Single-run replacement: correct `<w:del>`/`<w:ins>` structure, `w:delText`, `xml:space="preserve"`, `w:rPr` inheritance
- Cross-run replacement: multiple runs in one `<w:del>`, first-run formatting on `<w:ins>`
- Partial-run split: boundary mid-run, both halves correct, no text lost
- Reverse-order application: two suggestions in same paragraph, both apply without offset shift
- Complex element rejection: footnote ref in range → rejection, other suggestions still apply
- textSnapshot mismatch: suggestion skipped (with heading prefix stripping)
- Revision ID uniqueness: no collisions with existing IDs
- Overlapping range detection: overlapping suggestions rejected
- Comment resolution: `commentsExtended.xml` created/updated, `.rels` and content types correct
- DOM mutation rollback: exception during apply → no file written, error returned
- Empty newText (deletion-only suggestion): produces `<w:del>` with no `<w:ins>`

### Integration tests — JSZip round-trip

- Load `.docx` fixture → apply suggestion → repack → re-extract `document.xml` → verify tracked change markup
- Repacked `.docx` parseable by mammoth without errors (structural integrity)
- **Text comparison guard**: load `.docx`, verify `extractText(ydoc)` matches walker flat text
- **Pre-existing tracked changes**: load fixture with `<w:del>`/`<w:ins>`, apply new suggestion, verify offsets are correct

### MCP tool tests

- Precondition checks (not .docx, uploaded file, no accepted suggestions, file locked)
- Backup created before modifications, verified by size
- Pending annotation warning
- `tandem_restoreBackup` copies back and reloads
- Coordinate system guard: abort when texts diverge

### E2E test (Playwright)

- Open `.docx` fixture → create suggestion via MCP → accept in browser → click "Apply as Tracked Changes" → verify toast + backup file on disk
- Contextual nudge: resolve all annotations → verify "Ready to apply" toast appears

### Test fixtures

Small hand-crafted `.docx` files in `tests/fixtures/`:
- Simple text (single paragraph, one run)
- Mixed formatting (bold/italic across runs)
- Existing tracked changes (`<w:del>` and `<w:ins>`)
- Footnotes and field codes
- Document with `w14:paraId` attributes and Word comments
- Document without `w14:paraId` (older format)
- Unicode text with special characters

## Implementation Sequencing

The feature decomposes into three independently testable PRs:

1. **Walker extraction** (`docx-walker.ts`) — Pure refactor of `docx-comments.ts`. Behavior change: skip `<w:del>` subtrees (latent bug fix). Regression guard: walker flat text must match `extractText(ydoc)` for all existing .docx fixtures. This is a safe first PR with clear success criteria.

2. **Core apply logic** (`docx-apply.ts` + `atomicWriteBuffer` + `dom-serializer` dep) — No MCP, no browser. Testable entirely with fixtures. The run-splitting logic is the highest-risk code and gets the most test coverage here.

3. **Entry points** (MCP tool + browser button + API endpoint) — Thin wrappers over the core logic. Includes CRDT resolution in the MCP layer, UI components, confirmation dialog, contextual nudge.
