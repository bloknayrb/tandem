# Area: Tests and CI gates

**Raw:** [`../raw/findings-tests.txt`](../raw/findings-tests.txt) (Fable, resumed, 7 calls, one over cap);
[`../raw/gapfill-C.txt`](../raw/gapfill-C.txt) (Sonnet) and [`../raw/gapfill-G.txt`](../raw/gapfill-G.txt)
(Haiku inventories: 51 conditional gates, 71 `vi.mock` targets, 436 testids).
**Manifest:** [`../raw/manifests/tests.md`](../raw/manifests/tests.md).
**Track:** [K tests and lows](../tracks/K-tests-and-lows.md).
**Spot-check:** both Highs read at the cited lines. The scanners that found the vacuous tests are
in [`../experiments/`](../experiments/README.md) (`scan-zero-assert.mjs`, `scan-subject-mock.mjs`,
`scan-stale-mock.mjs`, `find_no_expect.py`).

## Findings

| Sev | Where | Finding | Evidence | Status | Issue |
|---|---|---|---|---|---|
| H | `tests/server/mcp-tool-integration.test.ts:307-318` | "tandem_comment rejects invalid arguments" has no `expect` in either branch; green on any behaviour. | [read] | Source-confirmed | [#1783](https://github.com/bloknayrb/tandem/issues/1783) |
| H | `tests/server/license-gate-coverage.test.ts:139-144`; `tool-count-drift.test.ts:64` | Completeness derives `registered` from the `gatedTool` / `withErrorBoundary` wrappers only; a bare `server.tool("tandem_x")` is invisible and ships ungated with the suite green (zero bare today; latent). The drift test has the right derivation but compares counts only. | [read] | Source-confirmed | [#1784](https://github.com/bloknayrb/tandem/issues/1784) |
| M | `tests/scripts/coverage-gate-wiring.test.ts:~100-112` | The "suite references module" check is `includes(stem)`; for 11 of 14 modules half the tree satisfies it, so the deletion half of ADR-051 is defeated by hollowing a suite that stays on disk. | [ran] | Agent-ran (per-stem counts) | [#1784](https://github.com/bloknayrb/tandem/issues/1784) |
| M | `tests/e2e/*.spec.ts` | `tandem_checkInbox` appears in 0 of 55 Playwright specs; the user→Claude direction is never driven end to end; the Solo E2E asserts geometry only. | [ran] | Agent-ran (grep) | [#1783](https://github.com/bloknayrb/tandem/issues/1783) |
| L | `tests/hooks/test_workflow_state.sh`; `awareness.test.ts:130`, `changelog-path.test.ts:32`, `file-watcher.test.ts:178`, `integrations/apply.test.ts:335`; `keyboard-a11y.spec.ts:271`, `settings-modal.spec.ts:155`; `cwd-preview.test.ts:248-258`; `annotation-remove-seam.test.ts:428-432` | Hook script invoked by nothing; four zero-assertion "does not throw" specs; two permanently skipped E2E specs that read as green; orphan fixture and helper; symlink failure goes silently green; `perf:gate` has no CI runner (may extend #1333/#1734); the remove seam pins an occurrence count where the reply seam has alias guards; no E2E asserts the Solo HOLD on the pull path. | [read]/[ran] | Agent-reported, four spot-checked | [#1825](https://github.com/bloknayrb/tandem/issues/1825) |

## Doc drift (in [#1821](https://github.com/bloknayrb/tandem/issues/1821))

`ci.yml` Playwright trace comment; Critical Rule 7 "must not remove" is enforced by snapshot
review, not the test; `coverage-gate-wiring` "none in `src/` today" reads tree-wide; ADR-051
"detects deletion" means file deletion only; CLAUDE.md names `documents/watcher.ts` while
`file-watcher.ts` is the seam that four `src` modules and fifteen mocks target.

## Verified fine

No `.only` / `todo` / `fixme`; `skipIf` gates are all platform or dark-flag keyed; no un-awaited
rejects; early returns preceded by `expect`; no subject-mocking; the five wiring tests hold as
claimed; the six claims tests derive from source; coverage policy floors sane; vitest projects
avoid the 0/0 hazard; Playwright uses the reserved ports with `reuseExistingServer: false`;
`run_acceptance_tests.py` fails non-zero on zero-collected and all-skipped; `linux-runtime-deps`
positive assertions run; the E2E MCP helper throws on `isError` (a refuted lead); the 46
unreferenced testids are dynamic templates, not a gap.
