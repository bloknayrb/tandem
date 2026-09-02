# Area: Upgrade and downgrade path

**Raw:** [`../raw/findings-upgrade-path.txt`](../raw/findings-upgrade-path.txt) (Opus fresh run, 90 calls
against a 70 cap; accepted). Probe: [`../experiments/upgrade-envelope-probe.ts`](../experiments/upgrade-envelope-probe.ts).
**Manifest:** [`../raw/manifests/upgrade-path.md`](../raw/manifests/upgrade-path.md).
**Tracks:** [E desktop lifecycle](../tracks/E-desktop-lifecycle.md) for the shared data dir, the
envelope and the UX items; [F](../tracks/F-push-paths-and-cli.md) for the plugin pin and skill
refresh (#1790).
**Spot-check:** the High and four Mediums read by the orchestrator; the envelope probe was the
agent's run, mechanism read (the enums are closed).

## Findings

| Sev | Where | Finding | Evidence | Status | Issue |
|---|---|---|---|---|---|
| H | `src/server/platform.ts:10-14,39-45`; `src-tauri/src/sidecar.rs:427`; `index.ts:624` | The sidecar sets `TANDEM_DATA_DIR` (used only as the welcome.md base) while the app-data resolver reads `TANDEM_APP_DATA_DIR`, so the desktop sidecar and an npm global share `sessions/`, last-seen-version, `integrations.json` and the annotation envelope dir. Alternating versions re-opens CHANGELOG on every launch of both and makes every downgrade hazard reachable without a downgrade. After the flip, `npm i -g tandem-editor@0.24.1` is a one-command gate bypass over the same dir. | [read] | Source-confirmed | [#1787](https://github.com/bloknayrb/tandem/issues/1787), [decision D](../decisions.md) |
| M | `src/server/integrations/apply.ts:2030-2035` | `installSkill` is a bare `atomicWrite` with no version comparison (only `refreshExistingSkillIfStale` compares); an older `tandem setup --apply`, which doctor prescribes, downgrades a newer installed skill. CLAUDE.md:273 conflates the two. | [read] | Source-confirmed | [#1790](https://github.com/bloknayrb/tandem/issues/1790) |
| M | `.claude-plugin/plugin.json:14,21,31,37` | All four commands pin `tandem-editor@0.24.1`; desktop and npm upgrades never move the pin, so plugin users run an old bridge, channel and monitor against every new server. | [read] | Source-confirmed (grep) | [#1790](https://github.com/bloknayrb/tandem/issues/1790) |
| M | `src/server/annotations/store.ts:605-622` | The `.future` park path is `console.error` only (the corrupt path toasts), and `fs.unlink(futurePath)` runs *before* the rename, so a second downgrade cycle deletes the only parked copy. Dormant until `SCHEMA_VERSION` > 1. | [read] | Source-confirmed | [#1791](https://github.com/bloknayrb/tandem/issues/1791) |
| M | `src/server/annotations/schema.ts:215-224`; `src/shared/types.ts:17,19` | Passthrough covers new fields, but a new enum value (`type`, `status`, `author`) fails `z.array`, so the whole envelope is renamed `.corrupt` with zero annotations. The header at `schema.ts:4-13` promises the opposite. | [ran] | Agent-ran (probe); mechanism read | [#1791](https://github.com/bloknayrb/tandem/issues/1791) |
| M | `useTandemSettings.svelte.ts:91`; `integrations/storage.ts:101-106`; `api-routes.ts:792-796,1152-1158`; `lib.rs:1942,1985`; `tutorial-annotations.ts:64-68` | `_readOnly` after a downgrade makes every non-modal settings control inert with no feedback; a future-schema `integrations.json` error is swallowed to a bare 500 and doctor has no check; `welcome.md` is copied only if absent and the tutorial anchors by `indexOf`, so a changed tutorial is dropped for upgraders only. | [read] | Agent-reported | [#1792](https://github.com/bloknayrb/tandem/issues/1792) |
| L | `src/server/index.ts:562`; `version-check.ts:24-33` | Skill refresh and the CHANGELOG-on-upgrade open sit inside `if (transportMode === "http")`; any-mismatch reads as "upgraded" (a downgrade shows the old changelog); the stamp is written before the open is attempted. | [read] | Source-confirmed | [#1792](https://github.com/bloknayrb/tandem/issues/1792) |

## Leads not run

- **Silent NSIS auto-update may skip `PageLeaveReinstall`**, so no `/UPDATE` flag and a full
  uninstall scrub of app data on every auto-update. Would be High and contradicts
  `data-locations.md:89-93`. Needs `tauri-plugin-updater`'s `install_inner` plus the bundled
  `installer.nsi` (not vendored) or one Windows run: the first [smoke line](../smoke-lines.md) and
  on the [release gate](../release-gate.md).
- Sidecar exe-unlock tolerance (`lib.rs:2372-2392`), third smoke line.
- Session `modelRevision` check is one-directional (`manager.ts:226`).

## Verified fine

The integrations v1→v2→v3 migration chain refuses future versions; the client settings 20-step
chain and `REMOVED_FIELDS`; the #1118 marker design (no fresh-install false positive, written at
download-finish); the updater's strictly-greater semver (no downgrade; prerelease < release;
`{{target}}` expanded for builder endpoints too); `tauri-release.yml` manifest verification; the
plugin-version-pin test; deprecated tool stubs warn; `loadSession` re-validates the path; a
future-major license fails closed with a distinct reason.
