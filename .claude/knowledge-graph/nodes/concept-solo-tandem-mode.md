---
id: concept-solo-tandem-mode
type: concept
name: Solo / Tandem mode
last_verified: 2026-05-18
sources:
  - src/server/mcp/awareness.ts
  - src/shared/constants.ts
---

# Solo / Tandem mode

A single boolean (`"solo" | "tandem"`) that tells Claude whether the user is currently collaborating or working alone. Returned by `tandem_status` and `tandem_checkInbox` so MCP handlers can adapt — in Solo mode, Claude holds annotations rather than surfacing them.

Stored **once globally**, not per-document: under `CTRL_ROOM`'s `Y_MAP_USER_AWARENESS` map at key `Y_MAP_MODE`. Mode changes broadcast to all open documents.

The two-mode design replaced an earlier per-document setting; storing in `CTRL_ROOM` means a single UI toggle covers every tab.
