import { defineConfig } from "@playwright/test";
import baseConfig from "../../playwright.config";

/**
 * Isolated Playwright config for deterministic screenshot capture.
 *
 * The capture spec (`capture.spec.ts`) is a build-artifact generator gated
 * behind `SCREENSHOTS=1` — it has no real assertions, only preconditions for
 * image capture. Keeping it under a separate `testDir` ensures the standard
 * `npm run test:e2e` runner cannot discover it, even if a future CI glob
 * change widens what the root config sweeps in.
 *
 * Run with: `npm run capture:screenshots`
 */
export default defineConfig({
  ...baseConfig,
  testDir: "./",
  fullyParallel: false,
  workers: 1,
});
