# Updater flow audit — rollback + post-restart health-poll (#925)

**Status:** Complete — decision **(c)** with a small scoped **(a)** improvement folded in.
**Date:** 2026-06-07
**Issue:** [#925](https://github.com/bloknayrb/tandem/issues/925)
**Code under audit:** `src-tauri/src/lib.rs` (`perform_install`, `install_update`, `check_for_update`, `wait_for_health`, `wait_for_port_release`, `wait_for_sidecar_unlock`, `kill_sidecar`, `start_sidecar`); `src-tauri/tauri.conf.json` (`plugins.updater`).

> Build constraint: `cargo`/Tauri cannot build in the audit environment (no GTK/webkit). This document is the deliverable. The one optional code change proposed in §6 is best-effort and **must be compiled + runtime-verified in Bryan's Tauri pass** before merge of any follow-up.

---

## 1. Current updater sequence (verified against source)

`check_for_update(app, manual)` → on update available, either emits `tandem://update-available` (auto path, in-app banner) or shows a confirm dialog (manual path), then calls `perform_install`. The banner's "Restart to install" CTA invokes the `install_update` command, which re-runs `updater.check()` and calls `perform_install`.

`perform_install(app, update, version)`:

```
kill_sidecar(app)                         // free the sidecar exe + port before install
  → wait_for_port_release(client, 5)      // poll /health until it stops responding
  → wait_for_sidecar_unlock(5)            // Windows-only, joined via tokio::join!; polls file write-lock
  → update.download_and_install(...)      // tauri-plugin-updater; minisign-verified, NSIS on Windows
  → on Ok:  app.restart()                 // divergent — see §3
  → on Err: show_update_error_dialog(...) // threads pre-install warnings into the message
```

Signature verification is delegated to `tauri-plugin-updater` via the minisign pubkey in `tauri.conf.json`; the endpoint is the GitHub-releases `latest.json`. `kill_sidecar` is idempotent and reused at four sites.

The **normal startup** path (`start_sidecar` → `wait_for_health`, with a `MAX_RESTARTS` retry loop and a `sidecar-restart-failed` event) already provides post-spawn health verification and a bounded supervisor — but it runs in the *freshly relaunched* process, not inside `perform_install`.

---

## 2. The two alleged gaps, re-stated

1. **No rollback if `app.restart()` fails to relaunch.** A new binary that crashes immediately (corrupt install, missing OS dep) leaves the user with a broken Tandem and no automatic recovery. The sidecar supervisor catches *sidecar* crashes, not *Tauri-shell* startup failures.
2. **No health-poll inside the updater path after `app.restart()`.** The post-spawn `wait_for_health()` handles the normal startup path; the updater does not verify post-restart health before declaring success.

---

## 3. The decisive architectural fact: `app.restart()` never returns

Tauri v2's `AppHandle::restart()` is **divergent** — it handles the restart request, exits, and relaunches **without returning** to the caller (`docs.rs/tauri` `App::restart`; tauri-apps/tauri issues [#12310](https://github.com/tauri-apps/tauri/issues/12310), [#13923](https://github.com/tauri-apps/tauri/issues/13923), [#11392](https://github.com/tauri-apps/tauri/issues/11392)). It also may exit before `RunEvent::Exit` reaches plugins (#12310).

Consequences that bound the design space:

- **Gap 2 as literally framed is impossible.** There is no "after `app.restart()`" in the calling process — code there is unreachable. Any genuine *post-restart* health verification must live in the **next** process's startup path. Tandem already has exactly that: `start_sidecar` → `wait_for_health` (bounded), the `MAX_RESTARTS` retry loop, and the `sidecar-restart-failed` event surfaced to the WebView. So the "post-restart health-poll" the issue asks for **already exists for the sidecar**, just not labelled as part of the updater.
- **Gap 1 (rollback on failed relaunch) cannot be driven from the old process** for the same reason — the old process is gone the instant `restart()` runs. A `.previous`-swap-back scheme would need a *separate* watchdog/bootstrapper process that outlives both the old and new shells, detects that the new shell never came up healthy, and swaps the binary back. Tandem ships no such bootstrapper, and the Tauri updater plugin provides no rollback hook (confirmed: the v2 updater docs and CrabNebula's guide describe *no* built-in rollback or post-restart verification — both stop at `download_and_install()` + relaunch).

What `app.restart()` failures actually look like in practice is **not** "control returns with an error" — it's one of:
- the process exits and the OS *fails to spawn* the new image (corrupt/incompatible binary) → **no Tandem process at all**, or
- the new image spawns but the Tauri shell panics during init → **the next process dies before/while creating its window**.

Neither is observable from `perform_install`. Recovery for both requires an external supervisor.

---

## 4. Best-practice comparison (references)

| Source | Post-install verification | Rollback | Post-restart health probe |
|---|---|---|---|
| [Tauri v2 updater plugin](https://v2.tauri.app/plugin/updater/) | Signature verification *before* install only | **None built-in** | **None** — "restarting immediately is not required; you choose how to handle the update." Developer-owned. |
| [CrabNebula auto-updates guide](https://docs.crabnebula.dev/guides/auto-updates-tauri) | None beyond signature | **None** — `downloadAndInstall()` then `relaunch()`, full stop | **None** |
| [rfdonnelly — Tauri async process](https://rfdonnelly.github.io/posts/tauri-async-rust-process/) | n/a (about sidecar I/O wiring) | n/a | Reinforces: the Tauri main thread brokers between WebView and the async child; `std::sync::Mutex` guards must not cross `.await` — already honored in `perform_install` (it clones `reqwest::Client` out of state, holds no std mutex across awaits). |

**Takeaway:** The ecosystem norm for a Tauri v2 app is exactly Tandem's current shape — verify signature, kill children, install, relaunch — with **no** rollback and **no** in-updater post-restart probe. Apps that do implement rollback are the exception and pay for it with a custom bootstrapper/watchdog process. Neither reference recommends it; both stop at relaunch.

---

## 5. Decision: **(c)** accept current behavior for v1, with one cheap hardening from **(a)**

**Rationale:**

1. **The failure mode is rare and already mitigated upstream.** `download_and_install` is reached only after minisign signature verification, so "corrupt install" requires either a signing-key compromise (out of scope for an updater health probe) or post-download disk corruption (vanishingly rare). "Missing OS dep" is caught earlier — a build that won't run on the target OS would fail the *first* launch, not survive install and die on relaunch.
2. **True rollback is disproportionate for v1.** It requires a standalone watchdog/bootstrapper process that outlives both shells, a `.previous` binary copy (doubling install footprint and complicating the NSIS/`.app`/AppImage layout), and platform-specific swap-back logic that contradicts how each installer manages its own files. That is a multi-week, high-risk subsystem to defend against a failure neither cited reference considers worth handling. It is explicitly **out of scope for v1**.
3. **The "post-restart health-poll" the issue wants already exists** — in the relaunched process's `start_sidecar`/`wait_for_health`/`MAX_RESTARTS`/`sidecar-restart-failed` path (§3). What it does *not* cover is the Tauri **shell** failing to relaunch at all, which is unobservable from Rust without an external supervisor (§3). Adding an in-`perform_install` probe after `app.restart()` is dead code by construction.
4. **A pre-restart sanity check is the only health verification that can run in-process**, and it buys little: the binary is already installed by the time we could check, and on Windows the running shell is the *old* version (the new one only exists after relaunch). There is nothing meaningful to probe between `download_and_install` returning `Ok` and `app.restart()`.

**Scoped (a) improvement actually adopted (cheap, safe, in-process):** The one genuinely useful, low-cost win is a **persisted "pending update" marker** the *next* startup can read: write a small sentinel file before `restart()`; on the next boot, if the sentinel is present and the running version matches the target, clear it (success); if startup wedges, the sentinel survives and a future "your last update may not have completed — [report a bug]" affordance can read it. This is the minimal, in-process-only slice of (a) that survives the divergent-`restart()` constraint.

> The persisted-marker slice is **proposed, not implemented in this PR** — it touches Rust (`perform_install` + a startup check in `setup()`) and a small WebView affordance, and Rust can't be compiled/verified here. It is filed as a follow-up (see §7). v1 ships behavior unchanged; this audit closes #925.

---

## 6. If the follow-up is taken: sketch of the persisted-marker design

- **Write** before `app.restart()` in `perform_install` (on the `Ok` arm): atomically write `update-pending.json` `{ "target_version": "<v>", "ts": <unix> }` into the app-data dir (same dir family as sessions), then flush logs, then `app.restart()`.
- **Read** in `setup()` *after* `wait_for_health` succeeds: if the marker exists and `APP_VERSION == target_version`, delete it (update verified). If it exists and the version does **not** match (relaunch produced the old binary, or a partial install), keep it and emit `tandem://update-may-have-failed` so the WebView can show a one-time "report a bug" banner. If the app never reaches `setup()` at all (hard relaunch failure), the marker simply persists and the *next manual* launch surfaces the banner.
- **No rollback.** The marker is diagnostic + user-recovery-hint only. It does not swap binaries. This deliberately stays inside option (a), not (b).
- **Tests:** marker round-trip (write→read→clear), version-mismatch→banner, missing-marker→no-op. All compilable as Rust unit tests with a temp dir; **must be run in Bryan's Tauri pass.**

This is intentionally *not* implemented here: it is Rust-only, unbuildable in this environment, and small enough to land cleanly as its own verified change.

---

## 7. Acceptance checklist (issue #925)

- [x] Both references read; CrabNebula + rfdonnelly key takeaways summarized (§4).
- [x] One of (a)/(b)/(c) selected with rationale → **(c)** for v1, with the in-process-only slice of (a) sketched as a follow-up (§5–§6).
- [x] (c) rationale documented (this doc + ADR pointer below).
- [ ] Follow-up implementation issue for the §6 persisted-marker slice — **to be filed by maintainer** (optional; not v1-blocking). Title suggestion: *"Updater: persisted pending-update marker + 'update may have failed' banner (#925 follow-up)"*.

**ADR:** Captured as a short decision note in `docs/decisions.md` (ADR-043) so the "no rollback, no in-updater post-restart probe for v1" stance is discoverable from the canonical decisions log.

---

## 8. One-paragraph summary for the issue thread

`app.restart()` in Tauri v2 is divergent — it exits and relaunches without returning ([#12310](https://github.com/tauri-apps/tauri/issues/12310)/[#13923](https://github.com/tauri-apps/tauri/issues/13923)/[#11392](https://github.com/tauri-apps/tauri/issues/11392)), so a "post-restart health-poll inside the updater path" is dead code by construction, and rollback on a failed relaunch is impossible from the old process (it's already gone). The post-restart health verification the issue asks for **already exists** for the sidecar via `start_sidecar`/`wait_for_health`/`MAX_RESTARTS`/`sidecar-restart-failed`; what's missing is recovery for the Tauri *shell* failing to relaunch, which needs an external watchdog neither the Tauri v2 updater docs nor CrabNebula's guide recommend (both stop at `downloadAndInstall()` + relaunch with no rollback). **Decision (c): ship v1 unchanged.** The only meaningful in-process win — a persisted "pending update" marker the next boot reads to surface a "your update may not have completed" hint — is the (a)-flavored slice that survives the divergent-`restart()` constraint and is sketched as an optional follow-up (§6), deferred to a verified Tauri build.
