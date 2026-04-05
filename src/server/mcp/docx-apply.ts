/**
 * MCP tools for applying accepted suggestions back into .docx files as
 * tracked changes, and restoring from backup.
 */

import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCurrentDoc, requireDocument } from "./document-service.js";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { relPosToFlatOffset } from "../positions.js";
import { extractText } from "./document-model.js";
import {
  applyTrackedChanges,
  atomicWriteBuffer,
  type AcceptedSuggestion,
} from "../file-io/index.js";
import type { Annotation } from "../../shared/types.js";
import { mcpError, mcpSuccess, noDocumentError, withErrorBoundary } from "./response.js";

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
  // 1. Resolve document
  const r = requireDocument(documentId);
  if (!r) throw Object.assign(new Error("No document is open."), { code: "NO_DOCUMENT" });

  const { doc: ydoc, filePath } = r;

  // 2. Check preconditions
  const docState = getCurrentDoc(documentId);
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

  // Reject UNC backup paths (Windows NTLM hash leak)
  if (backupPath) {
    const resolvedBp = path.resolve(backupPath);
    if (
      process.platform === "win32" &&
      (resolvedBp.startsWith("\\\\") || resolvedBp.startsWith("//"))
    ) {
      throw Object.assign(new Error("UNC paths are not supported for security reasons."), {
        code: "INVALID_PATH",
      });
    }
  }

  // 3. Collect accepted suggestions
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  const suggestions: AcceptedSuggestion[] = [];
  let pendingCount = 0;

  for (const [, raw] of map) {
    const ann = raw as Annotation;
    if (ann.type !== "suggestion") continue;
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

    // Parse suggestion content
    let newText = "";
    try {
      const parsed = JSON.parse(ann.content) as { newText: string; reason: string };
      newText = parsed.newText;
    } catch {
      // If content isn't JSON, treat the whole string as newText
      newText = ann.content;
    }

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
  let resolvedBackup = backupPath ?? filePath.replace(/\.docx$/i, ".backup.docx");
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
    withErrorBoundary("tandem_applyChanges", async (args) => {
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
    "Restore a .docx file from its backup ({name}.backup.docx). " +
      "Use after tandem_applyChanges if the result is unsatisfactory.",
    {
      documentId: z.string().optional().describe("Target document ID (defaults to active doc)"),
    },
    withErrorBoundary("tandem_restoreBackup", async (args) => {
      const r = requireDocument(args.documentId);
      if (!r) return noDocumentError();

      const { filePath } = r;
      const backupPath = filePath.replace(/\.docx$/i, ".backup.docx");

      try {
        await fs.access(backupPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return mcpError("FILE_NOT_FOUND", `No backup file found at ${backupPath}`);
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
    }),
  );
}
