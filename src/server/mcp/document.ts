import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Root } from "mdast";
import path from "path";
import * as Y from "yjs";
import { z } from "zod";
import {
  CTRL_ROOM,
  TANDEM_MODE_DEFAULT,
  Y_MAP_AUTHORSHIP,
  Y_MAP_AWARENESS,
  Y_MAP_CLAUDE,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../shared/constants.js";
import { headingPrefix } from "../../shared/offsets.js";
import { withMcp } from "../../shared/origins.js";
import type { AuthorshipRange, ClaudeAwareness } from "../../shared/types.js";
import { TandemModeSchema, toFlatOffset } from "../../shared/types.js";
import { generateAuthorshipId } from "../../shared/utils.js";
import { isStoreReadOnly } from "../annotations/store.js";
import { isDirty } from "../documents/dirty.js";
import { mdParser } from "../file-io/markdown.js";
import { appendMdast } from "../file-io/mdast-ydoc.js";
// Position system
import { anchoredRange, resolveToElement, validateRange } from "../positions.js";
import { saveSession } from "../session/manager.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import { convertToMarkdown } from "./convert.js";
// Document model (pure logic)
import {
  extractText,
  getElementText,
  getElementTextLength,
  getHeadingPrefixLength,
  getOrCreateXmlText,
  mergeXmlTextDelta,
  TEXTBLOCK_NODES,
} from "./document-model.js";
// Document service (state management)
import {
  broadcastOpenDocs,
  closeDocumentById,
  docCount,
  getActiveDocId,
  getCurrentDoc,
  getOpenDocs,
  hasDoc,
  renameDocument,
  requireDocument,
  saveDocumentToDisk,
  setActiveDocId,
  toDocListEntry,
} from "./document-service.js";
import { openFileByPath, openScratchpad } from "./file-opener.js";
import {
  getTextContentOutputShape,
  listDocumentsOutputShape,
  statusOutputShape,
} from "./output-schemas.js";
import {
  getErrorMessage,
  mcpError,
  mcpStructured,
  mcpSuccess,
  noDocumentError,
  withErrorBoundary,
  withStructuredErrors,
} from "./response.js";
import { withTypingPresence } from "./typing-presence.js";

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
  mergeXmlTextDelta,
  populateYDoc,
  TEXTBLOCK_NODES,
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

/**
 * Stamp Claude authorship across an entire freshly-loaded document.
 *
 * Used by `tandem_open`'s `authoredBy: "claude"` affordance (issue #937): when
 * Claude writes a document wholesale to disk and then opens it, none of the text
 * is attributed to Claude because authorship is otherwise only stamped by
 * `tandem_edit`. This stamps one Claude `AuthorshipRange` per top-level element,
 * each spanning that element's POST-PREFIX text (heading prefixes like `# ` are
 * excluded so the CRDT anchor resolves — `flatOffsetToRelPos(doc, 0)` returns
 * null inside a heading prefix, which would otherwise degrade the whole doc to
 * flat-only).
 *
 * Idempotent via deterministic IDs (`claude-block-{index}`): re-open,
 * session-restore, and force-reload re-`set` the same keys instead of appending
 * duplicates. Never bulk-clears the authorship map, so any browser-added
 * `author:"user"` ranges are preserved (a user can reclaim a block by editing
 * it). Offsets mirror `extractText`'s top-level walk: top-level elements joined
 * by FLAT_SEPARATOR (1 char), each element offset by its heading prefix.
 *
 * `startIndex` (default 0) restricts stamping to top-level blocks at or after
 * that fragment index — used by `tandem_appendContent` to stamp only the
 * freshly-appended blocks while leaving earlier (possibly user-authored) blocks
 * untouched. The `flatCursor` still advances across the skipped earlier blocks
 * so the stamped ranges keep their ABSOLUTE flat offsets (anchoring against the
 * top of the doc would silently mis-attribute existing text).
 */
export function stampClaudeAuthorshipWholeDoc(doc: Y.Doc, startIndex = 0): void {
  const fragment = doc.getXmlFragment("default");
  const authorshipMap = doc.getMap(Y_MAP_AUTHORSHIP);
  const timestamp = Date.now();
  const entries: Array<{ key: string; entry: AuthorshipRange }> = [];

  let flatCursor = 0;
  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (!(node instanceof Y.XmlElement)) continue;

    const prefixLen = getHeadingPrefixLength(node);
    const textLen = getElementTextLength(node);
    const from = flatCursor + prefixLen;
    const to = from + textLen;

    // Advance the cursor past this element (prefix + text) plus the
    // FLAT_SEPARATOR that joins top-level elements. Runs for EVERY block,
    // including those before startIndex, so offsets stay absolute.
    flatCursor = to + 1;

    // Append-stamping: skip blocks before startIndex (already stamped /
    // user-authored). The cursor advance above already ran for them.
    if (i < startIndex) continue;

    // Skip zero-width spans (empty paragraphs, bare headings) —
    // resolveAuthorshipRange rejects them anyway.
    if (from >= to) continue;

    const anchored = anchoredRange(doc, toFlatOffset(from), toFlatOffset(to));
    if (!anchored.ok) continue;

    // Key on the fragment element index (not a running stamped-block counter)
    // so IDs stay stable across re-opens even when some blocks are skipped.
    const key = `claude-block-${i}`;
    entries.push({
      key,
      entry: {
        id: key,
        author: "claude",
        range: anchored.range,
        relRange: anchored.fullyAnchored ? anchored.relRange : undefined,
        timestamp,
      },
    });
  }

  if (entries.length === 0) return;

  withMcp(doc, () => {
    for (const { key, entry } of entries) {
      authorshipMap.set(key, entry);
    }
  });
}

export function registerDocumentTools(server: McpServer): void {
  const openDocs = getOpenDocs();

  server.tool(
    "tandem_open",
    "Open a file in the Tandem editor; returns a documentId. Auto-opens the editor. force=true reloads from disk if the file changed externally.",
    {
      filePath: z.string().describe("Absolute path to the file to open"),
      force: z
        .boolean()
        .optional()
        .describe("Force reload from disk even if already open. Clears annotations and session."),
      authoredBy: z
        .literal("claude")
        .optional()
        .describe(
          "Pass 'claude' when you wrote this file wholesale before opening, to stamp Claude authorship across its content. Idempotent.",
        ),
    },
    withErrorBoundary("tandem_open", async ({ filePath, force, authoredBy }) => {
      try {
        const result = await openFileByPath(filePath, { force });

        // Issue #937: attribute Claude-authored documents at creation. Stamp
        // AFTER openFileByPath resolves — content is guaranteed populated, and
        // the durable-sync/channel observers attach later in wireAnnotationStore,
        // so there is no race. Upload/scratchpad paths bypass openFileByPath and
        // are naturally excluded.
        if (authoredBy === "claude") {
          const loaded = requireDocument(result.documentId);
          if (loaded) {
            stampClaudeAuthorshipWholeDoc(loaded.doc);
          }
        }
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
    "tandem_scratchpad",
    "Open a new ephemeral Scratchpad tab for drafting — never touches the filesystem; content is lost when the tab closes. Optionally seed with markdown.",
    {
      content: z
        .string()
        .optional()
        .describe(
          "Initial markdown. Block structure (headings, lists, blank-line-separated paragraphs) is parsed into real blocks.",
        ),
    },
    withErrorBoundary("tandem_scratchpad", async ({ content }) => {
      const result = await openScratchpad(content);
      return mcpSuccess({
        documentId: result.documentId,
        fileName: result.fileName,
        format: result.format,
      });
    }),
  );

  server.registerTool(
    "tandem_getTextContent",
    {
      description:
        "Read document as plain text whose offsets match the annotation coordinate system.",
      inputSchema: {
        section: z.string().optional().describe("Optional heading text to read only that section"),
        documentId: z
          .string()
          .optional()
          .describe("Target document ID (defaults to active document)"),
      },
      outputSchema: getTextContentOutputShape,
    },
    withStructuredErrors(
      withErrorBoundary("tandem_getTextContent", async ({ section, documentId }) => {
        const r = requireDocument(documentId);
        if (!r) return noDocumentError();

        if (section) {
          const fragment = r.doc.getXmlFragment("default");
          const result = getSection(fragment, section);
          if (!result.found) {
            return mcpError("INVALID_RANGE", `Section "${section}" not found in document.`);
          }
          return mcpStructured({ text: result.text, filePath: r.filePath, section });
        }

        // Always use extractText — its offsets match validateRange/anchoredRange.
        // extractMarkdown adds markdown syntax (e.g. `> ` for blockquotes) that
        // shifts offsets, causing RANGE_MOVED errors in annotation tools.
        const text = extractText(r.doc);
        return mcpStructured({ text, filePath: r.filePath, documentId: r.docId });
      }),
    ),
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
        // #651 presence: tandem_edit targets text (not an annotation), so the
        // marker is the generic status-bar "Claude is working" indicator.
        return withTypingPresence({ tool: "tandem_edit", documentId }, async () => {
          const r = requireDocument(documentId);
          if (!r) return noDocumentError();

          const docState = getCurrentDoc(documentId);
          if (docState?.readOnly) {
            return mcpError(
              "FORMAT_ERROR",
              "Document is read-only (.docx). Use annotations instead.",
            );
          }

          // An empty document has no addressable range — resolveToElement returns
          // null on a zero-length fragment, which would otherwise surface as a
          // confusing generic INVALID_RANGE. Point the agent at the seeding path.
          if (r.doc.getXmlFragment("default").length === 0) {
            return mcpError(
              "EMPTY_DOCUMENT",
              "Document is empty — no text range to edit. Seed content with tandem_appendContent({ content }) or tandem_scratchpad({ content }).",
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

          // Guard: only textblock elements (paragraph, heading, codeBlock) may be
          // edited. This must reject before the transaction to prevent partial-commit
          // corruption — Y.js transactions don't roll back on throw.
          const startNode = fragment.get(startPos.elementIndex);
          if (!(startNode instanceof Y.XmlElement) || !TEXTBLOCK_NODES.has(startNode.nodeName)) {
            return mcpError(
              "INVALID_RANGE",
              `Target element is a container (${startNode instanceof Y.XmlElement ? startNode.nodeName : "unknown"}) — edit a specific paragraph or list item instead.`,
            );
          }
          if (startPos.elementIndex !== endPos.elementIndex) {
            const endNode = fragment.get(endPos.elementIndex);
            if (!(endNode instanceof Y.XmlElement) || !TEXTBLOCK_NODES.has(endNode.nodeName)) {
              return mcpError(
                "INVALID_RANGE",
                `Target end element is a container (${endNode instanceof Y.XmlElement ? endNode.nodeName : "unknown"}) — edit a specific paragraph or list item instead.`,
              );
            }
          }

          if (startPos.elementIndex !== endPos.elementIndex) {
            withMcp(r.doc, () => {
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
              mergeXmlTextDelta(startText, endText, startPos.textOffset);
              fragment.delete(startPos.elementIndex + 1, 1);

              startText.insert(startPos.textOffset, newText);
            });
          } else {
            withMcp(r.doc, () => {
              const node = fragment.get(startPos.elementIndex) as Y.XmlElement;
              const textNode = getOrCreateXmlText(node);
              const deleteLen = endPos.textOffset - startPos.textOffset;
              if (deleteLen > 0) {
                textNode.delete(startPos.textOffset, deleteLen);
              }
              if (newText.length > 0) {
                textNode.insert(startPos.textOffset, newText);
              }
            });
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
              withMcp(r.doc, () => {
                authorshipMap.set(rangeId, entry);
              });
            }
          }

          return mcpSuccess({ edited: true, from, to, newTextLength: newText.length });
        });
      },
    ),
  );

  // 1 MB inline cap — mdParser.parse is synchronous and blocks the event loop;
  // the 50 MB file cap is far too loose for an inline MCP argument.
  const MAX_APPEND_CONTENT_BYTES = 1_000_000;

  server.tool(
    "tandem_appendContent",
    "Append markdown to the END of the document, parsing headings/lists/paragraphs into real blocks (unlike tandem_edit, which is single-paragraph with literal newlines). Non-destructive; also seeds an empty document. Markdown documents only.",
    {
      content: z
        .string()
        .describe("Markdown to append. Block structure is parsed into real blocks."),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary("tandem_appendContent", async ({ content, documentId }) => {
      return withTypingPresence({ tool: "tandem_appendContent", documentId }, async () => {
        const r = requireDocument(documentId);
        if (!r) return noDocumentError();

        const docState = getCurrentDoc(documentId);
        if (docState?.readOnly) {
          return mcpError("FORMAT_ERROR", "Document is read-only (.docx) — cannot append content.");
        }
        if (docState && docState.format !== "md") {
          return mcpError("FORMAT_ERROR", "tandem_appendContent supports markdown documents only.");
        }
        if (Buffer.byteLength(content, "utf-8") > MAX_APPEND_CONTENT_BYTES) {
          return mcpError(
            "FILE_TOO_LARGE",
            `Content exceeds the ${MAX_APPEND_CONTENT_BYTES}-byte append limit.`,
          );
        }

        // Parse outside the transaction to shrink the in-transact failure surface
        // (mirrors the adapter parse/apply split). Cast: mdParser.parse is typed Node.
        const tree = mdParser.parse(content) as Root;

        const fragment = r.doc.getXmlFragment("default");
        const fragBefore = fragment.length;
        withMcp(r.doc, () => appendMdast(r.doc, tree));
        const fragAfter = fragment.length;

        // Stamp only the freshly-appended top-level blocks as Claude authorship,
        // mirroring tandem_edit's automatic stamp of inserted text. Skip the
        // whole-fragment walk when nothing was appended (e.g. whitespace-only).
        if (fragAfter > fragBefore) {
          stampClaudeAuthorshipWholeDoc(r.doc, fragBefore);
        }

        return mcpSuccess({
          appended: true,
          // Fragment-element delta, not an mdast-paragraph count: splitParagraphImages
          // can emit multiple elements from one paragraph, so this may exceed the
          // number of source markdown paragraphs.
          blockCount: fragAfter - fragBefore,
        });
      });
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
      // path.basename eliminates directory components so CodeQL does not trace
      // user input through Map.get(id) to existing.filePath (js/path-injection).
      const safeDocId = documentId !== undefined ? path.basename(documentId) : undefined;
      const r = requireDocument(safeDocId);
      if (!r) return noDocumentError();

      const docState = getCurrentDoc(safeDocId);
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

      // Read-only documents (e.g. CHANGELOG, uploads) — session-only save.
      // .docx is no longer read-only (#576); it round-trips through the binary
      // save branch below.
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

      // Delegate to shared save function (handles .docx body export back to disk)
      const result = await saveDocumentToDisk(r.docId, "mcp");
      if (result.status === "saved") {
        // Surface .docx body-export fidelity warnings (#576) so the agent knows
        // what the round-trip downgraded (e.g. unsupported blocks → plain text).
        return mcpSuccess({
          saved: true,
          filePath: r.filePath,
          ...(result.fidelityWarnings && result.fidelityWarnings.length > 0
            ? { fidelityWarnings: result.fidelityWarnings }
            : {}),
          // Post-write verification advisories (#1123 0e). Content-free strings;
          // surfaced so the agent knows the save may have lost content
          // unexpectedly (the user's original is backed up). A `blocked` verdict
          // never reaches here — it aborts the save (result.status === "error").
          ...(result.integrityWarnings && result.integrityWarnings.length > 0
            ? { integrityWarnings: result.integrityWarnings }
            : {}),
        });
      }
      if (result.status === "skipped") {
        // Fall back to session-only save for skipped formats. The disk save
        // did NOT happen, so persist the dirty flag (#1069): without it a
        // skipped save (e.g. "File modified externally" on a dirty .docx)
        // would write a clean-looking session that a restart then discards —
        // losing the only copy of the unsaved edits.
        await saveSession(r.filePath, format, r.doc, { dirty: isDirty(r.docId) });
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

  server.registerTool(
    "tandem_status",
    {
      description:
        "Read editor status (no params) or set your visible status text (pass text), shown in the editor's status bar.",
      inputSchema: {
        text: z.string().optional().describe("Status text to display — omit for read-only"),
        focusParagraph: z
          .number()
          .optional()
          .describe("Index of paragraph the AI is focusing on (write mode only)"),
        focusOffset: z
          .number()
          .optional()
          .describe("Flat character offset for precise cursor positioning (write mode only)"),
        documentId: z
          .string()
          .optional()
          .describe("Target document ID for status write (defaults to active document)"),
      },
      outputSchema: statusOutputShape,
    },
    withStructuredErrors(
      withErrorBoundary(
        "tandem_status",
        async ({ text, focusParagraph, focusOffset, documentId }) => {
          // Write mode — update Claude's status shown in the editor
          if (text !== undefined) {
            const current = getCurrentDoc(documentId);
            if (!current) {
              return mcpStructured({
                status: text,
                warning: "No document open — status not broadcast to editor.",
              });
            }
            const doc = getOrCreateDocument(current.docName);
            const awarenessMap = doc.getMap(Y_MAP_AWARENESS);
            withMcp(doc, () => {
              // #651: preserve the in-flight `working` marker so a status
              // update during a wrapped tool call (tandem_comment / _edit /
              // _reply / _annotationReply) doesn't wipe the typing indicator.
              const prev = awarenessMap.get(Y_MAP_CLAUDE) as ClaudeAwareness | undefined;
              awarenessMap.set(Y_MAP_CLAUDE, {
                status: text,
                timestamp: Date.now(),
                active: true,
                focusParagraph: focusParagraph ?? null,
                focusOffset: focusOffset ?? null,
                ...(prev?.working ? { working: prev.working } : {}),
              });
            });
            return mcpStructured({ status: text });
          }

          // Read mode — return editor status summary
          const activeId = getActiveDocId();
          const active = activeId ? openDocs.get(activeId) : null;

          const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
          const ctrlAwareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
          const mode = TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(
            ctrlAwareness.get(Y_MAP_MODE),
          );

          return mcpStructured({
            running: true,
            mode,
            storeReadOnly: isStoreReadOnly(),
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
      // path.basename eliminates directory components — CodeQL taint-terminator
      // before documentId reaches closeDocumentById's Map.get/FS sinks.
      const rawId = documentId ?? getActiveDocId();
      if (!rawId) return mcpError("NO_DOCUMENT", "No document to close.");
      const id = path.basename(rawId);

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
    "tandem_rename",
    "Rename an open on-disk file (same directory, same extension); document stays open with annotations intact. Not for scratchpads/uploads or read-only files.",
    {
      newName: z
        .string()
        .describe("New file name (basename only, e.g. 'notes.md' — must keep the same extension)"),
      documentId: z
        .string()
        .optional()
        .describe("Document ID to rename (defaults to active document)"),
    },
    withErrorBoundary("tandem_rename", async ({ newName: rawNewName, documentId: rawDocId }) => {
      const rawId = rawDocId ?? getActiveDocId();
      if (!rawId) return mcpError("NO_DOCUMENT", "No document to rename.");
      // Sanitize via path.basename() — CodeQL's recognized taint-terminator for
      // js/path-injection. Both values are hashes or basenames (no separators on
      // valid input); the calls break the taint chain before reaching fs sinks.
      const id = path.basename(rawId);
      if (!id) return mcpError("BAD_REQUEST", "documentId resolved to an empty string.");
      const newName = path.basename(rawNewName);
      if (!newName) return mcpError("INVALID_NAME", "newName must not be empty.");

      const result = await renameDocument(id, newName);
      if (result.status === "error") {
        return mcpError(result.errorCode ?? "RENAME_FAILED", result.reason ?? "Rename failed.");
      }

      return mcpSuccess({
        renamed: true,
        from: result.oldPath,
        to: result.newPath,
        fileName: result.fileName,
      });
    }),
  );

  server.registerTool(
    "tandem_listDocuments",
    {
      description: "List all open documents with their IDs, file paths, and formats.",
      inputSchema: {},
      outputSchema: listDocumentsOutputShape,
    },
    withStructuredErrors(
      withErrorBoundary("tandem_listDocuments", async () => {
        return mcpStructured({
          documents: Array.from(openDocs.values()).map((d) => ({
            ...toDocListEntry(d),
            isActive: d.id === getActiveDocId(),
          })),
          activeDocumentId: getActiveDocId(),
          count: docCount(),
        });
      }),
    ),
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
      // path.basename eliminates directory components so CodeQL does not trace
      // user input through Map.get(id) to existing.filePath (js/path-injection).
      const safeDocId = documentId !== undefined ? path.basename(documentId) : undefined;
      try {
        const result = await convertToMarkdown(safeDocId, outputPath);
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
