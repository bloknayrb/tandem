import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { E2E_APP_DATA_DIR } from "./scripts/e2e-paths";
import { DEFAULT_MCP_PORT, TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV } from "./src/shared/constants";

/**
 * This config's own directory, for `globalSetup` below.
 *
 * Playwright resolves `globalSetup` against the LOADED config file's directory
 * (`node_modules/playwright/lib/common/config.js:69`), and
 * `scripts/screenshots/playwright.config.ts` spreads this whole object — so a
 * relative `"./scripts/e2e-guard.ts"` would resolve there as
 * `scripts/screenshots/scripts/e2e-guard.ts` and die with MODULE_NOT_FOUND
 * before a single frame was captured. That is the identical failure that file
 * documents at its head for `webServer.cwd`, which it re-roots by hand. An
 * absolute path is inheritance-safe by construction, so no child config has to
 * know this key exists.
 */
const CONFIG_DIR = dirname(fileURLToPath(import.meta.url));

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
  // #1483: refuses to run against a server this suite did not start — see
  // scripts/e2e-guard.ts for the ordering, the fail-closed rule, and why this
  // is not `reuseExistingServer: false`.
  globalSetup: resolve(CONFIG_DIR, "scripts/e2e-guard.ts"),
  use: {
    baseURL: "http://127.0.0.1:5173",
    headless: true,
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
        ? "node scripts/e2e-server.mjs dist/server/index.js"
        : "node scripts/e2e-server.mjs node_modules/tsx/dist/cli.mjs src/server/index.ts",
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
        // Isolate the E2E server's data dir so stale sessions/locks from the
        // stdio-smoke step (or any previous run) can't delay startup. Wiped
        // by scripts/e2e-server.mjs at server start — see the rationale there.
        TANDEM_APP_DATA_DIR: E2E_APP_DATA_DIR,
        // Skip auto-opening sample/welcome.md on startup. The onboarding-tutorial
        // spec opens it explicitly via tandem_open, and openFileByPath injects
        // tutorial annotations idempotently whenever the sample doc is opened.
        TANDEM_NO_SAMPLE: "1",
      },
    },
  ],
});
