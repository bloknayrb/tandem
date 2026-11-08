// Multi-session document ownership ships DARK behind this build flag (#2358,
// ADR-054). `__OWNERSHIP_ENABLED__` is injected by tsup (see tsup.config.ts)
// from `OWNERSHIP_ENABLED` in src/shared/constants.ts into the server + cli
// bundles. The define-less bundles (the stdio bridge, the shim, the monitor)
// and `src/shared` never import this module; tests/server/ownership-module-seam.test.ts
// pins that.

declare const __OWNERSHIP_ENABLED__: boolean;

// Ship-dark guard, the twin of docx-flag.ts's: a sidecar bundle without the
// define would fall back to the env var, so a mis-built bundle is caught at boot.
if (process.env.TANDEM_TAURI_SIDECAR === "1" && typeof __OWNERSHIP_ENABLED__ === "undefined") {
  console.error(
    "[ownership] WARNING: __OWNERSHIP_ENABLED__ define missing in sidecar bundle — " +
      "the ownership flag is falling back to the TANDEM_OWNERSHIP env var",
  );
}

/**
 * Whether multi-session document ownership is on. The build define wins, so a
 * release bundle ignores the environment. Absent a define (tsx dev, vitest),
 * `TANDEM_OWNERSHIP=1` turns it on so the dark code stays tested;
 * `OWNERSHIP_ENABLED` itself is not consulted there, because the define is
 * the release truth and is sourced from it.
 *
 * Read on every call, never cached: tests flip it with `vi.stubEnv`. The
 * define is read here, not into a module-level constant: a bundle wraps this
 * module in a lazy initializer, and a call that ran before it would otherwise
 * see `undefined` and fall back to the environment. Unlike
 * `TANDEM_DOCX`, `TANDEM_OWNERSHIP` is deliberately absent from vitest's root
 * `test.env`, so the default suite runs flag-off and only the
 * `ownership-flag-on` CI job (and test files that stub it) run flag-on.
 */
export function ownershipEnabled(): boolean {
  if (typeof __OWNERSHIP_ENABLED__ !== "undefined") return __OWNERSHIP_ENABLED__;
  return process.env.TANDEM_OWNERSHIP === "1";
}
