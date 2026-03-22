# Tandem — Positioning & Market Context

_Last updated: 2026-03-21_

## What Tandem Is

Tandem is an AI-powered document review tool. You open a document — a progress report, an RFP response, a compliance filing — and Claude reviews it alongside you in real time. Claude highlights issues, leaves comments, suggests rewrites. You accept, dismiss, or ask follow-up questions. The original file is never modified unless you say so.

The closest analogy: **what GitHub Copilot code review is for pull requests, Tandem is for documents.**

## What Makes It Different

Most AI document tools are writing assistants — they help you produce content. Tandem is a **review assistant** — it helps you evaluate content someone else wrote. That's a different workflow, a different user, and a different product.

### The annotation model

Tandem's core differentiator is that AI suggestions are **first-class data objects**, not ephemeral UI. Each annotation (highlight, comment, suggestion, question) is:

- **Addressable** — stored in a Y.Map with a unique ID
- **Typed** — highlight, comment, suggestion, or question, each with distinct visual treatment
- **Attributable** — author field tracks who created it (Claude or user)
- **Resolvable** — user accepts or dismisses each one individually
- **Queryable** — user can ask Claude about specific annotations via "Ask Claude"
- **Persistent** — survives server restarts via session persistence
- **Exportable** — `tandem_exportAnnotations` outputs a structured review report

No shipping product does this today. Word Copilot generates rewrite suggestions, but they're ephemeral sidebar content. Google Docs' "Help me write" is prompt-response. Grammarly's suggestions are confidence scores, not objects you can converse about. The only product with a comparable model is GitHub Copilot's PR review comments — but that's code-only.

### The presence model

Claude has a cursor, a status indicator, and awareness of what the user is doing. It's not a button in a toolbar that you invoke — it's a collaborator in the session. The user can see when Claude is reading, what paragraph Claude is focused on, and what Claude's current status is. This is built on Yjs/Hocuspocus CRDT collaboration, the same infrastructure that powers real-time multi-user editing in tools like Notion and Figma.

### The .docx review workflow

Tandem opens .docx files in review-only mode via mammoth.js. The original file is never modified. Claude annotates the content. The user accepts or dismisses annotations. Session persistence preserves annotations across restarts. `tandem_exportAnnotations` outputs a Markdown review report.

This maps directly to how government agencies, consultancies, and compliance teams actually work: receive a Word document, review it, send back comments. No one is building AI tooling for this workflow today.

## The Market

### Who reviews documents today

- **Government agencies** (toll authorities, DOTs, transit agencies) review contractor-submitted progress reports, invoices, and compliance filings. The workflow is: download .docx from SharePoint, open in Word, use Track Changes, email comments back. Pain points: comment consolidation across multiple reviewers, no AI assistance, 14-day review windows with no tooling support.

- **Legal teams** review contracts, but that market is well-served (Ironclad, Harvey, LegalOn). What's underserved is **narrative document review** — progress reports, proposals, technical memos. Thomson Reuters found that 51% of legal professionals use AI for contract review but only 14% for general document review.

- **Compliance teams** review documents against standards (SOC 2, regulatory requirements, internal policies). The annotation model maps naturally to compliance checklists — each annotation is a finding against a rule.

- **Consultancies** review client deliverables, peer-review reports, and QA submissions. The "comment merge problem" (multiple reviewers marking up the same document independently) is a top pain point with no good solution.

### What they use today

Word + email + SharePoint. That's it. A 2024 AIIM survey found 67% of organizations still route documents for review via email. 43% report "version confusion" as a regular problem. SharePoint's review/approval workflow is universally described as difficult to configure and abandoned in favor of email.

Bluebeam Revu built a $300M+ business solving the document review problem for PDFs in the architecture/engineering/construction market. There is no equivalent for .docx review workflows.

### AI adoption in document review

Near-zero outside legal contracts and e-discovery. The Gartner 2024 Hype Cycle places "AI document review beyond contracts" at "Innovation Trigger" — early, unproven, wide open.

## Competitive Landscape

| Tool | Model | Annotations? | Persistent? | .docx? | Review-focused? |
|------|-------|-------------|------------|--------|----------------|
| Word Copilot | Sidebar chat + batch rewrite | Ephemeral suggestions | No | Native | Partial |
| Google Docs Gemini | Sidebar chat + "Help me write" | No | No | Import only | No (writing) |
| Notion AI | Block-level actions | No | No | No | No (writing) |
| Grammarly | Overlay suggestions | Inline, not addressable | No | Via overlay | Style only |
| GitHub Copilot | PR review comments | Yes — first-class | Yes | No (code) | Yes (code) |
| LegalOn / Harvey | Batch contract review | Structured findings | Export only | Yes | Yes (contracts) |
| **Tandem** | **Live CRDT collaboration** | **Yes — first-class** | **Yes** | **Review-only** | **Yes (prose)** |

## Risks

### Distribution (high)

Tandem currently requires Claude Code, which gates the audience to developers and technical users. The agency reviewers and compliance officers who'd pay for this tool can't install it today. The architecture decision — whether Tandem stays a Claude Code extension or becomes a standalone web app with a Claude API backend — is the highest-leverage product decision not yet made.

### Platform risk (medium)

Microsoft could add equivalent annotation features to Word Copilot within 12-18 months. Word already has the Track Changes data model. If Copilot starts writing AI-reasoned suggestions into that model with "ask why" capability, the general-purpose differentiation collapses. The .docx-without-cloud and compliance angles would survive because they're distribution plays, not feature plays.

### MCP adoption (medium)

Tandem's architecture bets on MCP becoming a standard interface for AI tool use. If MCP remains Anthropic-specific or loses momentum, the "Claude Code extension" positioning becomes a ceiling. The mitigation is that MCP's technical design is sound, Microsoft and others have signaled interest, and the architecture could be ported to direct API calls if needed.

### Open source economics (low-medium)

The compliance and commercial use cases that would pay for this tool require either a hosted offering or a support contract. An open-source project competing on features with well-funded incumbents without a revenue model doesn't survive long enough to matter. This needs a decision before the tool reaches maturity.

## Positioning Summary

**Don't say:** "Collaborative AI editor" (invites comparison with Google Docs)
**Don't say:** "AI writing assistant" (crowded, undifferentiated)

**Do say:** "AI document reviewer" — like having a junior analyst review your reports
**Do say:** "What GitHub Copilot code review is for pull requests, Tandem is for documents"
**Do say:** "Open a Word doc, get AI annotations without touching the original"

The narrower and more specific the positioning, the stronger it is. The broadest defensible claim: **Tandem is the first tool that treats AI document suggestions as first-class, addressable, persistent objects that users can accept, dismiss, and converse about.**
