/**
 * The activation and removal error classes.
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

/**
 * Removing this device's licence failed (#1943): `license.json` is there but
 * could not be deleted (a lock, or permissions). ENOENT is not this error —
 * there was nothing to remove. The message names the directory, never file
 * contents.
 */
export class LicenseRemovalError extends Error {
  readonly code = "REMOVE_FAILED" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LicenseRemovalError";
  }
}
