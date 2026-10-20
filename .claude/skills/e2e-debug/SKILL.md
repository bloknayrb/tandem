---
name: e2e-debug
description: Debug Playwright E2E test failures — port conflicts, server startup, test isolation, and post-mortem analysis
disable-model-invocation: true
---

# E2E Test Debugging

Post-mortem guide for Playwright E2E failures in Tandem. Complements the `/e2e` skill (which covers the happy path).

## Ports (#1492)

E2E runs on **reserved ports** (`scripts/test-ports.ts`): Vite 4573, backend 4728 (ws) / 4729 (MCP). A running Tandem or `dev:server` on 3478/3479 is fine and is not touched. Three distinct early-abort signatures:

- **Playwright's "http://127.0.0.1:4729/health is already used"** — something (usually a stale E2E server) is answering the reserved MCP port; the backend entry is `reuseExistingServer: false`. Recovery: `fuser -k 4728/tcp 4729/tcp 4573/tcp` and rerun.
- **"Refusing to run this Playwright suite against a server it did not start"** — the `scripts/e2e-guard.ts` identity probe (#1483, now defense-in-depth): something answered :4729 that it could not prove is an E2E server.
- **"…serving a client that does NOT target the harness backend"** — the guard's served-client check: the Vite on :4573 was launched without `VITE_TANDEM_*` (e.g. hand-started), so its client is baked to the product ports and would drive the suite into a real Tandem through the UI. Stop that Vite and let Playwright start its own.

Anything holding the reserved pair that *fails* the health check — wedged, non-HTTP, or sitting on the never-probed :4728 — is silently SIGKILLed by the E2E server's own boot (`freePort()`); that self-healing is why the reserved numbers must never collide with ports any doc tells users to occupy.

## Pre-Flight Checklist

The backend Playwright starts depends on `CI` (`playwright.config.ts` `webServer`): locally it runs the server **from source** through tsx (`scripts/e2e-server.mjs … src/server/index.ts`); under `CI` it runs the built `dist/server/index.js`. The client is always the Vite dev server on :4573, never `dist/client/`. So a local run needs no build — check only the reserved ports (a holder is either refused or killed — see above):

```bash
curl -sf http://127.0.0.1:4729/health && echo "⚠ Server on :4729 (stale E2E?)" || echo "✓ Port free"
curl -sf http://127.0.0.1:4728 && echo "⚠ Something on :4728" || echo "✓ Port free"
```

## Failure Categories

### Timeout waiting for health endpoint
**Symptom**: `Timed out waiting for http://127.0.0.1:4729/health`
**Cause**: locally, the source server failed to boot — read the webServer output above the timeout. Under `CI`, a stale or missing `dist/server/`.
**Fix**: fix the boot error; for a `CI`-mode run, `npm run build:server` then retry.

### net::ERR_CONNECTION_REFUSED on :4573
**Symptom**: Client page fails to load
**Cause**: Vite webServer not started (check `playwright.config.ts` webServer section)
**Fix**: Verify `npm run dev -- --port 4573 --strictPort` works standalone; check for port conflicts on :4573.
A hand-started Vite serves a client baked to the PRODUCT ports and the guard will refuse it — if you export
`VITE_TANDEM_WS_PORT`/`VITE_TANDEM_MCP_PORT` to work around that, **unset them again**. They are read from the
ambient shell at build time, so a stale export bakes a harness port into any `npm run build` you run afterwards.
(`scripts/build-client.mjs` strips them for exactly this reason, and CI greps the bundle — but a bare `vite build`
does not.)

### Stale openDocuments / phantom tabs
**Symptom**: Tests find unexpected documents open or wrong tab state
**Cause**: not leftover session files. Every E2E run's backend (root `playwright.config.ts`) uses an isolated `TANDEM_APP_DATA_DIR` (`tandem-e2e-data`) that `scripts/e2e-server.mjs` wipes at start, and the perf harness does the same with `tandem-perf-data` (`tests/perf/perf-server.mjs`). Look for state leaking between specs in the same run (a spec that opens documents and never closes them), or a hand-started Vite that Playwright reused instead of starting its own. A design-baselines run (`scripts/design-baselines/playwright.config.ts`) uses `/tmp/tandem-baselines-data`, which is not wiped.
**Fix**: for a baselines run, delete `/tmp/tandem-baselines-data`. Never delete the per-OS `sessions/` directory for this — that is your real Tandem's session store, and the E2E backend does not read it.

### data-testid not found
**Symptom**: `locator.click: Error: strict mode violation` or element not found
**Cause**: testid was renamed or component restructured
**Fix**: grep `tests/design-system-impl/__snapshots__/testid-set.snap.txt` for the current name — that snapshot is the authoritative set (CLAUDE.md Critical Rule 7). Use `[data-testid="..."]` selectors, not CSS classes.

### WebServer cold-start race
**Symptom**: First test in suite fails, rest pass
**Cause**: Known Playwright webServer cold-start issue (#230)
**Fix**: The project uses a retry-on-first-failure workaround. If this regresses, check `playwright.config.ts` for the `retries` and `webServer.timeout` settings.

## One-Off Debug Run

For a single spec with browser visible:
```bash
npx playwright test tests/e2e/specific.spec.ts --headed --workers=1
```

For trace collection on failure:
```bash
npx playwright test tests/e2e/specific.spec.ts --trace on
```

View the trace:
```bash
npx playwright show-trace test-results/specific-spec-ts/trace.zip
```

## Common Patterns

- **Display-toggled panels**: ChatPanel and SidePanel are always mounted (CSS `display` toggle). Use `toBeVisible()` not `toBeAttached()`.
- **ESM __dirname**: E2E test files must use `import.meta.url` + `fileURLToPath`, not `__dirname`.
- **Uploaded files are read-only**: `upload://` paths from test fixtures don't support `tandem_save`.
