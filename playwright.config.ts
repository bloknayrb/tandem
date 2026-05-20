import { defineConfig } from "@playwright/test";
import { DEFAULT_MCP_PORT, TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV } from "./src/shared/constants";

// Set before defineConfig so the tsx webServer inherits it via process.env
// without needing an explicit `env:` key. Playwright's webServer.env REPLACES
// (not merges) the child environment, so specifying `env:` with a spread is
// fragile — the tsx server then cannot inherit any updates to the runner env
// made after the config is evaluated. Mutating process.env here is simpler
// and avoids that problem entirely.
process.env[TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV] = "1";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  retries: 1,
  workers: 1, // server supports one MCP session at a time
  use: {
    baseURL: "http://127.0.0.1:5173",
    headless: true,
    // Capture diagnostic artifacts only when a test ultimately fails (i.e.
    // after Playwright exhausts its retries). Keeps green-test runs fast
    // while giving us trace / screenshot / video to diagnose the residual
    // flakes — `retries: 1` masks intermittent failures from CI output, and
    // without these artifacts the underlying cause is invisible.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  // Two webServer entries instead of `npm run dev:standalone`:
  //   1. Vite dev server for the client
  //   2. Backend: pre-built dist in CI, tsx source in local dev
  //
  // CI uses `node dist/server/index.js` (same binary the stdio smoke test
  // validates) because tsx's on-demand TypeScript compilation has proven
  // unreliable under Playwright's webServer supervision in CI: the process
  // never binds the port, the 120s timeout expires, and no playwright-report
  // is generated. dist/server/index.js is already built by the `Build` step
  // that runs before E2E, so there is no extra build cost.
  //
  // Local dev uses `node node_modules/tsx/dist/cli.mjs src/server/index.ts`
  // for fast iteration without a rebuild. The direct tsx CLI path bypasses
  // both the watch-mode parent-process stdout-pipe deadlock on Windows AND
  // `npx`/`.bin` shim buffering issues (see issue #244 / PR #672).
  //
  // **Spread `process.env` explicitly** in `env:` — Playwright's
  // `webServer.env` REPLACES the child's environment rather than merging
  // into it, so omitting the spread strips PATH/HOME/etc. and the server
  // command can't resolve `node`.
  webServer: [
    {
      command: "npm run dev",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: process.env.CI
        ? "node dist/server/index.js"
        : "node node_modules/tsx/dist/cli.mjs src/server/index.ts",
      url: `http://127.0.0.1:${DEFAULT_MCP_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      // 3c-ii-b: the integration wizard now auto-opens on first run via
      // `GET /api/integrations/first-run-needed`. In E2E, a clean home
      // directory makes the server say `needed: true` and the wizard would
      // cover every unrelated test's editor surface. The integration-wizard
      // spec exercises the manual-reopen affordance with this var still set
      // (Reopen button always works).
      env: {
        ...(process.env as Record<string, string>),
        [TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV]: "1",
      },
    },
  ],
});
