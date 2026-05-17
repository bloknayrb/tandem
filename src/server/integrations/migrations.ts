/**
 * Versioned migration framework for the `IntegrationsFile` on-disk shape.
 *
 * PR 1 ships the framework with **no migrations**. PR 3 (wizard) introduces
 * the first v1→v2 migration alongside `tokenSecretRef`. To register a real
 * migration in a future PR, add an entry to the `migrations` array below
 * (do NOT re-export it; the registry is module-local on purpose so external
 * code cannot push a migration into the chain at runtime).
 *
 * **Contract for migration authors:** the `input` parameter is typed
 * `unknown` and the framework does not validate the v_n shape before
 * passing it to your function. Validate with Zod against `IntegrationsFileVn`
 * inside the migration — do NOT use `as IntegrationsFileVn` casts. The
 * `unknown` input type is the compile-time signal that runtime validation
 * is required.
 *
 * The simple `unknown → unknown` signature is intentional — when the array
 * is empty, generics would erase to `unknown` anyway and add no safety.
 * PR 3 may revisit the generic typing when there is a real type witness
 * pair (v1 → v2) to constrain.
 */

export type MigrationFn = (input: unknown) => unknown;

/**
 * Ordered migration chain. `migrations[i]` migrates v(i+1) → v(i+2).
 * Empty for PR 1. Module-local — exposed only via `migrateUp` so external
 * code cannot inject a migration at runtime.
 */
const migrations: ReadonlyArray<MigrationFn> = [];

/**
 * Run the migration chain forward from `fromVersion` to `toVersion`. The
 * caller is responsible for Zod-validating the result. A missing migration
 * throws — silent default behavior would mask a corrupt or future-version
 * file.
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
