# Area: Server runtime (process lifecycle, launcher, integrations writer)

**Raw:** [`../raw/findings-server-runtime.txt`](../raw/findings-server-runtime.txt) (Fable, resumed, 4 calls)
and [`../raw/gapfill-A.txt`](../raw/gapfill-A.txt), [`../raw/gapfill-D.txt`](../raw/gapfill-D.txt).
**Manifest:** [`../raw/manifests/server-runtime.md`](../raw/manifests/server-runtime.md).
**Tracks:** [A](../tracks/A-stop-the-bleeding.md) for Quit and EPIPE; [E](../tracks/E-desktop-lifecycle.md)
for the lock-then-`freePort` ordering; [F](../tracks/F-push-paths-and-cli.md) for the config writer;
Lows in [K](../tracks/K-tests-and-lows.md).
**Spot-check:** both Highs (one by grep, one by re-running `epipe2/3/4.mjs`), the lock ordering by
reading `index.ts:312` and `:580`.

## Findings

| Sev | Where | Finding | Evidence | Status | Issue |
|---|---|---|---|---|---|
| H | `src-tauri/src/lib.rs:1404,1574,1613`; `sidecar.rs:187`; `lib.rs:2362` | Quit → `app.exit(0)` → `RunEvent::Exit` → `kill_sidecar`. No `ExitRequested`/`prevent_exit`; `stop_sidecar_gracefully` is called only from restart and update. Up to 60 s of edits and the tab set are lost; the store lock is left behind. `docs/architecture.md:843` documents Quit as "kill sidecar, then exit". | [read] | Source-confirmed (grep) | [#1756](https://github.com/bloknayrb/tandem/issues/1756) |
| H | `src/server/launcher/supervisor.ts:901-922`; `index.ts:154-178` | `stdin.write` to a mid-exit child raises EPIPE as an `'error'` on the Writable; no `stdin.on("error")` exists and the `ChildProcess` listener does not catch it, so `uncaughtException` → `handleFatalError` exits 1 with no flush. | [ran] | Reproduced (`epipe2.mjs`, `epipe3.mjs`, `epipe4.mjs`: `UNCAUGHT: EPIPE`) | [#1757](https://github.com/bloknayrb/tandem/issues/1757) |
| M | `src/server/index.ts:302-372` vs `:580-581`; `platform.ts:179-244` | The 30 s store-lock retry runs *before* `freePort`, so a second instance stalls, commits to read-only, then SIGKILLs the healthy holder of 3478/3479 (the desktop sidecar, under open documents). `release-smoke-checklist.md:209-214` certified "gives up rather than displacing"; `troubleshooting.md:141` calls the holder "stale". | [read] | Source-confirmed (ordering; the SIGKILL branch of `freePort` not re-read) | [#1758](https://github.com/bloknayrb/tandem/issues/1758) |
| M | `src/server/integrations/apply.ts:217-223` | `MAX_CONFIG_BYTES` 5 MiB against its own comment "routinely multi-megabyte"; oversize → generic `WRITE_FAILED`; the boot sweep leaves a stale node path silently. | [read] | Agent-reported | [#1801](https://github.com/bloknayrb/tandem/issues/1801) |
| M | `apply.ts:1056-1147` | `applyConfig` replaces a malformed `~/.claude.json` with a fresh Tandem-only file (backup under `.broken-backups`) and reports success; `readConfigForMutation` refuses instead. Whether Claude Code writes that file atomically is unknown (tmp.PID files seen in the wild), which keeps this Medium. | [read] | Agent-reported | [#1802](https://github.com/bloknayrb/tandem/issues/1802) |
| M | `src-tauri/src/sidecar.rs:567-601` | Health poll checks HTTP 2xx only, so it passes against an old process still on the port; feeds the lock-then-`freePort` window. | [read] | Source-confirmed | [#1812](https://github.com/bloknayrb/tandem/issues/1812) |
| L | `index.ts:76-94` (48 sites); `sentry.ts`; `index.ts:735-752`; `index.ts:229-233`; `existing-config.ts`; `queue.ts`; `store.ts:139-146` | Production stderr filter drops `util.format` placeholders; Sentry sends `server_name` and absolute frame paths despite `sendDefaultPii: false`; stdio mode never exits on stdin EOF; Windows SIGTERM is `TerminateProcess` so the 6 s grace is dead; no BOM strip or size cap on `existing-config.ts`; orphaned `.tandem-setup-*.tmp` never reaped; `queue.ts` tracks ids before the forward decision; lock PID reuse after reboot; initial reason "stdio-mode" during the HTTP startup window. | mixed | Agent-reported (two `[ran]`) | [#1823](https://github.com/bloknayrb/tandem/issues/1823) |

## Leads not run

- Unix orphan reaper (#800) never landed: a Tauri crash leaves the sidecar holding the ports. Smoke
  line in [smoke-lines.md](../smoke-lines.md).
- Fast-fail spawn closes stdin before the bootstrap write (a second EPIPE trigger).
- `installSkill` overwrites a hand-edited `SKILL.md` (now in the upgrade-path area, #1790).

## Doc drift (in [#1821](https://github.com/bloknayrb/tandem/issues/1821))

`docs/security.md:33,163,170,178`; `index.ts:229-233` SIGTERM comment; `architecture.md:843`.

## Verified fine

Startup ordering (documents before bind in HTTP mode); Solo gate over the three external
subscribers; auth; the loopback exception set; wake socket; licensing inertness with importers
enumerated; local-model dark; reaper; integrations gates; supervisor breaker.
