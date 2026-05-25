---
id: concept-origin-contract
type: concept
name: Origin contract (5 tags)
last_verified: 2026-05-25
sources:
  - src/shared/origins.ts
  - .claude/hooks/check-raw-transact.sh
  - scripts/audit-origins.ts
  - docs/decisions.md#adr-031-origin-tagged-transaction-wrappers
---

# Origin contract

Every Y.Doc write is tagged with one of five origin values: `mcp`, `file-sync`, `internal`, `reload`, `browser`. Observers (channel events, durable-annotation sync, tombstone ledger) inspect the origin to decide whether to react. Picking the wrong wrapper is a silent bug — the wrapper choice IS the contract.

| Origin     | Channel events | Durable-sync | Tombstones |
|------------|----------------|--------------|------------|
| `mcp`      | skip           | persist      | record     |
| `file-sync`| skip           | skip         | skip       |
| `internal` | skip           | skip         | skip       |
| `reload`   | skip           | persist      | record     |
| `browser`  | **emit**       | persist      | record     |

Only `browser` writes emit channel events — this is how the channel shim distinguishes "user did something" from server-internal noise.

Wrapper helpers in `src/shared/origins.ts`:
- `withMcp` — Claude-initiated writes from MCP tool handlers
- `withFileSync` — echoes from the durable-annotation file-writer
- `withInternal` — session restore, mdast/docx population, tutorial seeding, scratchpad seeding, force-reload, server metadata broadcasts
- `withReload` — file-watcher `reloadFromDisk` flow (origin distinct from `file-sync` so durable-sync persists re-anchored relRanges)
- `withBrowser` — user edits from the browser

Raw `doc.transact(...)` should not appear anywhere in `src/`; the rule is surfaced by the warn-only PostToolUse hook `.claude/hooks/check-raw-transact.sh` and the `npm run audit:origins` static walk (no blocking pre-commit hook or Biome AST rule is wired). Test-only synthetic Y.Docs use `transactForTest` (sentinel origin `"test"`, allowlisted).
