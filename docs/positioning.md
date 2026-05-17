# Tandem — Positioning & Market Context

_Last updated: 2026-05-17_

## What Tandem Is

Tandem lets you work on documents with an AI without the constant copy-paste. You open a document — a progress report, an RFP response, a compliance filing — highlight the text you want to discuss, and the AI sees it directly. The AI can suggest rewrites, leave comments, flag issues, and edit text alongside you. Because the AI connects through MCP, it brings all its knowledge, tools, and conversation context to the document — it's not working in isolation. The original file is never modified unless you say so.

The core value: **you point at text, the AI sees it, and you iterate together without leaving the document.**

> **Integration policy ([ADR-038](decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration)):**
>
> Tandem's integration contract is **MCP**. The default integration is **Claude** (Claude Code + Claude Desktop) — it's what we recommend, what we test against, and it ships with the channel push, cowork, plugin monitor, and auto-launcher features. Any MCP-capable client can connect to the same MCP HTTP endpoint and use the same 26 tools, but the Claude-specific transports don't apply. Other clients are **best-effort, MCP-contract-compatible, not validated** today.

## What Makes It Different

Most AI document tools are either writing assistants (generate content for you) or chat interfaces (you paste text in, get text back). Tandem is an **iteration surface** — you and the AI both see the document, and you work on it together without copy-paste. The AI can review what's there, help you rewrite it, or draft new content, all without either of you leaving your surface.

### The annotation model

Tandem's core differentiator is that AI suggestions are **first-class data objects**, not ephemeral UI. Each annotation (highlight, comment — including suggestions and questions — and flag) is:

- **Addressable** — stored in a Y.Map with a unique ID
- **Typed** — highlight, comment, or flag, with comments supporting replacement suggestions and directed questions as variants
- **Attributable** — author field tracks who created it (Claude or user)
- **Resolvable** — user accepts or dismisses each one individually
- **Queryable** — user can ask Claude about specific annotations via "Ask Claude"
- **Persistent** — survives server restarts via session persistence
- **Exportable** — `tandem_exportAnnotations` outputs a structured review report

No shipping product does this today. Word Copilot generates rewrite suggestions, but they're ephemeral sidebar content. Google Docs' "Help me write" is prompt-response. Grammarly's suggestions are confidence scores, not objects you can converse about. The only product with a comparable model is GitHub Copilot's PR review comments — but that's code-only.

### The presence model

The AI has a cursor, a status indicator, and awareness of what the user is doing (Claude, in the default integration; the cursor label is settable by any MCP client that wires it up). It's not a button in a toolbar that you invoke — it's a collaborator in the session. The user can see when the AI is reading, what paragraph it's focused on, and what its current status is. This is built on Yjs/Hocuspocus CRDT collaboration, the same infrastructure that powers real-time multi-user editing in tools like Notion and Figma.

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

### Distribution (medium — narrowed by ADR-038)

**Resolved at the architectural level by [ADR-038](decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration) (2026-05-17).** Tandem's integration contract is MCP, not Claude Code specifically. Claude remains the default integration because that's the deepest-supported path (channel push, cowork, plugin monitor, auto-launcher), but the architecture is no longer Claude-locked.

The remaining distribution-friction risk is **downstream**: whether multi-provider parity (Anthropic + OpenAI + Gemini + local LLMs via the Agent SDK adapter, per ADR-038 §3) ships in time for v1.0 and whether the desktop app's integration setup wizard (#477 PR 3) makes the install path tractable for non-developers. Both are tracked items, not architectural unknowns.

### Platform risk (medium)

Microsoft could add equivalent annotation features to Word Copilot within 12-18 months. Word already has the Track Changes data model. If Copilot starts writing AI-reasoned suggestions into that model with "ask why" capability, the general-purpose differentiation collapses. The .docx-without-cloud and compliance angles would survive because they're distribution plays, not feature plays.

### MCP adoption (medium)

Tandem's architecture bets on MCP becoming a standard interface for AI tool use. Under ADR-038, MCP is **the contract** — not a Claude-specific transport. The mitigation has two layers:

- **If MCP adoption broadens** (Microsoft, OpenAI, others speaking MCP natively), Tandem benefits without changes — the same `:3479/mcp` endpoint serves any client.
- **If MCP adoption stalls**, Claude remains usable via Anthropic's continued MCP commitment, and non-MCP providers reach Tandem via the Agent SDK adapter (ADR-038 §3 — owned by a future ADR). Tandem isn't Claude-locked even in the bear case.

### Open source economics (low-medium)

The compliance and commercial use cases that would pay for this tool require either a hosted offering or a support contract. An open-source project competing on features with well-funded incumbents without a revenue model doesn't survive long enough to matter. This needs a decision before the tool reaches maturity.

## Positioning Summary

**Don't say:** "Collaborative AI editor" (invites comparison with Google Docs)
**Don't say:** "AI writing assistant" (crowded, undifferentiated)

**Do say:** "Work on documents with your AI — no more copy-paste"
**Do say:** "Your full Claude — or any MCP-capable AI you bring — just now it can see and edit your document too"
**Do say:** "Point at text, the AI sees it, iterate together"

The narrower and more specific the positioning, the stronger it is. The broadest defensible claim: **Tandem is the first tool that connects your full AI to your document via MCP, so you iterate on text together without copy-paste — and the AI's suggestions are first-class, addressable, persistent objects you can accept, dismiss, and converse about.**
