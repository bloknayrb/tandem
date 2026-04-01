---
name: e2e
description: Run Playwright E2E tests safely (warns about dev server conflicts)
disable-model-invocation: true
---

# Run E2E Tests

Run the Playwright end-to-end test suite for Tandem.

## Critical Warning
**E2E tests will kill any running dev server.** Playwright's `webServer` config starts its own servers on :3478/:3479, and `freePort()` kills existing processes on those ports. Do NOT run E2E tests while `dev:server` or `dev:standalone` is running unless you're OK losing that session.

## Steps

1. Check for running dev servers and warn:
   ```bash
   if curl -sf http://127.0.0.1:3479/health 2>/dev/null; then
     echo "WARNING: Dev server detected on :3479. E2E tests will kill it."
     echo "Stop your dev server first, or accept it will be terminated."
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
