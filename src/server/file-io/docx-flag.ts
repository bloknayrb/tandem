// `.docx` support ships DARK behind this build flag (ADR-053). `__DOCX_ENABLED__`
// is injected by tsup (see tsup.config.ts) from `DOCX_ENABLED` in
// src/shared/constants.ts into the server + cli bundles.
import { DOCX_EXTENSION, extensionsFor } from "../../shared/constants.js";

declare const __DOCX_ENABLED__: boolean;

const defineValue: boolean | undefined =
  typeof __DOCX_ENABLED__ !== "undefined" ? __DOCX_ENABLED__ : undefined;

// Ship-dark guard, the twin of gate-flag.ts's: a sidecar bundle without the
// define would fall back to the env var, so a mis-built bundle is caught at boot.
if (process.env.TANDEM_TAURI_SIDECAR === "1" && typeof defineValue === "undefined") {
  console.error(
    "[docx] WARNING: __DOCX_ENABLED__ define missing in sidecar bundle — " +
      "the .docx flag is falling back to the TANDEM_DOCX env var",
  );
}

/**
 * Whether `.docx` support is on. The build define wins, so a release bundle
 * ignores the environment. Absent a define (tsx dev, vitest), `TANDEM_DOCX=1`
 * turns it on so the dark code stays tested; `DOCX_ENABLED` itself is not
 * consulted there, because the define is the release truth and is sourced from it.
 *
 * Read on every call, never cached: tests flip it with `vi.stubEnv`, and the
 * values derived from it (the allowlist, tool registration, tool wording) are
 * computed per call or per `McpServer`, never at import.
 */
export function docxEnabled(): boolean {
  if (typeof defineValue !== "undefined") return defineValue;
  return process.env.TANDEM_DOCX === "1";
}

/** Every extension the server opens right now: the base set, plus `.docx` when enabled. */
export function supportedExtensions(): ReadonlySet<string> {
  return extensionsFor(docxEnabled());
}

/** True when `ext` (lower-cased, with its dot) is `.docx` and `.docx` is off. */
export function isDarkDocx(ext: string): boolean {
  return ext === DOCX_EXTENSION && !docxEnabled();
}
