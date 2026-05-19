---
id: concept-channel-events
type: concept
name: Channel events (push)
last_verified: 2026-05-18
sources:
  - src/server/events/
  - src/channel/
  - docs/decisions.md#adr-019-channel-shim-for-push-notifications-issue-106--claude-default-integration
---

# Channel events

Server-Sent Events stream from the server to Claude Code via the channel shim, replacing polling. The shim uses the low-level MCP `Server` class (not `McpServer`) because the Channels spec requires explicit `setRequestHandler()` wiring.

Event emission is **gated by origin** (see `concept-origin-contract`): only `browser`-origin writes emit channel events. Internal-purpose origins (`mcp`, `file-sync`, `internal`, `reload`) skip the event queue, so Claude's own writes don't echo back as user events.

**Meta keys use underscores only.** The Channels API silently drops meta keys containing hyphens. Use `document_id`, `annotation_id`, `event_type` — never `document-id`. This is a real footgun documented in lessons-learned.

The channel shim is the *default* integration with Claude per ADR-038 (MCP-first policy); REST polling is the fallback.
