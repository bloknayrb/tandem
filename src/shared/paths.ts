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

export function isScratchpadPath(filePath: string): boolean {
  return filePath.startsWith(SCRATCHPAD_PREFIX);
}
