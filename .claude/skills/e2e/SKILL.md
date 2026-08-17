---
name: e2e
description: Run Playwright E2E tests safely (warns about dev server conflicts)
disable-model-invocation: true
---

# Run E2E Tests

Run the Playwright end-to-end test suite for Tandem.

## Critical Warning
**E2E refuses to run while Tandem or a dev server holds :3479** (#1483). The `globalSetup` guard in `scripts/e2e-guard.ts` asks `/api/info` for the server's storage dir and aborts before the first spec unless it is the isolated E2E one — so the old hazard, silently *adopting* the desktop sidecar and running the destructive suite against real documents, now fails loudly instead. Once E2E starts its own server, `freePort()` does free :3478/:3479.

So the failure mode to expect is a refusal, not a lost session. Stop `dev:server`/`dev:standalone` or quit Tandem before running.

## Steps

1. Check for running dev servers and warn:
   ```bash
   if curl -sf http://127.0.0.1:3479/health 2>/dev/null; then
     echo "WARNING: Something is on :3479. E2E will REFUSE to start."
     echo "Quit Tandem or stop the dev server first."
   fi
   ```

2. Ask the user for confirmation if a server was detected.

3. Run the tests:
   ```bash
   npm run test:e2e
   ```

   For interactive debugging mode:
   ```bash
   npm run test:e2e:ui
   ```

4. If tests fail, check:
   - `data-testid` attributes are present (kebab-case convention)
   - Server started cleanly (check Playwright output for port conflicts)
   - No stale `openDocuments` entries causing phantom tab removal

## Test Conventions
- Use `data-testid` selectors (kebab-case): `accept-btn`, `dismiss-btn`, `annotation-card-{id}`
- E2E tests live in `tests/e2e/`
- McpTestClient helper simulates MCP tool calls without Claude Code
