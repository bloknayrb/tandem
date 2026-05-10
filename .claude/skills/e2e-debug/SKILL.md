---
name: e2e-debug
description: Debug Playwright E2E test failures — port conflicts, server startup, test isolation, and post-mortem analysis
disable-model-invocation: true
---

# E2E Test Debugging

Post-mortem guide for Playwright E2E failures in Tandem. Complements the `/e2e` skill (which covers the happy path).

## Critical Warning

E2E tests use `freePort()` which **kills any process on :3478/:3479**. Confirm with the user that no dev server is in use before running.

## Pre-Flight Checklist

Before running E2E tests, verify:

```bash
# 1. Server bundle exists (E2E uses pre-built server, not tsx)
ls dist/server/index.js

# 2. Ports are free (or confirm user is OK with kill)
curl -sf http://127.0.0.1:3479/health && echo "⚠ Server running on :3479" || echo "✓ Port free"
curl -sf http://127.0.0.1:3478 && echo "⚠ Hocuspocus running on :3478" || echo "✓ Port free"

# 3. Client build exists (for webServer)
ls dist/client/index.html
```

If `dist/server/index.js` is missing or stale:
```bash
npm run build:server
```

## Failure Categories

### Timeout waiting for health endpoint
**Symptom**: `Timed out waiting for http://127.0.0.1:3479/health`
**Cause**: `dist/server/` is stale or missing
**Fix**: `npm run build:server` then retry

### net::ERR_CONNECTION_REFUSED on :5173
**Symptom**: Client page fails to load
**Cause**: Vite webServer not started (check `playwright.config.ts` webServer section)
**Fix**: Verify `npm run dev` works standalone; check for port conflicts on :5173

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
