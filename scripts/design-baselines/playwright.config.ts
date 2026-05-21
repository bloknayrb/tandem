import { defineConfig } from "@playwright/test";
import baseConfig from "../../playwright.config";

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
 * Run with: `npm run capture:design-baselines`
 */
export default defineConfig({
  ...baseConfig,
  testDir: "./",
  fullyParallel: false,
  workers: 1,
});
