/**
 * MCP tools for applying accepted suggestions back into .docx files as
 * tracked changes, and restoring from backup.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { listDocBackups } from "../file-io/doc-backup.js";
import {
  type AcceptedSuggestion,
  applyTrackedChanges,
  atomicWriteBuffer,
} from "../file-io/index.js";
import { resolveAppDataDir } from "../platform.js";
import { relPosToFlatOffset } from "../positions.js";
import { extractText } from "./document-model.js";
import { getCurrentDoc, requireDocument } from "./document-service.js";
import { YDocStore } from "./document-store.js";
import { restoreDocumentFromBackup } from "./file-opener.js";
import { gatedTool } from "./license-gate.js";
import { mcpError, mcpSuccess, noDocumentError } from "./response.js";

// ---------------------------------------------------------------------------
// Shared core logic (used by both MCP tool and API endpoint)
// ---------------------------------------------------------------------------

export interface ApplyChangesResult {
  applied: number;
  rejected: number;
  rejectedDetails: Array<{ id: string; reason: string }>;
  commentsResolved: number;
  backupPath: string;
  pendingWarning?: string;
}

/**
 * Collect accepted suggestions, apply them as tracked changes to the original
 * .docx, write a backup, and atomically replace the file.
 */
export async function applyChangesCore(
  documentId?: string,
  author?: string,
  backupPath?: string,
): Promise<ApplyChangesResult> {
  // Sanitize caller-supplied strings up front so CodeQL does not trace
  // user input through Map.get(id) to existing.filePath (js/path-injection).
  // path.basename eliminates directory components from the document ID (valid
  // IDs are 64-char hex / upload_* — no separators, so this is a no-op at
  // runtime). path.resolve normalises backupPath to an absolute path, which
  // is also the CodeQL-recognised sanitizer already used for the UNC check.
  const safeDocId = documentId !== undefined ? path.basename(documentId) : undefined;
  const resolvedBackupPath = backupPath !== undefined ? path.resolve(backupPath) : undefined;

  // Reject UNC backup paths (Windows NTLM hash leak)
  if (
    resolvedBackupPath !== undefined &&
    process.platform === "win32" &&
    (resolvedBackupPath.startsWith("\\\\") || resolvedBackupPath.startsWith("//"))
  ) {
    throw Object.assign(new Error("UNC paths are not supported for security reasons."), {
      code: "INVALID_PATH",
    });
  }

  // 1. Resolve document
  const r = requireDocument(safeDocId);
  if (!r) throw Object.assign(new Error("No document is open."), { code: "NO_DOCUMENT" });

  const { doc: ydoc, filePath } = r;

  // 2. Check preconditions
  const docState = getCurrentDoc(safeDocId);
  if (!docState) throw Object.assign(new Error("No document is open."), { code: "NO_DOCUMENT" });

  if (docState.format !== "docx") {
    throw Object.assign(
      new Error(`Apply changes is only supported for .docx files (this is ${docState.format}).`),
      { code: "UNSUPPORTED_FORMAT" },
    );
  }

  if (docState.source !== "file") {
    throw Object.assign(new Error("Cannot apply changes to uploaded files. Save to disk first."), {
      code: "INVALID_PATH",
    });
  }

  // 3. Collect accepted suggestions.
  // `listAnnotations()` sanitizes legacy shapes through the same migration-log
  // relay (keyed on docHash(filePath)) the inline loop used, and skips
  // malformed rows that could never carry a valid suggestion range.
  const store = new YDocStore(ydoc, filePath);
  const suggestions: AcceptedSuggestion[] = [];
  let pendingCount = 0;

  for (const ann of store.listAnnotations()) {
    if (ann.suggestedText === undefined) continue;
    if (ann.status === "pending") {
      pendingCount++;
      continue;
    }
    if (ann.status !== "accepted") continue;

    // Resolve CRDT positions, falling back to flat offsets
    let from = ann.range.from;
    let to = ann.range.to;
    if (ann.relRange) {
      const resolvedFrom = relPosToFlatOffset(ydoc, ann.relRange.fromRel);
      const resolvedTo = relPosToFlatOffset(ydoc, ann.relRange.toRel);
      // All-or-nothing: only use CRDT offsets if both resolve successfully
      if (resolvedFrom !== null && resolvedTo !== null) {
        if (resolvedFrom > resolvedTo) {
          // Concurrent edits moved anchors past each other — skip this annotation
          console.error(
            `[docx-apply] Inverted CRDT range for ${ann.id}: [${resolvedFrom}, ${resolvedTo}]; skipping`,
          );
          continue;
        }
        from = resolvedFrom;
        to = resolvedTo;
      }
    }

    const newText = ann.suggestedText ?? "";

    // Extract importCommentId from annotation ID if it starts with "import-"
    // Format: import-{commentId}-{timestamp} where commentId may contain hyphens
    let importCommentId: string | undefined;
    if (ann.id.startsWith("import-")) {
      const withoutPrefix = ann.id.slice("import-".length);
      const lastDash = withoutPrefix.lastIndexOf("-");
      if (lastDash > 0) {
        importCommentId = withoutPrefix.slice(0, lastDash);
      }
    }

    suggestions.push({
      id: ann.id,
      from,
      to,
      newText,
      textSnapshot: ann.textSnapshot,
      importCommentId,
    });
  }

  if (suggestions.length === 0) {
    throw Object.assign(new Error("No accepted suggestions to apply."), { code: "NO_SUGGESTIONS" });
  }

  // 4. Get ydocFlatText and read the original file
  const ydocFlatText = extractText(ydoc);
  const buffer = await fs.readFile(filePath);

  // 5. Apply tracked changes
  const result = await applyTrackedChanges(buffer, suggestions, {
    author: author ?? "Tandem Review",
    ydocFlatText,
  });

  // 6. Backup — avoid overwriting an existing backup from a previous apply
  let resolvedBackup = resolvedBackupPath ?? filePath.replace(/\.docx$/i, ".backup.docx");
  try {
    await fs.access(resolvedBackup);
    // Backup already exists — use a timestamped name to preserve the original
    const ext = path.extname(resolvedBackup);
    const base = resolvedBackup.slice(0, -ext.length);
    resolvedBackup = `${base}-${Date.now()}${ext}`;
  } catch {
    // No existing backup — use the default path
  }
  await fs.copyFile(filePath, resolvedBackup);
  // Verify backup size
  const [origStat, backupStat] = await Promise.all([fs.stat(filePath), fs.stat(resolvedBackup)]);
  if (origStat.size !== backupStat.size) {
    throw Object.assign(new Error("Backup verification failed: file sizes do not match."), {
      code: "BACKUP_FAILED",
    });
  }

  // 7. Write modified .docx
  await atomicWriteBuffer(filePath, result.buffer);

  // 8. Build result
  const output: ApplyChangesResult = {
    applied: result.applied,
    rejected: result.rejected,
    rejectedDetails: result.rejectedDetails,
    commentsResolved: result.commentsResolved,
    backupPath: resolvedBackup,
  };

  if (pendingCount > 0) {
    output.pendingWarning = `${pendingCount} suggestion(s) are still pending review and were not applied.`;
  }

  return output;
}

// ---------------------------------------------------------------------------
// MCP tool registration
// ---------------------------------------------------------------------------

export function registerApplyTools(server: McpServer): void {
  server.tool(
    "tandem_applyChanges",
    "Apply all accepted suggestions to the .docx file as tracked changes (w:del + w:ins). " +
      "Creates a backup before writing. Only works on .docx files opened from disk.",
    {
      documentId: z.string().optional().describe("Target document ID (defaults to active doc)"),
      author: z
        .string()
        .optional()
        .describe("Author name for tracked changes (default: 'Tandem Review')"),
      backupPath: z
        .string()
        .optional()
        .describe("Custom backup path (default: {name}.backup.docx)"),
    },
    gatedTool("tandem_applyChanges", async (args) => {
      try {
        const result = await applyChangesCore(args.documentId, args.author, args.backupPath);
        return mcpSuccess(result);
      } catch (err) {
        const e = err as Error & { code?: string };
        if (e.code === "NO_DOCUMENT") return noDocumentError();
        if (e.code === "NO_SUGGESTIONS") return mcpError("NO_SUGGESTIONS", e.message);
        if (e.code === "UNSUPPORTED_FORMAT") return mcpError("FORMAT_ERROR", e.message);
        if (e.code === "INVALID_PATH") return mcpError("FORMAT_ERROR", e.message);
        if (e.code === "BACKUP_FAILED") return mcpError("BACKUP_FAILED", e.message);
        throw err;
      }
    }),
  );

  server.tool(
    "tandem_restoreBackup",
    "Restore a document from a backup. Tandem snapshots a document's on-disk bytes before its " +
      "first overwrite each server run (.md/.txt/.docx). Call without `backup` to list available " +
      "snapshots (newest first), then call again with `backup` set to a snapshot name to restore " +
      "it. For .docx with no snapshots yet, falls back to the {name}.backup.docx sidecar written " +
      "by tandem_applyChanges. Restoring reloads the open document in place — annotations are " +
      "preserved and re-anchored.",
    {
      documentId: z.string().optional().describe("Target document ID (defaults to active doc)"),
      backup: z
        .string()
        .optional()
        .describe("Snapshot filename to restore. Omit to list available snapshots."),
    },
    gatedTool("tandem_restoreBackup", async (args) => {
      // path.basename on the ID strips any directory components so CodeQL
      // does not trace args.documentId through Map.get to existing.filePath.
      // Valid IDs (64-char hex / upload_*) have no separators, so this is a
      // no-op at runtime.
      const safeDocId = args.documentId !== undefined ? path.basename(args.documentId) : undefined;
      const docState = getCurrentDoc(safeDocId);
      if (!docState) return noDocumentError();

      const { filePath } = docState;

      // .docx gains the same pre-overwrite doc-backups snapshots as .md/.txt
      // (#1086 extended). The {name}.backup.docx sidecar written by
      // tandem_applyChanges is preserved as a fallback when no snapshots exist.
      if (docState.format === "docx") {
        if (docState.source !== "file") {
          return mcpError(
            "FORMAT_ERROR",
            "Uploaded documents and scratchpads have no on-disk backup file.",
          );
        }
        // A named snapshot restores through the shared reload lifecycle below
        // (re-parses the .docx, re-injects Word comments, re-anchors annotations).
        if (args.backup === undefined) {
          const snapshots = await listDocBackups(filePath, resolveAppDataDir());
          if (snapshots.length > 0) {
            return mcpSuccess({
              filePath,
              backups: snapshots,
              message:
                "Snapshots listed newest first. Call tandem_restoreBackup again with `backup` " +
                "set to one of these names to restore it.",
            });
          }
          // No doc-backups snapshots — fall back to the applyChanges sidecar.
          const backupPath = filePath.replace(/\.docx$/i, ".backup.docx");
          try {
            await fs.access(backupPath);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              return mcpError(
                "FILE_NOT_FOUND",
                `No backups found for ${path.basename(filePath)}. Tandem snapshots a .docx ` +
                  "before its first overwrite each server run; tandem_applyChanges also writes a " +
                  "{name}.backup.docx sidecar.",
              );
            }
            throw err;
          }

          await fs.copyFile(backupPath, filePath);
          // Verify restored file matches backup size
          const [backupStat, restoredStat] = await Promise.all([
            fs.stat(backupPath),
            fs.stat(filePath),
          ]);
          if (backupStat.size !== restoredStat.size) {
            throw new Error("Restore verification failed: file sizes do not match.");
          }
          return mcpSuccess({
            message: `Restored ${path.basename(filePath)} from backup.`,
            restoredFrom: backupPath,
          });
        }
        // args.backup provided → fall through to the shared named-snapshot restore.
      }

      // Shared snapshot path: .md/.txt list-or-restore, plus the named-snapshot
      // restore .docx falls through to from above. Snapshots live under
      // {APP_DATA}/doc-backups (#1086). No `backup` arg = list mode (.md/.txt
      // only — .docx no-arg returned above).
      try {
        if (args.backup === undefined) {
          if (docState.source !== "file") {
            return mcpError(
              "FORMAT_ERROR",
              "Uploaded documents and scratchpads have no on-disk backups.",
            );
          }
          const backups = await listDocBackups(filePath, resolveAppDataDir());
          if (backups.length === 0) {
            return mcpError(
              "FILE_NOT_FOUND",
              `No backups found for ${path.basename(filePath)}. Tandem snapshots a text ` +
                "document's on-disk bytes before its first overwrite each server run.",
            );
          }
          return mcpSuccess({
            filePath,
            backups,
            message:
              "Snapshots listed newest first. Call tandem_restoreBackup again with `backup` " +
              "set to one of these names to restore it.",
          });
        }
        const result = await restoreDocumentFromBackup(docState.id, path.basename(args.backup));
        return mcpSuccess(result);
      } catch (err) {
        const e = err as Error & { code?: string };
        if (e.code === "NO_DOCUMENT") return noDocumentError();
        if (e.code === "FILE_NOT_FOUND") return mcpError("FILE_NOT_FOUND", e.message);
        if (e.code === "INVALID_PATH" || e.code === "UNSUPPORTED_FORMAT") {
          return mcpError("FORMAT_ERROR", e.message);
        }
        if (e.code === "READ_ONLY") return mcpError("READ_ONLY", e.message);
        if (e.code === "RELOAD_IN_PROGRESS") return mcpError("RELOAD_IN_PROGRESS", e.message);
        throw err;
      }
    }),
  );
}
