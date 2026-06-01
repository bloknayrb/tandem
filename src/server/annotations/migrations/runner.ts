/**
 * Versioned migration framework for the on-disk annotation envelope
 * (`<annotationsDir>/<docHash>.json`).
 *
 * Modeled on `src/server/integrations/migrations.ts`: an ordered
 * `MigrationFn[]` chain plus a `migrateUp(input, fromVersion, toVersion)`
 * runner. `migrations[i]` migrates v(i+1) → v(i+2).
 *
 * **Contract for migration authors:** the `input` parameter is typed
 * `unknown` and the framework does NOT validate the v_n shape before passing
 * it to your function. Validate with Zod against the v_n schema inside the
 * migration — do NOT use `as` casts. The `unknown` input type is the
 * compile-time signal that runtime validation is required.
 *
 * **Current state:** the production envelope is still `SCHEMA_VERSION = 1`
 * (see `../schema.ts`). The v1 → v2 entry below is a dormant proof-of-shape:
 * because `migrateUp` is always called with `toVersion === SCHEMA_VERSION`,
 * it never fires during a normal load while `SCHEMA_VERSION` is 1. When a
 * future PR bumps `SCHEMA_VERSION` to 2, the load path begins running it
 * automatically with no further wiring.
 */

import { migrateV1ToV2 } from "./v1_to_v2.js";

export type MigrationFn = (input: unknown) => unknown;

/**
 * Ordered migration chain. `migrations[i]` migrates v(i+1) → v(i+2).
 * Module-local — exposed only via `migrateUp` so external code cannot inject
 * a migration at runtime.
 */
const migrations: ReadonlyArray<MigrationFn> = [migrateV1ToV2];

/**
 * Run the migration chain forward from `fromVersion` to `toVersion`. The
 * caller is responsible for Zod-validating the result. A missing migration
 * throws — silent default behavior would mask a corrupt or future-version
 * file.
 *
 * Returns `input` unchanged (by reference) when `fromVersion === toVersion`,
 * so the common already-current case allocates nothing.
 */
export function migrateUp(input: unknown, fromVersion: number, toVersion: number): unknown {
  if (toVersion < fromVersion) {
    throw new Error(`Cannot migrate down: from v${fromVersion} to v${toVersion}`);
  }
  let current = input;
  for (let v = fromVersion; v < toVersion; v++) {
    const m = migrations[v - 1];
    if (!m) {
      throw new Error(`No migration registered from v${v} to v${v + 1}`);
    }
    current = m(current);
  }
  return current;
}
