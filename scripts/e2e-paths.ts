/**
 * Filesystem constants shared by the E2E harness.
 *
 * Neutral home on purpose. Three files need this value and none of them should
 * own it: `playwright.config.ts` sets it as `TANDEM_APP_DATA_DIR`,
 * `scripts/e2e-guard.ts` compares a live server's reported path against it, and
 * `tests/e2e/helpers.ts` derives the annotations dir from it. A guard is a
 * policy module and a config is a config; a path is data.
 *
 * `scripts/e2e-server.mjs` deliberately does NOT import from here — it
 * re-validates the dir by basename before wiping it, and that independence is
 * the safety boundary that keeps a bad import from turning into a bad `rm`.
 */
export const E2E_APP_DATA_DIR = "/tmp/tandem-e2e-data";

/**
 * The wipe of {@link E2E_APP_DATA_DIR} lives in `scripts/e2e-server.mjs`, not
 * here and not in the config: Playwright re-imports both in every worker
 * process, so an `rmSync` at module scope would re-fire mid-run underneath the
 * live server. Full rationale in that launcher's header.
 */
export const E2E_APP_DATA_BASENAME = "tandem-e2e-data";
