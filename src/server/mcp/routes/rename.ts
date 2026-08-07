import type { Request, Response } from "express";
import path from "path";

import { API_RENAME } from "../../../shared/api-paths.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
} from "../../integrations/api-routes.js";
import { renameDocument } from "../document-service.js";
import { errorCodeToHttpStatus, isLoopbackRequest, scrubOptionalPathForCaller } from "./_shared.js";

/**
 * Path-free copy for a non-loopback caller, keyed by renameDocument's errorCode.
 *
 * Kept here rather than in `_shared.ts`'s GENERIC_ERROR_MESSAGE because the
 * rename codes deliberately do not flow through `errorCodeToLabel` — see the
 * NOTE there. The fallback covers the `fs.rename` errno codes (EXDEV, EPERM,
 * EACCES, …) that reach this branch unmapped and whose Node messages embed both
 * absolute paths.
 */
const RENAME_GENERIC_MESSAGE: Record<string, string> = {
  NOT_FOUND: "The document is not open.",
  READ_ONLY: "The document is read-only.",
  NOT_RENAMABLE: "Only on-disk files can be renamed.",
  INVALID_NAME: "The new filename is not valid.",
  INVALID_PATH: "The new filename is not valid.",
  EXTENSION_MISMATCH: "The file extension must stay the same.",
  PATH_REJECTED: "The destination path was rejected.",
  ALREADY_EXISTS: "A file with that name already exists.",
  RENAME_IN_PROGRESS: "A rename is already in progress.",
  SAVE_IN_PROGRESS: "A save is in progress; try again.",
};

/**
 * POST /api/rename — rename an open on-disk document's file in place (#1017).
 *
 * Body: `{ documentId: string, newName: string }`. `newName` is a bare basename
 * (same directory, same extension). Gated on origin allowlist + loopback so
 * authenticated LAN callers cannot rename local files (#1121 F6).
 */
export async function handleRename(req: Request, res: Response): Promise<void> {
  if (assertOriginAllowlisted(req, res, API_RENAME)) return;
  if (assertLoopbackForMutation(req, res)) return;
  const { documentId: rawDocumentId, newName: rawNewName } = (req.body ?? {}) as Record<
    string,
    unknown
  >;
  if (!rawDocumentId || typeof rawDocumentId !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId is required" });
    return;
  }
  if (!rawNewName || typeof rawNewName !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "newName is required" });
    return;
  }
  // Sanitize both inputs at the HTTP boundary via path.basename(). CodeQL's
  // js/path-injection taint-tracker treats path.basename() as a sanitizer
  // barrier, so the basename'd binding is what flows to renameDocument's
  // file-system sinks. The `tandem_rename` MCP handler basenames identically
  // (document.ts), so both entry points normalize a path-like input to its
  // last component rather than rejecting it — separators (`sub/b.md` → `b.md`)
  // and single-char drive prefixes (`a:b.md` → `b.md`) are stripped here. Every
  // other illegal name (`<>"|?*`, control chars, reserved devices, trailing
  // dot, multi-char `name:stream`) survives basename and is rejected by
  // renameDocument's validateRenameFilename. documentId is a hash with no
  // separators, so basename is a no-op on valid input; a malformed one strips
  // to a value that just misses openDocs.get() → NOT_FOUND.
  const documentId = path.basename(rawDocumentId);
  if (!documentId) {
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId is required" });
    return;
  }
  const newName = path.basename(rawNewName);
  if (!newName) {
    res.status(400).json({ error: "INVALID_PATH", message: "newName must not be empty" });
    return;
  }

  const result = await renameDocument(documentId, newName);
  if (result.status === "error") {
    const status = errorCodeToHttpStatus(result.errorCode);
    // #1294: the success branch below basenames its paths, but this branch used
    // to echo `result.reason` verbatim — and two of renameDocument's reasons are
    // absolute-path-bearing: `assertPathSafe` throws "Refusing to operate on
    // symlinked path: <abs>", and a failed `fs.rename` throws a message carrying
    // both the old and the new absolute path. The error branch is where this
    // class of leak survives a fix aimed at the success branch, so it gets the
    // same treatment sendApiError gives its detail: structured code for
    // everyone, free-text reason for loopback only.
    res.status(status).json({
      error: result.errorCode ?? "INTERNAL",
      message: isLoopbackRequest(req)
        ? result.reason
        : (RENAME_GENERIC_MESSAGE[result.errorCode ?? "INTERNAL"] ?? "The rename failed."),
    });
    return;
  }

  // #1294: oldPath/newPath were returned verbatim. `fileName` is already a
  // basename, so a non-loopback caller loses nothing actionable — only the
  // directory layout and username the absolute paths disclosed.
  res.json({
    data: {
      oldPath: scrubOptionalPathForCaller(req, result.oldPath),
      newPath: scrubOptionalPathForCaller(req, result.newPath),
      fileName: result.fileName,
    },
  });
}
