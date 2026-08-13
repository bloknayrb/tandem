import { defineConfig } from "@playwright/test";
import baseConfig from "../../playwright.config";

/**
 * Isolated Playwright config for deterministic screenshot capture — the ONLY
 * screenshot pipeline (`scripts/take-screenshots.mjs` was deleted).
 *
 * The capture spec (`capture.spec.ts`) is a build-artifact generator gated
 * behind `SCREENSHOTS=1`. Every step now asserts on what it is photographing —
 * see the rules in that file's header — but it is still a generator, not a
 * regression suite. Keeping it under a separate `testDir` ensures the standard
 * `npm run test:e2e` runner cannot discover it, even if a future CI glob
 * change widens what the root config sweeps in.
 *
 * **Port precondition**: this config spreads the root `webServer`, whose
 * `freePort()` KILLS whatever holds :3478/:3479. Nothing may be running on
 * those ports (a `dev:server`, the installed desktop app) when you capture.
 *
 * The first-run wizard is unreachable here: the root config sets
 * `TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV=1` before `defineConfig` and the spread
 * below inherits it. `13-setup-wizard` therefore drives the manual reopen entry
 * point (`settings-modal-open-integration-wizard`) rather than first run. Do
 * NOT delete the env var here to "fix" it — that diverges this config from the
 * e2e suite it shares helpers with.
 *
 * Run with: `npm run capture:screenshots`
 */
export default defineConfig({
  ...baseConfig,
  testDir: "./",
  fullyParallel: false,
  workers: 1,
  // No retries: a screenshot step that only passes on the second attempt was
  // photographing a transient state the first time round.
  retries: 0,
  use: {
    ...baseConfig.use,
    // Wider than the e2e default (1280x720). Below ~1400px the margin-view
    // ladder steps down out of `full`, and the README hero has to carry the
    // document, the annotation rail and the tab bar at an 820px display width.
    // Individual tests widen further via `page.setViewportSize`.
    viewport: { width: 1440, height: 900 },
  },
});
