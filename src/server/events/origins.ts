/**
 * Y.Map transaction origin constants for the Tandem event queue.
 *
 * Kept in a standalone file so that `src/server/annotations/sync.ts` can
 * import `FILE_SYNC_ORIGIN` without creating a circular dependency through
 * `queue.ts`.
 */

/** Origin tag for all MCP-initiated Y.Map writes. */
export const MCP_ORIGIN = "mcp";

/**
 * Origin tag for Y.Map writes that originated from the annotation file-writer
 * (app-data JSON → Y.Map sync). Observers that emit channel events to external
 * consumers MUST skip transactions with this origin so a file-reload doesn't
 * fire spurious `annotation:*` SSE events.
 */
export const FILE_SYNC_ORIGIN = "file-sync";
