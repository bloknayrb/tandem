/**
 * Y.Doc transaction origin constants — re-exported from `src/shared/origins.ts`.
 *
 * Kept as a thin re-export for backward compatibility during the ADR-031
 * migration. PR 9 (shim cleanup) removes this file once every callsite
 * imports from `shared/origins` directly. New code should import from
 * `src/shared/origins.ts`.
 */

export {
  BROWSER_ORIGIN,
  FILE_SYNC_ORIGIN,
  INTERNAL_ORIGIN,
  MCP_ORIGIN,
  RELOAD_ORIGIN,
  type TandemOrigin,
} from "../../shared/origins.js";
