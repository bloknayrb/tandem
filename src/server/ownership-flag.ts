// Multi-session document ownership (#2358, ADR-054), on since the flip.
// `__OWNERSHIP_ENABLED__` is injected by tsup (see tsup.config.ts) from
// `OWNERSHIP_ENABLED` in src/shared/constants.ts into the server + cli
// bundles. The define-less bundles (the stdio bridge, the shim, the monitor)
// and `src/shared` never import this module; tests/server/ownership-module-seam.test.ts
// pins that.

import { OWNERSHIP_ENABLED } from "../shared/constants.js";

declare const __OWNERSHIP_ENABLED__: boolean;

// Ship guard, the twin of docx-flag.ts's: a sidecar bundle without the define
// would fall back to the env var (or, unset, the literal), so a mis-built
// bundle is caught at boot.
if (process.env.TANDEM_TAURI_SIDECAR === "1" && typeof __OWNERSHIP_ENABLED__ === "undefined") {
  console.error(
    "[ownership] WARNING: __OWNERSHIP_ENABLED__ define missing in sidecar bundle — " +
      "the ownership flag is falling back to the TANDEM_OWNERSHIP env var, or the source literal when it is unset",
  );
}

/**
 * Whether multi-session document ownership is on. The build define wins, so a
 * release bundle ignores the environment. Absent a define (tsx dev, vitest),
 * a set `TANDEM_OWNERSHIP` decides (on for exactly `"1"`, so `""` runs the
 * dark path a test pins), and an unset one follows the `OWNERSHIP_ENABLED`
 * literal, so a run from source behaves as a release does (the flip,
 * ADR-054's flip amendment; before it, the literal was `false` and this
 * fallback read the variable alone).
 *
 * Read on every call, never cached: tests flip it with `vi.stubEnv`. The
 * define is read here, not into a module-level constant: a bundle wraps this
 * module in a lazy initializer, and a call that ran before it would otherwise
 * see `undefined` and fall back to the environment. `TANDEM_OWNERSHIP` is
 * absent from vitest's root `test.env`, so the default suite follows the
 * literal.
 */
export function ownershipEnabled(): boolean {
  if (typeof __OWNERSHIP_ENABLED__ !== "undefined") return __OWNERSHIP_ENABLED__;
  if (process.env.TANDEM_OWNERSHIP === undefined) return OWNERSHIP_ENABLED;
  return process.env.TANDEM_OWNERSHIP === "1";
}
