/**
 * Versioned migration framework for the `IntegrationsFile` on-disk shape.
 *
 * **Contract for migration authors:** the `input` parameter is typed
 * `unknown` and the framework does not validate the v_n shape before
 * passing it to your function. Validate with Zod against `IntegrationsFileVn`
 * inside the migration — do NOT use `as IntegrationsFileVn` casts. The
 * `unknown` input type is the compile-time signal that runtime validation
 * is required.
 *
 * The simple `unknown → unknown` signature is intentional — when generics
 * would erase to `unknown` for the empty initial array, they add no safety.
 * When a future PR has a real type-witness pair (v2 → v3) to constrain,
 * we can revisit.
 */

import { IntegrationsFileV1Schema } from "./schema.js";

export type MigrationFn = (input: unknown) => unknown;

/**
 * v1 → v2: re-stamp `schemaVersion` to 2. v1 added no new required fields
 * to existing kinds and removed no kinds, so the `integrations` array is
 * a structurally valid v2 payload. The v1 Zod schema is the input contract
 * — we refuse to migrate garbage, even though the v2 schema would accept
 * a superset of v1's shape.
 */
const migrateV1ToV2: MigrationFn = (input) => {
  const parsed = IntegrationsFileV1Schema.parse(input);
  return {
    schemaVersion: 2,
    integrations: parsed.integrations,
    ...(parsed.defaultIntegrationId !== undefined
      ? { defaultIntegrationId: parsed.defaultIntegrationId }
      : {}),
  };
};

/**
 * Ordered migration chain. `migrations[i]` migrates v(i+1) → v(i+2).
 * Module-local — exposed only via `migrateUp` so external code cannot
 * inject a migration at runtime.
 */
const migrations: ReadonlyArray<MigrationFn> = [migrateV1ToV2];

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
