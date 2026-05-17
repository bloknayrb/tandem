# PR 1 description (ready to use when pushing after #697 merges)

## Title

```
feat(origins): origin-tagged transaction wrappers (ADR-031)
```

## Body

```markdown
## Summary

Implements **ADR-031**: replace direct `doc.transact(...)` with five free-function helpers in `src/shared/origins.ts` — `withMcp`, `withFileSync`, `withInternal`, `withReload`, `withBrowser`. Every Y.Doc write — server-side and browser-side — now goes through one of the helpers. Raw `*.transact(` outside the helpers file is flagged by `.claude/hooks/check-raw-transact.sh`.

Skip-set matrix (channel / durable-sync / tombstone observers) is enforced via predicates `shouldSkipChannel` / `shouldSkipDurableSync` / `shouldSkipTombstone` instead of inline origin equality. The migration also widens skip sets to match the ADR contract: channel observers now skip `internal` and `reload` in addition to `mcp` and `file-sync`; the durable-sync observer skips `internal` in addition to `file-sync`.

Closes the silent-bug class where untagged setup writes (session restore, file population, tutorial seeding, server-internal metadata broadcasts, cleanup-after-failure paths, force-reload) compiled fine and avoided observer echo only by coincidence.

## Commit sequence (review in order)

1. **`feat(origins): introduce 5 origin-tagged transaction wrappers`** — `src/shared/origins.ts` foundation: constants, helpers, skip-set predicates, `transactForTest`. Unit tests at `tests/shared/origins.test.ts`. `src/server/events/origins.ts` becomes a thin re-export for migration-window compatibility (PR 9 cleanup deletes it).
2. **`refactor(origins): widen observer skip-sets via shared/origins predicates`** — every channel observer (annotations / awareness / ctrl-chat / ctrl-meta / replies) and the durable-sync observer migrates from inline `txn.origin === MCP_ORIGIN || txn.origin === FILE_SYNC_ORIGIN` checks to `shouldSkipChannel(txn.origin)` / `shouldSkipDurableSync(txn.origin)`. The merge transact in `loadAndMerge` becomes `withFileSync`. **Behaviour today is unchanged** — `internal` / `reload` origins don't exist until callsites migrate in subsequent commits.
3. **`refactor(origins): migrate small-fanin callsites`** — positions (`refreshAllRanges` → `withMcp`), session manager chat-prune (→ `withInternal`), `injectCommentsAsAnnotations` (→ `withInternal`), tutorial seeding (→ `withInternal`).
4. **`refactor(origins): migrate mcp/ callsites`** — annotations, awareness, channel-routes, document, document-service. `addReplyToAnnotation`'s `origin?: string` parameter is replaced with `wrap: (doc, fn) => void` defaulting to `withBrowser`; MCP caller passes `withMcp`. `document-service.ts` metadata broadcasts (open-docs list, generationId, store readOnly) migrate from "MCP_ORIGIN as a skip-set hack" to the structurally correct `withInternal`.
5. **`refactor(origins): migrate file-opener + browser highlight-toggle`** — 10 callsites in file-opener: read-only meta → `withMcp`, populate + clear-and-reload + cleanup-after-failure → `withInternal`, `evictPartialDocState` → `withFileSync`, `reloadFromDisk` (both transacts) → `withReload`, saved baseline + doc metadata → `withMcp`. Client highlight-toggle → `withBrowser`. Test assertions updated to match the new origin sequence; `tests/server/reload-from-disk-persistence.test.ts`'s "mimic durable-sync observer" now uses `shouldSkipDurableSync` instead of inline `FILE_SYNC_ORIGIN` equality.
6. **`chore(hooks): add check-raw-transact.sh PostToolUse hook`** — informational stderr warning when a new raw `*.transact(` is introduced in `src/` outside the helpers file. Allowlist: `src/shared/origins.ts`, `**/*.test.ts`, `**/*.spec.ts`.
7. **`chore(agents): teach reviewers the ADR-031 five-origin model`** — `annotation-model-reviewer.md` and `crdt-reviewer.md` prompts reference the helpers, the skip-set matrix, and the hook. The old "every transact must pass `MCP_ORIGIN`" rule (now wrong post-migration) is replaced.

## Test plan

- [x] `npm test` — **2125 tests pass** (4 skipped). Full vitest suite across server + client.
- [x] `npm run typecheck` — clean. No errors / warnings.
- [x] Origin helper unit tests (`tests/shared/origins.test.ts`) — 10/10 pass.
- [x] Per-file regression: `tests/server/annotations/sync.test.ts`, `tests/server/event-queue.test.ts`, `tests/server/reload-from-disk-persistence.test.ts`, `tests/server/file-opener-transact-batching.test.ts`, `tests/server/file-opener-cleanup-on-failure.test.ts`, `tests/server/docx-comments.test.ts`, `tests/server/annotation-replies.test.ts` — all green.
- [x] `grep -nE "(transact\(.*MCP_ORIGIN|transact\(.*FILE_SYNC_ORIGIN)" src/` — only doc-comment hits remain (cleaned up in PR 9 alongside the re-export shim).
- [ ] **Manual smoke** — open a `.md` file, accept/dismiss a Claude comment, write a chat message, modify a file on disk to trigger reload — verify channel events fire only for browser-origin writes (use `tandem_checkInbox` to confirm). _Pending Bryan's manual verification._

## What this PR does NOT do

- Does not delete `src/server/events/origins.ts` — kept as a thin re-export for the migration window. **PR 9** (shim cleanup) deletes it after PR 6 lands.
- Does not add the Biome AST rule for dynamic-dispatch bypass detection (`doc["trans" + "act"](...)`). Tracked for a follow-up — the grep-based hook catches the common case.
- Does not migrate `MCP_ORIGIN` / `FILE_SYNC_ORIGIN` mentions in doc comments — PR 9 sweeps those.

Refs ADR-031 (in #697).
```
