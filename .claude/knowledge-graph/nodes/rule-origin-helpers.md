---
id: rule-origin-helpers
type: rule
name: Origin-tag every Y.Doc write
last_verified: 2026-05-18
sources:
  - src/shared/origins.ts
  - .claude/hooks/check-raw-transact.sh
  - scripts/audit-origins.ts
  - docs/decisions.md#adr-031-origin-tagged-transaction-wrappers
---

# Rule: Origin-tag every Y.Doc write

Raw `doc.transact(...)` is forbidden anywhere in `src/`. Every write must go through one of the five wrappers in `src/shared/origins.ts`: `withMcp`, `withFileSync`, `withInternal`, `withReload`, `withBrowser`. See `concept-origin-contract` for the decision table.

**Why this matters:** the origin determines which observers react (channel events, durable-sync, tombstone ledger). Picking the wrong wrapper is a silent bug — no exception thrown, just the wrong side-effects (or no side-effects).

**Enforced by (all warn-only as of 2026-05-18):**
- PostToolUse hook `.claude/hooks/check-raw-transact.sh` — warns on stderr during Claude Code edits
- `npm run audit:origins` — static TS-compiler walk; warn-only finding list
- Test-only synthetic Y.Docs allowed via `transactForTest` (sentinel origin `"test"`)

**Drift note:** `CLAUDE.md` and ADR-031 prose describe this as "pre-commit hook blocks" with a "Biome AST rule." Neither is currently wired — lint-staged runs eslint/biome/check-tokens only. The warn surface is real and effective but stronger language in the docs overstates the guardrail. Flag for separate cleanup.

**How to choose:** see the worked-example table in `src/shared/origins.ts` and `adr-031`. Short version: ask "what should happen?" — if Claude initiated it (MCP handler) use `withMcp`; if a file-watcher reload use `withReload`; if startup/seeding/cleanup use `withInternal`; if a user did it in the browser use `withBrowser`; if it's an echo from the file-writer use `withFileSync`.
