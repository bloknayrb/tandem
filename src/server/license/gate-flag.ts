// The license gate ships DARK behind this build flag (ADR-040 consequences).
// `__LICENSE_GATE_ENABLED__` is injected by tsup (see tsup.config.ts) into every
// bundle whose tree can import this module — today the server + cli bundles.
// Default: false (v0.16.0). Flip the single tsup const to `true` at v1.0.
declare const __LICENSE_GATE_ENABLED__: boolean;

/**
 * Pure flag resolver (injectable for tests). The build-time `define` value wins;
 * absent a define (tsx dev / vitest), the `TANDEM_LICENSE_GATE=1` env var enables
 * the gate so both paths can be exercised without rebuilding.
 */
export function readGateFlag(deps: {
  defineValue: boolean | undefined;
  env: Record<string, string | undefined>;
}): boolean {
  if (typeof deps.defineValue !== "undefined") return deps.defineValue;
  return deps.env.TANDEM_LICENSE_GATE === "1";
}

const defineValue: boolean | undefined =
  typeof __LICENSE_GATE_ENABLED__ !== "undefined" ? __LICENSE_GATE_ENABLED__ : undefined;

// Ship-dark guard: a production sidecar bundle MUST carry the define. If it
// doesn't, we'd silently fall back to the env var and ship dark regardless of
// the build const — warn loudly so a mis-built bundle is caught at boot.
if (process.env.TANDEM_TAURI_SIDECAR === "1" && typeof defineValue === "undefined") {
  console.error(
    "[license] WARNING: __LICENSE_GATE_ENABLED__ define missing in sidecar bundle — " +
      "gate flag is falling back to the TANDEM_LICENSE_GATE env var",
  );
}

export const GATE_ENABLED = readGateFlag({ defineValue, env: process.env });
