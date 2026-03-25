# Workflows

Real-world patterns for using Tandem with Claude on toll consulting documents.

## Reviewing a DRPA Progress Report

**Setup:** Bryan has a monthly progress report draft that needs review before submitting to DRPA.

```
Claude: tandem_open({ filePath: "C:\\Users\\bkolb\\...\\progress-report-feb.md" })
```

Browser opens, document loads. Claude starts by understanding the structure:

```
Claude: tandem_getOutline()
→ { outline: [
    { level: 1, text: "Monthly Progress Report - February 2026" },
    { level: 2, text: "Executive Summary" },
    { level: 2, text: "Project Status" },
    { level: 2, text: "Cost Summary" },
    { level: 3, text: "Labor Costs" },
    { level: 3, text: "Direct Expenses" },
    { level: 2, text: "Issues and Risks" }
  ]}
```

Claude reviews section by section without loading the full doc:

```
Claude: tandem_setStatus("Reviewing Cost Summary...", { focusParagraph: 8 })
Claude: tandem_getTextContent({ section: "Cost Summary" })
```

Bryan sees Claude's focus move to the Cost Summary section (blue tint). Claude finds an issue:

```
Claude: tandem_resolveRange({ pattern: "$12.4 million" })
→ { from: 342, to: 355 }

Claude: tandem_highlight({
  from: 342, to: 355,
  color: "red",
  note: "Q3 revenue was updated to $13.1M in the latest financial report"
})
```

Red highlight appears in Bryan's browser. Claude suggests the fix:

```
Claude: tandem_suggest({
  from: 342, to: 355,
  newText: "$13.1 million",
  reason: "Updated per Q3 financial report"
})
```

Bryan sees the suggestion in the side panel -- accepts or rejects with one click. Repeat for each section.

When done:
```
Claude: tandem_save()
Claude: tandem_setStatus("Review complete")
```

## Cross-Referencing an Invoice (Multi-Document)

**Setup:** Bryan needs to verify that an invoice matches the work described in a progress report. Both files are open simultaneously.

```
Claude: tandem_open({ filePath: "C:\\Users\\bkolb\\...\\progress-report-feb.md" })
→ { documentId: "progress-report-f-1a2b3c", fileName: "progress-report-feb.md", ... }

Claude: tandem_open({ filePath: "C:\\Users\\bkolb\\...\\invoice-feb.docx" })
→ { documentId: "invoice-feb-d4e5f6", fileName: "invoice-feb.docx", readOnly: true, ... }
```

Bryan sees two tabs in the browser. Claude verifies both are open:

```
Claude: tandem_listDocuments()
→ { documents: [
    { id: "progress-report-f-1a2b3c", fileName: "progress-report-feb.md", isActive: false },
    { id: "invoice-feb-d4e5f6", fileName: "invoice-feb.docx", isActive: true }
  ], count: 2 }
```

Claude searches for dollar figures in the progress report using `documentId`:

```
Claude: tandem_search({ query: "\\$[\\d,.]+", regex: true, documentId: "progress-report-f-1a2b3c" })
→ { matches: [
    { from: 342, to: 355, text: "$13.1 million" },
    { from: 487, to: 498, text: "$2.4 million" },
    { from: 612, to: 621, text: "$847,000" }
  ]}
```

Claude cross-references against the invoice and annotates the progress report:

```
// Matches invoice
Claude: tandem_highlight({ from: 342, to: 355, color: "green", note: "Matches invoice line 12",
  documentId: "progress-report-f-1a2b3c" })

// Discrepancy found
Claude: tandem_highlight({ from: 487, to: 498, color: "red", note: "Invoice shows $2.6M -- $200K discrepancy",
  documentId: "progress-report-f-1a2b3c" })

// Not in invoice
Claude: tandem_highlight({ from: 612, to: 621, color: "yellow", note: "Not found in invoice -- verify",
  documentId: "progress-report-f-1a2b3c" })
```

Bryan switches to the progress report tab and sees green/red/yellow highlights. Claude adds a summary:

```
Claude: tandem_comment({
  from: 0, to: 40,
  text: "Invoice cross-reference: 1 match, 1 discrepancy ($200K on labor), 1 item not in invoice.",
  documentId: "progress-report-f-1a2b3c"
})
```

Bryan reviews the highlights and addresses discrepancies before approving the invoice.

## Drafting an RFP Response

**Setup:** Bryan needs to draft a response to an RFP. He has the RFP open in another window for reference.

```
Claude: tandem_open({ filePath: "C:\\Users\\bkolb\\...\\rfp-response-draft.md" })
```

The document starts with a skeleton. Claude drafts a section:

```
Claude: tandem_setStatus("Drafting Technical Approach section...")
Claude: tandem_resolveRange({ pattern: "[Technical approach content here]" })
→ { from: 156, to: 192 }

Claude: tandem_edit({
  from: 156, to: 192,
  newText: "Our approach leverages 15 years of toll systems experience across DRPA, VDOT, and DelDOT to deliver a comprehensive solution..."
})
```

The placeholder is replaced with draft text -- Bryan sees it appear live. He edits inline in the browser, refining the language. Claude notices Bryan is working:

```
Claude: tandem_getActivity()
→ { active: true, isTyping: true, cursor: 203 }
```

Claude waits until Bryan pauses, then reviews what changed:

```
Claude: tandem_getActivity()
→ { active: true, isTyping: false, lastEdit: 1710936000000 }

Claude: tandem_getTextContent({ section: "Technical Approach" })
// Reads Bryan's edits and suggests improvements
```

## Multi-Model Workflow

**Setup:** Large document that benefits from parallel review. Opus orchestrates, Sonnet agents handle sections.

Opus reads the outline:
```
Opus: tandem_getOutline()
// Sees 8 sections
```

Opus dispatches Sonnet agents (via Claude Code's Agent tool) with targeted context:
```
Agent A: tandem_getTextContent({ section: "Executive Summary" })
// Reviews and annotates just that section

Agent B: tandem_getTextContent({ section: "Cost Summary" })
// Reviews cost figures, cross-references

Agent C: tandem_getTextContent({ section: "Issues and Risks" })
// Checks for completeness and specificity
```

Each agent uses `tandem_highlight`, `tandem_comment`, and `tandem_suggest` independently. All annotations appear in Bryan's browser in real-time. Opus monitors progress:

```
Opus: tandem_getAnnotations({ author: "claude", status: "pending" })
// Sees all annotations from all agents
```

## Keyboard Review Mode

**Setup:** Claude has finished reviewing and left 15+ annotations. Bryan wants to process them efficiently.

The browser's side panel shows all pending annotations with filter controls:
- Filter by type (highlights, comments, suggestions, questions)
- Filter by author (Claude, You)
- Filter by status (pending, accepted, dismissed)

Bryan clicks the **Review** button (or presses `Ctrl+Shift+R`) to enter keyboard review mode:

```
Tab       → Jump to next pending annotation (editor scrolls to it)
Shift+Tab → Previous annotation
Y         → Accept the current annotation
N         → Dismiss the current annotation
Escape    → Exit review mode
```

The side panel shows progress: "Reviewing 3 / 15". Each accepted suggestion applies its text change automatically.

When all annotations are resolved, a **Review Summary** overlay appears showing:
- Total reviewed, accepted count, dismissed count, accept rate

For bulk operations, use **Accept All** or **Dismiss All** buttons in the side panel header.

## Session Handoff

**What persists** across server restarts (via session persistence):
- Document content (Y.Doc state, restored on reopen)
- All annotations (stored in session file alongside Y.Doc state)
- File path, format, and metadata
- Multiple documents can each have their own session

**What doesn't persist:**
- Claude's awareness state (status text, focus paragraph)
- User awareness state (selection, typing indicator)
- Which documents were open (must reopen with `tandem_open`)

**How a new Claude session picks up:**

1. New Claude session starts, Tandem MCP server is already configured
2. Call `tandem_status()` to see open documents (`openDocuments` array)
3. If documents are open, call `tandem_listDocuments()` for full details
4. Call `tandem_getOutline()` on the active document to orient
5. Call `tandem_getAnnotations()` to see what was already reviewed
6. Continue where the previous session left off

**If the server restarted:**

1. Call `tandem_open()` with the same file path
2. If the source file hasn't changed, the session is restored (annotations preserved)
3. If the source file changed externally, a fresh load occurs (annotations may be stale)
4. Open additional documents with more `tandem_open()` calls -- each gets its own tab

**Tip:** Always `tandem_save()` before ending a session to persist edits to disk.

## Opening Files from the Browser

Users can open files without Claude Code using the browser UI:

### Path Input
1. Click the **+** button at the end of the tab bar
2. Enter the absolute file path in the text input
3. Click **Open** — the file loads in a new tab

### Drag-and-Drop
1. Drag a file from Windows Explorer (or Finder) onto the editor area
2. A dashed border appears as a drop indicator
3. Drop the file — it opens in a new tab

### File Upload
1. Click **+** → switch to **Upload** mode
2. Click the drop zone to browse, or drag a file onto it
3. The file content is sent to the server and loaded

**Note:** Uploaded files have no disk path — they use synthetic `upload://` paths and are always read-only. `tandem_save` on an uploaded file saves only the session (annotations), not the file content.

## Running E2E Tests

Playwright E2E tests verify the annotation lifecycle end-to-end (browser + server).

```bash
# Run all E2E tests (auto-starts servers)
npm run test:e2e

# Playwright UI mode for debugging
npm run test:e2e:ui
```

**Requirements:** No dev server running (the test harness starts its own via `dev:standalone`; `freePort()` will kill existing servers on :3478/:3479).

**How tests work:**
1. `beforeEach`: McpTestClient connects to MCP, fixture files copied to temp dir
2. Test body: MCP calls open documents/create annotations, Playwright asserts browser state
3. `afterEach`: All docs closed via MCP, temp dir cleaned up

Tests use `data-testid` attributes for reliable selectors (e.g. `[data-testid="accept-btn"]`). Timing uses Playwright's auto-waiting with 10s timeout for annotation sync (multi-hop: MCP → Y.Doc → Hocuspocus WS → browser → React → ProseMirror).
