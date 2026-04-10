# Workflows

> **Looking for browser UI help?** See the [User Guide](user-guide.md) for how to use the editor, annotations, chat, and keyboard shortcuts. This document covers Claude Code workflows with MCP tool examples.

Real-world patterns for using Tandem with Claude on toll consulting documents.

## Quick Start (Global Install)

**Setup:** First-time user installs Tandem globally and connects Claude.

```bash
npm install -g tandem-editor
tandem setup
```

`tandem setup` auto-detects Claude Code and Claude Desktop, writes MCP config, and installs a Claude Code skill with workflow guidance:
```
Tandem Setup

Detecting Claude installations...
  Found: Claude Code (~/.claude/mcp_settings.json)

Writing MCP configuration...
  ✓ Claude Code

Installing Claude Code skill...
  ✓ ~/.claude/skills/tandem/SKILL.md

Setup complete! Start Tandem with: tandem
Then in Claude, your tandem_* tools will be available.
```

The skill teaches Claude how to use Tandem's 30 MCP tools effectively — workflow patterns, annotation strategy, Solo/Tandem mode respect, and error recovery. It auto-activates when Claude detects `tandem_*` tools.

Start Tandem from any directory:
```bash
tandem
```

The server starts and the browser opens to `http://localhost:3479`. `sample/welcome.md` loads on first run with the onboarding tutorial.

In a separate terminal, open Claude Code with the channel flag for real-time push notifications:
```bash
claude --dangerously-load-development-channels server:tandem-channel
```

Then try:
```
"Review the welcome document with me"
```

Claude connects to the running Tandem server, opens the document, and begins reviewing. With the channel active, chat messages and annotation actions push to Claude instantly. Without it, Claude falls back to polling via `tandem_checkInbox`.

**After upgrading** (re-run setup to update the skill and MCP paths):
```bash
npm update -g tandem-editor
tandem setup    # re-writes MCP config with new paths
```

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
- Filter by type (highlights, comments, suggestions, questions, flags)
- Filter by author (Claude, You)
- Filter by status (pending, accepted, dismissed)

Bryan clicks the **Review** button (or presses `Ctrl+Shift+R`) to enter keyboard review mode:

```
Tab       → Jump to next pending annotation (editor scrolls to it)
Shift+Tab → Previous annotation
Y         → Accept the current annotation
N         → Dismiss the current annotation
Z         → Undo the last accept/dismiss (within 10-second window)
Escape    → Exit review mode
```

The side panel shows progress: "Reviewing 3 / 15". Each accepted suggestion applies its text change automatically. After accepting or dismissing, a 10-second undo window appears on the annotation card with an "Undo" link. For accepted suggestions, undo atomically reverts both the text edit and the annotation status.

When all annotations are resolved, a **Review Summary** overlay appears showing:
- Total reviewed, accepted count, dismissed count, accept rate

For bulk operations, use **Accept All** or **Dismiss All** buttons in the side panel header. These require a confirmation step before executing. When filters are active, bulk actions only affect the filtered annotations (e.g., "Accept 3 of 12 pending?").

### Solo / Tandem Mode

The toolbar includes a **Solo / Tandem** toggle that controls how Claude's annotations appear.

- **Tandem** (default) — Claude's annotations appear as they arrive.
- **Solo** — Claude's pending annotations are held back. Resolved annotations (accepted/dismissed) are always visible regardless of mode.

This lets Bryan control how aggressively Claude's output interrupts the editing flow. During focused writing, switch to Solo; when ready to review, switch to Tandem to release all held annotations at once.

## Reviewing a .docx with Imported Word Comments

**Setup:** Bryan receives a .docx file from a colleague that already contains Word comments. He wants Claude to review the document while seeing the existing comments.

```
Claude: tandem_open({ filePath: "C:\\Users\\bkolb\\...\\contract-review.docx" })
→ { documentId: "contract-review-x1y2z3", readOnly: true, format: "docx", ... }
```

The .docx opens in review-only mode. Word comments (`<w:comment>` elements) are automatically extracted and imported as Tandem annotations with `author: "import"`. Bryan sees them in the SidePanel alongside any new annotations Claude adds.

```
Claude: tandem_getAnnotations({ author: "import" })
→ { annotations: [
    { id: "ann_...", author: "import", type: "comment", content: "Please verify this figure", range: { from: 120, to: 135 } },
    { id: "ann_...", author: "import", type: "comment", content: "Legal needs to review this clause", range: { from: 890, to: 920 } }
  ], count: 2 }
```

Claude reads the imported comments and acts on them:

```
Claude: tandem_getContext({ from: 120, to: 135, documentId: "contract-review-x1y2z3" })
// Reads the context around the flagged figure

Claude: tandem_flag({
  from: 120, to: 135,
  note: "Imported comment flagged this figure. Cross-checked: the correct amount per Q3 report is $4.2M, not $3.8M.",
})
```

Bryan filters annotations by author in the SidePanel — "Imported" shows the original Word comments, "Claude" shows new findings. He can accept/dismiss both types using the same review workflow (Tab/Y/N/Z keys).

## Onboarding Tutorial (First Run)

**Setup:** First-time user launches Tandem with no restored sessions.

The server auto-opens `sample/welcome.md` and injects 3 tutorial annotations:
1. A **highlight** on the welcome heading — demonstrates visual markers
2. A **comment** on a paragraph — shows the annotation side panel
3. A **suggestion** with replacement text — introduces accept/reject workflow

A floating tutorial card appears at the bottom-left of the editor with three steps:

**Step 1: Review an annotation.** The card prompts the user to accept or dismiss one of the tutorial annotations. Clicking Accept or Dismiss on any annotation card (or using Y/N in keyboard review mode) completes this step.

**Step 2: Ask Claude a question.** The card prompts the user to select text and create an annotation (highlight, comment, or Ask Claude via Ctrl+Shift+A). Creating any user annotation completes this step.

**Step 3: Try editing.** The card prompts the user to click in the document and type something. Focusing the editor and making any keystroke completes this step.

After all three steps, the tutorial card disappears and doesn't return (persisted to localStorage). The tutorial is suppressed entirely if the user opened a different document or has completed it before.

## Editing Annotations After Creation

**Setup:** Claude left annotations during review, and the user (or Claude) wants to refine one without deleting and recreating it.

### Browser-Side Editing

Each pending annotation card shows a pencil (edit) button. Clicking it enters inline edit mode:

- **For highlights, comments, and flags:** A single textarea appears with the current note/text content.
- **For suggestions:** Two textareas appear — one for `newText` (the proposed replacement) and one for `reason` (the justification).

Click "Save" to apply the edit or "Cancel" to discard. The annotation card shows "(edited)" after saving, with the `editedAt` timestamp.

### Claude-Side Editing via MCP

Claude can edit its own annotations programmatically:

```
Claude: tandem_editAnnotation({
  id: "ann_1710936000000_a1b2c3",
  content: "Updated observation: This figure is correct per the March revision"
})
```

For suggestions, Claude can update the proposed text and reason separately:

```
Claude: tandem_editAnnotation({
  id: "ann_1710936000000_g7h8i9",
  newText: "$14.2 million",
  reason: "Corrected per Q4 financial report (was using Q3 figure)"
})
```

Only pending annotations can be edited — accepted or dismissed annotations are immutable.

## Session Handoff

**What persists** across server restarts (via session persistence):
- Document content (Y.Doc state, restored on reopen)
- All annotations (stored in session file alongside Y.Doc state)
- File path, format, and metadata
- Multiple documents can each have their own session

**What doesn't persist:**
- Claude's awareness state (status text, focus paragraph)
- User awareness state (selection, typing indicator)

**How a new Claude session picks up:**

1. New Claude session starts, Tandem MCP server is already configured
2. Call `tandem_status()` to see open documents (`openDocuments` array)
3. If documents are open, call `tandem_listDocuments()` for full details
4. Call `tandem_getOutline()` on the active document to orient
5. Call `tandem_getAnnotations()` to see what was already reviewed
6. Continue where the previous session left off

**If the server restarted:**

1. Previously-open documents are auto-restored on startup (no manual `tandem_open` needed)
2. Call `tandem_status()` to see which documents were restored
3. If the source file hasn't changed, the session is restored (annotations preserved)
4. If a source file was deleted from disk, the stale session is cleaned up automatically
5. Open additional documents with more `tandem_open()` calls -- each gets its own tab

**If a file changed on disk while already open (git pull, external editor):**

1. Call `tandem_open({ filePath: "...", force: true })` to reload from disk
2. The browser updates to show the new content automatically
3. Annotations and session state are cleared (they reference old positions)
4. `POST /api/open` also accepts `force: true` for browser-initiated reloads

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
