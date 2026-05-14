import { setActiveDocId } from "./mcp/document-service.js";
import { openFileByPath } from "./mcp/file-opener.js";

/**
 * Open a file referenced by the `TANDEM_OPEN_FILE` env var, if set.
 *
 * Used by the HTTP-mode startup block to honor the OS-file-association cold
 * start: the Tauri shell parses argv on Windows / Linux, extracts the file
 * path, and exports it as `TANDEM_OPEN_FILE` before spawning the Node sidecar.
 * `openFileByPath` runs synchronously before HTTP bind so the doc is in
 * `openDocuments` by the time browser clients connect — required to keep stale
 * tabs from CRDT-merging an `openDocuments` list that lacks the new doc (see
 * CLAUDE.md "Startup document opens must precede server bind").
 *
 * Returns `true` when a doc was successfully opened, `false` otherwise (env
 * var unset OR open failed). Callers use the return value to decide whether
 * to skip the `welcome.md` fallback.
 *
 * Failures (bad path, unsupported extension, size limit, etc.) are logged but
 * not thrown — a broken `TANDEM_OPEN_FILE` should not abort startup.
 */
export async function maybeOpenStartupFile(envPath: string | undefined): Promise<boolean> {
  if (!envPath || envPath.trim() === "") return false;
  try {
    const result = await openFileByPath(envPath);
    setActiveDocId(result.documentId);
    console.error(`[Tandem] Opened TANDEM_OPEN_FILE on startup: ${envPath}`);
    return true;
  } catch (err) {
    console.error(
      `[Tandem] TANDEM_OPEN_FILE failed (${envPath}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}
