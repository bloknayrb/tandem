/**
 * The development and test stand-in for the user's home, for every Claude
 * client config and skill path Tandem reads or writes (#2358 PR 2b).
 *
 * PR 2b makes the boot sweep rewrite `~/.claude.json`, and no test, dev server
 * or E2E run may touch the real one. So when the build define is ABSENT — tsx
 * (`npm run dev:server`, the local E2E server, `tsx src/cli/index.ts`) and
 * vitest — `detectTargets` and the skill installers treat
 * `TANDEM_CLIENT_CONFIG_HOME`, or failing that `<app-data>/client-config-home`,
 * as the home. Never the real one: a forgotten harness line cannot undo it.
 *
 * **When the define is present this returns undefined**, as `TANDEM_DOCX`
 * works (`file-io/docx-flag.ts`): both bundles that import this module,
 * `dist/server` and `dist/cli`, define `__TANDEM_VERSION__` (tsup.config.ts),
 * so no release build can be redirected by the variable. A built bundle run
 * from a checkout (CI's E2E server, perf, `cargo tauri dev`) is kept off the
 * real config by a different gate: the boot sweep and the skill refresh
 * (`refreshAllMcpEntryBinaries`, `refreshExistingSkillIfStale` in `apply.ts`)
 * run only from an installed build (`mayTouchDefaultClientConfigs`).
 *
 * Dependency-free on purpose: `tests/scripts/client-config-home-wiring.test.ts`
 * builds this file with and without the define and checks both behaviours, and
 * pins that no bundle lacking the define (stdio-bridge, channel, monitor) can
 * import it.
 */

declare const __TANDEM_VERSION__: string;

export const CLIENT_CONFIG_HOME_ENV = "TANDEM_CLIENT_CONFIG_HOME";

/**
 * The stand-in home, or undefined in a release build (use the real home).
 * `fallback` names the scratch home used when the variable is unset.
 */
export function devClientConfigHome(
  env: NodeJS.ProcessEnv,
  fallback: () => string,
): string | undefined {
  if (typeof __TANDEM_VERSION__ !== "undefined") return undefined;
  const value = env[CLIENT_CONFIG_HOME_ENV];
  return value && value.length > 0 ? value : fallback();
}
