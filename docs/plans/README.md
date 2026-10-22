---
tags: [index, historical, plans]
aliases: [Plans, Plan index, Implementation plans]
---

# Plans

> **Historical: each plan records what was intended on its date, before the change was made, and
> is not current guidance.** What actually shipped may differ, and a link or claim inside a plan may
> have gone stale. For how things work now, follow the [docs hub](../README.md); for the other
> historical sets, see the [History map](../maps/history.md).

One line per file, taken from its title.

## Current folder

- [2026-08-07-channel-flag-removal.md](2026-08-07-channel-flag-removal.md): removing an inert
  dev-channels flag and correcting what the docs said about push.
- [2026-08-10-session-monitor-auto-arm.md](2026-08-10-session-monitor-auto-arm.md): arming the
  per-session monitor on first Tandem use.
- [2026-08-10-session-monitor-auto-arm-review.md](2026-08-10-session-monitor-auto-arm-review.md):
  the review of that plan.
- [2026-08-11-raise-first-use-arming-probability.md](2026-08-11-raise-first-use-arming-probability.md):
  making a first-use session more likely to arm wake monitoring.
- [2026-08-11-session-monitor-gate-reachability.md](2026-08-11-session-monitor-gate-reachability.md):
  letting the session-monitor gate reach its own pass state (PR #1393).
- [2026-08-11-session-monitor-harness-fixes.md](2026-08-11-session-monitor-harness-fixes.md):
  unblocking the session-monitor acceptance harness (PR #1393).
- [2026-08-11-session-monitor-review-fixes.md](2026-08-11-session-monitor-review-fixes.md): the
  review findings on #1393 and #1397.
- [2026-08-12-windows-update-restart-port-timeouts.md](2026-08-12-windows-update-restart-port-timeouts.md):
  port timeouts on a Windows update restart, and a self-service port diagnostic.
- [2026-08-24-ai-assisted-maintainability-remediation.md](2026-08-24-ai-assisted-maintainability-remediation.md):
  an AI-assisted maintainability review and its remediation plan.
- [2026-08-27-codeql-alert-resolution.md](2026-08-27-codeql-alert-resolution.md): resolving the
  open GitHub security alerts.
- [2026-08-27-unit-11e-sidecar-lifecycle.md](2026-08-27-unit-11e-sidecar-lifecycle.md): moving the
  Tauri sidecar lifecycle into its own Rust module.
- [2026-08-28-caller-supplied-write-destinations.md](2026-08-28-caller-supplied-write-destinations.md):
  caller-supplied write destinations, and a CSRF hole found along the way.
- [2026-08-28-unit-07b-open-result.md](2026-08-28-unit-07b-open-result.md): migrating the ADR-034
  open result contract.
- [2026-08-28-unit-07c-file-opener-deletion.md](2026-08-28-unit-07c-file-opener-deletion.md):
  moving the reload family into `documents/` and deleting the old file opener.
- [2026-09-06-open-issues-sweep-design.md](2026-09-06-open-issues-sweep-design.md): the design for
  an orchestrated sweep of every open issue.
- [2026-09-06-open-issues-sweep.md](2026-09-06-open-issues-sweep.md): that sweep's ledger. Its
  workflow script, `2026-09-06-open-issues-sweep.workflow.js`, sits beside it.

## Archived

Earlier plans, kept in `archived/`:

- [1123-m1a-model-registry-relocation.md](archived/1123-m1a-model-registry-relocation.md),
  [1123-m2-model-registry-server-authority.md](archived/1123-m2-model-registry-server-authority.md),
  [1123-m2b-models-ui-mount.md](archived/1123-m2b-models-ui-mount.md),
  [1123-m3-provider-authorship.md](archived/1123-m3-provider-authorship.md) and
  [1123-m4-dark-mechanism.md](archived/1123-m4-dark-mechanism.md): the local-model milestones
  (#1123), built dark.
- [1150-docx-import-dedup-offset-drift.md](archived/1150-docx-import-dedup-offset-drift.md): the
  `.docx` imported-comment duplication on reload after drift (#1150).
- [2026-04-17-v0.6.3-release.md](archived/2026-04-17-v0.6.3-release.md) and
  [2026-05-21-v0.13.0-release.md](archived/2026-05-21-v0.13.0-release.md): two release plans.
- [2026-05-25-1.11-selection-surface.md](archived/2026-05-25-1.11-selection-surface.md),
  [2026-05-25-1.12-slash-menu.md](archived/2026-05-25-1.12-slash-menu.md) and
  [2026-05-25-1.13-decorations-control.md](archived/2026-05-25-1.13-decorations-control.md): the
  design-system sub-PRs for the selection surface, slash menu and decorations control.
- [2026-05-28-stage-c-cleave-locks.md](archived/2026-05-28-stage-c-cleave-locks.md),
  [2026-05-28-stage-c1-margin-mode-continuum.md](archived/2026-05-28-stage-c1-margin-mode-continuum.md),
  [2026-05-28-stage-c2-density-variants.md](archived/2026-05-28-stage-c2-density-variants.md),
  [2026-05-28-stage-c3-bezier-leaders-anchor-dots.md](archived/2026-05-28-stage-c3-bezier-leaders-anchor-dots.md)
  and [2026-05-29-stage-d-motion.md](archived/2026-05-29-stage-d-motion.md): the margin and motion
  stages of the design-system phase 3.5.
- [2026-06-11-local-models-v1-rescope.md](archived/2026-06-11-local-models-v1-rescope.md) and
  [2026-06-11-v1-roadmap-reconciliation.md](archived/2026-06-11-v1-roadmap-reconciliation.md): the
  June 2026 v1.0 scope changes.
- [2026-07-30-margin-vertical-pressure-elastic-width.md](archived/2026-07-30-margin-vertical-pressure-elastic-width.md):
  margin annotations that minimise under vertical pressure and widen elastically.
- [477-pr-3c-ii-auto-config-removal.md](archived/477-pr-3c-ii-auto-config-removal.md): removing
  automatic configuration under ADR-038.
- [cowork-detection-airtight.md](archived/cowork-detection-airtight.md),
  [cowork-detection-review-fixes.md](archived/cowork-detection-review-fixes.md) and
  [cowork-transport-test-matrix.md](archived/cowork-transport-test-matrix.md): Cowork detection and
  its transport test matrix.
- [diagnostics-surface.md](archived/diagnostics-surface.md): the diagnostics surface.
- [pre-write-doc-backups.md](archived/pre-write-doc-backups.md): document backups before a write,
  and flushing unsaved documents at shutdown.
- [stale-tab-resync.md](archived/stale-tab-resync.md): dropping and resyncing a stale tab on a
  generation mismatch.
- [tauri-plan.md](archived/tauri-plan.md) and [tauri-plan-review.md](archived/tauri-plan-review.md):
  the desktop app plan and its architecture review.
- [uninstall-scrub-docs-sweep.md](archived/uninstall-scrub-docs-sweep.md): extending the uninstall
  scrub, with a docs sweep.
