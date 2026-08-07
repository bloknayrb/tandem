# Archived Documentation

Finished work, kept for provenance. **None of this is current guidance** — for that see
[`docs/roadmap.md`](../roadmap.md), [`docs/decisions.md`](../decisions.md), and
[`CLAUDE.md`](../../CLAUDE.md).

These files are deliberately *not* updated to match today. A plan records what was planned, an
audit records what was found at the time, and rewriting either to agree with the present destroys
the only thing they are useful for. Where a live document cites one of them, the citation was
repointed here; the contents were left alone.

## Release and milestone plans

- [`v090-plan.md`](v090-plan.md) — v0.9.0 prep and roadmap-gap remediation.
- [`v011-plan.md`](v011-plan.md) — v0.11.0: dark theme, toolbar polish, annotation fixes.
- [`run-b-plan.md`](run-b-plan.md) — the v0.8.0 "Run B" milestone (9 issues).
- [`phase-3-plan.md`](phase-3-plan.md) — event-queue observer split for `src/server/events/queue.ts`.

Per-release and per-feature implementation plans live separately in
[`docs/plans/archived/`](../plans/archived/) and [`docs/superpowers/plans/archived/`](../superpowers/plans/archived/).

## Audits

- [`audit-v1.md`](audit-v1.md) — v0.7.1 pre-v1.0 codebase quality audit (modularity, god-files).
- [`audit-v2.md`](audit-v2.md) — v0.11.2 audit: dead code, dependency bloat, over-engineering.
- [`audit-v2-followups-plan.md`](audit-v2-followups-plan.md) — PR #621 review follow-ups, grouped by PR boundary.
- [`audit-v3-docs.md`](audit-v3-docs.md) — the 2026-06-10 documentation-only audit. Worth reading
  before starting another one: several of its findings recurred, and its R7 (state a count in one
  file, say "the MCP tools" everywhere else) is now enforced by `tests/docs/tool-count-drift.test.ts`.

## Design and UX research

- [`annotation-system-analysis.md`](annotation-system-analysis.md) — the first-principles rethink
  from a type-based to an audience-based annotation model. Cited by ADR-027.
- [`annotation-redesign-design-brief.md`](annotation-redesign-design-brief.md) — the design brief
  for the resulting toolbar reframe.
- [`redesign-review.md`](redesign-review.md) — gap/conflict review of the Claude Design handoff
  bundle. Cited by ADR-026.
- [`claude-design-response-prompt.md`](claude-design-response-prompt.md) — the corrections sent
  back to the design tool. Also cited by ADR-026, which is why it is kept.
- [`redesign-acceptance-matrix.md`](redesign-acceptance-matrix.md) — evidence gate for redesign
  issues #513–#522.
- [`redesign-bundle.md`](redesign-bundle.md) — pointer to the superseded redesign bundle.
- [`ux-opportunities.md`](ux-opportunities.md) — prioritized UX gap findings, led by
  discoverability and onboarding.

## Research

- [`agent-isolation-research.md`](agent-isolation-research.md) — running 5–15 parallel Claude Code
  agents without worktree, port, or `node_modules` contention.
