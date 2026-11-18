/**
 * Which kind of server run this is, for the development allowance
 * (`TANDEM_MODELS_DEV_ORIGIN`, #2410, ADR-039 P9 and V15).
 *
 * The allowance names one extra origin that may change the local-model
 * settings. It exists for the Vite dev client and the E2E harness, so a build
 * Tandem ships must not honour it just because the variable is in its
 * environment: an exported shell, a leftover developer setting or a profile
 * entry would otherwise reach every launch of the desktop app or `tandem`.
 *
 *  - `"source"`: no `__TANDEM_VERSION__` define (tsx, vitest). The allowance
 *    works as it always has. A bundle that lost the define classifies here
 *    too, which is why CI checks the built server for the define.
 *  - `"e2e-harness"`: a release build whose argv carries
 *    {@link E2E_HARNESS_ARGV_FLAG}, which only the E2E harness's launcher
 *    (`scripts/e2e-server.mjs`) adds. CI's E2E backend is the built server,
 *    so it keeps the allowance this way (V15).
 *  - `"release"`: any other run of a release build. The allowance is ignored.
 *
 * The fact is argv for the same reason `isTauriSidecar` reads argv: a web page
 * cannot set it, a child process does not inherit it, and no shipped launcher
 * passes it (the desktop shell passes exactly the server entry point and
 * `--tauri-sidecar`; the npm `tandem` passes exactly the server entry point).
 * So an ACCIDENTALLY inherited variable no longer opens the allowance. What it
 * does not stop is whoever controls the server's environment or command line:
 * `NODE_OPTIONS` can preload code that pushes the argument, and such an actor
 * already runs code in the server. That is #2410's existing residual, "a
 * process running as the user" (docs/security.md).
 *
 * Imports nothing and reads no environment variable; argv is a parameter so
 * the caller's is the only one read.
 */

declare const __TANDEM_VERSION__: string;

/** The argument only the E2E harness's launcher adds to the server's argv. */
export const E2E_HARNESS_ARGV_FLAG = "--tandem-e2e-harness";

export type DevAllowanceBuild = "source" | "e2e-harness" | "release";

/** First match wins: no define, then the harness argument (exact element), then release. */
export function devAllowanceBuild(argv: readonly string[]): DevAllowanceBuild {
  if (typeof __TANDEM_VERSION__ === "undefined") return "source";
  if (argv.includes(E2E_HARNESS_ARGV_FLAG)) return "e2e-harness";
  return "release";
}
