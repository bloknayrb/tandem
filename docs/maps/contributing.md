---
tags: [map, audience/contributor]
aliases: [Contributing map, Contributor map, Developer map]
---

# Contributing

Working on Tandem's code: setup, the rules that fail silently, the design system, and the review
tooling. Back to the [docs hub](../README.md).

## Start here

- [CONTRIBUTING](../../CONTRIBUTING.md) answers "how do I build, run and check this before a pull
  request?" It covers prerequisites, [the checks](../../CONTRIBUTING.md#checks),
  [what the git hooks run](../../CONTRIBUTING.md#what-the-git-hooks-actually-run) and
  [running E2E tests](../../CONTRIBUTING.md#running-e2e-tests). Read it first.
- [AGENTS.md](../../AGENTS.md) is the same ground for non-Claude coding agents, with the
  [invariants that fail silently](../../AGENTS.md#invariants-that-fail-silently).
- [CLAUDE.md](../../CLAUDE.md) is Claude Code's project memory: the
  [critical rules](../../CLAUDE.md#critical-rules), [gotchas](../../CLAUDE.md#gotchas) and the
  [development workflow](../../CLAUDE.md#development-workflow). Its rules apply to anyone.
- [CLI → npm run scripts](../cli.md#npm-run-scripts-source-checkouts-only) lists every script in
  a source checkout.

## Rules and their reasons

- [Gotchas](../gotchas.md) answers "why does this rule exist?" for each rule in CLAUDE.md, by
  area. Read the relevant section before changing code there.
- [Lessons learned](../lessons-learned.md) is the numbered story behind each hard-won lesson, with
  issue history.
- [Decisions](../decisions.md) records every architectural decision; the
  [Internals map](internals.md#decisions-by-topic) groups them by topic.
- [Stacked PRs](../stacked-prs.md) answers "how do I chain dependent pull requests safely?" Read
  it before stacking.

## Design system

Live references:

- [Semantic tokens](../semantic-tokens.md) answers "which colour, spacing or radius variable do I
  use?" Read it before styling anything.
- [Test-selector manifest](../design-system-impl/testid-manifest.md) lists the `data-testid`
  selectors. It is a convenience copy; the snapshot test is the contract.
- [Tutorial-anchor manifest](../design-system-impl/tutorial-anchor-manifest.md) maps each tutorial
  annotation to its text in the welcome document. Read it before editing either.
- [Motion](../design-system-impl/motion.md) is the animation canon and reduced-motion policy.
- [Conflicts resolved](../design-system-impl/conflicts-resolved.md) is the live decision record
  for design trade-offs, still cited from code.
- [Visual baseline procedure](../design-system-impl/baseline-procedure.md) says how to capture the
  on-demand screenshot gallery.
- [Derived-surface spec](../design-system-impl/derived-spec.md) and
  [Token audit](../design-system-impl/token-audit.md) are mixed: each marks which parts are live
  (the batch and bulk layout, the card chrome, the protected tokens) and which are records.
- [Screenshots](../screenshots/README.md) is the spec for the docs' screenshots, and
  [the screenshots skill](../../.claude/skills/screenshots/SKILL.md) captures them.

Historical records kept beside them (they say so at the top):

- [Phase 3.5 coordination handoff](../design-system-impl/3.5-coordination-handoff.md),
  [rail rebuild plan](../design-system-impl/R-rail-rebuild-plan.md),
  [changelog strategy](../design-system-impl/changelog-strategy.md) and
  [performance baseline procedure](../design-system-impl/perf-baseline.md), all from the
  design-system umbrella that shipped in v0.13.
- [Phase 1 manual QA checklist](../design-system-impl/preview/qa-1.1-1.6-checklist.md), beside the
  HTML previews in the same folder.
- [Toolbar UX research](../design-notes/toolbar-ux-research.md), superseded by the decision in
  Conflicts resolved.

## Claude Code tooling in this repo

- [Hooks](../../.claude/hooks/README.md) answers "why did a hook just block or warn me?" Each hook
  script is listed with what it checks.
- Review agents, spawned for the adversarial review step:
  [annotation model](../../.claude/agents/annotation-model-reviewer.md),
  [CRDT](../../.claude/agents/crdt-reviewer.md),
  [security](../../.claude/agents/security-reviewer.md),
  [Svelte](../../.claude/agents/svelte-migration-reviewer.md) and
  [licence](../../.claude/agents/license-reviewer.md). The
  [diverge generator](../../.claude/agents/diverge-generator.md) and
  [critic](../../.claude/agents/diverge-critic.md) run only inside
  [`/diverge`](../../.claude/commands/diverge.md), the optional ideation step before planning.
- Project skills: [dev server](../../.claude/skills/dev-server/SKILL.md),
  [E2E](../../.claude/skills/e2e/SKILL.md), [E2E debugging](../../.claude/skills/e2e-debug/SKILL.md),
  [UI inspector](../../.claude/skills/ui-inspector/SKILL.md),
  [screenshots](../../.claude/skills/screenshots/SKILL.md),
  [changelog](../../.claude/skills/changelog/SKILL.md) and
  [release](../../.claude/skills/release/SKILL.md).
- [The shipped skill](../../skills/tandem/SKILL.md) is different: it is installed into users'
  sessions, so a stale rule there is a product bug. Bump its version when you change it.

## Related maps

[Internals](internals.md) · [Security and licensing](security-and-licensing.md) ·
[Releases and operations](releases-and-ops.md) · [Glossary](../glossary.md)
