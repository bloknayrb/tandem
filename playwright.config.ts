import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { E2E_APP_DATA_DIR } from "./scripts/e2e-paths";
import { E2E_MCP_PORT, E2E_VITE_PORT, E2E_WS_PORT } from "./scripts/test-ports";
import { TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV } from "./src/shared/constants";

/**
 * This config's own directory, for `globalSetup` below.
 *
 * Playwright resolves `globalSetup` against the LOADED config file's directory
 * (`resolveScript` in `node_modules/playwright/lib/common/config.js`), and
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
// without needing an explicit `env:` key. Playwright MERGES webServer.env over
// process.env (`{ ...process.env, ...options.env }` in webServerPlugin), so no
// `env:` block is needed to preserve inheritance — and hand-writing one as
// `{ ...process.env, … }` would be strictly worse: that spread snapshots the
// runner env at config-EVALUATION time, while Playwright's own merge reads it
// at LAUNCH time. Mutating process.env here keeps the launch-time read.
process.env[TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV] = "1";

// The client half of #1492: the Vite webServer below inherits these via
// process.env (same mechanism as the wizard var above), and
// src/client/utils/backend-ports.ts resolves them at transform time — so the
// served client targets the harness backend, not the product one. The wiring
// test pins these against scripts/test-ports.ts; scripts/e2e-guard.ts verifies
// at run time that the Vite server actually serving the suite carries them.
process.env.VITE_TANDEM_WS_PORT = String(E2E_WS_PORT);
process.env.VITE_TANDEM_MCP_PORT = String(E2E_MCP_PORT);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  retries: 1,
  workers: 1, // server supports one MCP session at a time
  // #1483/#1492: defense-in-depth. The backend now runs on its own reserved
  // pair with `reuseExistingServer: false`, so the desktop app can no longer
  // be adopted by default — but anything answering the reserved MCP port that
  // is not a live E2E server is still refused, fail-closed, and the guard also
  // verifies the Vite server serving the suite was launched with the harness
  // env (a client baked to :3479 would drive the user's REAL backend through
  // the UI). See scripts/e2e-guard.ts for the ordering and the residual risks.
  globalSetup: resolve(CONFIG_DIR, "scripts/e2e-guard.ts"),
  use: {
    baseURL: `http://127.0.0.1:${E2E_VITE_PORT}`,
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
  // The `...process.env` spread in the backend `env:` below is redundant, not
  // load-bearing: Playwright already builds the child env as
  // `{ ...process.env, ...options.env }` (webServerPlugin), so PATH/HOME reach
  // the server either way. It is kept because removing it changes nothing.
  webServer: [
    {
      // Deliberately not 5173 (nor 5174, Vite's auto-increment target): a
      // developer's `npm run dev` — whose client targets the PRODUCT backend —
      // must never be silently adopted (#1492; same move tests/perf made for
      // `vite preview`). Reuse of a stale E2E Vite is safe because the guard
      // re-verifies the served client's ports on every run.
      command: `npm run dev -- --port ${E2E_VITE_PORT} --strictPort`,
      url: `http://127.0.0.1:${E2E_VITE_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: process.env.CI
        ? "node scripts/e2e-server.mjs dist/server/index.js"
        : "node scripts/e2e-server.mjs node_modules/tsx/dist/cli.mjs src/server/index.ts",
      url: `http://127.0.0.1:${E2E_MCP_PORT}/health`,
      // Never adopt (#1492). Adoption of a stale E2E server skips
      // scripts/e2e-server.mjs's per-run wipe (the cascading-failure mode its
      // header documents), and with the backend on a reserved pair there is no
      // legitimate server to adopt. NOTE the true residual: anything holding
      // the reserved pair that fails the /health check is SIGKILLed by this
      // server's own boot (`freePort`), and nothing probes the WS port at all
      // — which is why these numbers must never collide with a documented
      // remedy (see scripts/test-ports.ts).
      reuseExistingServer: false,
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
        // The server half of #1492's port move; the client half is the
        // VITE_TANDEM_* pair set at the top of this file.
        TANDEM_PORT: String(E2E_WS_PORT),
        TANDEM_MCP_PORT: String(E2E_MCP_PORT),
        // Skip auto-opening sample/welcome.md on startup. The onboarding-tutorial
        // spec opens it explicitly via tandem_open, and openFileByPath injects
        // tutorial annotations idempotently whenever the sample doc is opened.
        TANDEM_NO_SAMPLE: "1",
      },
    },
  ],
});
