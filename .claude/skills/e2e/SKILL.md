---
name: e2e
description: Run Playwright E2E tests safely (warns about dev server conflicts)
disable-model-invocation: true
---

# Run E2E Tests

Run the Playwright end-to-end test suite for Tandem.

## Ports (#1492)
The suite runs on **reserved ports** from `scripts/test-ports.ts` — Vite on 4573, backend on 4728 (ws) / 4729 (MCP). The product's 3478/3479 are untouched, so a running Tandem or `dev:server` coexists with an E2E run; you no longer need to quit anything.

**The reserved pair is *reserved*, not politely refused.** Playwright raises its terse "already used" error only for something answering 200–403 on :4729. Anything else holding the pair — a wedged stale E2E server, a non-HTTP process, or *anything at all* on :4728, which no Playwright check ever probes — is SIGKILLed by the E2E server's own boot (`freePort()`). For a stale E2E server that is desirable self-healing. Two guards still run in `scripts/e2e-guard.ts` (`globalSetup`): a fail-closed identity probe of :4729 (#1483), and a check that the Vite server actually serving the suite carries the harness env — a served client still baked to :3479 would drive the destructive suite into your REAL Tandem through the UI.

## Steps

1. Optionally check for a stale holder of the reserved pair:
   ```bash
   if curl -sf http://127.0.0.1:4729/health 2>/dev/null; then
     echo "Something is on :4729 (usually a stale E2E server) — the run will refuse"
     echo "with Playwright's 'already used' error. Free it with:"
     echo "  fuser -k 4728/tcp 4729/tcp 4573/tcp"
   fi
   ```

2. Run the tests:
   ```bash
   npm run test:e2e
   ```

   For interactive debugging mode:
   ```bash
   npm run test:e2e:ui
   ```

3. If tests fail, check:
   - `data-testid` attributes are present (kebab-case convention)
   - Server started cleanly (check Playwright output for port conflicts)
   - No stale `openDocuments` entries causing phantom tab removal

## Test Conventions
- Use `data-testid` selectors (kebab-case): `accept-btn`, `dismiss-btn`, `annotation-card-{id}`
- E2E tests live in `tests/e2e/`
- McpTestClient helper simulates MCP tool calls without Claude Code
