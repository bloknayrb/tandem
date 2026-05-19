---
id: rule-stdout-reserved
type: rule
name: stdout is reserved (stdio MCP)
last_verified: 2026-05-18
sources:
  - src/server/index.ts
  - .claude/hooks/check-console-log.sh
---

# Rule: stdout is reserved

`console.log`, `console.warn`, `console.info` all redirect to stderr in `src/server/index.ts` as defense-in-depth for the MCP stdio transport. Any byte written to stdout that isn't a valid JSON-RPC frame corrupts the wire and disconnects Claude.

**Why this matters:** stdio MCP uses stdin/stdout for the protocol. A single `console.log("debug")` from a dependency will break the session — and the failure looks like "MCP just dropped" rather than "your log line was misinterpreted as a frame."

**Enforced by:**
- Process-level redirect in `src/server/index.ts` (catches application code)
- Hook `.claude/hooks/check-console-log.sh` warns on `console.log()` introductions in `src/server/`

**Applies to:** any new dependency added to the server bundle. If a dep logs to stdout, it bypasses the redirect (already in the dep) — vet noisy deps before adding.
