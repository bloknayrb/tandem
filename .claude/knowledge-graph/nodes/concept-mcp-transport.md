---
id: concept-mcp-transport
type: concept
name: MCP transport (HTTP + stdio)
last_verified: 2026-05-18
sources:
  - src/server/mcp/server.ts
  - docs/decisions.md#adr-012-streamable-http-transport-replacing-stdio
  - docs/decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration
---

# MCP transport

Two transports for the same tool surface:
- **HTTP** (default): port 3479, used by the Tauri desktop app and standalone `dev:server`. Tools register in `createMcpServer()`.
- **stdio**: used by the deprecated browser-distribution sidecar and CI smoke tests.

**stdout is reserved in stdio mode** (`rule-stdout-reserved`). `console.log/warn/info` redirect to stderr in `index.ts` as defense-in-depth — a dependency that logs to stdout will corrupt the wire.

**MCP must start before Hocuspocus in stdio mode** — the init timeout fires if the order is reversed. HTTP mode doesn't have this ordering constraint.

Tool registration is split across 5 files: `document.ts` (11 tools), `annotations.ts` (10), `navigation.ts` (3), `awareness.ts` (3), `docx-apply.ts` (2). The tool count is snapshotted at startup from `_registeredTools` (private SDK field) and exposed via `/api/info`.

ADR-038 establishes MCP as the default integration; the channel shim is the push transport on top.
