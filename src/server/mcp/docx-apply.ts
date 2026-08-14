/**
 * MCP tools for applying accepted suggestions back into .docx files as
 * tracked changes, and restoring from backup.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import {
  Y_MAP_DOCUMENT_META,
  Y_MAP_EXTERNAL_CONFLICT,
  Y_MAP_SAVED_AT_VERSION,
} from "../../shared/constants.js";
import { rejectUnsafeWindowsPrefix } from "../../shared/windows-path-safety.js";
import { listDocBackups, snapshotBeforeFirstWrite } from "../file-io/doc-backup.js";
import {
  type AcceptedSuggestion,
  applyTrackedChanges,
  atomicWriteBuffer,
} from "../file-io/index.js";
import { resolveAppDataDir } from "../platform.js";
import { relPosToFlatOffset } from "../positions.js";
import { narrowConflict } from "../session/manager.js";
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

  // Reject UNC / device-namespace backup paths (Windows NTLM hash leak).
  //
  // RAW **and** resolved, in that order — checking only the resolved form makes
  // this inert on POSIX, which is the exact platform an ungated check exists to
  // cover. `path.resolve` is platform-dependent where this guard is not: on
  // POSIX it treats `\\server\share\x.docx` as a RELATIVE name and prepends
  // cwd, and it collapses `//evil/share` to `/evil/share` — either way the
  // prefix the check looks for is gone before the check runs. Same idiom and
  // same reason as `integrations/node-binary.ts` and `mcp/file-opener.ts`.
  if (backupPath !== undefined) {
    const unsafe =
      rejectUnsafeWindowsPrefix(backupPath) ?? rejectUnsafeWindowsPrefix(path.resolve(backupPath));
    if (unsafe) throw Object.assign(new Error(unsafe), { code: "INVALID_PATH" });
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

  // Read-only is the user's stated intent and dominates everything below. This
  // is the only write path in the codebase that used to ignore it: the View
  // Changelog button and every `POST /api/open {readOnly:true}` produce a doc
  // that refuses `saveDocumentToDisk` and, until now, accepted an overwrite from
  // `tandem_applyChanges`.
  if (docState.readOnly) {
    throw Object.assign(new Error("Cannot apply changes to a read-only document."), {
      code: "READ_ONLY",
    });
  }

  // An unresolved keep-vs-reload choice blocks this the same way it blocks
  // Ctrl+S and tandem_save (#1238). `diskChanged` is the discriminator, not the
  // flag's presence: an "unsaved-restore" over an unchanged disk is unambiguous
  // intent and stays permitted, mirroring `saveDocumentToDisk` exactly. Claude
  // has no surface that would even tell it a conflict is pending, so applying
  // over one is never a resolution.
  const conflict = narrowConflict(ydoc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_EXTERNAL_CONFLICT));
  if (conflict?.diskChanged) {
    throw Object.assign(
      new Error("The file changed on disk. Resolve the conflict before applying changes."),
      { code: "EXTERNAL_CONFLICT" },
    );
  }

  // 3. Collect accepted suggestions.
  // `listAnnotations()` sanitizes legacy shapes through the same migration-log
  // relay (keyed on docHash(filePath)) the inline loop used, and skips
  // malformed rows that could never carry a valid suggestion range.
  const store = new YDocStore(ydoc, filePath, docState.id);
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

  // 4. Get ydocFlatText and read the original file.
  //
  // The mtime guard runs HERE, immediately before the read whose bytes are
  // rewritten, not up with the other preconditions: the suggestion collection
  // above is synchronous but `applyTrackedChanges` below is not, and the value
  // being protected is the file's content at read time. Same 1-second tolerance
  // and the same `Y_MAP_SAVED_AT_VERSION` baseline as `saveDocumentToDisk` —
  // fs.watch debounce plus an atomic rename cause minor drift.
  //
  // The stat is wrapped the way `saveDocumentToDisk` wraps its own. A `.docx`
  // held open by Word raises EPERM/EBUSY on Windows and a deleted or moved file
  // raises ENOENT — both ordinary states, and both would otherwise leave here as
  // an unhandled fs error: an MCP protocol failure on one side, and a 500 logged
  // as "[Tandem] Unhandled API error" with a stack on the other, reporting an
  // expected condition as a Tandem crash in the one artefact (Copy Diagnostics)
  // a user would send us about it.
  //
  // Anything that is not ENOENT is re-thrown with its ORIGINAL errno code rather
  // than a code of our own, because EBUSY / EPERM / EACCES already map to
  // accurate labels (FILE_LOCKED, PERMISSION_DENIED) in `routes/_shared.ts`. A
  // new code would land on `default: INTERNAL` and say less.
  const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);
  const lastSavedAt = meta.get(Y_MAP_SAVED_AT_VERSION) as number | undefined;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw Object.assign(new Error("The source file no longer exists."), {
        code: "SOURCE_MISSING",
      });
    }
    console.error("[docx-apply] Unexpected stat error for %s:", filePath, err);
    throw Object.assign(new Error("Cannot verify the file's state."), { code });
  }
  if (lastSavedAt && stat.mtimeMs > lastSavedAt + 1000) {
    throw Object.assign(
      new Error("The file was modified outside Tandem. Reload it before applying changes."),
      { code: "FILE_MODIFIED" },
    );
  }

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

  // 7. Pre-overwrite snapshot of the on-disk original, then write.
  //
  // The `.backup.docx` sidecar above is NOT a substitute, and it was this
  // path's only net. It lands wherever the CALLER says — next to the user's
  // document by default, or at any `backupPath` an MCP client supplies — so
  // it is easy to delete, move or lose, and it is not swept or capped.
  // `snapshotBeforeFirstWrite` is the same once-per-path-per-run
  // mechanism every other write path calls, stored in app data, size-capped and
  // swept — and it is format-agnostic, so a `.docx` restores byte-identical.
  // Never throws: a snapshot failure must not block the write, since the
  // in-memory edits are the newer data.
  await snapshotBeforeFirstWrite(filePath, {
    appDataDir: resolveAppDataDir(),
    documentId: docState.id,
  });

  // 8. Write modified .docx
  //
  // `Y_MAP_SAVED_AT_VERSION` is deliberately NOT re-baselined here, unlike every
  // other write path. An earlier revision of this PR did re-baseline it, on the
  // reasoning that a path's own write should not read as an external change —
  // which is true everywhere else and wrong here.
  //
  // What went on disk is tracked-changes markup (`w:ins` / `w:del`). The
  // in-memory Y.Doc still holds the PRE-apply body and cannot represent
  // revisions at all: mammoth silently accepts every insertion and discards
  // every deletion on import, which is why `docx-lost-features.ts` exists. So
  // between this write and the watcher's reload, the Y.Doc is genuinely STALE
  // relative to the file, and an explicit Ctrl+S in that window would export it
  // over the revisions that were just written.
  //
  // The stale baseline is what makes `saveDocumentToDisk`'s
  // `stat.mtimeMs > lastSavedAt + 1000` fire and refuse that save. The refusal
  // is correct. The reload re-baselines when it lands.
  await atomicWriteBuffer(filePath, result.buffer);

  // 9. Build result
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
        // The write guards (#1448 W1). Every one of these is an expected policy
        // refusal, so it has to come back as a structured error the AI can read
        // and act on. Rethrowing would surface "the file changed on disk" as an
        // unhandled MCP protocol failure.
        if (e.code === "READ_ONLY") return mcpError("READ_ONLY", e.message);
        if (e.code === "EXTERNAL_CONFLICT") return mcpError("EXTERNAL_CONFLICT", e.message);
        if (e.code === "FILE_MODIFIED") return mcpError("FILE_MODIFIED", e.message);
        if (e.code === "SOURCE_MISSING") return mcpError("SOURCE_MISSING", e.message);
        // A locked or unreadable source keeps its own errno rather than a code of
        // ours, so it is matched by code here too — same reasoning as the stat guard.
        if (e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES")
          return mcpError("FILE_LOCKED", e.message);
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
