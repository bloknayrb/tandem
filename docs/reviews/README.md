---
tags: [index, historical, evidence]
aliases: [Reviews, Review index, Audits]
---

# Reviews and audits

> **Historical evidence: each review records what was found against one commit on its date, and
> is not current guidance.** Line numbers and statuses inside them are as of that commit; the
> issue tracker holds live status. Reviews are indexed, not updated. For how things work now,
> follow the [docs hub](../README.md); for the other historical sets, see the
> [History map](../maps/history.md).

Newest first. One line per file or folder, taken from its opening lines.

- [2026-10-20-docs-audit.md](2026-10-20-docs-audit.md): a whole-repo documentation audit against
  the code, with the fixes it made, the decisions it left for the maintainer and the follow-ups
  (including this docs vault).
- [2026-10-13-prompt-audit.md](2026-10-13-prompt-audit.md): an audit of Tandem's prompt text
  (the agent instructions, the shipped skill, project skills and agents, MCP tool descriptions)
  against current prompting guidance.
- [2026-10-01-license-review.md](2026-10-01-license-review.md): an agent's review of `LICENSE` and
  everything that restates its terms, revised after a second pass; not legal advice.
- [2026-09-17-test-audit/](2026-09-17-test-audit/test-audit.md): a review-only audit of the whole
  test suite against a production behaviour model built without reading the tests.
  - [test-audit.md](2026-09-17-test-audit/test-audit.md) is the report and
    [auditor-brief.md](2026-09-17-test-audit/auditor-brief.md) the brief each auditor followed.
  - [project-model.md](2026-09-17-test-audit/project-model.md) is the production behaviour model,
    and [heatmap.md](2026-09-17-test-audit/heatmap.md) the coverage heat map built from it.
  - [baseline-summary.md](2026-09-17-test-audit/baseline-summary.md) summarises the full test run
    the audit started from.
  - [removal-candidates.md](2026-09-17-test-audit/removal-candidates.md) lists the proposed
    removals and consolidations; [removal-review.md](2026-09-17-test-audit/removal-review.md) and
    the four slice reviews ([A](2026-09-17-test-audit/removal-review-A.md),
    [B](2026-09-17-test-audit/removal-review-B.md), [C](2026-09-17-test-audit/removal-review-C.md),
    [D](2026-09-17-test-audit/removal-review-D.md)) challenge them.
  - [cleanup-plan.md](2026-09-17-test-audit/cleanup-plan.md) is the synthesis: what was cleared to
    change and what was excluded.
- [2026-09-03-prompt-audit-diff.md](2026-09-03-prompt-audit-diff.md): an earlier prompt audit,
  written as a proposed diff with one finding per hunk.
- [2026-09-02-v1-review/](2026-09-02-v1-review/README.md): the pre-v1.0 code review, filed as a
  batch of `v1-review` issues, with the evidence and the fix plan.
  - [README.md](2026-09-02-v1-review/README.md) says where to start.
  - [release-gate.md](2026-09-02-v1-review/release-gate.md) says what blocked the next minor;
    [decisions.md](2026-09-02-v1-review/decisions.md) the decisions taken and open.
  - [tracks/](2026-09-02-v1-review/tracks/README.md) holds the fix tracks;
    [issues.md](2026-09-02-v1-review/issues.md) indexes every filed issue.
  - [areas/](2026-09-02-v1-review/areas/README.md) holds one evidence ledger per area;
    [experiments/](2026-09-02-v1-review/experiments/README.md) the reproduction scripts; `raw/`
    the unedited reviewer output.
  - [method.md](2026-09-02-v1-review/method.md) says how the review was run,
    [refuted.md](2026-09-02-v1-review/refuted.md) the claims that did not hold, and
    [smoke-lines.md](2026-09-02-v1-review/smoke-lines.md) the hardware checks later merged into the
    [release smoke checklist](../release-smoke-checklist.md).
