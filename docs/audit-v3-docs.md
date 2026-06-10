# Documentation Audit v3 — Docs-Only Sweep

**Date:** 2026-06-10
**Scope:** All project documentation — `README.md`, `CLAUDE.md`, `AGENTS.md`, `CHANGELOG.md`, every top-level `docs/*.md`, `.claude/skills/`, `.claude/knowledge-graph/`, and repo-state issues surfaced along the way. Unlike [audit-v1](audit-v1.md) and [audit-v2](audit-v2.md) (code quality sweeps), this audit covers documentation only: conflicts, outdated information, gaps, and hygiene.
**Method:** Three parallel exploration passes (core navigation docs / reference docs / status + planning docs), each cross-checking doc claims against the codebase, followed by direct verification of every contested finding and an adversarial review of the fix plan. Counts were verified by grep against source, not taken from other docs.

## Findings fixed in this PR

| # | Where | What was wrong | Fix |
|---|---|---|---|
| F1 | `CLAUDE.md` Documentation section | "ADRs (001-038)" — decisions.md actually runs to ADR-043 | Updated to 001-043 |
| F2 | `CLAUDE.md` Documentation section | "79 lessons" — lessons-learned.md has 80 | Updated to 80 |
| F3 | `CLAUDE.md` Documentation section | "25 hand-curated … nodes" — knowledge graph has 27 node files | Updated to 27 |
| F4 | `CLAUDE.md` Status | Ended at v0.13.5; v0.13.6 shipped 2026-06-04 and a large unreleased batch followed | Added v0.13.6 sentence + unreleased-work pointer |
| F5 | Eight sites across seven docs | Stale "27 tools" / "30 tools (27 active…)" counts. The canonical ADR-038 policy paragraph (quoted verbatim by decree in README, architecture, positioning, roadmap) said "the same 27 tools"; `workflows.md` and `user-guide.md` said "30 tools (27 active, 3 deprecated stubs)" — wrong total *and* wrong active count | All updated to 28 active / 31 total. The ADR-038 source text in `decisions.md` was updated together with its verbatim quotes so the quotes stay faithful (the count is incidental description, not decision substance). CHANGELOG historical entries left untouched |
| F6 | `docs/user-guide.md` (largest fix) | Documented the pre-redesign annotation system: a removed **Flag** type; the ADR-027-removed `directedAt: "claude"` / "@Claude" toggle; no **note** type at all; the old annotation toolbar; the removed dedicated **Review Mode** (`Ctrl+Shift+R`, `Y`/`N`/`E`/`Z` keys, dimmed editor, "Reviewing 3 / 15") including its Quick Start step, an entire shortcuts-table section, the deleted Review Summary overlay (#521), and an orphaned `05-review-mode.png` reference; ".docx opens in review-only mode" (editable since #576/#1068/#1069); "three tutorial annotations" (now four, including a note); Solo/Tandem "in the toolbar" (now title bar); a tab-navigation claim for `Alt+Left/Right` (it reorders, doesn't navigate) | Rewrote against current code: three-type taxonomy (`highlight` user-only / `comment` shared / `note` private per ADR-027, `src/shared/types.ts`); suggestions documented as **Claude-only**; selection-popup flow (highlight swatches + Annotate composer with Note-to-self vs Send-to-Claude, `Toolbar.svelte`); keyboard review via `Ctrl+Enter` / `Ctrl+Shift+Enter` / `Alt+]`/`[` (`useAppShortcuts.ts`); imported Word comments land as private notes with batch-promote (`docx-comments.ts`); `.docx` read-write with comment writeback + external-conflict banner; full shortcut tables regenerated from the actual matcher, with a pointer to Settings → Shortcuts remapping (ADR-041) |
| F7 | `docs/configuration.md` | `TANDEM_DISABLE_FIRST_RUN_WIZARD` undocumented (`src/shared/constants.ts:219`, checked in `integrations/api-routes.ts`) | Added to the Startup behavior table |
| F8 | `docs/mcp-tools.md` intro | "deprecated stubs that return structured errors" — they return MCP error responses with code `DEPRECATED` | Reworded |
| F9 | `.gitignore` | Skills allowlist drift: `.claude/skills/*` is ignored with negations for only 3 of the 5 tracked skills. `changelog/` and `e2e-debug/` are tracked but un-negated — works today only because gitignore doesn't affect tracked files, but a delete + re-add would silently skip them | Added the two missing negation lines |
| F10 | `CLAUDE.local.md` | Self-describes as "Gitignored. Local-only context" but was **tracked** — swept into the repo by feature commit `76949f8`. Stale (claims design-system Phase 1 in progress as of 2026-05-24; the umbrella merged in v0.13.5 on 2026-05-29) and contains machine-local Windows paths. Loaded as project memory in every fresh clone, contradicting CLAUDE.md | Untracked (`git rm --cached`) + `.gitignore` entry. **Pull-side caveat:** on clones where the file is unmodified, pulling this change deletes the working-tree copy — copy it aside first, or recover with `git show 76949f8:CLAUDE.local.md` |
| F11 | `src/client/components/OnboardingTutorial.svelte` | Tutorial step 1 told users to "Try Review Mode (Ctrl+Shift+R)" — a removed feature; the shortcut does nothing. Only in-code copy fix in this PR (found while verifying F6) | Replaced with the current accept/dismiss shortcuts |

## Recommendations (no action taken — decisions or out-of-repo work)

- **R1 — `issue-pipeline` skill missing from the repo.** `CLAUDE.md` links `.claude/skills/issue-pipeline/SKILL.md` twice and `architecture.md` lists it, but the directory doesn't exist in the repo: `.gitignore` ignores `.claude/skills/*` and `issue-pipeline` was never allowlisted, so it presumably exists only on the primary dev machine. Recommend: add `!.claude/skills/issue-pipeline/` and commit it from the machine that has it. The ten "generic skills" CLAUDE.md lists (accessibility, frontend-design, …) are symlinks per architecture.md and inherently local — consider a parenthetical in CLAUDE.md noting they're local-only so remote/fresh-clone sessions aren't surprised.
- **R2 — Knowledge-graph pilot review overdue.** CLAUDE.md and the KG README say "review 2026-06-01" with a kill criterion ("no surprising query in two weeks"); the review is 9+ days past due. Kill or extend — either way, update the stamped date.
- **R3 — `/diverge` kill-gate 2026-06-27** is ~2 weeks out and one of the kill criteria is "not invoked within 30 days" — no invocation log exists to evaluate it. Worth deciding (or noting invocations) before the date passes.
- **R4 — ~12 completed planning docs clutter `docs/` top level**: `v090-plan.md`, `v011-plan.md`, `phase-3-plan.md`, `run-b-plan.md`, `audit-v1.md`, `audit-v2.md`, `audit-v2-followups-plan.md`, `redesign-review.md`, `redesign-acceptance-matrix.md`, `annotation-redesign-design-brief.md`, `annotation-system-analysis.md`, `ux-opportunities.md`, `claude-design-response-prompt.md`. All describe shipped/superseded work; `docs/archive/` exists with a "kept for provenance" convention. Recommend a follow-up PR moving them (kept out of this PR so the audit diff stays reviewable). `428-macos-notarization-runbook.md` and `release-smoke-checklist.md` stay — both still live.
- **R5 — One-off session artifacts are tracked**: `.claude/notes/pr-review-*.md`, `.claude/reviews/pr-*.{codex.md,diff,summary.md}`, `ar1-stash.sha`. Candidates for pruning or archiving.
- **R6 — Refresh `CLAUDE.local.md` on the dev machine.** Its phase status predates the umbrella merge ("NEXT: Sub-PR 1.7"); a stale local memory file actively misleads sessions.
- **R7 — Count drift is structural.** The active-tool count is stated in 9+ places; it drifted the moment a 28th tool shipped. Consider stating exact counts only in `mcp-tools.md` (the reference) and CLAUDE.md, and using "the same MCP tools" elsewhere — especially in the ADR-038 canonical paragraph, where a count guarantees future unfaithful-quote churn.

## Verified correct (spot-checked, no issues)

- All `npm run` scripts referenced in CLAUDE.md Quick Reference exist and match `package.json`.
- All sampled CLAUDE.md file paths (`src/server/file-io/reaper.ts`, `doc-backup.ts`, `src/cli/setup.ts`, `src/server/startup-file.ts`, integrations modules) exist.
- All 20 hooks listed in CLAUDE.md exist in `.claude/hooks/` and are wired in `.claude/settings.json`.
- `CLAUDE.md` tool count (31 / 28 / 3) and the full `docs/mcp-tools.md` catalog — fresh from the #1080 catalog audit (PR #1104).
- `docs/architecture.md` file map, observer-ownership table, and data flows (except the F5 counts).
- `docs/cli.md` subcommands and flags vs `src/cli/`.
- `docs/security.md` CORS allowlist (incl. the PR #637 bare-`localhost` narrowing), auth-token generation, loopback gates.
- `docs/data-locations.md` paths vs `env-paths` usage; uninstall-scrub scope.
- `docs/semantic-tokens.md` token names vs `index.html` `:root`.
- `docs/workflows.md` tool-call examples (except the F5 counts).
- `docs/roadmap.md` v0.13.0 / v0.13.5 / v0.14.0 rows vs CHANGELOG and CLAUDE.md.
- `AGENTS.md` — consistent with CLAUDE.md.
- No tests or scripts assert on the content of any doc edited here (verified before editing).
