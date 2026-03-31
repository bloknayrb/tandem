import { Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { MCP_ORIGIN } from "../events/queue.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getOrCreateDocument } from "../yjs/provider.js";
import { getCurrentDoc, extractText } from "./document.js";
import { mcpSuccess, mcpError, noDocumentError, withErrorBoundary } from "./response.js";
import { exportAnnotations } from "../file-io/docx.js";
import * as Y from "yjs";
import type { Annotation, AnnotationType, HighlightColor } from "../../shared/types.js";
import {
  AnnotationTypeSchema,
  AnnotationStatusSchema,
  AnnotationPrioritySchema,
  HighlightColorSchema,
  AuthorSchema,
  AnnotationActionSchema,
  ExportFormatSchema,
} from "../../shared/types.js";
import { anchoredRange, refreshAllRanges } from "../positions.js";
import type { RangeValidation, AnchoredRangeResult } from "../../shared/positions/index.js";
import { pushNotification } from "../notifications.js";
import { generateAnnotationId, generateNotificationId } from "../../shared/utils.js";

/** Get the Y.Doc and annotations Y.Map for a document, or null if no doc is open */
function getDocAndAnnotations(documentId?: string): { ydoc: Y.Doc; map: Y.Map<unknown> } | null {
  const doc = getCurrentDoc(documentId);
  if (!doc) return null;
  const ydoc = getOrCreateDocument(doc.docName);
  return { ydoc, map: ydoc.getMap(Y_MAP_ANNOTATIONS) };
}

/** Human-readable message for a range validation failure. */
function rangeFailureMessage(result: Extract<RangeValidation, { ok: false }>): string {
  if (result.code === "RANGE_GONE") return "Target text no longer exists in the document.";
  if (result.code === "RANGE_MOVED") return "Target text has moved.";
  if (result.code === "INVALID_RANGE") return result.message;
  return 'Range overlaps with heading markup (e.g., "## "). Target the text content only.';
}

/** Convert an anchoredRange validation failure to an MCP error response. */
function rangeFailureToError(result: Extract<RangeValidation, { ok: false }>) {
  if (result.code === "RANGE_GONE") {
    return mcpError("RANGE_GONE", "Target text no longer exists in the document.");
  }
  if (result.code === "RANGE_MOVED") {
    return mcpError("RANGE_MOVED", "Target text has moved. Use resolvedFrom/resolvedTo to retry.", {
      resolvedFrom: result.resolvedFrom,
      resolvedTo: result.resolvedTo,
    });
  }
  if (result.code === "INVALID_RANGE") {
    return mcpError("INVALID_RANGE", result.message);
  }
  // HEADING_OVERLAP
  return mcpError(
    "INVALID_RANGE",
    'Range overlaps with heading markup (e.g., "## "). Target the text content only.',
  );
}

/** Push a notification to the browser alongside the MCP error response. */
function notifyRangeFailure(
  result: Extract<RangeValidation, { ok: false }>,
  toolName: string,
  documentId?: string,
): void {
  pushNotification({
    id: generateNotificationId(),
    type: "annotation-error",
    severity: "error",
    message: `Annotation failed: ${rangeFailureMessage(result)}`,
    toolName,
    errorCode: result.code,
    documentId,
    dedupKey: `${toolName}:${result.code}`,
    timestamp: Date.now(),
  });
}

const SNAPSHOT_CAP = 200;
/** Capture a text snapshot from the document at the given range, truncated to SNAPSHOT_CAP chars. */
function captureSnapshot(ydoc: Y.Doc, from: number, to: number): string {
  const text = extractText(ydoc).slice(from, to);
  return text.length > SNAPSHOT_CAP ? text.slice(0, SNAPSHOT_CAP - 3) + "..." : text;
}

/** Create an annotation from an anchored range result and store it in the Y.Map.
 *  The ydoc parameter is required for origin-tagged transactions (prevents channel echo). */
export function createAnnotation(
  map: Y.Map<unknown>,
  ydoc: Y.Doc,
  type: AnnotationType,
  anchored: AnchoredRangeResult,
  content: string,
  extras?: Partial<Annotation>,
): string {
  const id = generateAnnotationId();

  const annotation: Annotation = {
    id,
    author: "claude",
    type,
    range: anchored.range,
    ...(anchored.relRange ? { relRange: anchored.relRange } : {}),
    content,
    status: "pending",
    timestamp: Date.now(),
    ...extras,
  };
  ydoc.transact(() => map.set(id, annotation), MCP_ORIGIN);
  return id;
}

/** Collect all annotations from the Y.Map as an array */
export function collectAnnotations(map: Y.Map<unknown>): Annotation[] {
  const result: Annotation[] = [];
  map.forEach((value) => result.push(value as Annotation));
  return result;
}

export { refreshRange, refreshAllRanges } from "../positions.js";

export function registerAnnotationTools(server: McpServer): void {
  server.tool(
    "tandem_highlight",
    "Highlight text with a color and optional note",
    {
      from: z.number().describe("Start position"),
      to: z.number().describe("End position"),
      color: HighlightColorSchema.describe("Highlight color"),
      note: z.string().optional().describe("Optional note for the highlight"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
      priority: AnnotationPrioritySchema.optional().describe(
        "Annotation priority. Set to 'urgent' for critical issues that should be visible even when the user has interruption mode set to urgent-only. Flags and questions are implicitly urgent.",
      ),
      textSnapshot: z
        .string()
        .optional()
        .describe(
          "Expected text at [from, to] — returns RANGE_MOVED with relocated range on mismatch, or RANGE_GONE if text was deleted",
        ),
    },
    withErrorBoundary(
      "tandem_highlight",
      async ({ from, to, color, note, documentId, priority, textSnapshot }) => {
        const da = getDocAndAnnotations(documentId);
        if (!da) return noDocumentError();
        const result = anchoredRange(da.ydoc, from, to, textSnapshot);
        if (!result.ok) {
          notifyRangeFailure(result, "tandem_highlight", documentId);
          return rangeFailureToError(result);
        }
        const snap = captureSnapshot(da.ydoc, result.range.from, result.range.to);
        const id = createAnnotation(da.map, da.ydoc, "highlight", result, note || "", {
          color: color as HighlightColor,
          ...(priority ? { priority } : {}),
          textSnapshot: snap,
        });
        return mcpSuccess({ annotationId: id });
      },
    ),
  );

  server.tool(
    "tandem_comment",
    "Add a comment to a text range",
    {
      from: z.number().describe("Start position"),
      to: z.number().describe("End position"),
      text: z.string().describe("Comment text"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
      priority: AnnotationPrioritySchema.optional().describe(
        "Annotation priority. Set to 'urgent' for critical issues that should be visible even when the user has interruption mode set to urgent-only. Flags and questions are implicitly urgent.",
      ),
      textSnapshot: z
        .string()
        .optional()
        .describe(
          "Expected text at [from, to] — returns RANGE_MOVED with relocated range on mismatch, or RANGE_GONE if text was deleted",
        ),
    },
    withErrorBoundary(
      "tandem_comment",
      async ({ from, to, text, documentId, priority, textSnapshot }) => {
        const da = getDocAndAnnotations(documentId);
        if (!da) return noDocumentError();
        const result = anchoredRange(da.ydoc, from, to, textSnapshot);
        if (!result.ok) {
          notifyRangeFailure(result, "tandem_comment", documentId);
          return rangeFailureToError(result);
        }
        const snap = captureSnapshot(da.ydoc, result.range.from, result.range.to);
        const id = createAnnotation(da.map, da.ydoc, "comment", result, text, {
          ...(priority ? { priority } : {}),
          textSnapshot: snap,
        });
        return mcpSuccess({ annotationId: id });
      },
    ),
  );

  server.tool(
    "tandem_suggest",
    "Propose a text replacement (tracked change style)",
    {
      from: z.number().describe("Start position"),
      to: z.number().describe("End position"),
      newText: z.string().describe("Suggested replacement text"),
      reason: z.string().optional().describe("Reason for the suggestion"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
      priority: AnnotationPrioritySchema.optional().describe(
        "Annotation priority. Set to 'urgent' for critical issues that should be visible even when the user has interruption mode set to urgent-only. Flags and questions are implicitly urgent.",
      ),
      textSnapshot: z
        .string()
        .optional()
        .describe(
          "Expected text at [from, to] — returns RANGE_MOVED with relocated range on mismatch, or RANGE_GONE if text was deleted",
        ),
    },
    withErrorBoundary(
      "tandem_suggest",
      async ({ from, to, newText, reason, documentId, priority, textSnapshot }) => {
        const da = getDocAndAnnotations(documentId);
        if (!da) return noDocumentError();
        const result = anchoredRange(da.ydoc, from, to, textSnapshot);
        if (!result.ok) {
          notifyRangeFailure(result, "tandem_suggest", documentId);
          return rangeFailureToError(result);
        }
        const snap = captureSnapshot(da.ydoc, result.range.from, result.range.to);
        const id = createAnnotation(
          da.map,
          da.ydoc,
          "suggestion",
          result,
          JSON.stringify({ newText, reason: reason || "" }),
          { ...(priority ? { priority } : {}), textSnapshot: snap },
        );
        return mcpSuccess({ annotationId: id });
      },
    ),
  );

  server.tool(
    "tandem_flag",
    "Flag a text range for attention (e.g., issues, concerns, or items needing review)",
    {
      from: z.number().describe("Start position"),
      to: z.number().describe("End position"),
      note: z.string().optional().describe("Reason for flagging"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
      priority: AnnotationPrioritySchema.optional().describe(
        "Annotation priority. Set to 'urgent' for critical issues that should be visible even when the user has interruption mode set to urgent-only. Flags and questions are implicitly urgent.",
      ),
      textSnapshot: z
        .string()
        .optional()
        .describe(
          "Expected text at [from, to] — returns RANGE_MOVED with relocated range on mismatch, or RANGE_GONE if text was deleted",
        ),
    },
    withErrorBoundary(
      "tandem_flag",
      async ({ from, to, note, documentId, priority, textSnapshot }) => {
        const da = getDocAndAnnotations(documentId);
        if (!da) return noDocumentError();
        const result = anchoredRange(da.ydoc, from, to, textSnapshot);
        if (!result.ok) {
          notifyRangeFailure(result, "tandem_flag", documentId);
          return rangeFailureToError(result);
        }
        const snap = captureSnapshot(da.ydoc, result.range.from, result.range.to);
        const id = createAnnotation(da.map, da.ydoc, "flag", result, note || "", {
          ...(priority ? { priority } : {}),
          textSnapshot: snap,
        });
        return mcpSuccess({ annotationId: id });
      },
    ),
  );

  server.tool(
    "tandem_getAnnotations",
    "Read all annotations, optionally filtered by author/type/status. For checking new user actions, prefer tandem_checkInbox.",
    {
      author: AuthorSchema.optional().describe("Filter by author"),
      type: AnnotationTypeSchema.optional().describe("Filter by type"),
      status: AnnotationStatusSchema.optional().describe("Filter by status"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary("tandem_getAnnotations", async ({ author, type, status, documentId }) => {
      const da = getDocAndAnnotations(documentId);
      if (!da) return noDocumentError();

      let results = refreshAllRanges(collectAnnotations(da.map), da.ydoc, da.map);
      if (author) results = results.filter((a) => a.author === author);
      if (type) results = results.filter((a) => a.type === type);
      if (status) results = results.filter((a) => a.status === status);

      return mcpSuccess({ annotations: results, count: results.length });
    }),
  );

  server.tool(
    "tandem_resolveAnnotation",
    "Accept or dismiss an annotation",
    {
      id: z.string().describe("Annotation ID"),
      action: AnnotationActionSchema.describe("Action to take"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary("tandem_resolveAnnotation", async ({ id, action, documentId }) => {
      const da = getDocAndAnnotations(documentId);
      if (!da) return noDocumentError();

      const ann = da.map.get(id) as Annotation | undefined;
      if (!ann) return mcpError("INVALID_RANGE", `Annotation ${id} not found`);

      const updated = {
        ...ann,
        status: action === "accept" ? ("accepted" as const) : ("dismissed" as const),
      };
      da.ydoc.transact(() => da.map.set(id, updated), MCP_ORIGIN);
      return mcpSuccess({ id, status: updated.status });
    }),
  );

  server.tool(
    "tandem_removeAnnotation",
    "Remove an annotation entirely",
    {
      id: z.string().describe("Annotation ID"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary("tandem_removeAnnotation", async ({ id, documentId }) => {
      const da = getDocAndAnnotations(documentId);
      if (!da) return noDocumentError();
      if (!da.map.has(id)) return mcpError("INVALID_RANGE", `Annotation ${id} not found`);
      da.ydoc.transact(() => da.map.delete(id), MCP_ORIGIN);
      return mcpSuccess({ removed: true, id });
    }),
  );

  server.tool(
    "tandem_editAnnotation",
    "Edit the content of an existing annotation. For suggestions, use newText/reason params; for other types, use content.",
    {
      id: z.string().describe("Annotation ID"),
      content: z.string().optional().describe("New text for non-suggestion annotations"),
      newText: z.string().optional().describe("For suggestions: new replacement text"),
      reason: z.string().optional().describe("For suggestions: new reason"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary(
      "tandem_editAnnotation",
      async ({ id, content, newText, reason, documentId }) => {
        const da = getDocAndAnnotations(documentId);
        if (!da) return noDocumentError();

        const ann = da.map.get(id) as Annotation | undefined;
        if (!ann) return mcpError("INVALID_RANGE", `Annotation ${id} not found`);

        if (ann.status !== "pending") {
          return mcpError("INVALID_RANGE", `Cannot edit a ${ann.status} annotation`);
        }

        let updatedContent: string;

        if (ann.type === "suggestion") {
          if (content !== undefined && newText === undefined && reason === undefined) {
            // Allow raw content override for suggestions too
            updatedContent = content;
          } else if (newText !== undefined || reason !== undefined) {
            // Merge with existing suggestion fields
            let existing = { newText: "", reason: "" };
            try {
              existing = JSON.parse(ann.content);
            } catch {
              // malformed existing content
            }
            updatedContent = JSON.stringify({
              newText: newText !== undefined ? newText : existing.newText,
              reason: reason !== undefined ? reason : existing.reason,
            });
          } else {
            return mcpError(
              "INVALID_RANGE",
              "No editable fields provided. Use newText/reason for suggestions, or content.",
            );
          }
        } else {
          if (content === undefined) {
            return mcpError(
              "INVALID_RANGE",
              "No editable fields provided. Use content for non-suggestion annotations.",
            );
          }
          updatedContent = content;
        }

        const updated = { ...ann, content: updatedContent, editedAt: Date.now() };
        da.ydoc.transact(() => da.map.set(id, updated), MCP_ORIGIN);
        return mcpSuccess({ id, content: updatedContent, editedAt: updated.editedAt });
      },
    ),
  );

  server.tool(
    "tandem_exportAnnotations",
    "Export all annotations as a formatted summary. Useful for review reports, especially on read-only .docx files.",
    {
      format: ExportFormatSchema.optional().describe("Output format (default: markdown)"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary("tandem_exportAnnotations", async ({ format, documentId }) => {
      const da = getDocAndAnnotations(documentId);
      if (!da) return noDocumentError();

      const annotations = refreshAllRanges(collectAnnotations(da.map), da.ydoc, da.map);
      const { ydoc } = da;

      if (format === "json") {
        const fullText = extractText(ydoc);
        const enriched = annotations.map((ann) => ({
          ...ann,
          textSnippet: fullText.slice(
            Math.max(0, ann.range.from),
            Math.min(fullText.length, ann.range.to),
          ),
        }));
        return mcpSuccess({ annotations: enriched, count: enriched.length });
      }

      const markdown = exportAnnotations(ydoc, annotations);
      return mcpSuccess({ markdown, count: annotations.length });
    }),
  );
}
