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
 * The wipe lives in that launcher rather than here or in the config because
 * Playwright re-imports both in every worker process, so an `rmSync` at module
 * scope would re-fire mid-run underneath the live server.
 */
export const E2E_APP_DATA_DIR = "/tmp/tandem-e2e-data";

/**
 * The basename `scripts/e2e-server.mjs` requires before it will `rm -rf` the
 * dir, restated here as the declaration of what that literal is supposed to be.
 *
 * Nothing imports this — importing it is precisely what the launcher must not
 * do (see above). It is load-bearing anyway, because
 * `tests/scripts/e2e-guard-wiring.test.ts` asserts all three copies agree: this
 * one, `path.basename(E2E_APP_DATA_DIR)`, and the literal in the launcher
 * source. Without that assertion the "Must match" comment over there is a
 * promise nothing keeps, and drifting them makes the launcher refuse to wipe
 * (`exit 1`) while the config still points at the old dir.
 */
export const E2E_APP_DATA_BASENAME = "tandem-e2e-data";
