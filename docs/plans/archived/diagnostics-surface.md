# Diagnostics Surface (audit plan item 3) — rev 2, post-adversarial-review

Two review agents (correctness vs master; security vs threat model) reviewed rev 1.
This revision applies their corrections. Key change: **the POST reveal route is deleted
from the plan** — a native mechanism already exists.

## Problem

A stuck desktop user has no in-app way to find or share diagnostic state. Logs exist
(tauri-plugin-log file, stderr, `tandem doctor`) but nothing in `src/client` surfaces
them.

## Shape

### 1. Copy diagnostics (server route + client button)

- **Server:** `GET /api/diagnostics` in new `src/server/mcp/routes/diagnostics.ts`,
  registered inside `registerApiRoutes` with the `mw` LAN-aware middleware argument
  (api-routes.ts:143 pattern — mounting separately would skip DNS-rebinding protection).
  Handler top: unconditional `isLoopback(req.socket.remoteAddress)` else 403
  (NOT `assertLoopbackForMutation`, which is a no-op outside the unauthenticated-LAN
  opt-in — security F1). Note this is deliberately stricter than `/api/info`'s
  field-stripping (P3).
- Calls `runDoctor()` (verified pure: no argv/exit/stdout; SSE+health probes carry hard
  timeouts + destroy; annotation-store check is read-only on the lock). Wrap in
  try/catch → generic 500 `{ error: "diagnostics failed" }` — `Recorder.check` rethrows
  (M5/F2b). **Single-flight:** concurrent requests share one in-flight `runDoctor()`
  promise (~5 lines; kills the self-probe amplification — F6).
- **Filter dev-repo checks (M1):** drop `node-modules` and `.mcp.json`-cwd results from
  the route response and recompute `ok`/`failures`/`warnings`/`summary` from the filtered
  set. Those checks read `process.cwd()` and FAIL for every Tauri/npm-global user — every
  field report would otherwise lead with two false failures. (CLI `tandem doctor` keeps
  them — they're for dev-repo setups.) Filter by check name in the route; `doctor.ts`
  itself unchanged except:
- **Real ports (M2):** `runDoctor(opts?: { wsPort?: number; mcpPort?: number })`,
  defaulting to the existing constants — the server passes its live ports so a
  `TANDEM_PORT`-overridden instance doesn't report "server not running" from its own
  diagnostics route.
- Response: `{ report (filtered), version, transport, platform, arch, nodeVersion, tauriSidecar }`,
  `version`/`transport` dependency-injected like `makeInfoHandler` (the deps are in scope
  at the registration site).
- **Paths:** `API_DIAGNOSTICS` in `src/shared/api-paths.ts` (NOT constants.ts); client
  fetches `` `${API_BASE}${API_DIAGNOSTICS}` `` (raw relative fetch would hit Vite — M4).
- **Client:** "Copy diagnostics" button in `SettingsAboutTab.svelte` (testid
  `settings-modal-copy-diagnostics-btn`), disabled in flight. Formats via pure
  `formatDiagnostics(payload): string` in `src/client/utils/diagnostics.ts`
  (extract-over-mount): header (version/platform/transport/Node), one line per check
  `[ok|warn|fail] name — message`, `fix:` lines for non-ok. Then
  `navigator.clipboard.writeText` + `context.notify("info", "Diagnostics copied")`.
  Failures: fetch → notify error "Couldn't reach the server — is it running?";
  clipboard → notify error pointing at `tandem doctor`. Fixed strings only in notify
  (context contract — never raw err.message).
- Report contents verified acceptable for loopback (security F2): absolute paths
  (embed username), PIDs, `.mcp.json` url/args; **no token material, no shell-outs**.

### 2. Open log folder (client-only — NO new route)

Rev-1's `POST /api/reveal-log-folder` is deleted (P2/F7): `src/server/open-browser.ts`
no longer exists, and a native path is already shipped — `#[tauri::command]
show_in_file_manager` (src-tauri/src/lib.rs:1113, spawn-based, per-OS unit-tested)
invoked from `src/client/actions/builtin.svelte.ts:594-609` behind `isTauriRuntime()`.
The log folder only exists in the Tauri runtime (tauri-plugin-log), which is exactly
where the native path works.

- **Client:** "Open log folder" button (testid `settings-modal-open-log-folder-btn`),
  rendered only when `isTauriRuntime()`. On click: `appLogDir()` from
  `@tauri-apps/api/path`, then `invoke("show_in_file_manager", { path })` — same call
  shape as builtin.svelte.ts. Failure → notify error (fixed string). Verify at
  implementation that the `core:path:default` permission covers `appLogDir` in
  `src-tauri/capabilities/` (the path API is core; builtin already invokes custom
  commands from this surface).
- Browser/CLI mode: button absent; `docs/troubleshooting.md` explains logs go to the
  terminal there.
- This removes: the reveal route, `src/server/log-dir.ts`, `TAURI_BUNDLE_ID`, the
  OPTIONS preflight registration (M3), the spawn mutex/cooldown (F3), and the
  explorer.exe exit-code quirk (M6) from the plan entirely.

### Docs & tests

- `docs/troubleshooting.md`: "Sharing diagnostics" section — the two buttons, CLI
  equivalents, and a plain note that the copied text contains local absolute paths
  (user is about to paste into a public issue — F2a).
- `docs/architecture.md` file-map + CLAUDE.md Rule 7 testid list (M7): add the two new
  testids.
- CHANGELOG Unreleased → Added.
- Unit tests:
  - `tests/server/diagnostics-route.test.ts` — loopback 200 + response shape; dev-repo
    checks filtered + summary recomputed; LAN 403; throwing collector → 500 generic;
    single-flight (two concurrent requests, one collector invocation).
  - doctor ports-param coverage (existing doctor test file if present, else inline in
    the route test via injected collector).
  - `tests/client/diagnostics-format.test.ts` — formatter: header fields, ok/warn/fail
    lines, fix lines, stable ordering.
- E2E: none (thin glue over tested units; About tab has existing smoke coverage).
  Manual: Copy diagnostics in dev browser; both buttons in Bryan's Tauri pass.

## Out of scope

Crash-reporting prompt (Sentry #921 shipped; first-run prompt deferred); in-app log
viewer/tailing; embedding log file contents in the copied text (logs may contain
document paths/fragments).
