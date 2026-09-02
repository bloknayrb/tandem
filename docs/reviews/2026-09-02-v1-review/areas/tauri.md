# Area: Desktop (Tauri shell, sidecar, updater, autostart, keychain)

**Raw:** [`../raw/findings-tauri.txt`](../raw/findings-tauri.txt) (Fable, resumed, 3 calls) and
[`../raw/gapfill-A.txt`](../raw/gapfill-A.txt), [`../raw/gapfill-D.txt`](../raw/gapfill-D.txt) (keyring feature facts).
**Manifest:** [`../raw/manifests/tauri.md`](../raw/manifests/tauri.md).
**Track:** [E desktop lifecycle](../tracks/E-desktop-lifecycle.md); Lows in [K](../tracks/K-tests-and-lows.md).
**Spot-check:** all three Highs traced through `Cargo.lock`, `tauri-build` source and `lib.rs` by
the orchestrator. **`cargo` did not build during the review** (no GTK); it does now, see
[method.md](../method.md). Every finding here is read-only; nothing in `src-tauri/` was executed.

## Findings

| Sev | Where | Finding | Evidence | Status | Issue |
|---|---|---|---|---|---|
| H | `src-tauri/Cargo.toml:47`; `Cargo.lock:3210-3217`; `token_store.rs:72-101`; `lib.rs` cfg fall-through | `keyring = "3"` with no features; `keyring` 3.6.3 has no default backend, so every platform gets the mock (entry-only persistence). `set_password` returns Ok, so the file fallback is never written; every `get_or_create_token()` mints a fresh `TANDEM_AUTH_TOKEN`; the sidecar token differs from the Cowork-provisioned one, so the Cowork VM gets 401 by construction (#1455's root cause). `data-locations.md:54-55` claims an OS store. Fix: features `apple-native` / `windows-native` / `linux-native` or `sync-secret-service`. | [read] | Source-confirmed | [#1761](https://github.com/bloknayrb/tandem/issues/1761) |
| H | `src-tauri/src/sidecar.rs:877-924`; `tauri-build` 2.6.3 `lib.rs:69` | `sidecar_exe_path` builds `node-sidecar-<triple>.exe` but `tauri-build` strips the triple, so `wait_for_sidecar_unlock` returns true immediately ("packaging bug?" warning). The Windows updater's exe-unlock wait is dead; only the NSIS `PREINSTALL` kill protects. | [read] | Source-confirmed | [#1762](https://github.com/bloknayrb/tandem/issues/1762) |
| H | `src-tauri/src/lib.rs:673-712`; `src/server/launcher/api-routes.ts:530-536` | The deferred autostart launcher can never be released: Rust POSTs `/api/launcher/start` with Authorization but no Origin; `makeStartHandler` calls `assertOriginAllowlisted`, which fails closed on a missing Origin (403). No client caller of `API_LAUNCHER_START` exists. Third no-Origin route given the gate (cf. `open` and `rotate-token` in CLAUDE.md). | [read] | Source-confirmed | [#1763](https://github.com/bloknayrb/tandem/issues/1763) |
| M | `lib.rs:~2350-2450` | `perform_install` stops the sidecar before the download; a failed download never respawns it and the UI says "running". | [read] | Agent-reported | [#1808](https://github.com/bloknayrb/tandem/issues/1808) |
| M | `sidecar.rs:493-549` | A post-boot sidecar crash is never restarted; `MAX_RESTARTS` is a boot-window budget only, while `architecture.md:~819` implies steady state. | [read] | Agent-reported | [#1809](https://github.com/bloknayrb/tandem/issues/1809) |
| M | `autostart.rs:138-151`; `lib.rs:1483-1488` | `refresh_registration` runs only on autostart launches, so moved-app and flagless-registration repair is unreachable. | [read] | Agent-reported | [#1810](https://github.com/bloknayrb/tandem/issues/1810) |
| M | `sidecar.rs:567-601` | Health poll accepts any 2xx, including from an old process. | [read] | Source-confirmed | [#1812](https://github.com/bloknayrb/tandem/issues/1812) |
| L | `sidecar.rs:443`; capabilities; `show_in_file_manager`; `lib.rs:1942,1985` + `tutorial-annotations.ts:64-68`; `firewall.rs:850-875`; `license.ts:126` | Sidecar inherits the shell env (`TANDEM_MCP_PORT` / `TANDEM_BIND_HOST` leak); capabilities over-grant `shell:default` / `fs:default` and five commands have no client caller (including `cowork_apply_token`); `show_in_file_manager` path unconfined (UNC only); `welcome.md` copied only if absent so a changed tutorial is dropped for upgraders; u8 underflow (unreachable); `LICENSE_UPDATE_ENDPOINT` not asserted https; `tandem activate <dir>` uncaught. | [read] | Agent-reported | [#1825](https://github.com/bloknayrb/tandem/issues/1825) |

## Leads not run (hardware)

All in [smoke-lines.md](../smoke-lines.md): keychain persistence and the Cowork 401; the Windows
update log's "packaging bug?" line; start-at-login then confirm the launcher is not "deferred";
update with the network dropped; kill `node-sidecar` mid-session; move the app then autostart;
`TANDEM_MCP_PORT` in the login env; NSIS `PREINSTALL` kill vs Tauri's "app running" prompt
ordering (bundler template not read).

## Doc drift (in [#1821](https://github.com/bloknayrb/tandem/issues/1821))

`data-locations.md:54-55`; `architecture.md:~860` (exe-unlock), `~819` (`MAX_RESTARTS`);
`launcher/api-routes.ts:536` comment; `sidecar.rs:443` comment; capabilities comment;
`autostart.rs:138-151`; CLAUDE.md's "single release point" is accurate but the release never
succeeds.

## Verified fine

Updater transport and pubkey; CSP; plugin registration order; `validate_open_candidate`;
`strip_win_prefix`; job object; firewall argv-only; Cowork locks; the 21 invoke names match;
entitlements; reaper logic; NSIS `$UpdateMode` guard; `fs:default` has no scope entries;
uninstall keeps app data and logs, as documented.
