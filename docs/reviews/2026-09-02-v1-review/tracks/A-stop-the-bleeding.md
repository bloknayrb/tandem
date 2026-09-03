# Track A — Stop the bleeding

**Tier:** Opus builds, Fable reviews the plan. **Decisions needed:** none; decisions 1 and 2 are
taken. **Can start now.** **Release relation:** ships with the next minor
([release-gate.md](../release-gate.md)); not a blocker, but the line to cut the release behind.

Eleven server issues, each small, each unrecoverable data loss or a silent failure on an ordinary
action. They share nothing architecturally, so this track is a queue, not a design.

## Issues

| Issue | What | Area | Experiment (before / after) |
|---|---|---|---|
| [#1749](https://github.com/bloknayrb/tandem/issues/1749) | Re-arm `fs.watch` after every rename-replace, including Tandem's own `atomicWrite`; surface a banner when the watcher is dead. | [server-data](../areas/server-data.md) | `watch-rename.mjs` |
| [#1750](https://github.com/bloknayrb/tandem/issues/1750) | Hash the session key (keep a readable prefix); per-document try/catch in the autosave loop; write `SAVED_AT_VERSION` before `saveSession` can throw. | [server-data](../areas/server-data.md) | `exp4.ts` |
| [#1752](https://github.com/bloknayrb/tandem/issues/1752) | Bounds, integer, non-empty and surrogate-boundary checks in `validateRange`; one error code. | [server-mcp](../areas/server-mcp.md), [crdt](../areas/crdt.md) | `probe-tools.mts`, `exp2.ts`, `exp8.ts` |
| [#1756](https://github.com/bloknayrb/tandem/issues/1756) | Desktop Quit goes through `stop_sidecar_gracefully`. Rust; `cargo test` must run. **Shipped on `RunEvent::Exit`, NOT the `ExitRequested` + `prevent_exit()` shape this row originally prescribed** — ⌘Q / Dock Quit reach `applicationWillTerminate:` and never raise `ExitRequested`, the Linux no-tray close raises it twice, and `prevent_exit()` is a no-op for a restart-coded exit. See the round-1 note in [the spec](specs/A4-1756.md). | [server-runtime](../areas/server-runtime.md) | none automated; macOS smoke line |
| [#1757](https://github.com/bloknayrb/tandem/issues/1757) | `stdin.on("error")` on the child; treat EPIPE as child-gone, not fatal. | [server-runtime](../areas/server-runtime.md) | `epipe2.mjs`, `epipe3.mjs`, `epipe4.mjs` |
| [#1768](https://github.com/bloknayrb/tandem/issues/1768) | No-arg `restoreBackup` lists the sidecar as an entry and never restores; the restore path honours `readOnly`, the conflict check and the self-write fingerprint (decision 1). | [server-mcp](../areas/server-mcp.md) | `probe-tools.mts` |
| [#1795](https://github.com/bloknayrb/tandem/issues/1795) | Run user regexes off the event loop (worker) or under a real timeout; return partial matches with a `truncated` flag instead of `FORMAT_ERROR`. | [server-mcp](../areas/server-mcp.md) | `probe-redos.mts` |
| [#1796](https://github.com/bloknayrb/tandem/issues/1796) | Stop mapping every `FILE_NOT_FOUND` to "No document is open"; convert reports the missing directory. | [server-mcp](../areas/server-mcp.md) | `probe-tools.mts` |
| [#1797](https://github.com/bloknayrb/tandem/issues/1797) | `closeDocumentById` uses one id for lookup and cleanup. | [server-mcp](../areas/server-mcp.md) | `probe-tools.mts` |
| [#1798](https://github.com/bloknayrb/tandem/issues/1798) | `.html` opens read-only; annotations still work; `sessionOnly` saves stop reporting `saved: true` (decision 2). | [server-mcp](../areas/server-mcp.md) | `probe-tools.mts` |
| [#1800](https://github.com/bloknayrb/tandem/issues/1800) | Quarantine a corrupt `ydocState` (`.corrupt.<ts>`) and open from the markdown; toast once. | [server-data](../areas/server-data.md) | `exp3.ts` |

## Order

1. #1752 first: three other fixes (#1768's list path, #1798, the #1823 range Lows) assume the
   range checks exist, and `crdt-reviewer` should see the new `validateRange` once, not four times.
2. #1749 and #1750 together: both are in the save path and share the `document-service.ts`
   `SAVED_AT_VERSION` ordering.
3. #1757 and #1756: the supervisor and Quit paths; the second needs a Rust build.
4. The rest in any order.

## Reviewer agents

`crdt-reviewer` on #1752; `security-reviewer` on #1768 and #1798 (both change what a write can
reach on disk) and on #1797 (a route-reachable id). `annotation-model-reviewer` is not needed here.

## Done when

- Every experiment in the table prints its "fixed" output (the "still broken when" column of
  [experiments/README.md](../experiments/README.md) no longer matches), and each has become a
  vitest spec under `tests/server/`.
- `probe-tools.mts` passes all cases.
- `cargo test` passes and the macOS Quit smoke line is in `docs/release-smoke-checklist.md`
  (or handed to track E if E lands the checklist first).
- CLAUDE.md's Critical Rule 4 sentence and `docs/mcp-tools.md`'s range wording say what
  `validateRange` now enforces.

## Status

_(empty; fill in as issues close, or trust the tracker)_
