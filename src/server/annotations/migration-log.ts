/**
 * Once-per-(doc, kind) logging for legacy annotation migrations.
 *
 * Several read/write paths silently rewrite v0 annotations into the v1
 * model — flag→note, directedAt strip, unknown-type → comment coercion. The
 * rewrites are correct, but a silent rewrite destroys the v0→v1 forensic
 * trail: an operator investigating "where did my flags go?" sees no trace.
 *
 * This module gives those paths a shared dedup mechanism keyed by
 * `${docHash}:${kind}` so each lossy upgrade fires exactly once per doc per
 * kind, regardless of which path triggered it (parseAnnotationDoc, the
 * sync.ts fast-path strip, migrateToV1, etc.).
 *
 * Module placement: `sync.ts` already imports from `schema.ts`, so adding
 * a sync→schema log import would create a cycle. This module is the
 * shared dependency-free home both can import from.
 */

export type LegacyMigrationKind = "flag" | "directedAt" | "legacy-type";

/** Dedup state — `${docHash}:${kind}`. Cleared on doc close via `forgetDoc`. */
const loggedLegacyMigrations = new Set<string>();

/** Sentinel docHash for `migrateToV1`, whose envelope has `docHash: ""`. */
export const MIGRATE_TO_V1_DOC_HASH = "<migrateToV1>";

/**
 * Log a legacy-migration event the first time it's seen for `(docHash, kind)`.
 * Subsequent calls with the same pair are silent. `docHash === undefined`
 * skips dedup entirely (logs every call) — used in test paths and as a
 * defensive default.
 */
export function logLegacyMigration(docHash: string | undefined, kind: LegacyMigrationKind): void {
  if (docHash === undefined) {
    console.error(`[ANNOTATION-STORE] legacy migration: ${kind} (no docHash)`);
    return;
  }
  const key = `${docHash}:${kind}`;
  if (loggedLegacyMigrations.has(key)) return;
  loggedLegacyMigrations.add(key);
  console.error(`[ANNOTATION-STORE] legacy migration: ${kind} in ${docHash}`);
}

/** Drop dedup state for a specific doc — call on doc close so a reopen logs again. */
export function forgetDoc(docHash: string): void {
  for (const key of loggedLegacyMigrations) {
    if (key.startsWith(`${docHash}:`)) loggedLegacyMigrations.delete(key);
  }
}

/** Reset all dedup state. Tests only. */
export function resetMigrationLog(): void {
  loggedLegacyMigrations.clear();
}
