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
    await openFileByPath(envPath);
  } catch (err) {
    console.error(
      `[Tandem] TANDEM_OPEN_FILE failed (${envPath}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }

  // No activation call here, deliberately. `openFileByPath` has already
  // registered the document, made it active and published all of that in one
  // broadcast — `finalizeDocOpen` through `openDocumentWhenReady`, and the
  // already-open branch through `activateDocument`. Re-activating would advance
  // the activation epoch a SECOND time for one startup gesture and emit a second
  // `documentMeta` broadcast, which is the exact double-advance the registry's
  // composite surface exists to make unrepresentable (ADR-033).
  //
  // This was a bare `setActiveDocId` before ADR-033 and was already redundant
  // then; it only looked harmless because it emitted no broadcast of its own.
  // `startup-file.test.ts` pins the outcome rather than the call: exactly one
  // epoch advance, and CTRL_ROOM's published active id equal to the opened doc.
  console.error(`[Tandem] Opened TANDEM_OPEN_FILE on startup: ${envPath}`);
  return true;
}
