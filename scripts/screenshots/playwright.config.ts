import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import baseConfig from "../../playwright.config";

/**
 * Repo root, for `webServer.cwd` below.
 *
 * Playwright resolves `webServer.cwd` relative to the CONFIG FILE's directory,
 * not the repo root. The root config's commands (`npm run dev`, `node
 * scripts/e2e-server.mjs`) are written for a config that sits at the root, so
 * spreading them into this config -- which lives two levels down -- made Node
 * look for `scripts/screenshots/scripts/e2e-server.mjs` and die with
 * MODULE_NOT_FOUND before a single frame was captured.
 *
 * That failure is why this pipeline had never actually run: its output on disk
 * (`09-settings-popover.png`) is a name no step here writes, and the images
 * that were fresh came from the other, now-deleted script. Reading two
 * pipelines tells you which is better designed; only running one tells you
 * which works.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
 * **Port precondition, now enforced**: this config spreads the root config, so
 * as of #1483 it also inherits its `globalSetup` — `scripts/e2e-guard.ts` —
 * which refuses the run if :3479 is held by anything whose `/api/info` storage
 * dir is not the isolated E2E one. Nothing may be running on those ports (a
 * `dev:server`, the installed desktop app) when you capture, and a capture that
 * aborts with "Refusing to run this Playwright suite…" is that guard saying so.
 * It used to be an unenforceable comment; the inheritance is free, and the
 * absolute `globalSetup` path in the root config is what makes it survive the
 * spread.
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
  // Re-root every inherited webServer command. See REPO_ROOT above.
  webServer: (Array.isArray(baseConfig.webServer)
    ? baseConfig.webServer
    : baseConfig.webServer
      ? [baseConfig.webServer]
      : []
  ).map((server) => ({ ...server, cwd: REPO_ROOT })),
});
