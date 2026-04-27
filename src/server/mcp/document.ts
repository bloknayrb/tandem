import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Y from "yjs";
import { z } from "zod";
import {
  CTRL_ROOM,
  TANDEM_MODE_DEFAULT,
  Y_MAP_AUTHORSHIP,
  Y_MAP_AWARENESS,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../shared/constants.js";
import { headingPrefix } from "../../shared/offsets.js";
import type { AuthorshipRange } from "../../shared/types.js";
import { TandemModeSchema, toFlatOffset } from "../../shared/types.js";
import { generateAuthorshipId } from "../../shared/utils.js";
import { MCP_ORIGIN } from "../events/queue.js";
// Position system
import { anchoredRange, resolveToElement, validateRange } from "../positions.js";
import { saveSession } from "../session/manager.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import { convertToMarkdown } from "./convert.js";
// Document model (pure logic)
import { extractText, findXmlText, getElementText, getOrCreateXmlText } from "./document-model.js";
// Document service (state management)
import {
  broadcastOpenDocs,
  closeDocumentById,
  docCount,
  getActiveDocId,
  getCurrentDoc,
  getOpenDocs,
  hasDoc,
  requireDocument,
  saveDocumentToDisk,
  setActiveDocId,
  toDocListEntry,
} from "./document-service.js";
import { openFileByPath } from "./file-opener.js";
import {
  getErrorMessage,
  mcpError,
  mcpSuccess,
  noDocumentError,
  withErrorBoundary,
} from "./response.js";

// ElementPosition re-exported as ResolvedOffset for backward compatibility — prefer ElementPosition.
export type {
  AnchoredRangeResult,
  ElementPosition,
  ElementPosition as ResolvedOffset,
  RangeValidation,
} from "../../shared/positions/index.js";
// Position system re-exports
// resolveToElement re-exported as resolveOffset for backward compatibility — prefer resolveToElement.
export {
  anchoredRange,
  flatOffsetToRelPos,
  refreshAllRanges,
  refreshRange,
  relPosToFlatOffset,
  resolveToElement,
  resolveToElement as resolveOffset,
  validateRange,
} from "../positions.js";
export type { RangeVerifyResult } from "./document-model.js";
// Re-export for backward compatibility with existing consumers.
export {
  collectXmlTexts,
  detectFormat,
  docIdFromPath,
  extractMarkdown,
  extractText,
  findXmlText,
  findXmlTextAtOffset,
  getElementText,
  getElementTextLength,
  getHeadingPrefixLength,
  getOrCreateXmlText,
  populateYDoc,
  verifyAndResolveRange,
} from "./document-model.js";
export type { OpenDoc } from "./document-service.js";
export {
  addDoc,
  autoSaveAllToDisk,
  docCount,
  getActiveDocId,
  getCurrentDoc,
  getOpenDocs,
  hasDoc,
  removeDoc,
  requireDocument,
  restoreCtrlSession,
  restoreOpenDocuments,
  saveCurrentSession,
  saveDocumentToDisk,
  setActiveDocId,
  toDocListEntry,
  writeGenerationId,
} from "./document-service.js";
export type { OpenFileResult } from "./file-opener.js";
export { openFileByPath, openFileFromContent, SUPPORTED_EXTENSIONS } from "./file-opener.js";

export interface OutlineEntry {
  level: number;
  text: string;
  index: number;
}

/** Extract document outline (headings). Pure logic exported for testing. */
export function getOutline(fragment: Y.XmlFragment): OutlineEntry[] {
  const outline: OutlineEntry[] = [];
  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (node instanceof Y.XmlElement && node.nodeName === "heading") {
      const level = Number(node.getAttribute("level") ?? 1);
      outline.push({ level, text: getElementText(node), index: i });
    }
  }
  return outline;
}

/** Extract a section by heading text (case-insensitive). Pure logic exported for testing. */
export function getSection(
  fragment: Y.XmlFragment,
  sectionName: string,
): { found: true; text: string } | { found: false } {
  const lines: string[] = [];
  let inSection = false;
  let sectionLevel = 0;

  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (!(node instanceof Y.XmlElement)) continue;

    const text = getElementText(node);

    if (node.nodeName === "heading") {
      const level = Number(node.getAttribute("level") ?? 1);
      if (inSection && level <= sectionLevel) break;
      if (text.trim().toLowerCase() === sectionName.trim().toLowerCase()) {
        inSection = true;
        sectionLevel = level;
        lines.push(headingPrefix(level) + text);
        continue;
      }
    }

    if (inSection) {
      if (node.nodeName === "heading") {
        const level = Number(node.getAttribute("level") ?? 1);
        lines.push(headingPrefix(level) + text);
      } else {
        lines.push(text);
      }
    }
  }

  if (!inSection) return { found: false };
  return { found: true, text: lines.join("\n") };
}

export function registerDocumentTools(server: McpServer): void {
  const openDocs = getOpenDocs();

  server.tool(
    "tandem_open",
    "Open a file in the Tandem editor. Returns a documentId for multi-document workflows. Auto-opens editor. Pass force=true to reload from disk if the file changed externally.",
    {
      filePath: z.string().describe("Absolute path to the file to open"),
      force: z
        .boolean()
        .optional()
        .describe("Force reload from disk even if already open. Clears annotations and session."),
    },
    withErrorBoundary("tandem_open", async ({ filePath, force }) => {
      try {
        const result = await openFileByPath(filePath, { force });
        return mcpSuccess({
          ...result,
          message: result.forceReloaded
            ? `Force-reloaded from disk: ${result.fileName}`
            : result.alreadyOpen
              ? `Switched to already-open document: ${result.fileName}`
              : result.restoredFromSession
                ? `Session restored: ${result.fileName} (annotations preserved)`
                : result.readOnly
                  ? `Document opened (review only): ${result.fileName}`
                  : `Document opened: ${result.fileName}`,
        });
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT" || e.code === "FILE_NOT_FOUND") {
          return mcpError("FILE_NOT_FOUND", e.message);
        }
        if (e.code === "INVALID_PATH") {
          return mcpError("FILE_NOT_FOUND", e.message);
        }
        if (e.code === "UNSUPPORTED_FORMAT" || e.code === "FILE_TOO_LARGE") {
          return mcpError("FORMAT_ERROR", e.message);
        }
        if (e.code === "EBUSY" || e.code === "EPERM") {
          return mcpError(
            "FILE_LOCKED",
            `File is locked — another program (likely Microsoft Word) has it open. Close it and try again.`,
          );
        }
        if (e.code === "EACCES") {
          return mcpError("PERMISSION_DENIED", e.message);
        }
        return mcpError("FORMAT_ERROR", getErrorMessage(err));
      }
    }),
  );

  server.tool(
    "tandem_getTextContent",
    "Read document as plain text. ~60% fewer tokens than getContent().",
    {
      section: z.string().optional().describe("Optional heading text to read only that section"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary("tandem_getTextContent", async ({ section, documentId }) => {
      const r = requireDocument(documentId);
      if (!r) return noDocumentError();

      if (section) {
        const fragment = r.doc.getXmlFragment("default");
        const result = getSection(fragment, section);
        if (!result.found) {
          return mcpError("INVALID_RANGE", `Section "${section}" not found in document.`);
        }
        return mcpSuccess({ text: result.text, filePath: r.filePath, section });
      }

      // Always use extractText — its offsets match validateRange/anchoredRange.
      // extractMarkdown adds markdown syntax (e.g. `> ` for blockquotes) that
      // shifts offsets, causing RANGE_MOVED errors in annotation tools.
      const text = extractText(r.doc);
      return mcpSuccess({ text, filePath: r.filePath, documentId: r.docId });
    }),
  );

  server.tool(
    "tandem_getOutline",
    "Get document structure (headings, sections) without full content. Low token cost.",
    {
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary("tandem_getOutline", async ({ documentId }) => {
      const r = requireDocument(documentId);
      if (!r) return noDocumentError();
      const fragment = r.doc.getXmlFragment("default");
      const outline = getOutline(fragment);
      return mcpSuccess({ outline, totalNodes: fragment.length });
    }),
  );

  server.tool(
    "tandem_edit",
    "Edit text in the document at a specific range. For single-paragraph replacements only — newlines in newText are inserted as literal text.",
    {
      from: z.number().describe("Start position (character offset)"),
      to: z.number().describe("End position (character offset)"),
      newText: z.string().describe("Replacement text (single paragraph — no newlines)"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
      textSnapshot: z
        .string()
        .optional()
        .describe(
          "Expected text at [from, to] — returns RANGE_MOVED with relocated range on mismatch, or RANGE_GONE if text was deleted",
        ),
    },
    withErrorBoundary(
      "tandem_edit",
      async ({ from: rawFrom, to: rawTo, newText, documentId, textSnapshot }) => {
        const r = requireDocument(documentId);
        if (!r) return noDocumentError();

        const docState = getCurrentDoc(documentId);
        if (docState?.readOnly) {
          return mcpError(
            "FORMAT_ERROR",
            "Document is read-only (.docx). Use annotations instead.",
          );
        }

        const from = toFlatOffset(rawFrom);
        const to = toFlatOffset(rawTo);
        const v = validateRange(r.doc, from, to, {
          textSnapshot,
          rejectHeadingOverlap: true,
        });
        if (!v.ok) {
          if (v.code === "RANGE_GONE") {
            return mcpError("RANGE_GONE", "Target text no longer exists in the document.");
          }
          if (v.code === "RANGE_MOVED") {
            return mcpError(
              "RANGE_MOVED",
              "Target text has moved. Use resolvedFrom/resolvedTo to retry.",
              { resolvedFrom: v.resolvedFrom, resolvedTo: v.resolvedTo },
            );
          }
          if (v.code === "HEADING_OVERLAP") {
            return mcpError(
              "INVALID_RANGE",
              'Edit range overlaps with heading markup (e.g., "## "). Target the text content only. ' +
                "Use tandem_resolveRange to find the text position.",
            );
          }
          return mcpError("INVALID_RANGE", v.message);
        }

        const fragment = r.doc.getXmlFragment("default");
        const startPos = resolveToElement(fragment, from);
        const endPos = resolveToElement(fragment, to);

        if (!startPos || !endPos) {
          return mcpError(
            "INVALID_RANGE",
            `Cannot resolve offset range [${from}, ${to}] in document.`,
          );
        }

        // Guard: container elements (bulletList, blockquote, etc.) have no direct
        // XmlText child — editing them would corrupt the CRDT structure.
        const startNode = fragment.get(startPos.elementIndex);
        if (startNode instanceof Y.XmlElement && !findXmlText(startNode)) {
          return mcpError(
            "INVALID_RANGE",
            `Target element is a container (${startNode.nodeName}) — edit a specific paragraph or list item instead.`,
          );
        }
        if (startPos.elementIndex !== endPos.elementIndex) {
          const endNode = fragment.get(endPos.elementIndex);
          if (endNode instanceof Y.XmlElement && !findXmlText(endNode)) {
            return mcpError(
              "INVALID_RANGE",
              `Target end element is a container (${endNode.nodeName}) — edit a specific paragraph or list item instead.`,
            );
          }
        }

        if (startPos.elementIndex !== endPos.elementIndex) {
          r.doc.transact(() => {
            const startNode = fragment.get(startPos.elementIndex) as Y.XmlElement;
            const startText = getOrCreateXmlText(startNode);
            const startLen = startText.length;
            if (startPos.textOffset < startLen) {
              startText.delete(startPos.textOffset, startLen - startPos.textOffset);
            }

            const deleteCount = endPos.elementIndex - startPos.elementIndex - 1;
            for (let i = 0; i < deleteCount; i++) {
              fragment.delete(startPos.elementIndex + 1, 1);
            }

            const endNode = fragment.get(startPos.elementIndex + 1) as Y.XmlElement;
            const endText = getOrCreateXmlText(endNode);
            if (endPos.textOffset > 0) {
              endText.delete(0, endPos.textOffset);
            }
            const remaining = endText.toDelta();
            let mergeOffset = startPos.textOffset;
            for (const seg of remaining) {
              if (typeof seg.insert === "string") {
                startText.insert(mergeOffset, seg.insert, seg.attributes);
                mergeOffset += seg.insert.length;
              } else {
                // Embed (hardBreak, image, etc.) — clone to detach from endText
                const embed = seg.insert instanceof Y.XmlElement ? seg.insert.clone() : seg.insert;
                startText.insertEmbed(mergeOffset, embed, seg.attributes);
                mergeOffset += 1;
              }
            }
            fragment.delete(startPos.elementIndex + 1, 1);

            startText.insert(startPos.textOffset, newText);
          }, MCP_ORIGIN);
        } else {
          r.doc.transact(() => {
            const node = fragment.get(startPos.elementIndex) as Y.XmlElement;
            const textNode = getOrCreateXmlText(node);
            const deleteLen = endPos.textOffset - startPos.textOffset;
            if (deleteLen > 0) {
              textNode.delete(startPos.textOffset, deleteLen);
            }
            if (newText.length > 0) {
              textNode.insert(startPos.textOffset, newText);
            }
          }, MCP_ORIGIN);
        }

        // Record authorship for the inserted text (Y.Map overlay strategy).
        // This runs in a separate transaction because anchoredRange() reads the
        // Y.Doc state *after* the edit to compute RelativePositions for the new
        // text. Combining it into the edit transaction would anchor against
        // pre-edit state. The race window is acceptable for v1 — authorship is
        // decorative (highlight overlay), not semantic.
        if (newText.length > 0) {
          const newFrom = from;
          const newTo = toFlatOffset(newFrom + newText.length);
          const anchored = anchoredRange(r.doc, newFrom, newTo);
          if (anchored.ok) {
            const authorshipMap = r.doc.getMap(Y_MAP_AUTHORSHIP);
            const rangeId = generateAuthorshipId("claude");
            const entry: AuthorshipRange = {
              id: rangeId,
              author: "claude",
              range: anchored.range,
              relRange: anchored.fullyAnchored ? anchored.relRange : undefined,
              timestamp: Date.now(),
            };
            r.doc.transact(() => {
              authorshipMap.set(rangeId, entry);
            }, MCP_ORIGIN);
          }
        }

        return mcpSuccess({ edited: true, from, to, newTextLength: newText.length });
      },
    ),
  );

  server.tool(
    "tandem_save",
    "Save the current document back to disk",
    {
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary("tandem_save", async ({ documentId }) => {
      const r = requireDocument(documentId);
      if (!r) return noDocumentError();

      const docState = getCurrentDoc(documentId);
      const format = docState?.format ?? "txt";
      const readOnly = docState?.readOnly ?? false;

      // Uploaded files have no disk path — session-only save
      if (docState?.source === "upload") {
        await saveSession(r.filePath, format, r.doc);
        return mcpSuccess({
          saved: true,
          sessionOnly: true,
          filePath: r.filePath,
          message:
            "Session saved (annotations preserved). This file was uploaded — no disk path to save to.",
        });
      }

      // Read-only documents (e.g. .docx) — session-only save
      if (readOnly) {
        await saveSession(r.filePath, format, r.doc);
        return mcpSuccess({
          saved: true,
          sessionOnly: true,
          filePath: r.filePath,
          message:
            "Session saved (annotations preserved). Source file unchanged — document is read-only.",
        });
      }

      // Delegate to shared save function
      const result = await saveDocumentToDisk(r.docId, "mcp");
      if (result.status === "saved") {
        return mcpSuccess({ saved: true, filePath: r.filePath });
      }
      if (result.status === "skipped") {
        // Fall back to session-only save for skipped formats
        await saveSession(r.filePath, format, r.doc);
        return mcpSuccess({
          saved: true,
          sessionOnly: true,
          filePath: r.filePath,
          message: `Session saved. Disk save skipped: ${result.reason}`,
        });
      }
      // result.status === "error"
      if (result.errorCode === "EACCES" || result.errorCode === "EPERM") {
        return mcpError("FILE_LOCKED", result.reason ?? "Save failed");
      }
      return mcpError("FORMAT_ERROR", result.reason ?? "Save failed");
    }),
  );

  server.tool(
    "tandem_status",
    "Check editor status (no params), or set Claude's visible status text (pass text).",
    {
      text: z.string().optional().describe("Status text to display — omit for read-only"),
      focusParagraph: z
        .number()
        .optional()
        .describe("Index of paragraph Claude is focusing on (write mode only)"),
      focusOffset: z
        .number()
        .optional()
        .describe("Flat character offset for precise cursor positioning (write mode only)"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID for status write (defaults to active document)"),
    },
    withErrorBoundary(
      "tandem_status",
      async ({ text, focusParagraph, focusOffset, documentId }) => {
        // Write mode — update Claude's status shown in the editor
        if (text !== undefined) {
          const current = getCurrentDoc(documentId);
          if (!current) {
            return mcpSuccess({
              status: text,
              warning: "No document open — status not broadcast to editor.",
            });
          }
          const doc = getOrCreateDocument(current.docName);
          const awarenessMap = doc.getMap(Y_MAP_AWARENESS);
          doc.transact(
            () =>
              awarenessMap.set("claude", {
                status: text,
                timestamp: Date.now(),
                active: true,
                focusParagraph: focusParagraph ?? null,
                focusOffset: focusOffset ?? null,
              }),
            MCP_ORIGIN,
          );
          return mcpSuccess({ status: text });
        }

        // Read mode — return editor status summary
        const activeId = getActiveDocId();
        const active = activeId ? openDocs.get(activeId) : null;

        const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
        const ctrlAwareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
        const mode = TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(
          ctrlAwareness.get(Y_MAP_MODE),
        );

        return mcpSuccess({
          running: true,
          mode,
          activeDocument: active
            ? { documentId: active.id, filePath: active.filePath, format: active.format }
            : null,
          openDocuments: Array.from(openDocs.values()).map((d) => ({
            documentId: d.id,
            filePath: d.filePath,
            format: d.format,
            readOnly: d.readOnly,
          })),
          documentCount: docCount(),
        });
      },
    ),
  );

  server.tool(
    "tandem_close",
    "Close a document. Closes the active document if no documentId specified.",
    {
      documentId: z
        .string()
        .optional()
        .describe("Document ID to close (defaults to active document)"),
    },
    withErrorBoundary("tandem_close", async ({ documentId }) => {
      const id = documentId ?? getActiveDocId();
      if (!id) return mcpError("NO_DOCUMENT", "No document to close.");

      const result = await closeDocumentById(id);
      if (!result.success) return mcpError("NO_DOCUMENT", result.error);

      return mcpSuccess({
        closed: true,
        was: result.closedPath,
        activeDocumentId: result.activeDocumentId,
      });
    }),
  );

  server.tool(
    "tandem_listDocuments",
    "List all open documents with their IDs, file paths, and formats.",
    {},
    withErrorBoundary("tandem_listDocuments", async () => {
      return mcpSuccess({
        documents: Array.from(openDocs.values()).map((d) => ({
          ...toDocListEntry(d),
          isActive: d.id === getActiveDocId(),
        })),
        activeDocumentId: getActiveDocId(),
        count: docCount(),
      });
    }),
  );

  server.tool(
    "tandem_switchDocument",
    "Switch the active document. Tools will operate on this document by default.",
    {
      documentId: z.string().describe("Document ID to switch to"),
    },
    withErrorBoundary("tandem_switchDocument", async ({ documentId }) => {
      if (!hasDoc(documentId)) {
        return mcpError("NO_DOCUMENT", `Document ${documentId} is not open.`);
      }
      setActiveDocId(documentId);
      broadcastOpenDocs();
      return mcpSuccess({
        activeDocumentId: documentId,
        ...toDocListEntry(openDocs.get(documentId)!),
      });
    }),
  );

  server.tool(
    "tandem_convertToMarkdown",
    "Convert a .docx document to an editable Markdown file. Writes the .md file to disk and opens it as a new tab.",
    {
      documentId: z
        .string()
        .optional()
        .describe("Document ID of the .docx to convert (defaults to active document)"),
      outputPath: z
        .string()
        .optional()
        .describe("Custom output path for the .md file (defaults to same directory as the .docx)"),
    },
    withErrorBoundary("tandem_convertToMarkdown", async ({ documentId, outputPath }) => {
      try {
        const result = await convertToMarkdown(documentId, outputPath);
        return mcpSuccess({
          converted: true,
          outputPath: result.outputPath,
          documentId: result.documentId,
          fileName: result.fileName,
          message: `Converted to Markdown: ${result.fileName}`,
        });
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "FILE_NOT_FOUND") return noDocumentError();
        if (
          e.code === "UNSUPPORTED_FORMAT" ||
          e.code === "INVALID_PATH" ||
          e.code === "EMPTY_CONVERSION" ||
          e.code === "OPEN_FAILED"
        ) {
          return mcpError("FORMAT_ERROR", e.message);
        }
        throw err; // Let withErrorBoundary handle unexpected errors
      }
    }),
  );
}
