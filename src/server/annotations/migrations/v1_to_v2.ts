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
 * envelope is already a structurally valid v2 payload. The frozen v1 Zod
 * schema below is the input contract (mirrors `integrations/migrations.ts`):
 * we refuse to migrate garbage even though the transform is otherwise a no-op.
 */

import { z } from "zod";

import { AnnotationDocSchemaV1 } from "../schema.js";

import type { MigrationFn } from "./runner.js";

export const migrateV1ToV2: MigrationFn = (input) => {
  // Build the frozen input contract LAZILY, inside the function — never at
  // module top level. There is an import cycle
  // (schema.ts → migrations/index.ts → runner.ts → v1_to_v2.ts → schema.ts);
  // evaluating `AnnotationDocSchemaV1.extend(...)` during module init would run
  // before schema.ts finishes defining `AnnotationDocSchemaV1`, throwing a TDZ
  // "Cannot access 'AnnotationDocSchemaV1' before initialization" that crashes
  // the load path on import. Deferring to call time (the same reason the
  // transform itself is an arrow function) sidesteps the cycle: by the time any
  // migration runs, schema.ts is fully initialized.
  //
  // The contract locks `schemaVersion` to the numeric literal `1`, NOT the live
  // `SCHEMA_VERSION` constant. `AnnotationDocSchemaV1` validates `schemaVersion`
  // against `z.literal(SCHEMA_VERSION)` — the *current* version. The moment a
  // future PR bumps `SCHEMA_VERSION` to 2, that schema starts requiring
  // `schemaVersion === 2`, and this migration — which by definition receives
  // genuine v1 files (`schemaVersion: 1`) — would reject every one of them,
  // quarantining all annotations as `corrupt` on the first load after the
  // upgrade. A migration's input version must be pinned to a literal forever;
  // every subsequent migration must follow the same rule.
  const FrozenV1InputSchema = AnnotationDocSchemaV1.extend({
    schemaVersion: z.literal(1),
  });
  const parsed = FrozenV1InputSchema.parse(input);
  // `.passthrough()` on the schema means `parsed` already carries any
  // forward-compatible extra fields verbatim; spread preserves them and the
  // explicit `schemaVersion` override wins over the parsed `1`.
  return {
    ...parsed,
    schemaVersion: 2,
  };
};
