import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getOrCreateDocument } from "../yjs/provider.js";
import {
  getCurrentDoc,
  extractText,
  verifyAndResolveRange,
  flatOffsetToRelPos,
  relPosToFlatOffset,
} from "./document.js";
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

/** Get the Y.Doc and annotations Y.Map for a document, or null if no doc is open */
function getDocAndAnnotations(documentId?: string): { ydoc: Y.Doc; map: Y.Map<unknown> } | null {
  const doc = getCurrentDoc(documentId);
  if (!doc) return null;
  const ydoc = getOrCreateDocument(doc.docName);
  return { ydoc, map: ydoc.getMap("annotations") };
}

/** Check textSnapshot against the document range. Returns an error response if stale, or null if valid. */
function checkRangeStale(ydoc: Y.Doc, from: number, to: number, textSnapshot: string | undefined) {
  if (!textSnapshot) return null;
  const result = verifyAndResolveRange(ydoc, from, to, textSnapshot);
  if (result.valid) return null;
  if (result.gone) {
    return mcpError("RANGE_STALE", "Target text no longer exists in the document.");
  }
  return mcpError("RANGE_STALE", "Target text has moved. Use resolvedFrom/resolvedTo to retry.", {
    resolvedFrom: result.resolvedFrom,
    resolvedTo: result.resolvedTo,
  });
}

import { generateAnnotationId as generateId } from "../../shared/utils.js";
export { generateId };

/** Create an annotation and store it in the Y.Map. Returns the annotation ID. */
export function createAnnotation(
  map: Y.Map<unknown>,
  type: AnnotationType,
  from: number,
  to: number,
  content: string,
  extras?: Partial<Annotation>,
  ydoc?: Y.Doc,
): string {
  const id = generateId();

  // Compute CRDT-anchored positions when Y.Doc is available
  let relRange: Annotation["relRange"];
  if (ydoc) {
    const fromRel = flatOffsetToRelPos(ydoc, from, 0); // assoc 0: stick right
    const toRel = flatOffsetToRelPos(ydoc, to, -1); // assoc -1: stick left
    if (fromRel && toRel) {
      relRange = { fromRel, toRel };
    }
  }

  const annotation: Annotation = {
    id,
    author: "claude",
    type,
    range: { from, to },
    ...(relRange ? { relRange } : {}),
    content,
    status: "pending",
    timestamp: Date.now(),
    ...extras,
  };
  map.set(id, annotation);
  return id;
}

/** Collect all annotations from the Y.Map as an array */
export function collectAnnotations(map: Y.Map<unknown>): Annotation[] {
  const result: Annotation[] = [];
  map.forEach((value) => result.push(value as Annotation));
  return result;
}

/**
 * Refresh an annotation's flat offsets from its relRange, or lazily attach
 * relRange if missing. Returns the (possibly updated) annotation.
 * If `map` is provided, persists changes back to the Y.Map.
 */
export function refreshRange(ann: Annotation, ydoc: Y.Doc, map?: Y.Map<unknown>): Annotation {
  if (!ann.relRange) {
    // Lazy attachment: compute relRange from current flat offsets
    const fromRel = flatOffsetToRelPos(ydoc, ann.range.from, 0);
    const toRel = flatOffsetToRelPos(ydoc, ann.range.to, -1);
    if (!fromRel || !toRel) return ann;
    const updated = { ...ann, relRange: { fromRel, toRel } };
    if (map) map.set(ann.id, updated);
    return updated;
  }

  // Resolve relRange to current flat offsets
  const newFrom = relPosToFlatOffset(ydoc, ann.relRange.fromRel);
  const newTo = relPosToFlatOffset(ydoc, ann.relRange.toRel);
  if (newFrom === null || newTo === null) return ann; // deleted content, keep old range
  if (newFrom === ann.range.from && newTo === ann.range.to) return ann; // unchanged

  const updated = { ...ann, range: { from: newFrom, to: newTo } };
  if (map) map.set(ann.id, updated);
  return updated;
}

/** Refresh all annotations in a batch, wrapping Y.Map writes in a transaction. */
function refreshAllRanges(
  annotations: Annotation[],
  ydoc: Y.Doc,
  map: Y.Map<unknown>,
): Annotation[] {
  const results: Annotation[] = [];
  ydoc.transact(() => {
    for (const ann of annotations) {
      results.push(refreshRange(ann, ydoc, map));
    }
  });
  return results;
}

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
        "Annotation priority — urgent bypasses the Hold interruption mode",
      ),
      textSnapshot: z
        .string()
        .optional()
        .describe(
          "Expected text at [from, to] — returns RANGE_STALE with relocated range on mismatch",
        ),
    },
    withErrorBoundary(
      "tandem_highlight",
      async ({ from, to, color, note, documentId, priority, textSnapshot }) => {
        const da = getDocAndAnnotations(documentId);
        if (!da) return noDocumentError();
        const staleError = checkRangeStale(da.ydoc, from, to, textSnapshot);
        if (staleError) return staleError;
        const id = createAnnotation(
          da.map,
          "highlight",
          from,
          to,
          note || "",
          { color: color as HighlightColor, ...(priority ? { priority } : {}) },
          da.ydoc,
        );
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
        "Annotation priority — urgent bypasses the Hold interruption mode",
      ),
      textSnapshot: z
        .string()
        .optional()
        .describe(
          "Expected text at [from, to] — returns RANGE_STALE with relocated range on mismatch",
        ),
    },
    withErrorBoundary(
      "tandem_comment",
      async ({ from, to, text, documentId, priority, textSnapshot }) => {
        const da = getDocAndAnnotations(documentId);
        if (!da) return noDocumentError();
        const staleError = checkRangeStale(da.ydoc, from, to, textSnapshot);
        if (staleError) return staleError;
        const id = createAnnotation(
          da.map,
          "comment",
          from,
          to,
          text,
          priority ? { priority } : {},
          da.ydoc,
        );
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
        "Annotation priority — urgent bypasses the Hold interruption mode",
      ),
      textSnapshot: z
        .string()
        .optional()
        .describe(
          "Expected text at [from, to] — returns RANGE_STALE with relocated range on mismatch",
        ),
    },
    withErrorBoundary(
      "tandem_suggest",
      async ({ from, to, newText, reason, documentId, priority, textSnapshot }) => {
        const da = getDocAndAnnotations(documentId);
        if (!da) return noDocumentError();
        const staleError = checkRangeStale(da.ydoc, from, to, textSnapshot);
        if (staleError) return staleError;
        const id = createAnnotation(
          da.map,
          "suggestion",
          from,
          to,
          JSON.stringify({ newText, reason: reason || "" }),
          priority ? { priority } : {},
          da.ydoc,
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
        "Annotation priority — urgent bypasses the Hold interruption mode",
      ),
      textSnapshot: z
        .string()
        .optional()
        .describe(
          "Expected text at [from, to] — returns RANGE_STALE with relocated range on mismatch",
        ),
    },
    withErrorBoundary(
      "tandem_flag",
      async ({ from, to, note, documentId, priority, textSnapshot }) => {
        const da = getDocAndAnnotations(documentId);
        if (!da) return noDocumentError();
        const staleError = checkRangeStale(da.ydoc, from, to, textSnapshot);
        if (staleError) return staleError;
        const id = createAnnotation(
          da.map,
          "flag",
          from,
          to,
          note || "",
          priority ? { priority } : {},
          da.ydoc,
        );
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
      da.map.set(id, updated);
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
      da.map.delete(id);
      return mcpSuccess({ removed: true, id });
    }),
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
