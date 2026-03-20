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

## Cross-Referencing an Invoice

**Setup:** Bryan needs to verify that an invoice matches the work described in a progress report.

```
Claude: tandem_open({ filePath: "C:\\Users\\bkolb\\...\\progress-report-feb.md" })
```

Claude searches for dollar figures across the document:

```
Claude: tandem_search({ query: "\\$[\\d,.]+", regex: true })
→ { matches: [
    { from: 342, to: 355, text: "$13.1 million" },
    { from: 487, to: 498, text: "$2.4 million" },
    { from: 612, to: 621, text: "$847,000" }
  ]}
```

Claude highlights each figure with status:

```
// Matches invoice
Claude: tandem_highlight({ from: 342, to: 355, color: "green", note: "Matches invoice line 12" })

// Discrepancy found
Claude: tandem_highlight({ from: 487, to: 498, color: "red", note: "Invoice shows $2.6M -- $200K discrepancy" })

// Not in invoice
Claude: tandem_highlight({ from: 612, to: 621, color: "yellow", note: "Not found in invoice -- verify" })
```

Bryan sees green/red/yellow highlights throughout the document. Claude adds a summary comment:

```
Claude: tandem_comment({
  from: 0, to: 40,
  text: "Invoice cross-reference: 1 match, 1 discrepancy ($200K on labor), 1 item not in invoice."
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

## Session Handoff

**What persists** when the Tandem server is running:
- Document content (in Y.Doc, synced via Hocuspocus)
- All annotations (in Y.Map on the Y.Doc)
- File path and format metadata

**What doesn't persist** across server restarts:
- Claude's awareness state (status text, focus paragraph)
- User awareness state (selection, typing indicator)
- Browser-open tracking (will reopen on next `tandem_open`)

**How a new Claude session picks up:**

1. New Claude session starts, Tandem MCP server is already configured
2. Call `tandem_status()` to check if a document is open
3. If open, call `tandem_getOutline()` to orient
4. Call `tandem_getAnnotations()` to see what was already reviewed
5. Continue where the previous session left off

**If the server restarted:**

1. Call `tandem_open()` with the same file path
2. Document reloads from disk (any unsaved Tandem edits are lost)
3. Annotations from the previous session are gone (session persistence planned for a future step)
4. Start fresh review

**Tip:** Always `tandem_save()` before ending a session to persist edits to disk.
