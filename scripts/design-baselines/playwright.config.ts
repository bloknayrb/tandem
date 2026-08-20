import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import baseConfig from "../../playwright.config";
import { E2E_MCP_PORT, E2E_VITE_PORT, E2E_WS_PORT } from "../test-ports";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * Isolated Playwright config for HTML-baseline capture.
 *
 * The capture spec (`capture.spec.ts`) is a build-artifact generator gated
 * behind `CAPTURE_DESIGN_BASELINES=1` — it has no real assertions, only
 * writes self-contained HTML files to docs/design-system-impl/preview/baselines/.
 * Keeping it under a separate testDir ensures `npm run test:e2e` cannot
 * discover it even if a future CI glob change widens what the root config
 * sweeps in.
 *
 * webServer entries override the base config to pin `cwd` to the repo root
 * — the base config's relative paths (`node node_modules/tsx/...`) resolve
 * against the config file's directory by default, which fails when the
 * config lives in scripts/design-baselines/.
 *
 * Ports come from scripts/test-ports.ts (#1492): importing the base config
 * above also runs its module body, which exports VITE_TANDEM_* into
 * process.env — the Vite child inherits them, so the served client targets
 * the harness backend. `webServer.env` MERGES over process.env
 * (`{ ...process.env, ...options.env }` in playwright's webServerPlugin), but
 * nothing puts TANDEM_PORT/TANDEM_MCP_PORT in process.env, so the backend
 * entry must set them explicitly.
 *
 * KNOWN GAP, deliberate: this config overrides `globalSetup` with its own, so
 * it never inherited `scripts/e2e-guard.ts` and still does not. Its only
 * protections are the reserved port pair and `reuseExistingServer: false` —
 * which #1492 made real protections (pre-#1492 this config hand-wrote the
 * PRODUCT ports, so "never reuse" meant "SIGKILL the desktop app instead").
 *
 * Run with: `npm run capture:design-baselines`
 */
export default defineConfig({
  ...baseConfig,
  testDir: "./",
  fullyParallel: false,
  workers: 1,
  // Run-once hooks (immune to worker restarts on retry): setup clears the
  // scratch parts dir, teardown folds the per-scene parts into baselines.html.
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  webServer: [
    {
      command: `npm run dev -- --port ${E2E_VITE_PORT} --strictPort`,
      cwd: repoRoot,
      url: `http://127.0.0.1:${E2E_VITE_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "node node_modules/tsx/dist/cli.mjs src/server/index.ts",
      cwd: repoRoot,
      url: `http://127.0.0.1:${E2E_MCP_PORT}/health`,
      // Never reuse a server the developer already has running — `seedAnnotations`
      // writes "Nice opener" fixtures into sample/welcome.md, and reusing a
      // real instance would persist them into the developer's actual profile.
      // Always start a fresh server pinned to a throwaway data dir.
      reuseExistingServer: false,
      timeout: 120_000,
      // `env` MERGES over process.env, but it does NOT inherit the base config's
      // backend entry: this config replaces the whole `webServer` array, so
      // every var that entry set is gone and must be re-declared here. Chiefly
      // TANDEM_APP_DATA_DIR — without it the seeded annotations land in the
      // real `<app-data>/annotations` store and accumulate across capture runs.
      // The `...process.env` spread below is redundant with Playwright's own
      // merge, not load-bearing — kept only to avoid churn in a config no gate
      // exercises.
      env: {
        ...(process.env as Record<string, string>),
        TANDEM_DISABLE_FIRST_RUN_WIZARD: "1",
        TANDEM_NO_SAMPLE: "1",
        TANDEM_APP_DATA_DIR: "/tmp/tandem-baselines-data",
        TANDEM_PORT: String(E2E_WS_PORT),
        TANDEM_MCP_PORT: String(E2E_MCP_PORT),
      },
    },
  ],
});
