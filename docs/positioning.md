# Tandem — Positioning & Market Context

_Last updated: 2026-05-26_

> **Audience & monetization direction ([ADR-040](decisions.md#adr-040-audience-and-monetization-individuals-same-canvas-moat-free-beta-to-one-time-license)):** Tandem targets **individuals** working on their own documents — not institutions. The moat is the **same-canvas / no-copy-paste** review experience backed by **persistent, queryable annotations + the .docx review-record loop**. Monetization is **free during public beta → a one-time paid license at v1.0** (offline signed-license activation; beta users grandfathered). This document is being reframed to that direction; institutional roles below survive only as example *contexts*, not as the target buyer.

## What Tandem Is

Tandem lets you work on documents with an AI without the constant copy-paste. You open a document — an essay, a thesis chapter, a report, a contract you're reviewing, or anything else you write — highlight the text you want to discuss, and the AI sees it directly. The AI can suggest rewrites, leave comments, flag issues, and edit text alongside you. Because the AI connects through MCP, it brings all its knowledge, tools, and conversation context to the document — it's not working in isolation. The original file is never modified unless you say so.

The core value: **you point at text, the AI sees it, and you iterate together without leaving the document.**

> **Integration policy ([ADR-038](decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration)):**
>
> Tandem's integration contract is **MCP**. The default integration is **Claude** (Claude Code + Claude Desktop) — it's what we recommend, what we test against, and it ships with the channel push, cowork, plugin monitor, and auto-launcher features. Any MCP-capable client can connect to the same MCP HTTP endpoint and use the same 28 tools, but the Claude-specific transports don't apply. Other clients are **best-effort, MCP-contract-compatible, not validated** today.

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

This maps directly to how a huge amount of real document work actually happens: someone hands you a Word document, you review it, you send back comments. A grad student marking up an advisor's draft, a freelancer reviewing a client's brief, an analyst checking a colleague's report — the loop is the same. No one is building AI tooling for this round-trip today.

## The Market

Tandem is for **individuals** who write and review prose-heavy documents and want to do that work alongside an AI — not for institutions buying seats. The near-term reachable audience is who already runs an MCP-capable LLM **or a local model** (the 2026-06-11 [ADR-039](decisions.md#adr-039-non-mcp-model-providers-local-slice-v10-cloud-slice-v11) decision brings Ollama/LM Studio into v1.0 via Tandem's own loop — see [ADR-040](decisions.md#adr-040-audience-and-monetization-individuals-same-canvas-moat-free-beta-to-one-time-license) §1 note); we grow that audience by lowering setup friction, not by adding a hosted backend.

### Who this is

The same person shows up in many contexts. Tandem doesn't care which:

- **Writers and researchers** — drafting and self-editing essays, theses, articles, technical memos, proposals; wanting a second reader for tone and structure without pasting paragraphs into a chat window.
- **Knowledge workers reviewing prose** — someone hands you a report, a brief, or a deliverable and you mark it up. This is the same Word-comment round-trip whether the reviewer is a grad student, a freelancer, an analyst, or someone in a legal, compliance, or consulting role. Those roles are *example contexts* for the work, not the buyer — Tandem is bought by the individual doing it.
- **People working with AI-drafted text** — the AI wrote a draft and you need to read it critically and decide what to keep, in place, as addressable suggestions rather than a wall of regenerated text.

The underserved gap is **narrative document review** — proposals, reports, technical memos, theses — as opposed to contract review, which is well-served (Ironclad, Harvey, LegalOn). Thomson Reuters found 51% of legal professionals use AI for contract review but only 14% for general document review; that 14% gap generalizes well beyond legal.

### What they use today

Copy-paste into a chat window, or Word + Track Changes + email. A 2024 AIIM survey found 67% of organizations still route documents for review via email and 43% report "version confusion" as a regular problem — and the individual feeling that pain is the one Tandem helps. For AI specifically, the dominant workflow is still "select text → paste into ChatGPT/Claude → paste the answer back," which loses the document context on every hop.

Bluebeam Revu built a $300M+ business solving document review for PDFs in the architecture/engineering/construction market. There is no equivalent for the everyday .docx/Markdown review loop an individual runs.

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

The remaining distribution-friction risk is **downstream**, and was resolved in two same-day amendments (2026-06-11, canonical record in [ADR-039](decisions.md#adr-039-non-mcp-model-providers-local-slice-v10-cloud-slice-v11)): **local models (Ollama / LM Studio) ship in v1.0** (#1123 — a tool-use loop driving OpenAI-compatible local endpoints; gated on the M0 capability spike), while cloud BYO keys (OpenAI/Gemini API) arrive in v1.1. v1.0's reachable audience is therefore Claude users **plus anyone who can run a local model** — the zero-subscription stack (free local LLM + one-time license) that ADR-040 §2 leans on. The license applies identically with local models (no free tier implied). The desktop app's integration setup wizard (#477 PR 3, shipped) keeps the install path tractable for non-developers.

### Platform risk (medium)

Microsoft could add equivalent annotation features to Word Copilot within 12-18 months, and in-place AI editing with accept/reject is **already shipped** by ChatGPT Canvas, Claude artifacts (now MCP-connected), and `docx-mcp`. So in-place editing itself is no longer the differentiator. What survives is the durable wedge: a **persistent, addressable, queryable, exportable review record** that lives in your own files, runs **local-first with no cloud account**, and works with **whatever AI you bring** — an MCP-capable client like Claude, or (v1.0, #1123) a local model via Tandem's built-in loop — rather than one vendor's cloud. Canvas, artifacts, and docx-mcp do the editing; none of them give you that record. Invest there, not in raw editing (see [ADR-040](decisions.md#adr-040-audience-and-monetization-individuals-same-canvas-moat-free-beta-to-one-time-license) §2).

### MCP adoption (medium)

Tandem's architecture bets on MCP becoming a standard interface for AI tool use. Under ADR-038, MCP is **the contract** — not a Claude-specific transport. The mitigation has two layers:

- **If MCP adoption broadens** (Microsoft, OpenAI, others speaking MCP natively), Tandem benefits without changes — the same `:3479/mcp` endpoint serves any client.
- **If MCP adoption stalls**, Claude remains usable via Anthropic's continued MCP commitment, and non-MCP providers reach Tandem via the Agent SDK adapter (ADR-038 §3 — owned by a future ADR). Tandem isn't Claude-locked even in the bear case.

### Revenue model (decided — ADR-040)

The revenue question is now settled in [ADR-040](decisions.md#adr-040-audience-and-monetization-individuals-same-canvas-moat-free-beta-to-one-time-license). Tandem is **free during the public beta** and moves to a **one-time paid license at v1.0**, activated by an **offline Ed25519-signed license file** — no hosted offering, no subscription, no support-contract dependency, consistent with the local-first promise. A Merchant of Record (Polar.sh or Paddle) handles checkout and global tax; auto-updates within the license's renewal window are served by a small license-checked endpoint. Existing beta users are grandfathered with a free license; new users pay. Pricing is set low (~$29–79) so paying beats building from source. Revenue is expected to be modest, and that is an accepted risk (full commitment, no kill-criterion) — see ADR-040 §3 and the licensing-change prerequisite in §5.

## Positioning Summary

**Don't say:** "Collaborative AI editor" (invites comparison with Google Docs)
**Don't say:** "AI writing assistant" (crowded, undifferentiated)

**Do say:** "Work on documents with your AI — no more copy-paste"
**Do say:** "Your full Claude — or any MCP-capable AI you bring, or a local model — just now it can see and edit your document too"
**Do say:** "Point at text, the AI sees it, iterate together"

The narrower and more specific the positioning, the stronger it is. The broadest defensible claim: **Tandem is the first tool that connects your full AI to your document via MCP, so you iterate on text together without copy-paste — and the AI's suggestions are first-class, addressable, persistent objects you can accept, dismiss, and converse about.**
