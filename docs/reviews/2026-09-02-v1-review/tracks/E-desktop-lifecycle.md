# Track E — Desktop lifecycle and the upgrade path

**Tier:** Opus builds the Rust and the server halves; then hardware (Bryan) for the smoke lines.
**Decisions needed:** [D](../decisions.md) (the npm gate bypass) gates #1787's second half only.
**Release relation:** the first three [smoke lines](../smoke-lines.md) are on the
[release gate](../release-gate.md); the code here is not. **Prerequisite:** `cargo test` must
run, see the setup recipe in `docs/gotchas.md` under Testing & E2E.

## Issues

| Issue | What | Area |
|---|---|---|
| [#1758](https://github.com/bloknayrb/tandem/issues/1758) | `freePort` before the store-lock retry, or refuse to start when a healthy holder answers `/api/health` with a Tandem identity; never SIGKILL a responding instance. Fix the smoke-checklist line that certified the opposite. | [server-runtime](../areas/server-runtime.md) |
| [#1761](https://github.com/bloknayrb/tandem/issues/1761) | `keyring` with platform features (`apple-native`, `windows-native`, `linux-native` or `sync-secret-service`); a test that the backend is not the mock; make the file fallback real when the store is unavailable. Root cause of #1455. | [tauri](../areas/tauri.md) |
| [#1762](https://github.com/bloknayrb/tandem/issues/1762) | `sidecar_exe_path` resolves the name `tauri-build` actually emits; a test that the path exists in a built bundle. | [tauri](../areas/tauri.md) |
| [#1763](https://github.com/bloknayrb/tandem/issues/1763) | The launcher release route accepts the Rust caller: either the sidecar POSTs with a Tauri Origin, or the route drops `assertOriginAllowlisted` and relies on the loopback invariant plus a parsed-JSON-body proof as `rotate-token` does. CLAUDE.md's no-Origin route list grows by one either way. | [tauri](../areas/tauri.md) |
| [#1787](https://github.com/bloknayrb/tandem/issues/1787) | The sidecar sets `TANDEM_APP_DATA_DIR` (or the resolver honours `TANDEM_DATA_DIR`) so desktop and npm stop sharing a data dir; then decision D. | [upgrade-path](../areas/upgrade-path.md) |
| [#1791](https://github.com/bloknayrb/tandem/issues/1791) | Envelope forward compatibility: unknown enum values degrade one record, not the file; the `.future` park path toasts and unlinks *after* the rename. | [upgrade-path](../areas/upgrade-path.md) |
| [#1792](https://github.com/bloknayrb/tandem/issues/1792) | Downgrade shows the right changelog; settings read-only state has feedback outside the modal; future-schema `integrations.json` gives a readable error and a doctor check; welcome.md refreshes on upgrade. | [upgrade-path](../areas/upgrade-path.md) |
| [#1808](https://github.com/bloknayrb/tandem/issues/1808) | `perform_install` respawns the sidecar when the download fails. | [tauri](../areas/tauri.md) |
| [#1809](https://github.com/bloknayrb/tandem/issues/1809) | Steady-state sidecar restart with a backoff budget, or make `architecture.md` say there is none. | [tauri](../areas/tauri.md) |
| [#1810](https://github.com/bloknayrb/tandem/issues/1810) | `refresh_registration` on every launch, not only autostart ones. | [tauri](../areas/tauri.md) |
| [#1812](https://github.com/bloknayrb/tandem/issues/1812) | The health poll checks a Tandem identity and generation, not any 2xx. | [tauri](../areas/tauri.md) |

Experiment: `experiments/upgrade-envelope-probe.ts` (#1791). Everything else in this track is a
Rust path with no automated reproduction; the smoke lines are the verification.

## Order

1. #1761 first: it is the root cause of an already-reported user-facing bug (#1455) and the fix is
   a `Cargo.toml` line plus a test.
2. #1763 and #1812 together (the launcher and health paths both talk to the server's identity).
3. #1758 and #1787 together: both are about two Tandems on one machine.
4. #1762, #1808, #1809, #1810: the updater and restart paths; then the Windows smoke run.
5. #1791 and #1792 last; #1791's second half is dormant until `SCHEMA_VERSION` > 1.
6. Merge [smoke-lines.md](../smoke-lines.md) into `docs/release-smoke-checklist.md` in this track,
   whichever issue lands first.

## Rules that bite here

- `strip_win_prefix()` on every path handed to the sidecar; `TAURI_HOSTNAME`, never a raw string.
- `open` and `rotate-token` must not get the origin gate (CLAUDE.md Security); #1763 is the same
  class and the fix must not be to add an Origin the CLI cannot send.
- The `LAUNCHER_DEFERRED` latch is re-read on every spawn; `show_main_window` is the single
  release point. No `tandem:settings` field.
- Adding a config writer widens the accepted finding #1599; `tests/docs/config-writer-set-claims.test.ts`
  pins the set.

## Reviewer agents

`security-reviewer` on #1761, #1763 and #1787 (token storage, a gate change, and what a second
process can reach); nothing here needs the annotation or CRDT reviewers.

## Done when

- `cargo test` includes a test that fails on the mock keyring backend and on a missing sidecar
  path.
- The launcher UI never shows "deferred" after a login-launched session on a real machine (smoke).
- `npm i -g tandem-editor` and the desktop app run side by side on separate data dirs, and
  `tandem` refuses to displace a healthy desktop server.
- The Windows update smoke lines pass on a real 0.24.1 → next upgrade and the checklist carries
  the new lines.
- Decision D is recorded.

## Status

_(empty)_
