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

Before running E2E tests, verify:

```bash
# 1. Server bundle exists (E2E uses pre-built server, not tsx)
ls dist/server/index.js

# 2. Reserved ports are free (a holder is either refused or killed — see above)
curl -sf http://127.0.0.1:4729/health && echo "⚠ Server on :4729 (stale E2E?)" || echo "✓ Port free"
curl -sf http://127.0.0.1:4728 && echo "⚠ Something on :4728" || echo "✓ Port free"

# 3. Client build exists (for webServer)
ls dist/client/index.html
```

If `dist/server/index.js` is missing or stale:
```bash
npm run build:server
```

## Failure Categories

### Timeout waiting for health endpoint
**Symptom**: `Timed out waiting for http://127.0.0.1:4729/health`
**Cause**: `dist/server/` is stale or missing
**Fix**: `npm run build:server` then retry

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
**Cause**: Prior test crash left session state on disk
**Fix**: Delete session directory:
- Windows: `%LOCALAPPDATA%\tandem\Data\sessions\`
- macOS: `~/Library/Application Support/tandem/sessions/`
- Linux: `~/.local/share/tandem/sessions/`

### data-testid not found
**Symptom**: `locator.click: Error: strict mode violation` or element not found
**Cause**: testid was renamed or component restructured
**Fix**: Check CLAUDE.md Critical Rule #7 for the current testid list. Use `[data-testid="..."]` selectors, not CSS classes.

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
