import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import baseConfig from "../../playwright.config";

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
 * Run with: `npm run capture:design-baselines`
 */
export default defineConfig({
  ...baseConfig,
  testDir: "./",
  fullyParallel: false,
  workers: 1,
  webServer: [
    {
      command: "npm run dev",
      cwd: repoRoot,
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "node node_modules/tsx/dist/cli.mjs src/server/index.ts",
      cwd: repoRoot,
      url: "http://127.0.0.1:3479/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...(process.env as Record<string, string>),
        TANDEM_DISABLE_FIRST_RUN_WIZARD: "1",
        TANDEM_NO_SAMPLE: "1",
      },
    },
  ],
});
