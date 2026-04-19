/**
 * Shared path helpers for synthetic `upload://` URIs.
 *
 * The server mints `upload://<id>/<name>` paths when a user opens a file via
 * the upload flow (no real filesystem path). Several modules need to branch on
 * "is this an upload?" — this file is the single source of truth so the prefix
 * never drifts.
 */

export const UPLOAD_PREFIX = "upload://";

export function isUploadPath(filePath: string): boolean {
  return filePath.startsWith(UPLOAD_PREFIX);
}
