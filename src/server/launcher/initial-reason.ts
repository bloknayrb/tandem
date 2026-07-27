/**
 * Initial auto-launcher state resolution (#1236).
 *
 * Lives in its own module rather than in `src/server/index.ts` because
 * importing that file *runs the server*: `main()` is invoked at the bottom of
 * it, and `main()` calls `freePort()`, which kills whatever process holds
 * :3478/:3479. A test that imported it would terminate the developer's running
 * dev server. Pure function, pure module, no side effects on import.
 */

import type { LauncherUnavailableReason } from "../../shared/launcher/contract.js";

/**
 * Resolve the launcher's starting state from the environment.
 *
 * The precedence is load-bearing:
 *
 * - `TANDEM_DISABLE_LAUNCHER=1` is an operator kill switch and MUST outrank the
 *   autostart deferral. `POST /api/launcher/start` only accepts
 *   `deferred-autostart`, so if the deferral won here that route would become
 *   an HTTP bypass of a kill switch that is otherwise undefeatable remotely.
 * - `TANDEM_DEFER_LAUNCHER` is only honored when `TANDEM_TAURI_SIDECAR === "1"`.
 *   The server reads `process.env` regardless of who spawned it, and
 *   `tandem start` inherits the shell environment — without this gate an
 *   exported var would permanently kill the auto-launcher on the npm
 *   distribution, which has neither a Settings toggle nor a presence trigger to
 *   recover with.
 *
 * Both vars are compared against exactly `"1"`, matching every other
 * `TANDEM_*` switch in the codebase.
 */
export function resolveInitialLauncherReason(env: NodeJS.ProcessEnv): LauncherUnavailableReason {
  if (env.TANDEM_DISABLE_LAUNCHER === "1") return "disabled-by-env";
  if (env.TANDEM_DEFER_LAUNCHER === "1" && env.TANDEM_TAURI_SIDECAR === "1") {
    return "deferred-autostart";
  }
  return "stdio-mode";
}
