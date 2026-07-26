/**
 * The activation error class.
 *
 * The codes and their user-facing copy live in `src/shared/license-copy.ts` —
 * the client needs them too, and `shared/` is the only tree all three surfaces
 * (server, CLI, browser) may import. This module exists solely so the throw
 * sites have a typed error to raise, without the CLI having to import the
 * Express route module to get at it.
 */
import type { LicenseActivationCode } from "../../shared/license-copy.js";

export class LicenseActivationError extends Error {
  constructor(
    readonly code: LicenseActivationCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LicenseActivationError";
  }
}
