/**
 * Public entry point for the annotation-envelope migration framework.
 * See `./runner.ts` for the runner contract and `./v1_to_v2.ts` for the
 * first (dormant, proof-of-shape) migration.
 */

export { type MigrationFn, migrateUp } from "./runner.js";
export { migrateV1ToV2 } from "./v1_to_v2.js";
