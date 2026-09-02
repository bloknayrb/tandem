# Pre-v1.0 review — 2026-09-02

**Base:** `master` at `3fb6408` (v0.24.1). **Status:** review complete, nothing fixed yet.
**Tracker:** 84 issues, [#1744](https://github.com/bloknayrb/tandem/issues/1744) through
[#1827](https://github.com/bloknayrb/tandem/issues/1827), all labelled
[`v1-review`](https://github.com/bloknayrb/tandem/issues?q=is%3Aissue+label%3Av1-review).

This folder is the evidence snapshot and the fix plan. **The issue tracker is the live status**;
nothing here is updated when an issue closes, except the optional status column in
[issues.md](issues.md). A session that starts fix work reads this folder first and the issues
second — the issues carry the mechanism and suggested fix per finding, the folder carries what
connects them.

## Start here

1. [release-gate.md](release-gate.md) — what blocks the next minor and what merely ships with it.
2. [decisions.md](decisions.md) — the five decisions already taken and the eight still open
   ([#1827](https://github.com/bloknayrb/tandem/issues/1827)). Three of the open ones gate whole
   tracks.
3. [tracks/](tracks/README.md) — eleven fix tracks, A–K. Each names its issues, the area ledgers
   with the file:line evidence, the experiments to run before and after, the reviewer agents to
   spawn, and what "done" means. **Tracks A, I and K need no decision and can start now.**
4. [issues.md](issues.md) — every issue with severity, area and track, one line each.

## Map

| File | What it holds |
|---|---|
| [method.md](method.md) | How the review was run: phases, model tiers, call caps, verification lanes, cost readings, and what was never executed. |
| [areas/](areas/README.md) | Eighteen per-area ledgers keyed by `file:line`, with evidence tag and status per finding. Curated from the raw reports; supersedes them. |
| [tracks/](tracks/README.md) | The fix plan. One file per track. |
| [decisions.md](decisions.md) | Taken and open decisions, with the context to answer each. |
| [refuted.md](refuted.md) | Nine claims that did not hold and the leads closed as fine. Read before re-raising anything. |
| [release-gate.md](release-gate.md) | The next-minor verdict. |
| [smoke-lines.md](smoke-lines.md) | Eleven hardware-gated checks drafted for `docs/release-smoke-checklist.md`; not yet merged there. |
| [experiments/](experiments/README.md) | The reproduction scripts, rewritten to run from the repo root. Each names the issue it reproduces and the output that means "still broken". |
| [raw/](raw/) | The agent reports as returned (`findings-*.txt`, `gapfill-*.txt`, `report-*.md`), the per-area file manifests, and the Playwright lane's log. Unvetted; the area ledgers are the vetted reading. |

The narrative version of the same content is the published review page (private, same numbers):
`https://claude.ai/code/artifact/7c2c17b7-e663-4bf2-9aca-9d6a22cb6e77`.

## Conventions used throughout

- **Severity.** High = data loss, privacy, a broken release or upgrade path, or a core action that
  fails silently. Medium = wrong behaviour with a workaround or a narrow trigger. Low = hygiene,
  copy, or defence in depth. Lows were filed in six batches, everything else individually.
- **Evidence tags.** `[ran]` the reviewer executed it; `[read]` the reviewer read the cited lines;
  `[inferred]` neither. An inferred finding was never allowed to be High.
- **Status in the area ledgers.** `Reproduced` — re-run by the orchestrating session, not only the
  agent. `Source-confirmed` — the orchestrator read the cited lines and the mechanism holds.
  `Agent-ran` / `Agent-reported` — accepted from the report; the cited line was checked, the run
  was not repeated. `Refuted` — checked and wrong; listed in [refuted.md](refuted.md).
- **Every High** was re-run or source-confirmed by the orchestrator. Mediums were sampled.
- **Paths** are repository-relative. Line numbers are as of `3fb6408` and will drift.

## What is not in here

- Nothing under `src/`, `tests/` or the shipped skill was changed by the review.
- The scratch servers, transcripts and the agents' working directories. The experiments and raw
  reports are what survives.
- The eleven smoke lines are not yet in the release checklist; they land with track E.
