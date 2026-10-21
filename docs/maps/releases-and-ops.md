---
tags: [map, audience/maintainer]
aliases: [Releases and operations, Release map, Ops map]
---

# Releases and operations

Cutting a release, checking it on real machines, the v1.0 gates and what is still ahead. Back to
the [docs hub](../README.md).

## Cutting a release

- [The release skill](../../.claude/skills/release/SKILL.md) answers "what are the steps to ship a
  version?" It covers the version bump across every surface, the tag, the GitHub Release and the
  smoke run. Follow it rather than improvising.
- [The changelog skill](../../.claude/skills/changelog/SKILL.md) drafts the
  [CHANGELOG](../../CHANGELOG.md) entry from the git log. The CHANGELOG is also shown to users in
  the app after an update.
- [Release smoke checklist](../release-smoke-checklist.md) answers "does the published build
  actually work?" Run it after every tagged release, per platform. Its
  [recording the result](../release-smoke-checklist.md#recording-the-result) section says where the
  outcome goes, and the dated sections at the end say what each past run settled.
- [macOS signing and notarization runbook](../428-macos-notarization-runbook.md) answers "why do
  Macs say Tandem is damaged, and how do I fix the certificates?" Read it when a certificate
  expires or notarization fails.
- [Stacked PRs](../stacked-prs.md) covers chaining dependent pull requests before a release.

## Gates toward v1.0

- [Roadmap](../roadmap.md) answers "what is left before v1.0?" See
  [Active — toward v1.0](../roadmap.md#active--toward-v10) and the
  [v1.0 exit criteria](../roadmap.md#v100-exit-criteria). It holds only what is ahead.
- [Performance gate results](../perf-gate-results.md) records each run of the performance gate,
  with the harness settings.
- [Accessibility gate results](../a11y-gate-results.md) records the accessibility criteria, which
  pass and which still need a human with a screen reader.
- [Licensing operations](../licensing-operations.md) holds the
  [pre-launch gate](../licensing-operations.md#8-pre-launch-gate-all-of-these-before-a-stranger-can-pay)
  for the licence system, which ships dark until v1.0.

## Records

- [CHANGELOG](../../CHANGELOG.md) says what shipped in each release.
- [The 2026-10-20 docs audit](../reviews/2026-10-20-docs-audit.md) is the latest whole-repo
  documentation check, with the decisions it left open.
- Older plans and the frozen roadmap snapshot are in the [History map](history.md).

## Related maps

[Security and licensing](security-and-licensing.md) · [Contributing](contributing.md) ·
[History](history.md) · [Glossary](../glossary.md)
