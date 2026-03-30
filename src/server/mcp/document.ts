import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as Y from "yjs";
import { getOrCreateDocument } from "../yjs/provider.js";
import {
  mcpSuccess,
  mcpError,
  noDocumentError,
  getErrorMessage,
  withErrorBoundary,
} from "./response.js";
import { headingPrefix } from "../../shared/offsets.js";
import { getAdapter, atomicWrite } from "../file-io/index.js";
import { saveSession, stopAutoSave } from "../session/manager.js";
import { openFileByPath } from "./file-opener.js";
import { Y_MAP_DOCUMENT_META, Y_MAP_SAVED_AT_VERSION } from "../../shared/constants.js";
import { MCP_ORIGIN } from "../events/queue.js";

// Document model (pure logic)
import {
  extractText,
  extractMarkdown,
  getElementText,
  getOrCreateXmlText,
} from "./document-model.js";

// Position system
import { validateRange, resolveToElement } from "../positions.js";

// Document service (state management)
import {
  getOpenDocs,
  getActiveDocId,
  setActiveDocId,
  getCurrentDoc,
  requireDocument,
  broadcastOpenDocs,
  toDocListEntry,
  removeDoc,
  hasDoc,
  docCount,
} from "./document-service.js";

// Re-export for backward compatibility with existing consumers.
export {
  extractText,
  extractMarkdown,
  populateYDoc,
  getElementText,
  findXmlText,
  getOrCreateXmlText,
  resolveOffset,
  verifyAndResolveRange,
  detectFormat,
  docIdFromPath,
  getHeadingPrefixLength,
} from "./document-model.js";
export type { ResolvedOffset, RangeVerifyResult } from "./document-model.js";

// Position system re-exports
export {
  validateRange,
  anchoredRange,
  resolveToElement,
  flatOffsetToRelPos,
  relPosToFlatOffset,
  refreshRange,
  refreshAllRanges,
} from "../positions.js";
export type {
  RangeValidation,
  AnchoredRangeResult,
  ElementPosition,
} from "../../shared/positions/index.js";
export {
  getCurrentDoc,
  getOpenDocs,
  getActiveDocId,
  setActiveDocId,
  requireDocument,
  toDocListEntry,
  saveCurrentSession,
  restoreCtrlSession,
  writeGenerationId,
  addDoc,
  removeDoc,
  hasDoc,
  docCount,
} from "./document-service.js";
export type { OpenDoc } from "./document-service.js";
export { openFileByPath, openFileFromContent, SUPPORTED_EXTENSIONS } from "./file-opener.js";
export type { OpenFileResult } from "./file-opener.js";

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
    "Open a file in the Tandem editor. Returns a documentId for multi-document workflows. Auto-opens browser. Pass force=true to reload from disk if the file changed externally.",
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
    "tandem_getContent",
    "Read full document content. Warning: token-heavy for large docs. Use getOutline() or getTextContent() instead.",
    {
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary("tandem_getContent", async ({ documentId }) => {
      const r = requireDocument(documentId);
      if (!r) return noDocumentError();
      const fragment = r.doc.getXmlFragment("default");
      return mcpSuccess({ content: fragment.toJSON(), filePath: r.filePath, documentId: r.docId });
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

      const docState = getCurrentDoc(documentId);
      const format = docState?.format;
      const text = format === "md" ? extractMarkdown(r.doc) : extractText(r.doc);
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
    withErrorBoundary("tandem_edit", async ({ from, to, newText, documentId, textSnapshot }) => {
      const r = requireDocument(documentId);
      if (!r) return noDocumentError();

      const docState = getCurrentDoc(documentId);
      if (docState?.readOnly) {
        return mcpError("FORMAT_ERROR", "Document is read-only (.docx). Use annotations instead.");
      }

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

      if (startPos.elementIndex !== endPos.elementIndex) {
        r.doc.transact(() => {
          const startNode = fragment.get(startPos.elementIndex) as Y.XmlElement;
          const startText = getOrCreateXmlText(startNode);
          const startLen = startText.toString().length;
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
          const remainingText = endText.toString();
          if (remainingText.length > 0) {
            startText.insert(startPos.textOffset, remainingText);
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

      return mcpSuccess({ edited: true, from, to, newTextLength: newText.length });
    }),
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
      try {
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

        const adapter = getAdapter(format);

        if (readOnly || !adapter.canSave) {
          await saveSession(r.filePath, format, r.doc);
          return mcpSuccess({
            saved: true,
            sessionOnly: true,
            filePath: r.filePath,
            message:
              "Session saved (annotations preserved). Source file unchanged — document is read-only.",
          });
        }

        const output = adapter.save(r.doc)!;
        await atomicWrite(r.filePath, output);
        await saveSession(r.filePath, format, r.doc);

        // Mark document clean: bump savedAtVersion so client resets dirty flag
        const meta = r.doc.getMap(Y_MAP_DOCUMENT_META);
        r.doc.transact(() => meta.set(Y_MAP_SAVED_AT_VERSION, Date.now()), MCP_ORIGIN);

        return mcpSuccess({ saved: true, filePath: r.filePath });
      } catch (err: unknown) {
        const errCode = (err as NodeJS.ErrnoException).code;
        if (errCode === "EACCES" || errCode === "EPERM") {
          return mcpError("FILE_LOCKED", getErrorMessage(err));
        }
        return mcpError("FORMAT_ERROR", `Save failed: ${getErrorMessage(err)}`);
      }
    }),
  );

  server.tool(
    "tandem_status",
    "Check editor status: running, open documents, active document",
    {},
    withErrorBoundary("tandem_status", async () => {
      const activeId = getActiveDocId();
      const active = activeId ? openDocs.get(activeId) : null;
      return mcpSuccess({
        running: true,
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
    }),
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

      const docState = openDocs.get(id);
      if (!docState) return mcpError("NO_DOCUMENT", `Document ${id} not found.`);

      const doc = getOrCreateDocument(id);
      await saveSession(docState.filePath, docState.format, doc);

      removeDoc(id);

      if (getActiveDocId() === id) {
        const remaining = Array.from(openDocs.keys());
        setActiveDocId(remaining.length > 0 ? remaining[0] : null);
      }

      if (docCount() === 0) {
        stopAutoSave();
      }

      broadcastOpenDocs();

      return mcpSuccess({
        closed: true,
        was: docState.filePath,
        activeDocumentId: getActiveDocId(),
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
}
