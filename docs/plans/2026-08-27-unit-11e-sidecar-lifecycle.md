# Unit 11e — Extract the Tauri sidecar lifecycle into `src-tauri/src/sidecar.rs`

Branch: `refactor/unit-11e-sidecar-lifecycle` (worktree `.claude/worktrees/units`, based on
`origin/master` @ 4bbf2df). Epic: `docs/plans/2026-08-24-ai-assisted-maintainability-remediation.md`
§ Unit 11. Predecessors merged: 11a (#1630), 11b, 11c, 11d (#1648). `lib.rs` is 5101 lines.

This is a **pure move**. No reordering, no reformatting, and no behaviour change with one
recorded exception: `log::` macros default their target to `module_path!()`, so the 20 moved log
sites change from `app_lib` to `app_lib::sidecar` in `tandem.log`, on stdout, and in `log://log`
WebView events. Nothing filters or keys on those targets (`tauri_plugin_log` is built with
`.level()` and `.targets()` only, no `.level_for`), but `tandem.log` is what support triage reads
— so it is stated rather than covered by a flat "no behaviour change", which is what 11a–11d did.

---

## 1. The cluster, and why this boundary

Identified from the source, not from the epic's line-range guess (the epic said
"~3095–3880" in the *pre-11a* numbering; that range no longer denotes anything).

**In scope — "the Node sidecar child process, from spawn to death, plus the port/health
plumbing that decides whether it is alive."** Concretely:

| Group | Items |
|---|---|
| Endpoints | `HEALTH_URL`, `SHUTDOWN_URL` |
| Timings / limits | `HEALTH_POLL_INTERVAL`, `HEALTH_TIMEOUT`, `HTTP_CLIENT_TIMEOUT`, `GRACEFUL_SHUTDOWN_DEADLINE_SECS`, `POST_KILL_PORT_RELEASE_SECS`, `SIDECAR_UNLOCK_DEADLINE_SECS`, `PORT_HOLDER_LOOKUP_TIMEOUT`, `MAX_RESTARTS`, `WS_PORT`, `MCP_PORT` |
| Child handle | `SidecarState` |
| Restart gate | `RESTART_IN_PROGRESS` |
| Lifecycle | `start_sidecar`, `stop_sidecar_gracefully`, `kill_sidecar`, `restart_sidecar` (`#[tauri::command]`), `build_http_client` |
| Health | `wait_for_health`, `check_health`, `wait_for_port_release` |
| Spawn-env resolution | `resolve_channel_dist`, `resolve_stdio_bridge_dist` |
| Port diagnostic | `NetstatRow`, `parse_netstat_row`, `find_netstat_row`, `parse_netstat_listening_pid`, `parse_netstat_lingering_port`, `parse_tasklist_image_name`, `run_system32_tool`, `PortHolder` + `impl`, `describe_process`, `describe_port_holder` (both cfg arms), `port_holder_for_dialog` (both cfg arms) |
| Exe file lock | `sidecar_exe_path`, `wait_for_sidecar_unlock` |
| Tests | `#[cfg(test)] mod port_holder_tests` |

**Out of scope, and why each is a deliberate exclusion:**

- **`SIDECAR_HEALTHY` / `SIDECAR_GAVE_UP`.** They read like sidecar state, and they are not.
  Both are documented as *"read and written ONLY under the `PendingOpens` mutex"*; their
  writers are `promote_healthy_and_drain`, `clear_healthy_under_lock` and
  `begin_start_attempt`, and their 300-line test module is `pending_opens_tests`. Splitting a
  flag from the mutex that gives it its ordering proof is the exact hazard its own doc comment
  warns about. They go wherever `PendingOpens` goes.
- **`await_sidecar_healthy`.** Polls `SIDECAR_HEALTHY`; belongs to the presence/launcher flow
  (`note_user_presence`), which is 11f's territory.
- **`show_server_error_dialog`, `attach_main_window_or_warn`.** Dialog surface, not lifecycle:
  `attach_main_window_or_warn` is shared by every `show_*_dialog`, and splitting the family is a
  worse boundary than leaving all of it for 11f. The first draft *also* justified this by "it
  keeps a fixed-path guard green", which review correctly called circular — the construct would
  not move because the guard is fixed-path, and the guard would stay fixed-path because the
  construct does not move. That leg is withdrawn: §5 now widens the guard regardless, and the
  exclusion stands or falls on cohesion alone.
- **`perform_install` / `warn_port_still_responding` / the updater.** Consumers of the
  lifecycle, not part of it. 11f.
- **`copy_sample_files`.** First-run resource copy that happens to run before spawn.
- **`OPEN_URL`, `LAUNCHER_*_URL`, `LICENSE_STATUS_URL`, `PRESENCE_HEALTH_DEADLINE`,
  `UPDATE_CHECK_INTERVAL`, `COWORK_HEAL_INTERVAL`.** Other subsystems' loopback URLs and
  cadences that merely sit adjacent in the constant block.
- **`#[cfg(test)] mod url_constants_tests`.** It pins `HEALTH_URL` *and* `OPEN_URL` *and* the
  two `LAUNCHER_*_URL`s — it is a claim about the whole loopback-URL family, not about the
  sidecar. It stays in `lib.rs` and imports the four constants it needs from `crate::sidecar`.

Result: `sidecar.rs` ≈ 1075 moved lines + a small import header. Comparable to
`context_menu.rs` (1122) and `native_theme.rs` (1173).

## 2. The exact blocks (verified against `git show HEAD:src-tauri/src/lib.rs`)

| # | Lines | Content | Count |
|---|---|---|---|
| B1 | 108–112 | `HEALTH_URL` + doc | 5 |
| B2 | 114–117 | `SHUTDOWN_URL` + doc | 4 |
| B3 | 140–198 | `HEALTH_POLL_INTERVAL` … `MCP_PORT` (contiguous; 199 `UPDATE_CHECK_INTERVAL` stays) | 59 |
| B4 | 622–623 | `SidecarState` + doc | 2 |
| B5 | 1991–2097 | `RESTART_IN_PROGRESS` … both `port_holder_for_dialog` arms | 107 |
| B6 | 2399–3129 | `stop_sidecar_gracefully` … `resolve_stdio_bridge_dist` | 731 |
| B7 | 4026–4192 | `mod port_holder_tests` | 167 |

Total **1075**. `lib.rs` should land at roughly **4029** lines (5101 − 1075 + `mod sidecar;`
+ the two `use` lines noted below), i.e. a delta of about **−1072**.

B3 and B6 are each fully contiguous — verified line by line, no non-cluster item is interleaved.

## 3. Visibility: what the move requires, and nothing more

**Rust privacy runs downward.** A private item at the crate root is visible to `mod sidecar`
because `sidecar` is a *descendant* of the crate root. So every `lib.rs` item the moved code
calls — `strip_win_prefix`, `PendingOpens`, `RejectionBatch`, `post_batch_for_app`,
`begin_start_attempt`, `promote_healthy_and_drain`, `clear_healthy_under_lock`,
`report_pending_opens_with`, `surface_startup_rejection`, `clear_startup_rejection`,
`LAUNCHER_DEFERRED` — **needs no visibility change at all**. Only the reverse direction does.

**Visibility is not name resolution, and conflating them is how this move fails to compile.**
Plan review caught the plan doing exactly that: privacy decides whether a `use` is *permitted*;
it does nothing to bring a bare path into a child module's scope. Every one of the names above
is written bare inside the moved bodies and is an `E0425`/`E0412` in `sidecar.rs` without an
explicit import. The full import header is §4a — it is part of the work, not boilerplate.

`pub(crate)` to add, each because a named `lib.rs` site reads it:

| Item | Read from |
|---|---|
| `SidecarState` **and its tuple field** | `.manage(SidecarState(Mutex::new(None)))` at `lib.rs:1432` |
| `RESTART_IN_PROGRESS` | `run()`'s initial-spawn CAS; `show_server_error_dialog` retry arm |
| `build_http_client`, `HTTP_CLIENT_TIMEOUT` | `run()` setup |
| `start_sidecar` | `run()` setup; `show_server_error_dialog` retry |
| `kill_sidecar` | `RunEvent::Exit` |
| `stop_sidecar_gracefully`, `GRACEFUL_SHUTDOWN_DEADLINE_SECS` | `perform_install` |
| `wait_for_port_release`, `POST_KILL_PORT_RELEASE_SECS` | `perform_install`, `warn_port_still_responding` |
| `wait_for_sidecar_unlock`, `SIDECAR_UNLOCK_DEADLINE_SECS` (both `cfg(windows)`) | `perform_install`'s Windows arm |
| `port_holder_for_dialog` (both arms) | `run()` setup; `show_server_error_dialog` |
| `PortHolder::message`, `PortHolder::killable_process` | `show_server_error_dialog` (`PortHolder` itself is already `pub(crate)`) |
| `WS_PORT`, `MCP_PORT` | `show_server_error_dialog`; `url_constants_tests` |
| `HEALTH_URL`, `HEALTH_TIMEOUT` | `url_constants_tests` |
| `restart_sidecar` | `generate_handler!` |

Everything else stays private to `sidecar.rs`: `SHUTDOWN_URL`, `HEALTH_POLL_INTERVAL`,
`PORT_HOLDER_LOOKUP_TIMEOUT`, `MAX_RESTARTS`, `check_health`, `wait_for_health`,
`resolve_channel_dist`, `resolve_stdio_bridge_dist`, `sidecar_exe_path`, the whole netstat
family, `describe_process`, `describe_port_holder`.

**`pub(crate)` sits between the attribute list and the item** — e.g.
`#[cfg_attr(not(target_os = "windows"), allow(dead_code))]` then `pub(crate) fn …`, and
`#[tauri::command]` then `pub(crate) fn restart_sidecar`. This is the shape that broke three
`rename_all` assertions in 11c; nothing here anchors on attribute/item adjacency, but the
line-by-line diff must expect the item line to be the changed one.

## 4. Cross-module path resolution — the E0432 trap, in both directions

Bare module paths (`sidecar_job::…`, `token_store::…`) resolve at the crate root inside
`lib.rs` and **do not resolve inside `sidecar.rs`**. Handling, chosen so the moved bodies stay
byte-identical:

- **Ungated crate-root modules** — `token_store`, `sentry_reporting`: one top-level
  `use crate::{sentry_reporting, token_store};` in `sidecar.rs`. Both `mod` declarations are
  unconditional, so this import is safe on every target.
- **`sidecar_job` (`#[cfg(target_os = "windows")] mod sidecar_job;`)**: the module *does not
  exist* off Windows, so a top-level `use crate::sidecar_job;` is an unconditional E0432 on
  macOS and Linux even though its only call site is inside a `#[cfg(target_os = "windows")]`
  block. This is verbatim the 11c break. Import it under a **mirrored cfg**:
  ```rust
  #[cfg(target_os = "windows")]
  use crate::sidecar_job;
  ```
  which keeps `job = handle.state::<sidecar_job::SidecarJob>()` in `start_sidecar` verbatim.
- **`system_paths` (also Windows-gated)**: `run_system32_tool` already writes
  `crate::system_paths::system32_exe(exe)?` and is itself `#[cfg(target_os = "windows")]`.
  Verbatim, no import. Its doc comment's intra-doc link `[`system_paths::system32_exe`]` will
  no longer resolve from the new module — a `rustdoc::broken_intra_doc_links` warning that only
  `cargo doc` sees, and CI does not run it. Left verbatim rather than edited; noted here so it
  is a recorded decision and not an oversight.
- **The inverse direction** (a Windows-only consumer losing sight of a moved type): the only
  Windows-gated `lib.rs` code that touches this cluster is `perform_install`'s
  `#[cfg(target_os = "windows")]` block, which reads `wait_for_sidecar_unlock` and
  `SIDECAR_UNLOCK_DEADLINE_SECS`. Both are themselves `cfg(windows)`, so the `lib.rs` import
  group for them carries the same cfg.

### §4a — `sidecar.rs`'s import header (the half the first draft omitted)

Three reviewers, two of them independently, found the same defect: §3 proved *privacy* and said
nothing about *resolution*, so an implementer following it literally writes a module that does not
compile on any platform. The header is part of the work:

```rust
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{Emitter, Manager};
use tauri_plugin_shell::ShellExt;

use crate::{
    begin_start_attempt, clear_healthy_under_lock, clear_startup_rejection, post_batch_for_app,
    promote_healthy_and_drain, report_pending_opens_with, strip_win_prefix,
    surface_startup_rejection, LAUNCHER_DEFERRED, PendingOpens, RejectionBatch,
};
use crate::{sentry_reporting, token_store};
#[cfg(target_os = "windows")]
use crate::sidecar_job;
```

Two traps in that block. **`Emitter` and `Manager` never appear by name in the moved text** — they
are trait imports that `.emit(` (1 site) and `.state()` (10 sites) need for method resolution, so
an identifier sweep of the moved lines finds neither and an `E0599` is the only signal. And
`Arc` is needed *here* as well as retained in `lib.rs`: `start_sidecar`'s
`Arc::new(AtomicBool::new(false))` and `lib.rs`'s `TrayAvailable` are both real.

### The `lib.rs` side

```rust
use crate::sidecar::{
    build_http_client, kill_sidecar, port_holder_for_dialog, start_sidecar,
    stop_sidecar_gracefully, wait_for_port_release, GRACEFUL_SHUTDOWN_DEADLINE_SECS,
    HTTP_CLIENT_TIMEOUT, MCP_PORT, POST_KILL_PORT_RELEASE_SECS, PortHolder,
    RESTART_IN_PROGRESS, SidecarState, WS_PORT,
};
#[cfg(target_os = "windows")]
use crate::sidecar::{wait_for_sidecar_unlock, SIDECAR_UNLOCK_DEADLINE_SECS};
```

`PortHolder` is in that group even though it is *already* `pub(crate)` — §3's table is keyed on
"visibility to add", which is a different question from "must be nameable", and review caught the
type falling through the gap. `restart_sidecar` deliberately gets **no** import: it is reached only
as `sidecar::restart_sidecar` inside `generate_handler!`. `HEALTH_URL` / `HEALTH_TIMEOUT`
deliberately get no crate-root import either — their only consumers are `#[cfg(test)]`, so a root
import would warn on every non-test build. They are imported inside `mod url_constants_tests`,
where they arrive alongside `use super::*`; an explicit `use` shadows a glob, so `WS_PORT` /
`MCP_PORT` arriving by both routes is legal and warning-free, not a duplicate-import bug.

**None of this is locally checkable.** `cargo check --target x86_64-unknown-linux-gnu` dies in
`glib-sys`'s build script for want of Linux pkg-config. **Open the PR before the local suite
finishes** and let the three-platform matrix be the oracle.

### Dead imports left behind in `lib.rs`

`use tauri_plugin_shell::ShellExt;` (line 104) becomes unused — `.shell()` has exactly one call
site, inside `start_sidecar`. Remove it. `Arc`, `Mutex`, `Duration`, `AtomicBool`, `Ordering`,
`Emitter`, `Manager` all retain other users and stay. `lib.rs` gains
`use crate::sidecar::{…}` groups (one plain, one `cfg(windows)`), plus a
`use crate::sidecar::{HEALTH_TIMEOUT, HEALTH_URL, MCP_PORT, WS_PORT};` inside
`mod url_constants_tests` (its `use super::*` reaches crate-root items only).

### `generate_handler!`

`restart_sidecar,` becomes `sidecar::restart_sidecar,`. The macro registers the **last
segment**, so the wire name stays `restart_sidecar` and the IPC contract is unchanged. Omitting
the qualification fails to compile; a *wrong* qualification compiles and silently kills the
command at runtime — which is precisely what
`tests/docs/tauri-command-registration-claims.test.ts` exists to catch, since it derives the
registered list from the macro block and the invoked list from `src/client/`.

### `mod sidecar;` placement

`lib.rs:1-9` is **two** alphabetical runs, not one: `autostart … pending_update`, then
`pub mod keychain;`, then `sentry_reporting … uninstall_scrub`. Two reviewers disagreed about the
slot, which is the signal to read the source rather than pick a verdict. `sidecar` sorts after
`sentry_reporting` and before `token_store`, which keeps the second run sorted; that is the slot.
Unconditional: the module compiles on every target (its Windows-only interior is already
individually gated).

## 5. Guards — what breaks, what does not, what to widen

Surveyed every text-scanning guard under `tests/docs/` and `tests/build/`:

- **`tests/docs/tauri-command-registration-claims.test.ts`** — parses `generate_handler!` from
  `lib.rs` by fixed path and takes the last `::` segment. The move is exactly the case it was
  written for; it should stay green and *would* go red on a wrong qualification.
- **`tests/docs/startup-open-failure-wiring-claims.test.ts`** — reads `lib.rs` by fixed path for
  `show_server_error_dialog`'s `if !retry` arm and for `OpenRoute::ServerUnavailable`. Both stay
  in `lib.rs`. Its third spec walks all of `src-tauri/src` via `rustSources()` and asserts
  `lib.rs` + `pending_update.rs` are in the set — unaffected.
- **`tests/build/screened-open-path.test.ts`** — reads `lib.rs` by fixed path for the
  `ScreenedOpenPath` carriers (`PendingOpens`, `promote_healthy_and_drain`, `try_queue_or_post`,
  `post_paths_and_surface`, `cold_start_file: Option<ScreenedOpenPath>`). All stay. Its
  offender walk is disk-derived and `sidecar.rs` constructs no `ScreenedOpenPath`
  (`start_sidecar` takes `Option<&std::path::Path>`).
- **`tests/server/platform.test.ts`** — mentions `src-tauri/src/lib.rs` in a *comment* pointing
  at the shared TIME_WAIT claim. Prose, not an assertion. Update the pointer to `sidecar.rs`
  so the cross-reference stays true; nothing depends on it mechanically.
- Everything else in that grep (`cowork-*`, `firewall-*`, `native-theme-claims`,
  `file-association-alignment`, `unc-check-duplication`, `invariant-citations`,
  `dangling-citations`) reads modules this unit does not touch.

**So no guard goes red on the move itself.** The first draft stopped there and declined to widen
the two fixed-path guards, on the grounds that a widening here would be "untested against the
break it anticipates". Review refuted that on the project's own record:

- Epic row 11a: the guard was widened to a disk-derived scan *"not re-pointed at a fixed pair — a
  two-file list would have reproduced the same bug one extraction later"*.
- Epic row 11c: *"Re-pointing it at `native_theme.rs` would re-arm the same break for 11d–11f."*
- Epic row 11d: *"across this split a hardcoded path does not go red, it goes quiet."*

Three consecutive units concluded that a fixed `lib.rs` path is a **silent** liability, and 11c
verified its widening *without* the pinned construct moving — green at baseline, red hijacked,
green hijacked with the fix reverted. The same three-point measurement is available here, and
§7's M7 already is it. **Decision reversed: widen both in this PR.**

- `tests/docs/startup-open-failure-wiring-claims.test.ts` — its `const lib = …readFileSync(LIB_RS)`
  becomes two `rustSourceDefining()` lookups, one anchored on `fn show_server_error_dialog(`, one
  on `fn handle_opened_urls(`. Reading `.code` rather than `stripRustComments(text)` is strictly
  stronger: it also strips `#[cfg(test)]` modules, which is the hole 11a closed.
- `tests/build/screened-open-path.test.ts` — its six carrier regexes move from
  `expect(LIB).toMatch(re)` to `rustSourceDefining(re, name)`. The **seventh** assertion, the
  `pub use open_candidate::{…ScreenedOpenPath…}` re-export, keeps its fixed `lib.rs` path on
  purpose: a crate-root re-export can only live at the crate root, so that path is the claim
  rather than an assumption about where code sits.

Widening is where a guard becomes zero-of-zero (#1399), so each keeps a positive control:
`rustSourceDefining` already throws on zero *and* on two-or-more matches, and §7's N4 adds
`sidecar.rs` to the walk's named-file controls.

One guard also gets a new assertion rather than a widening: §7's F3 mutant showed that spec 4 of
`tauri-command-registration-claims.test.ts` derives its `defined` map with a regex that must
tolerate `pub(crate)` between `#[tauri::command]` and `fn`. If it ever stopped matching, the map
would silently lose an entry and the spec would stay green — "an empty filter result satisfies a
zero check". A path-free `expect([...defined.keys()]).toContain("restart_sidecar")` closes it.

## 6. Procedure

1. `git show HEAD:src-tauri/src/lib.rs > /tmp/lib-head.rs` as the diff oracle.
2. Extract B1–B7 with a **line-range script that asserts its own preconditions** (first and last
   line of each block match an expected literal) — an unasserted bulk edit silently does nothing.
3. Write `sidecar.rs`: module doc comment, the §4a import header, then **B1, B2, B3, B4, B5, B6,
   B7 in their original relative order**. The first draft said "B4, B1, B2, B3, …" while
   describing it as "constants first, then state" — B4 *is* the state, so the sequence
   contradicted its own parenthetical. Original order also keeps `WS_PORT`'s doc comment
   ("keep in sync with the URL constants **above**") literally true. Nothing in the set is
   order-sensitive to the compiler: no `macro_rules!`, one inherent `impl` that travels with its
   own enum inside B6, and the `#[cfg]`-duplicated pairs are mutually exclusive.
4. Delete the blocks from `lib.rs`; add `mod sidecar;`, the two `use crate::sidecar::{…}` groups,
   the test-module import, and the `generate_handler!` qualification; drop the dead `ShellExt`.
5. **Verbatim check, both directions.** (a) For every non-blank line of `sidecar.rs` outside the
   new header, assert it appears in `/tmp/lib-head.rs`; report and justify every line that does
   not. Expectation: exactly the `pub(crate)` item lines (§3). (b) **And assert the moved lines
   are gone from post-move `lib.rs`** — review found (a) alone is one-directional. A leftover
   duplicate of any item the plan keeps private (`SHUTDOWN_URL`, `check_health`, the netstat
   family) compiles: different modules, so no `E0428`, and there is no `-D warnings` anywhere in
   `ci.yml` or the crate, so it costs a `dead_code` warning nobody reads. The `−1072` line count
   is a weak proxy that any compensating error satisfies.
6. **Doc and prose sweep**, which §5's original scope (`tests/docs/` + `tests/build/`) missed
   entirely. `docs/architecture.md`'s file map calls itself *authoritative* and 11a–11d each
   earned a bullet in it: trim the sidecar clauses from the `src/lib.rs` entry and add a
   `src/sidecar.rs` one, and re-point line 374's `TANDEM_CHANNEL_DIST` attribution. Then sweep
   `git grep -l 'lib\.rs'` across `scripts/`, `.github/`, `docs/`, `tests/` and `src-tauri/src/`
   for prose naming a moved symbol — `probe-launcher.mjs` (×2), `tauri-release.yml`,
   `tauri-webdriver.yml`, `platform.test.ts` (×2), `lessons-learned.md`, and `lib.rs`'s own
   line-18 `(as `PortHolder` is)` aside. Fixing one of eight is worse than fixing none.
7. Verify: `npm run typecheck`, `npm test`, `cargo test --manifest-path src-tauri/Cargo.toml`.
   **No `cargo fmt`** — the tree is not rustfmt-clean and it reformats unrelated files.
   No `npm run test:e2e` — another session shares the fixed ports and app-data dir.
8. Commit, push, `gh pr create` against `master`. Do not merge.

## 7. Mutation battery — measured

Run on the post-move tree against the three guards this PR touches or relies on.
**Method note, because it invalidated a first pass:** reverting each mutant with
`git checkout -- src-tauri/src/lib.rs` reverts the *whole extraction*, since `lib.rs` is tracked
and its HEAD is the 5101-line pre-move file. Four mutants silently ran against the pre-move tree
and one "survivor" was an artifact of it. Reverts are now file-snapshot copies, and every mutant
is confirmed in place (`grep`) before its run.

| Mutant | Result |
|---|---|
| M2 — delete the `sidecar::restart_sidecar` handler entry | **KILLED** (2 specs) |
| M4 — delete `report_pending_opens_with(` from the `if !retry` arm | **KILLED** |
| M5 — `terminal = true` → `false` in that arm | **KILLED** |
| M6 — `OpenRoute::ServerUnavailable => rejected.record(…)` → `=> {}` | **KILLED** |
| M7 — move `show_server_error_dialog` into `sidecar.rs` | **KILLED**, by `screened-open-path`'s `cold_start_file` carrier — the move duplicates that signature across two modules and `rustSourceDefining` requires exactly one. The *dialog* guard stays green, which is the widening working as intended |
| N3 — `HEALTH_TIMEOUT` 30 → 15 in `sidecar.rs` | **KILLED** by `url_constants_tests`, which now lives in a different module from the constant — the point of the split |
| F3 — remove `pub(crate)` tolerance from spec 4's `#[tauri::command]` regex | **KILLED** by the new `toContain("restart_sidecar")`; **survived** without it |
| N1 — leave a duplicate `const SHUTDOWN_URL` in `lib.rs` | **SURVIVED**, as predicted: compiles, emits `constant SHUTDOWN_URL is never used`, all 38 guard specs green. This is the finding that makes §6 step 5(b) load-bearing rather than belt-and-braces |
| N2 — drop the `#[cfg(windows)]` from `use crate::sidecar_job;` | **UNRUNNABLE LOCALLY.** Green on Windows by construction; only the macOS and Linux CI legs can see it. Not claimed as a kill |
| **P1** — unmutated tree | **GREEN** (38/38) |
| **P2** — rename `sidecar.rs` → `sidecar_lifecycle.rs` | **GREEN** — a harmless rename must not redden |

**A control I had to withdraw.** The first cut added `expect(rel).toContain("src-tauri/src/sidecar.rs")`
to both walks as a positive control. It is incompatible with P2 by construction, and on inspection
it buys nothing: `rustSourceDefining` already fails loudly on zero matches, so the module cannot
silently leave the scan. Pinning the filename would have re-introduced exactly the fixed-path
coupling this PR removes. Dropped, and the reason recorded here rather than left for the next unit
to rediscover.

**What M7 actually showed about "goes quiet".** The epic rows say a hardcoded path *goes quiet*
across this split. Measured on this guard, it does not: each spec asserts it *found* its construct
before asserting anything about it, so moving the dialog with the old fixed path turns the file
red. The real cost is what the loud failure buys you — the only way to green it is to re-point the
path, and a re-pointed path is armed for the next unit. That is the honest case for widening, and
it is now what the guard's own comment says.

## 8. Risks

1. **E0432 on a platform I cannot compile.** Mitigation: §4's cfg-mirrored import, plus pushing
   the PR before the local suite finishes so CI's macOS and Linux legs report early.
2. **A wrong `generate_handler!` qualification is silent at runtime.** Mitigation: M2/M3 above,
   and the existing registration guard.
3. **`SidecarState`'s tuple field needs `pub(crate)`** — a wider widening than the item alone,
   and every module in the crate can then reach `.0`. All three existing access sites use a
   poison-recovery idiom (`Err(poisoned) => poisoned.into_inner()`); a future
   `state.0.lock().unwrap()` from anywhere would panic where today's code recovers, and nothing
   flags it. Not "unavoidable" as the first draft claimed — a `pub(crate) fn new()` keeps the
   field private without touching the plugin chain — but **out of scope for a pure move**, and
   the PR body says so rather than the field growing a comment this move did not carry.
4. **Non-verbatim lines beyond the `pub(crate)` set.** Mitigation: §6 step 5 counts them
   mechanically rather than by reading.
