/**
 * v1 → v2 annotation-envelope migration.
 *
 * **Proof-of-shape, not a real schema change.** The on-disk annotation
 * envelope is still `schemaVersion: 1` in production (`SCHEMA_VERSION` in
 * `../schema.ts` is unchanged). This migration exists to prove the framework
 * end-to-end and to give the first *real* v2 a place to land: when a future
 * PR bumps `SCHEMA_VERSION` to 2, the load path begins running this function
 * automatically with no further wiring.
 *
 * The transform is an identity over the record payload — it only re-stamps
 * `schemaVersion` to 2. No fields are added, removed, or reshaped, so a v1
 * envelope is already a structurally valid v2 payload. The v1 Zod schema is
 * the input contract (mirrors `integrations/migrations.ts`): we refuse to
 * migrate garbage even though the transform is otherwise a no-op.
 */

import { AnnotationDocSchemaV1 } from "../schema.js";

import type { MigrationFn } from "./runner.js";

export const migrateV1ToV2: MigrationFn = (input) => {
  const parsed = AnnotationDocSchemaV1.parse(input);
  // `.passthrough()` on the schema means `parsed` already carries any
  // forward-compatible extra fields verbatim; spread preserves them and the
  // explicit `schemaVersion` override wins over the parsed `1`.
  return {
    ...parsed,
    schemaVersion: 2,
  };
};
