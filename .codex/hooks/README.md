# Tandem hook scripts (Codex mirror)

Wired in `.codex/hooks.json` — the Codex CLI counterpart of `.claude/settings.json`. Each script's purpose is documented in its first 2-3 comment lines (`head -3 *.sh` reveals all of them at once).

**Path resolution note:** unlike Claude Code's `$CLAUDE_PROJECT_DIR`, Codex's `hooks.json` has no documented variable-interpolation syntax for the project root, and Codex hook commands run with the *session* cwd — which is not guaranteed to be the repo root (Codex may be started from a subdirectory). Every `command` in `hooks.json` therefore resolves the script path via `$(git rev-parse --show-toplevel)/.codex/hooks/<script>.sh` rather than a bare relative path — this matches Codex's own documented guidance for repo-local hooks. Internal script logic (state-dir paths, etc.) still assumes cwd == repo root; that narrower assumption is unverified for Codex and is a known limitation, not fixed here.

**Hook semantics:**
- `PreToolUse` hooks exit `2` to block the tool call.
- `PostToolUse` hooks exit `0` (warnings only — they emit to stderr but never block).
- Workflow-nudge hooks emit stderr and never block.
- Per-session state lives in `.codex/.workflow-state/<session_id>/` (gitignored via the un-anchored `**/.workflow-state/` rule, pruned at SessionStart after 7 days via `sessionstart-prune-state.sh`). This is deliberately a *separate* tree from `.claude/.workflow-state/` — sharing one would let Codex and Claude Code sessions clobber each other's markers.

## Inventory (18 scripts)

### Shared / helper

- **`_workflow-state.sh`** — Shared helpers for workflow-nudge hooks. Sourced, not executed.

### SessionStart

- **`sessionstart-prune-state.sh`** — Prunes workflow-state directories older than 7 days.

### PreToolUse — `Edit|Write` matcher

- **`block-sensitive.sh`** — Blocks edits to `.env`, lock files, and other sensitive paths. Exits 2 on match.
- **`nudge-plan-review.sh`** — Warns when a `.claude/plans/*.md` was written this session but no `Agent` tool has run before a source edit. One-shot per plan. **Inert under Codex** — see "The plan-review chain is Claude-Code-only" below.

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
2. Wire it in `.codex/hooks.json` under the matching event + matcher, using the `$(git rev-parse --show-toplevel)/.codex/hooks/<script>.sh` path form (see the path-resolution note above).
3. Add an entry above in the matching subsection of this README.
4. If the hook stores per-session state, route writes through `_workflow-state.sh` helpers so the state-dir pruning logic catches it.

## The plan-review chain is Claude-Code-only

`.claude/` runs a three-part plan-review workflow: `track-workflow-events.sh` records a
`last-plan-write` marker, `nudge-plan-review.sh` warns on a source edit that follows a plan
write with no `Agent` call between, and `block-plan-without-agent-review.sh` hard-blocks
`ExitPlanMode` until the transcript shows a review agent ran.

**Only the first two are mirrored here, and both are inert under Codex.** The marker is set by
matching a file path against `.claude/plans/`, which Codex never writes, so the nudge never
fires. They are retained because an advisory hook that no-ops costs nothing and would start
working if a Codex plan-file convention appears.

**`block-plan-without-agent-review.{sh,mjs}` was deliberately NOT mirrored**, on two grounds:

1. `ExitPlanMode` is not in Codex's tool vocabulary. Codex's canonical tool names are `Bash`,
   `apply_patch` (which also matches the aliases `Edit` and `Write` — that is why the
   `Edit|Write` matchers above do work), MCP tools, and local functions like `update_plan`.
   A matcher that never matches is a safety hook that silently protects nothing.
2. The guard's mechanism is Claude-Code-specific end to end, not just its matcher — it reads
   `envelope.transcript_path` and scans for writes under `~/.claude/plans/`. And it **fails
   closed**: absent a transcript it blocks. So wiring it to some other Codex event would not
   port the guard, it would hard-block that event unconditionally.

Do not "fix" this by pointing the matcher at `update_plan`. That fires on every plan revision
rather than on plan approval, which is a different event with different semantics.

## Agents (`.codex/agents/*.toml`)

The 11 files under `.codex/agents/` are **hand-copied, reformatted snapshots** of `.claude/agents/*.md` — Codex's agent-definition format is TOML with a `developer_instructions` string field, not YAML-frontmatter Markdown, so a byte-for-byte copy isn't possible. There is no generator keeping them in sync. When a `.claude/agents/*.md` file changes, re-copy its body into the matching `.codex/agents/*.toml` file's `developer_instructions` by hand (translate the YAML frontmatter `name`/`description` into the TOML `name`/`description` fields). This is a known drift risk, not an oversight — building a generator was judged not worth it for 11 rarely-changed files, but a silent divergence between the two sets is possible if this step is skipped.
