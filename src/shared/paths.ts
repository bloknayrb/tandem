/**
 * Shared path helpers for synthetic `upload://` URIs and `upload://scratchpad/` URIs.
 *
 * The server mints `upload://<id>/<name>` paths when a user opens a file via
 * the upload flow (no real filesystem path). Scratchpad documents use
 * `upload://scratchpad/<uuid>/Scratchpad.md` — a sub-prefix of the upload
 * namespace — so every existing `isUploadPath` branch (session filtering,
 * save skipping, recent-files exclusion) covers scratchpads for free.
 *
 * Several modules need to branch on these prefixes — this file is the single
 * source of truth so the prefixes never drift.
 */

export const UPLOAD_PREFIX = "upload://";

/** Sub-prefix for ephemeral scratchpad documents. Always begins with UPLOAD_PREFIX. */
export const SCRATCHPAD_PREFIX = "upload://scratchpad/";

export function isUploadPath(filePath: string): boolean {
  return filePath.startsWith(UPLOAD_PREFIX);
}

/**
 * True when the path is a scratchpad synthetic URI
 * (`upload://scratchpad/<uuid>/Scratchpad.md`). Use this instead of scattering
 * the `SCRATCHPAD_PREFIX` literal so the prefix never drifts.
 */
export function isScratchpadPath(filePath: string): boolean {
  return filePath.startsWith(SCRATCHPAD_PREFIX);
}

/**
 * Extract the scratchpad UUID from a scratchpad synthetic path. Returns null
 * when the path is not a scratchpad path or has no UUID segment. The UUID is
 * the path segment immediately following `SCRATCHPAD_PREFIX`
 * (`upload://scratchpad/<uuid>/Scratchpad.md` → `<uuid>`).
 *
 * Persistence keys scratchpad content by this UUID rather than by the document
 * hash: all scratchpads collapse to one `docHash`, so keying by hash would make
 * concurrent scratchpads overwrite each other's recovery content.
 */
export function scratchpadUuidFromPath(filePath: string): string | null {
  if (!isScratchpadPath(filePath)) return null;
  const rest = filePath.slice(SCRATCHPAD_PREFIX.length);
  const uuid = rest.split("/")[0];
  return uuid.length > 0 ? uuid : null;
}
