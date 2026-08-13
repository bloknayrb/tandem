# Integrations

Which AI clients connect to Tandem, how, and what the MCP surface exposes. For setting one up, see
[Install](../README.md#install) in the README — the in-app wizard does the configuration.

## The MCP integration policy

The [Model Context Protocol](https://modelcontextprotocol.io) (MCP) is an open standard for AI clients to talk to tools and data sources. Tandem exposes its document and annotation surface over MCP, which is how AI clients like Claude read and modify the file you are editing.

The integration policy is set by [ADR-038](decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration):

> Tandem's integration contract is **MCP**. The default integration is **Claude** (Claude Code + Claude Desktop) — it's what we recommend, what we test against, and it ships with the channel push, cowork, plugin monitor, and auto-launcher features. Any MCP-capable client can connect to the same MCP HTTP endpoint and use the same MCP tools, but the Claude-specific transports don't apply. Other clients are **best-effort, MCP-contract-compatible, not validated** today.
>
> **Integration setup** runs through the integration setup wizard (#477 PR 3). The earlier transitional behavior — Tandem auto-writing its MCP entry to Claude's config files on Tauri startup — was **removed in #477 PR 3c-ii-c**. Every integration (Claude included) is now configured via the wizard, never silently; `tandem setup --apply` is the scriptable non-interactive equivalent.

Client compatibility:

| AI surface | Status |
|---|---|
| **Claude Code** (local CLI) | Default. Validated. Channel push supported. |
| **Claude Desktop** (local app) | Supported via the [Cowork plugin bridge](../README.md#cowork) (Windows today). Request/response only — channel push N/A. |
| **claude.ai web chat** | Not supported. Would require exposing the local server publicly via a tunnel, which is outside scope. |
| **Other MCP-capable clients** (Cursor, Continue.dev, LM Studio, Ollama, …) | Best-effort, MCP-contract-compatible, not validated. |
| **Non-MCP AIs** | Not supported today. **Local models** (Ollama / LM Studio via OpenAI-compatible endpoints) are committed for v1.0 ([ADR-039](decisions.md#adr-039-non-mcp-model-providers-local-slice-v10-cloud-slice-v11), tracked in #1123); cloud providers (ChatGPT direct, Gemini direct) follow in v1.1. |

## MCP tools at a glance

Tandem's MCP tools span six capability areas. Full reference: [docs/mcp-tools.md](mcp-tools.md).

- **Document.** Open, switch, list, close, rename, and convert documents; read text content and outlines; edit text ranges; append content; save back to disk.
- **Annotation.** Create, resolve, remove, and edit annotations and replies; query the annotation list; export a review report.
- **Apply.** Write accepted suggestions into a `.docx` as Word tracked changes, and restore a document from a pre-write snapshot.
- **Navigation.** Search the document, resolve a match to a range, and pull surrounding context.
- **Awareness.** Read user presence and Solo/Tandem mode; check the inbox for selection events, chat messages, and annotation actions; reply in the chat sidebar.
- **Diagnostics.** Report connection and boot health over MCP itself, so a client that can't reach loopback can still self-diagnose.

## Real-time push

The Claude-specific push transports — the self-armed watch, the plugin monitor, and the channel
shim — are described in [Real-time updates](../README.md#real-time-updates) in the README. Other MCP
clients pull with `tandem_checkInbox`, which is authoritative for every client regardless of which
push route is active.
