# Tandem hook scripts

Wired in `.claude/settings.json`. Each script's purpose is documented in its first 2-3 comment lines (`head -3 *.sh` reveals all of them at once).

**Hook semantics:**
- `PreToolUse` hooks exit `2` to block the tool call.
- `PostToolUse` hooks exit `0` (warnings only — they emit to stderr but never block).
- Workflow-nudge hooks emit stderr and never block.
- Per-session state lives in `.claude/.workflow-state/<session_id>/` (gitignored, pruned at SessionStart after 7 days via `sessionstart-prune-state.sh`).

## Inventory (18 scripts)

### Shared / helper

- **`_workflow-state.sh`** — Shared helpers for workflow-nudge hooks. Sourced, not executed.

### SessionStart

- **`sessionstart-prune-state.sh`** — Prunes workflow-state directories older than 7 days.

### PreToolUse — `Edit|Write` matcher

- **`block-sensitive.sh`** — Blocks edits to `.env`, lock files, and other sensitive paths. Exits 2 on match.
- **`nudge-plan-review.sh`** — Warns when a `.claude/plans/*.md` was written this session but no `Agent` tool has run before a source edit. One-shot per plan.

### PreToolUse — `Bash` matcher

- **`block-no-verify.sh`** — Blocks `--no-verify` flag (Husky bypass). Fail-closed on parse error.
- **`nudge-simplify-before-commit.sh`** — Warns on `git commit` when source edits have happened since last `/simplify`. One-shot per edit batch.

### PostToolUse — unmatched (every tool)

- **`track-workflow-events.sh`** — Records markers used by nudge hooks: `last-plan-write`, `last-source-edit`, `last-agent-call`, `last-simplify`, `last-commit`. Clears `stop-nudged` marker on successful commit so the stop reminder can re-fire after the next edit cycle. Fast-paths uninteresting tools to skip the node spawn.

### PostToolUse — `Edit|Write` matcher

- **`typecheck-on-edit.sh`** — Runs `tsc --noEmit` after `.ts`/`.tsx` edits. Uses the appropriate tsconfig based on file path.
- **`svelte-check-on-edit.sh`** — Runs `svelte-check` after `.svelte` edits. Opt-out: `TANDEM_SKIP_SVELTE_CHECK=1`.
- **`format-on-edit.sh`** — Runs Biome format on edited files.
- **`related-test.sh`** — Runs matching vitest after source edits. Maps `src/{area}/` to `tests/{area}/` via basename matching. Opt-out: `TANDEM_SKIP_RELATED_TEST=1`.
- **`check-console-log.sh`** — Warns on `console.log()` in `src/server/` (Critical Rule #3 — stdout is reserved for the MCP wire).
- **`check-extract-markdown.sh`** — Warns on `extractMarkdown()` usage in MCP tool files (Critical Rule #5 — shifts offsets relative to annotation coordinate system).
- **`check-ymap-keys.sh`** — Warns on raw Y.Map key strings (Critical Rule #1 — must come from `shared/constants.ts`).
- **`check-raw-transact.sh`** — Warns when raw `*.transact(` appears outside the ADR-031 helpers' file (`src/shared/origins.ts`) and existing test fixtures.
- **`check-token-violation.sh`** — Delegates to `scripts/check-semantic-tokens.ts` for raw hex/rgba in `src/client/`.

### PostToolUse — `Bash` matcher

- **`nudge-pr-review.sh`** — After a successful `gh pr create`, nudges to run `/pr-review-toolkit:review-pr`.

### Stop

- **`stop-cycle-check.sh`** — Fires every agent turn end. If the session has uncommitted source edits, emits an informational nudge. One-shot per session.

## How to add a new hook

1. Write the `.sh` script with a `# PreToolUse|PostToolUse|... hook: <purpose>` header in the first 2 lines.
2. Wire it in `.claude/settings.json` under the matching event + matcher.
3. Add an entry above in the matching subsection of this README.
4. If the hook stores per-session state, route writes through `_workflow-state.sh` helpers so the state-dir pruning logic catches it.
