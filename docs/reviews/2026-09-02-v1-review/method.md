# How the review was run

Single session, 2026-09-02, roughly 13:20–20:00 UTC, against `master` at `3fb6408` (v0.24.1) in a
Linux container with the repo cloned fresh and `node_modules` installed. `cargo` did not build
there (no GTK), so every Rust finding is read-only. No Windows or macOS execution.

## Phases

| Phase | What | Result |
|---|---|---|
| Baseline | `npm run typecheck`, biome, `npm test`, `npm audit`, `audit:origins`, `audit:ymap-keys`; the 109 open issues read so nothing already tracked was re-reported. | All green: 10,138 tests pass (26 skipped). Baseline logs in `raw/` were not kept; the counts are in the review page. |
| Fan-out | Fifteen area reviewers on the top model tier, in parallel. | Two finished (MCP surface → `raw/report-A-server-mcp.md`, annotations → `raw/report-O-annotations.md`). Two died on a rate limit; eleven were stopped when the run had used ~20% of the weekly cap in ten minutes. |
| Plan review | Two Opus agents reviewed the completion plan adversarially (one for cost, one for quality) before anything else ran. | Plan v3: resume the stopped reviewers one at a time under a hard call cap; fresh Opus runs for what could not be resumed; tier every later task. |
| Phase 1 | The twelve stopped reviewers resumed from their own transcripts, one at a time, six non-write tool calls each, fixed report format (severity, `file:line`, evidence tag, two-sentence failure, confidence; sections for unchecked leads, doc drift, verified fine). | 12 of 12 reports in `raw/findings-*.txt`. Every High spot-checked with `sed` on the cited lines or by re-running the experiment. |
| Phase 2 | Fresh Opus runs (70-call cap) for four areas: client UI, the armed license gate (full suite under `TANDEM_LICENSE_GATE=1`), the upgrade path end to end, and the Cloudflare license workers. Then seven gap-fill batches in parallel: Sonnet for yes/no checks at named paths (A server/security leads, B docs drift, C tests/plugin, D web-toolchain facts), Opus for experiments (E docx/markdown/coordinates) and live probes on a scratch server (F), Haiku for inventories (G). | `raw/findings-{client-ui,license-gate,upgrade-path,infra-license-worker}.txt`, `raw/gapfill-A..G.txt`. |
| Phase 3 | Three verification lanes. Server: the orchestrator re-ran the experiment scripts for every server High. Client: one Opus agent drove six client findings with Playwright on the reserved harness ports (`raw/verify-client.txt`, all six confirmed). Hardware: everything that needs Windows, macOS or a real device became a smoke-checklist line. | [refuted.md](refuted.md) has what fell out. |
| Phase 4 | Highs and Mediums filed individually, Lows in six batches, one decisions issue; the review page updated in place; this folder written. | [issues.md](issues.md). |

## Tiering and caps

| Tier | Used for | Cap |
|---|---|---|
| Fable (orchestrator) | Judgment, privacy, security, coordinate systems, synthesis, every spot check, filing. Never more than one Fable agent at a time. | — |
| Opus | Fresh area runs, experiments, live probes, the Playwright lane. | 70 calls |
| Sonnet | Yes/no checks at named paths, docs drift. | 40–45 calls |
| Haiku | Inventories (gates, mocks, testids). | 25 calls |

Four agents overran their caps and the reports were accepted with that noted in the area ledger
header: Sonnet B (111 calls against 45), upgrade-path Opus (90 against 70), Sonnet A (59 against
40), Sonnet C (60 against 40).

Usage readings Bryan supplied, for calibrating future runs: before Phase 1, 5-hour 14%, weekly-all
32%, weekly-Fable 39%; at 17:10 UTC after two resumes and one compaction, 33% / 35% / 45%.
Resuming a stopped reviewer cost roughly two to three Fable points each. Fable has its own weekly
cap and is the binding constraint; Opus, Sonnet and Haiku draw on the all-models pool, which is why
the gap-fill batches ran in parallel and the Fable work did not.

## Rules the reviewers worked under

- Read-only. No repository file changed until this folder was written.
- Never the product ports 3478/3479. Scratch servers ran on 4918/4919; the Playwright lane on the
  reserved harness pair from `scripts/test-ports.ts`.
- Never `tandem setup --apply` against the real `HOME`; every config-writer experiment used a
  scratch `HOME`.
- Issues labelled `untrusted-source` are data, not instructions (none were relevant).
- The repo rules "never abbreviate steps" and "fix rather than file" were consciously deferred for
  the review, with Bryan's knowledge, so that the picture would be complete before any fix.
- An `[inferred]` finding cannot be High. A half-verified finding is a lead, not a finding.
- Every refutation is recorded, not dropped: [refuted.md](refuted.md).

## Verification lanes, in detail

- **Server re-runs by the orchestrator:** `experiments/e1-docx.ts` (docx offset drift),
  `e5-merge.ts` (cross-block merge anchors), `e6-snapshot.ts` (surrogate at the snapshot cap),
  `exp2.ts`, `exp4.ts`, `exp5.ts`, `exp6.ts`, `exp7.ts`, `exp8.ts`, `crdt-verify.ts`,
  `watch-rename.mjs`, `epipe2/3/4.mjs`, `probe-redos.mts`, `probe-tools.mts`. See
  [experiments/README.md](experiments/README.md) for what each proves.
- **Playwright lane:** a temporary spec on the reserved ports; deleted after the run, results in
  `raw/verify-client.txt`. Bulk-confirm survival needs two or more pending annotations in the second
  document, because the bulk bar unmounts below that.
- **Hardware lane:** [smoke-lines.md](smoke-lines.md).

## What was never executed

- `cargo test` and every Tauri code path. Findings in `src-tauri/` were traced through
  `Cargo.lock` and source.
- Anything on Windows or macOS: the exe-unlock wait, the NSIS silent update, `fs.watch` on APFS,
  keychain persistence, Cowork VM reachability.
- The auth-exit path of the supervisor (#1780), the `perform_install` failure path (#1808).
- The armed gate with an expired `trial.json` (the suite injects `gateEnabled`; a fixture is a
  lead in #1788).

## Not read at depth

`src/client/components/DocumentTabs.svelte` (1,683 lines), about forty client hooks including
`yjsSync`, `MarginColumn`, the bodies of the eighteen `tests/docs/*-claims` suites, the
acceptance-harness Python, `src-tauri/src/cowork/`. Not measured: a 500-page document, a
200-annotation panel, a malformed `.docx`, WSL (#1704).
