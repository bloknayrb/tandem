/**
 * Versioned migration framework for the `IntegrationsFile` on-disk shape.
 *
 * PR 1 ships the framework with **no migrations**. PR 3 (wizard) introduces
 * the first v1→v2 migration alongside `tokenSecretRef`, at which point this
 * file gains a real `migrations[0]` entry and the generic-typed migration
 * pattern with explicit `IntegrationsFileV1 → IntegrationsFileV2` witnesses.
 *
 * The simple `unknown → unknown` signature is intentional — when the array
 * is empty, generics would erase to `unknown` anyway and add no safety.
 */

export type MigrationFn = (input: unknown) => unknown;

/**
 * Ordered migration chain. `migrations[i]` migrates v(i+1) → v(i+2).
 * Empty for PR 1.
 */
export const migrations: MigrationFn[] = [];

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
