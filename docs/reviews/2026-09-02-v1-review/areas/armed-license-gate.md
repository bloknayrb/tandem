# Area: The license gate, armed

**Raw:** [`../raw/findings-license-gate.txt`](../raw/findings-license-gate.txt) (Opus fresh run, 48 calls;
ran the full suite under `TANDEM_LICENSE_GATE=1`: 615 files, 10,140 passed, 0 failed);
[`../raw/gapfill-F.txt`](../raw/gapfill-F.txt) (live probes with the gate armed on the scratch server).
**Track:** [H the flip](../tracks/H-the-flip.md); the copy items are #1819 (also track H).
**Spot-check:** all three Highs and the two Mediums read by the orchestrator (`sed`); the
`/api/mode/release` and `firstRunAt: ""` behaviours were live-probed by the gap-fill agent.

The gate ships dark and must stay byte-identical until the flip (CLAUDE.md, ADR-040). Every finding
here is about what happens *after* the flip; none changes shipped behaviour today. The scratch
server recipe that arms it is [`../experiments/server-probes/run.sh`](../experiments/server-probes/run.sh).

## Findings

| Sev | Where | Finding | Evidence | Status | Issue |
|---|---|---|---|---|---|
| H | `src-tauri/src/lib.rs:2212-2252`; `tauri.conf.json:107-109` | `entitled_license_id()` returns None for every non-entitled case and `build_updater()` falls back to the public GitHub `latest.json`, so the update window gates nobody; an out-of-window buyer still updates even after the endpoint const is filled. `docs/security.md:179` is false as shipped. Fix is separate from filling the const: neutralise the `tauri.conf.json` endpoint at the flip. | [read] | Source-confirmed | [#1785](https://github.com/bloknayrb/tandem/issues/1785) |
| H | `src-tauri/src/lib.rs:171` | `const LICENSE_UPDATE_ENDPOINT: &str = "";` early-returns in `entitled_license_id`. A **second** const must flip at v1.0, in a second language; CLAUDE.md's "one const flips" is wrong. | [read] | Source-confirmed | [#1785](https://github.com/bloknayrb/tandem/issues/1785) |
| H | `infra/license-update-worker/src/worker.ts:31-42,90-101`; Settings warning | `reason` is logged only, never returned; the Settings warning keys on local `updateWindowCurrent`. "You're up to date forever" has no client-side detector; the worker's enum is operator-only and (see the infra area) retained nowhere. | [read] | Source-confirmed | [#1786](https://github.com/bloknayrb/tandem/issues/1786) |
| M | `src/server/mcp/routes/mode-release.ts:80-107`; `api-routes.ts:396`; `docs/licensing-explained.md` | `POST /api/mode/release` clears `heldInSolo` markers under `withModeRelease` with no `licenseGate` and is absent from the gated-set list (grep: 0 hits). Armed and restricted: `tandem_edit` → `LICENSE_REQUIRED`, `mode/release` still 200. The rest of the gated set matches source both ways (13 MCP + 7 `/api`). | [ran] | Agent-ran (probe) + source-confirmed | [#1788](https://github.com/bloknayrb/tandem/issues/1788) |
| M | `src/server/license/license-state.ts:128-130` | `tf?.firstRunAt ? … : nowMs` fails **open** for `""`, null, 0 or corrupt JSON: a fresh 14-day trial each launch, and `""` is never rewritten (`wx` flag) so it is perpetual. An unparseable non-empty value fails the opposite way (NaN → restricted). Two failure directions for one file. | [ran] | Reproduced (probe) | [#1788](https://github.com/bloknayrb/tandem/issues/1788), [decision 5](../decisions.md) |
| M | `provider.ts:130-157`; `useLicense.svelte.ts:65-75`; `tandem_resolveAnnotation` | Surface A is per-connection with a 60 s client poll whose catch is empty; in restricted mode Claude can resolve annotations while the human cannot edit. | [read] | Agent-reported | [#1788](https://github.com/bloknayrb/tandem/issues/1788), [decision F](../decisions.md) |
| M | Settings copy; `licensing-explained.md:24`; `TANDEM_APP_DATA_DIR` | Settings tells a desktop buyer to run `tandem activate` (no CLI in the bundle); the doc says double-click the `.license` file but no association exists; `TANDEM_APP_DATA_DIR` relocates `trial.json` and `license.json`; the pinned public key has no dated rotation issue. | [read] | Agent-reported | [#1789](https://github.com/bloknayrb/tandem/issues/1789) |
| M | `license-state.ts:127-144`; `lib.rs:2157-2168` | `daysRemaining` unclamped; up-to-date dialog has no ended-window branch. | [read] | Agent-reported | [#1819](https://github.com/bloknayrb/tandem/issues/1819) |
| L | `license.ts:126`; `LicenseUi.editable`; verifier | `tandem activate <dir>` uncaught; `editable` dead; no deactivation path; verifier brand not shape-validated; the dark path leaks a `licenseInstalled` boolean to LAN. | [read] | Agent-reported | [#1825](https://github.com/bloknayrb/tandem/issues/1825), [#1822](https://github.com/bloknayrb/tandem/issues/1822) |

## Leads not run

- Armed **and restricted** was never exercised by the suite: with no `trial.json` the unit tests
  inject `gateEnabled`. Add a fixture with an expired `trial.json` (in #1788).
- The updater's behaviour on an `http://` endpoint (rejected in release builds unless the dangerous
  flag is set; error swallowed on the auto path) is a Low in #1825.

## Verified fine

`dist` compiles the flag to `true ? false : void 0`; canonicalization is injective; activation is
verify-then-persist; `license.json` is 0600; wall dismissal does not re-enable editing;
`/api/license/status` while dark has no PII; the `reason` enum matches the worker 5/5.
