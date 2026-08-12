# Windows update-restart port timeouts + self-service port diagnostic

**Date:** 2026-08-12
**Status:** revised after three adversarial plan reviews (security, correctness,
Tauri/UX). Findings folded in are marked **[rev]**.

**Trigger:** Beta user (Eddie) updated v0.21.1 → v0.22.0 on Windows 11. After the
post-install `app.restart()`, the app showed:

> Server unavailable — Tandem can't reach its sync server.
> Server Error: Tandem's server failed to start. Error: Server failed to start
> after 3 restart attempts. Try restarting the application. If the problem
> persists, check that port 3479 is not in use by another process.

Recovery required running `netstat -ano | findstr :3479` + `taskkill` by hand
(the recipe in `docs/troubleshooting.md` §"Port already in use").

**Scope:** two independent, additive mitigations. NOT in scope: the ADR-043
pending-update boot marker (#1118), the update download/install flow itself, the
WebView "Server unavailable" empty state, or consolidating the eight hardcoded
`3479`s in `lib.rs`.

---

## References (verified on this branch; ✓ = re-verified by a reviewer)

| Ref | Location | What it is |
|---|---|---|
| R1 ✓ | `src-tauri/src/lib.rs:86` | `HEALTH_TIMEOUT = 15s` — per-attempt `/health` wait |
| R2 ✓ | `src-tauri/src/lib.rs:93` | `MAX_RESTARTS = 3` |
| R3 ✓ | `src-tauri/src/lib.rs:2179`, loop at `2233-2366` | `start_sidecar` |
| R4 ✓ | `src-tauri/src/lib.rs:2368-2370` | the `"Server failed to start after {MAX_RESTARTS} restart attempts"` error |
| R5 ✓ | `src-tauri/src/lib.rs:2413-2422` | `wait_for_port_release(client, deadline_secs)` |
| R6 ✓ | `src-tauri/src/lib.rs:2447-2477` | `wait_for_sidecar_unlock(deadline_secs)` (Windows-only) |
| R7 ✓ | `src-tauri/src/lib.rs:4443, 4444, 4458` | `perform_install`'s three `5`-second literals |
| R8 ✓ | `src-tauri/src/lib.rs:1226-1247` | setup()'s "Server Error" dialog — **the dialog Eddie saw** |
| R9 ✓ | `src-tauri/src/lib.rs:1577-1625` | `restart_sidecar` + `RESTART_IN_PROGRESS` |
| R10 ✓ | `src/server/platform.ts:45` | `waitForPort(port, timeoutMs = 5000)` |
| R11 ✓ | `src/server/platform.ts:88-122` | `freePortWindows` — netstat+taskkill, PID validated `/^\d+$/` |
| R12 ✓ | `src/server/index.ts:588-594`, `740-745` | the two `freePort`→`waitForPort` sites; failure is **logged and ignored** |
| R13 ✓ | `tests/server/platform.test.ts:75-133` | `waitForPort` tests |
| R14 ✓ | `docs/lessons-learned.md:234` | the prior fixed-sleep→polling fix; says "every 100ms (up to 5s default)" — **both numbers wrong** |
| R15 ✓ | `docs/troubleshooting.md:112` | manual recipe; says the server "logs … and exits" (R12: it proceeds) |
| R16 **[rev]** | `src/server/index.ts:305-345` (HTTP branch; `acquireStoreLock` in `src/server/annotations/store.ts:158`) | store-lock acquisition retries up to **30s** *before* R12 runs |
| R17 **[rev]** | `docs/architecture.md:754, 755, 799` + `docs/roadmap.md:353` | four more stale citations of the numbers Part 1 changes |
| R18 **[rev]** | `src-tauri/src/lib.rs:1159-1166` | `tauri-plugin-log` registers `TargetKind::Webview` at `LevelFilter::Warn` — `log::error!` **does** reach the WebView |
| R19 **[rev]** | `src/client/components/EmptyState.svelte:94-101` | the WebView's own "Server unavailable" + **Retry** button, shown after 3s |
| R20 **[rev]** | `src/client/components/NetworkSettings.svelte:39` | `invoke("restart_sidecar")` — the app's real recovery path |

---

## Part 1 — Widen the three ~5s ceilings

### Problem

Three 5s ceilings sit in the update→restart path, all Windows timing
assumptions. Windows holds a killed listener's port in TIME_WAIT for seconds,
and the moment we are most likely to exceed 5s is immediately after an update —
new files on disk, antivirus scanning them, installer still settling.

- R7a `wait_for_port_release(&client, 5)` → install proceeds with the old sidecar possibly alive.
- R7b `wait_for_sidecar_unlock(5)` → NSIS may fail to overwrite `node-sidecar.exe`.
- R10 `waitForPort(port, 5000)` → the fresh sidecar stops waiting, binds anyway
  (R12 swallows the error), gets EADDRINUSE, dies. Tauri retries, exhausts
  `MAX_RESTARTS`, shows R8.

### Fix

1. **`src/server/platform.ts` (R10)** — default `timeoutMs` 5000 → **15000**, with
   a comment naming post-update TIME_WAIT on Windows as the reason.
2. **`src-tauri/src/lib.rs` (R7)** — replace the three `5` literals with named consts:
   `POST_KILL_PORT_RELEASE_SECS: u64 = 15` and (Windows-only)
   `SIDECAR_UNLOCK_DEADLINE_SECS: u64 = 15`. The two warning strings hardcode
   `"after 5s"` — they must interpolate the const or the next bump makes the log lie.
3. **`HEALTH_TIMEOUT` (R1) 15s → 30s. Not optional.** The sidecar's own
   `waitForPort` runs *inside* the window `wait_for_health` is timing. Today
   5s(port) + startup < 15s(health) holds. Raising the port wait to 15s without
   raising the health timeout kills a sidecar that legitimately waited 15s — i.e.
   mitigation 1 alone would make Eddie's bug *more* likely. Verified by two
   reviewers as a real coupling.

   **[rev] Honest margin.** 30s covers 15s of port wait plus normal startup. It
   does **not** cover R16: `acquireStoreLock` retries for up to 30s on its own,
   *before* the port wait, when a genuinely live competing process holds
   `store.lock`. That case (a stray `tandem start`, a second app-data dir) can
   exhaust 30s by itself. We are not widening for it — it is a different failure
   with its own deadline and its own error — but the code comment on
   `HEALTH_TIMEOUT` must say so rather than implying 30s is universal margin.

### Deliberately unchanged

- **`MAX_RESTARTS` (R2) stays 3.** **[rev] corrected arithmetic:** backoff is
  `2u64.pow(attempt-1)` = 1+2+4 = **7s**, not 14s. Worst case to the dialog goes
  15·4+7+3 ≈ **67s** → 30·4+7+3 ≈ **127s** (the +3 is the three
  `wait_for_port_release(client, 1)` calls on the failed attempts). That is the
  accepted cost; the alternative is failing a machine that would have succeeded,
  which is the reported bug. Part 2 is what makes the longer wait tolerable.
- **Backoff**, and `wait_for_port_release(client, 1)` in R3's error arm — the
  backoff sleep right after it is the real buffer.
- **The healthy path.** All four are polling loops that return on first success.
  A wider ceiling costs zero milliseconds when the port is free.

### **[rev]** Other affected populations (verified, no action needed)

- **Stdio mode is unaffected.** R12's second site sits in a *non-awaited* async
  IIFE; `startMcpServerStdio()` is awaited outside it, so a 15s default cannot
  delay MCP init.
- **npm-global `tandem start` shares the HTTP branch.** A browser user with a
  foreign holder on 3478/3479 now waits 15s instead of 5s before auto-open.
  Acceptable; named here so it isn't a surprise.
- **CI is not coupled.** Playwright `webServer` 120s, `ci.yml` backend probe 30s,
  `dev-standalone.mjs` 60s all exceed the new ceilings, and they invoke
  `dist/server/index.js` directly, bypassing `HEALTH_TIMEOUT`.

### Tests / docs

- R13: add one test pinning the **default**, under `vi.useFakeTimers()` so it
  costs no wall clock — hold the port, call `waitForPort(port)` with no timeout,
  advance to 14 900 ms and assert still pending, advance past 15 000 ms and
  assert it rejects with `after 15000ms`.
- Rust: no existing test asserts any of these constants (independently confirmed
  by two reviewers). Add a const-invariant test asserting
  `HEALTH_TIMEOUT.as_secs() >= 30` with a comment naming the cross-language
  coupling to `src/server/platform.ts`.
- **[rev] Five doc citations, not two:** R14 (fix *both* "5s" and "100ms" — the
  poll is 200ms), R15, `docs/architecture.md:754` (15s), `:799` (5s deadline),
  `:755` ("shows an error dialog and exits" — now has a Retry button),
  `docs/roadmap.md:353` (15s).

---

## Part 2 — Make the terminal failure self-service

### 2a — Concrete diagnostic

New in `src-tauri/src/lib.rs`:

```rust
const MCP_PORT: u16 = 3479;   // keep in sync with the URL constants above
const WS_PORT:  u16 = 3478;   // Hocuspocus

fn parse_netstat_listening_pid(output: &str, port: u16) -> Option<u32>;
fn parse_tasklist_image_name(output: &str) -> Option<String>;
fn describe_port_holder(ports: &[u16]) -> Option<String>;  // "3479 by node.exe (PID 12345)"
```

**[rev] Both ports, not just 3479.** The sidecar binds 3478 *and* 3479 and
`freePort`s both (R12). A conflict on 3478 produces an identical
`wait_for_health` failure, and a 3479-only probe would return `None` for half
the affected population — degrading to exactly the generic text this exists to
replace.

Security discipline (mirrors R11 and the `reveal_command_args` tests):

- **No `cmd /c`, no pipe to `findstr`.** Filtering happens in
  `parse_netstat_listening_pid`. Strictly less surface than R11, which is
  shell-mediated.
- The only interpolated value is a `u32` from `str::parse::<u32>()` — it cannot
  carry a metacharacter by construction (a stronger guarantee than R11's regex).
- **[rev] Anchor both binaries to `%SystemRoot%\System32\`** rather than relying
  on PATH order. `firewall.rs:3-4` documents bare-name invocation as house style,
  but both binaries are guaranteed at a fixed path, so anchoring is free. Fall
  back to the bare name only if `SystemRoot` is unset.
- `CREATE_NO_WINDOW` (0x08000000) via `CommandExt::creation_flags` — a GUI app
  must not flash a console.
- **[rev] `spawn_blocking`.** `Command::output()` is synchronous and the caller
  is async; the file already uses `spawn_blocking` at `lib.rs:1272`.
- **[rev] PID-reuse TOCTOU.** Between `netstat` and `tasklist` the PID can be
  recycled, and `docs/troubleshooting.md` teaches users to `taskkill` what we
  name. Mitigation: re-run the netstat lookup after `tasklist` and only report
  if the same PID still holds the port, and word it **"appears to be held by"**
  rather than as an assertion.
- Exact port matching: split the local-address column on the **last** `:` so
  `[::1]:3479` matches and `:34790` does not.
- Every failure path returns `None`. A diagnostic must never break startup.

**[rev] Where it is called — this is the change that removes the privacy
question entirely.** The original plan folded the holder string into
`start_sidecar`'s `Err`. That is wrong: R18 shows `tauri-plugin-log` registers
`TargetKind::Webview`, so the `log::error!` in `restart_sidecar` (R9) *does*
cross into the WebView — the existing "never user-visible" comment at
`lib.rs:1610-1612` is already stale. So instead:

> `start_sidecar` returns its error unchanged. `show_server_error_dialog` — the
> setup()-only surface — computes the holder description and composes the
> message.

`restart_sidecar`'s path is untouched, and no new string crosses any boundary.
Fix the stale comment at 1610-1612 in the same pass (small, and we are in the file).

### 2b — Retry action

Extract R8 into `fn show_server_error_dialog(app: &AppHandle, error: &str,
holder: Option<String>, cold_start_file: Option<PathBuf>, allow_retry: bool)`.

**[rev] There is no existing precedent for this dialog shape** — `grep
OkCancelCustom src-tauri/src/lib.rs` returns nothing, and
`show_update_available_dialog` uses plain `OkCancel` + `blocking_show()`. This
is the first custom-label task dialog Tandem ships. Verified against the
vendored `tauri-plugin-dialog` 2.7.0 source:

- `MessageDialogButtons::OkCancelCustom(String, String)` — **takes `String`**;
  the `&str` form in the crate's own doc example does not compile (E0308).
- `show<F: FnOnce(bool) + Send + 'static>` — `true` = first (OK) label.
  **Esc and the title-bar X both map to `false`**, i.e. Close.
- Custom labels do render on Windows: the plugin pins `rfd` with
  `common-controls-v6`, selecting the `TaskDialogIndirect` backend.
- Non-blocking `.show(cb)` is correct here (`blocking_show()` from the async
  task is what `lib.rs:4202-4206` warns deadlocks). Correction to the earlier
  rationale: the plugin runs its wait on a fresh `std::thread` either way, so
  the win is not "avoids parking a Tokio worker" but "does not park *this*
  task's worker".
- **[rev] `.parent(&window)`** with the `log::warn!` fallback, matching the three
  other dialog helpers. A parentless modal that lands behind the (already
  visible — `lib.rs:1135-1137` shows the window first) main window is a real
  usability failure now that the dialog carries an action.
- **[rev] Label the button "Retry Server Start", not "Retry".** R19 puts a
  *different* Retry on screen 3s into the failure (it only re-dials the
  Hocuspocus WS, so it is inert here). Two identically-labelled Retry buttons
  with different meanings is worse than a longer label.

On `true`, the callback spawns a task that:

1. **[rev] Takes `RESTART_IN_PROGRESS` *inside* the spawned task** and releases
   it on both arms. Taking it outside would strand it forever if the callback
   never runs — `run_on_main_thread`'s error is discarded in the plugin
   (`desktop.rs:219`), and a panic in the plugin's thread unwinds silently.
2. **[rev] Passes `cold_start_file` through, not `None`.** `restart_sidecar`
   passes `None` because setup() already opened the file — on *this* path setup()
   **failed**, so nothing was opened. Without this, a user who double-clicked a
   `.md`, hit the conflict, and clicked Retry silently lands on `welcome.md`.
3. Does **not** call `clear_startup_rejection` — the buffered rejection is from
   this same launch and is still valid.
4. **[rev] Runs `check_for_update(&handle, false)` on success**, which setup()'s
   failure path `return`ed before. Otherwise a recovered session has no startup
   update check for 8h.
5. On failure, re-shows the dialog with `allow_retry: false`.

**Why "retry" and not a Rust-side kill:** `start_sidecar` spawns the sidecar,
whose first act is `freePort()` (R11) — the kill already happens, in reviewed
code that is its single owner. A `taskkill` in the Tauri shell would add a second
kill implementation *and* a second PID-reuse TOCTOU with a destructive outcome
(kill the wrong process) instead of a cosmetic one. This runs literally the same
kill-and-retry `start_sidecar` logic the brief asks for.

**[rev] The dead end must name the real exit.** R20 shows Settings → Network →
Restart server is the app's actual recovery path. The `allow_retry: false`
dialog says so, instead of implying the app is finished.

### **[rev]** Accepted limitations (stated, not fixed)

- While the retry holds `RESTART_IN_PROGRESS`, R20's Settings restart is a
  **silent** no-op (R9's contended branch is a bare `log::warn!` + `return`).
  Giving it a user-visible signal needs a new client toast contract — out of
  scope here; recorded so it is a known gap, not a discovery.
- `perform_install` (`lib.rs:4417`) does not take the gate either, so a retry can
  race an update install. Pre-existing; `app.restart()` tears everything down.
- Worst case is now two ~127s waits and two modals before the honest dead end.

### Tests

Pure-function Rust unit tests, no process spawn (same shape as
`reveal_command_tests`), using real captured output from this machine:

- `parse_netstat_listening_pid`: IPv4 LISTENING match; IPv6 `[::]:3479` match;
  `:34790` not matched; `ESTABLISHED` on the same port not matched; empty → `None`.
- `parse_tasklist_image_name`: real CSV row; the literal
  `INFO: No tasks are running which match the specified criteria.` (which
  `tasklist` prints on **exit 0** for a missing PID) → `None`; garbage → `None`.

---

## Verification

1. `npm run typecheck`
2. `npm test`
3. `cd src-tauri && cargo test` (prereqs confirmed present: both sidecar stubs in
   `src-tauri/binaries/`, all four `dist/` dirs; `cargo test --no-run` already
   passes on this machine).
4. **Not verifiable here:** the real Windows update→restart flow needs a signed
   release, an installed v0.21.1, and a published version to update to. The
   report must say so rather than claiming the user-visible bug is fixed.

## Files touched

- `src/server/platform.ts`, `tests/server/platform.test.ts`
- `src-tauri/src/lib.rs`
- `docs/lessons-learned.md`, `docs/troubleshooting.md`, `docs/architecture.md`,
  `docs/roadmap.md`
