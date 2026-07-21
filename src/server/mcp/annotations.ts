import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Y from "yjs";
import { z } from "zod";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { withBrowser, withMcp } from "../../shared/origins.js";
import type { AnchoredRangeResult, RangeValidation } from "../../shared/positions/index.js";
import type { SanitizationEvent } from "../../shared/sanitize.js";
import { sanitizeAnnotation } from "../../shared/sanitize.js";
import type {
  Annotation,
  AnnotationReply,
  AnnotationType,
  ReplyAuthor,
} from "../../shared/types.js";
import {
  AnnotationActionSchema,
  AnnotationStatusSchema,
  AuthorSchema,
  ExportFormatSchema,
  HighlightColorSchema,
  toFlatOffset,
} from "../../shared/types.js";
import {
  generateAnnotationId,
  generateNotificationId,
  generateReplyId,
} from "../../shared/utils.js";
import { relaySanitizationEvent } from "../annotations/migration-log.js";
import { nextRev } from "../annotations/schema.js";
import { exportAnnotations } from "../file-io/docx.js";
import { atomicWrite } from "../file-io/index.js";
import { rejectUnsafeWindowsPrefix } from "../file-io/windows-path-safety.js";
import { hideFromAI, readModeState } from "../mode.js";
import { pushNotification } from "../notifications.js";
import { anchoredRange } from "../positions.js";
import { extractText, getCurrentDoc } from "./document.js";
import { getDocumentStore } from "./document-store.js";
import { gatedTool } from "./license-gate.js";
import { getAnnotationsOutputShape } from "./output-schemas.js";
import {
  mcpError,
  mcpStructured,
  mcpSuccess,
  noDocumentError,
  withErrorBoundary,
  withStructuredErrors,
} from "./response.js";
import { sanitizeAnnotationIdForPresence, withTypingPresence } from "./typing-presence.js";

/** Build an `onLossy` callback that relays to the migration-log for the given doc. */
function makeOnLossy(hash: string | undefined): (event: SanitizationEvent) => void {
  return (event) => relaySanitizationEvent(hash, event);
}

/** Get the annotation replies Y.Map for a document. */
function getRepliesMap(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
}

/** Remove the annotation and its orphaned replies. Tombstones are recorded
 *  automatically by the sync observer on the Y.Map delete event (see #695). */
export function removeAnnotationById(
  ydoc: Y.Doc,
  annotationsMap: Y.Map<unknown>,
  filePath: string,
  annotationId: string,
): { ok: true; id: string } | { ok: false; code: string; error: string } {
  void filePath;
  const existing = annotationsMap.get(annotationId) as Annotation | undefined;
  if (!existing) {
    return { ok: false, code: "NOT_FOUND", error: `Annotation ${annotationId} not found` };
  }

  withMcp(ydoc, () => {
    annotationsMap.delete(annotationId);
    const repliesMap = getRepliesMap(ydoc);
    const toDelete: string[] = [];
    repliesMap.forEach((value, key) => {
      const reply = value as { annotationId?: string };
      if (reply && reply.annotationId === annotationId) toDelete.push(key);
    });
    for (const key of toDelete) repliesMap.delete(key);
  });

  return { ok: true, id: annotationId };
}

/**
 * Replies safe to surface to Claude for `annotation`. The SINGLE place that
 * enforces both ADR-027 reply-privacy gates, so no Claude-facing caller can
 * forget one (#1000 security review R1):
 *   1. only `comment` parents expose replies at all, and
 *   2. `private` replies (note-authored or imported Word threads) are stripped
 *      even after a note→comment promotion.
 * `loadReplies` is a thunk so the replies Y.Map is only walked for comments.
 * Every Claude egress (`tandem_getAnnotations`, `tandem_exportAnnotations`)
 * MUST route through this — never call `collectRepliesForAnnotation` /
 * `store.listReplies` directly for Claude-facing output.
 */
export function channelVisibleReplies(
  annotation: Annotation,
  loadReplies: (annotationId: string) => AnnotationReply[],
): AnnotationReply[] {
  if (annotation.type !== "comment") return [];
  return loadReplies(annotation.id).filter((r) => r.private !== true);
}

/**
 * Collect all replies for a given annotation from the replies Y.Map.
 *
 * Returns EVERY reply for the id regardless of parent type or `private` flag —
 * this is the raw store accessor. Any output bound for Claude MUST go through
 * `channelVisibleReplies` instead; see ADR-027 and #1000.
 */
export function collectRepliesForAnnotation(
  repliesMap: Y.Map<unknown>,
  annotationId: string,
): AnnotationReply[] {
  const replies: AnnotationReply[] = [];
  repliesMap.forEach((value) => {
    const reply = value as AnnotationReply;
    if (reply && typeof reply === "object" && reply.annotationId === annotationId) {
      replies.push(reply);
    }
  });
  // Sort chronologically
  replies.sort((a, b) => a.timestamp - b.timestamp);
  return replies;
}

/**
 * Add a reply to an annotation. Writes to the separate annotationReplies Y.Map.
 * Returns the reply ID on success, or an error string on failure.
 */
export function addReplyToAnnotation(
  ydoc: Y.Doc,
  annotationsMap: Y.Map<unknown>,
  annotationId: string,
  text: string,
  author: ReplyAuthor,
  /**
   * ADR-031 transact wrapper: `withMcp` for Claude-initiated replies via the
   * MCP tool; `withBrowser` for user replies via the HTTP route. Defaults to
   * `withBrowser` so the lone HTTP caller doesn't need to pass it explicitly.
   */
  wrap: (doc: Y.Doc, fn: () => void) => void = withBrowser,
): { ok: true; replyId: string } | { ok: false; error: string; code?: string } {
  const raw = annotationsMap.get(annotationId) as Annotation | undefined;
  if (!raw) return { ok: false, error: `Annotation ${annotationId} not found`, code: "NOT_FOUND" };

  const ann = sanitizeAnnotation(raw, makeOnLossy(undefined));
  // Highlights are user-only UI markup with no body to thread — reject for any
  // author. Notes and comments accept replies (#1000): note replies are
  // user-private, stamped `private` below and stripped from every Claude-facing
  // read by `channelVisibleReplies`; the channel observer independently gates on
  // `parentAnn.type === "comment"`, so note replies never emit an SSE event.
  if (ann.type === "highlight") {
    return {
      ok: false,
      error: `Cannot reply to a highlight annotation; only notes and comments support replies`,
      code: "INVALID_ARGUMENT",
    };
  }
  // ADR-027: Claude never interacts with notes. The note-reply relaxation
  // (#1000) is for the USER path only (`tandem_annotationReply` always passes
  // `author: "claude"`); Claude may reply only to comments. Without this the
  // MCP tool would let Claude write into a private note thread.
  if (author === "claude" && ann.type !== "comment") {
    return {
      ok: false,
      error: `Claude can only reply to comments, not ${ann.type} annotations`,
      code: "INVALID_ARGUMENT",
    };
  }
  if (ann.status !== "pending") {
    return {
      ok: false,
      error: `Cannot reply to a ${ann.status} annotation`,
      code: "ANNOTATION_RESOLVED",
    };
  }

  const replyId = generateReplyId();
  const reply: AnnotationReply = {
    id: replyId,
    annotationId,
    author,
    text,
    timestamp: Date.now(),
    rev: nextRev(),
    // A reply inherits its parent's privacy at creation. Note replies are
    // user-private forever (even if the note is later promoted to a comment);
    // comment replies omit the flag and surface to Claude normally (#1000).
    ...(ann.type === "comment" ? {} : { private: true }),
    // WS-A2: server-stamp the Solo-hold marker on a user reply created in Solo.
    // Replies are created server-side (this function is the sole write path), so
    // unlike browser annotation writes the stamp lives here. Live hiding is still
    // mode-based (Phase 2 pushEvent + the checkInbox/getAnnotations reply gates);
    // this persisted marker drives the held-badge and the fail-closed-restart
    // hold (indeterminate mode). Claude/import replies never carry it.
    ...(author === "user" && readModeState() === "solo" ? { heldInSolo: true } : {}),
  };

  const repliesMap = getRepliesMap(ydoc);
  wrap(ydoc, () => repliesMap.set(replyId, reply));

  return { ok: true, replyId };
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

/** Surface a deprecated-tool call to the user; without this, only the AI client sees the failure. */
function notifyDeprecatedTool(toolName: string): void {
  pushNotification({
    id: generateNotificationId(),
    type: "annotation-error",
    severity: "warning",
    message: `Your AI tried a deprecated tool (${toolName}). Ask it to retry with tandem_comment.`,
    toolName,
    errorCode: "DEPRECATED",
    dedupKey: `deprecated:${toolName}`,
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

  const annotation = {
    id,
    author: "claude" as const,
    type,
    // Claude-created annotations are always outbound (visible to Claude); extras may override
    audience: "outbound" as const,
    range: anchored.range,
    ...(anchored.relRange ? { relRange: anchored.relRange } : {}),
    content,
    status: "pending" as const,
    timestamp: Date.now(),
    rev: nextRev(),
    ...extras,
  } as Annotation;
  withMcp(ydoc, () => map.set(id, annotation));

  const snippet = annotation.textSnapshot
    ? `: "${annotation.textSnapshot.slice(0, 60)}${annotation.textSnapshot.length > 60 ? "…" : ""}"`
    : "";
  // Derive notification label from field presence, not raw type
  const label =
    annotation.suggestedText !== undefined ? "Replacement" : type[0].toUpperCase() + type.slice(1);
  const dedupSuffix = annotation.suggestedText !== undefined ? "replacement" : type;
  pushNotification({
    id: generateNotificationId(),
    type: "review-pending",
    severity: "info",
    message: `New ${label}${snippet}`,
    dedupKey: `review-pending:${dedupSuffix}`,
    timestamp: Date.now(),
  });

  return id;
}

export { type RawAnnotation, sanitizeAnnotation } from "../../shared/sanitize.js";
// sanitizeAnnotation is also imported above for internal use within this file.

/** Collect all annotations from the Y.Map as an array, skipping malformed entries.
 *  Applies sanitizeAnnotation() to normalize legacy shapes. */
export function collectAnnotations(map: Y.Map<unknown>, docHashKey: string): Annotation[] {
  const result: Annotation[] = [];
  const onLossy = makeOnLossy(docHashKey);
  map.forEach((value, key) => {
    const ann = value as Record<string, unknown>;
    if (
      ann &&
      typeof ann === "object" &&
      typeof ann.id === "string" &&
      typeof ann.type === "string" &&
      typeof ann.status === "string" &&
      ann.range &&
      typeof (ann.range as Record<string, unknown>).from === "number" &&
      typeof (ann.range as Record<string, unknown>).to === "number"
    ) {
      result.push(sanitizeAnnotation(ann as unknown as Annotation, onLossy));
    } else {
      console.warn(`[Tandem] Skipping malformed annotation entry: ${key}`);
    }
  });
  return result;
}

export { refreshAllRanges, refreshRange } from "../positions.js";

export function registerAnnotationTools(server: McpServer): void {
  server.tool(
    "tandem_highlight",
    "DEPRECATED. Highlights are user-only. Use tandem_comment for text annotations.",
    {
      // All params optional: a deprecated stub must surface DEPRECATED for any
      // call shape, including ones missing the legacy required params.
      from: z.number().optional(),
      to: z.number().optional(),
      color: HighlightColorSchema.optional(),
      note: z.string().optional(),
      documentId: z.string().optional(),
      textSnapshot: z.string().optional(),
    },
    gatedTool("tandem_highlight", async () => {
      notifyDeprecatedTool("tandem_highlight");
      return mcpError(
        "DEPRECATED",
        "tandem_highlight is deprecated. Highlights are user-only. Use tandem_comment for text annotations.",
      );
    }),
  );

  server.tool(
    "tandem_comment",
    "Add a comment to a text range. Optionally include suggestedText for a replacement proposal.",
    {
      from: z.number().describe("Start position"),
      to: z.number().describe("End position"),
      text: z.string().describe("Comment text"),
      suggestedText: z
        .string()
        .optional()
        .describe("Optional replacement text — turns this into a tracked-change suggestion"),
      directedAt: z
        .enum(["claude"])
        .optional()
        .describe("Deprecated — pass omitted; including this field returns DEPRECATED."),
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
    gatedTool(
      "tandem_comment",
      async ({
        from: rawFrom,
        to: rawTo,
        text,
        suggestedText,
        directedAt,
        documentId,
        textSnapshot,
      }) => {
        // #651 presence: tandem_comment creates a new annotation (no pre-existing
        // id to broadcast), so the presence marker is a generic "Claude is
        // working on the document" indicator surfaced in the status bar.
        return withTypingPresence({ tool: "tandem_comment", documentId }, async () => {
          if (directedAt !== undefined)
            return mcpError(
              "DEPRECATED",
              "directedAt is no longer supported — comments now always reach the connected AI client. Drop the field from your call.",
            );
          const store = getDocumentStore(documentId);
          if (!store) return noDocumentError();
          const from = toFlatOffset(rawFrom);
          const to = toFlatOffset(rawTo);
          const result = anchoredRange(store.ydoc, from, to, textSnapshot, {
            rejectHeadingOverlap: true,
          });
          if (!result.ok) {
            notifyRangeFailure(result, "tandem_comment", documentId);
            return rangeFailureToError(result);
          }
          const snap = captureSnapshot(store.ydoc, result.range.from, result.range.to);
          const id = store.createAnnotation("comment", result, text, {
            textSnapshot: snap,
            ...(suggestedText !== undefined ? { suggestedText } : {}),
          });
          return mcpSuccess({ annotationId: id });
        });
      },
    ),
  );

  server.tool(
    "tandem_suggest",
    "DEPRECATED — use tandem_comment with suggestedText instead. Always returns an error.",
    {
      // All params optional: a deprecated stub must surface DEPRECATED for any
      // call shape, including ones missing the legacy required params.
      from: z.number().optional(),
      to: z.number().optional(),
      newText: z.string().optional(),
      reason: z.string().optional(),
      documentId: z.string().optional(),
      textSnapshot: z.string().optional(),
    },
    gatedTool("tandem_suggest", async () => {
      notifyDeprecatedTool("tandem_suggest");
      return mcpError(
        "DEPRECATED",
        "tandem_suggest is deprecated. Use tandem_comment with suggestedText instead.",
      );
    }),
  );

  server.tool(
    "tandem_flag",
    "DEPRECATED. Use tandem_comment instead.",
    {
      // All params optional: a deprecated stub must surface DEPRECATED for any
      // call shape, including ones missing the legacy required params.
      from: z.number().optional(),
      to: z.number().optional(),
      note: z.string().optional(),
      documentId: z.string().optional(),
      textSnapshot: z.string().optional(),
    },
    gatedTool("tandem_flag", async () => {
      notifyDeprecatedTool("tandem_flag");
      return mcpError("DEPRECATED", "tandem_flag is deprecated. Use tandem_comment instead.");
    }),
  );

  server.registerTool(
    "tandem_getAnnotations",
    {
      description:
        "Read annotations, optionally filtered by author/type/status. User notes are always excluded — they are private (ADR-027); notesExcluded reports how many were filtered, including imported Word comments awaiting user promotion (promoted ones surface as user comments). For new user actions, prefer tandem_checkInbox.",
      inputSchema: {
        author: AuthorSchema.optional().describe("Filter by author"),
        type: z.enum(["highlight", "comment"]).optional().describe("Filter by type"),
        status: AnnotationStatusSchema.optional().describe("Filter by status"),
        documentId: z
          .string()
          .optional()
          .describe("Target document ID (defaults to active document)"),
      },
      outputSchema: getAnnotationsOutputShape,
    },
    withStructuredErrors(
      withErrorBoundary("tandem_getAnnotations", async ({ author, type, status, documentId }) => {
        const store = getDocumentStore(documentId);
        if (!store) return noDocumentError();

        let results = store.listAnnotationsRefreshed();
        if (author) results = results.filter((a) => a.author === author);
        if (type) results = results.filter((a) => a.type === type);
        if (status) results = results.filter((a) => a.status === status);

        // User notes are always excluded — they are private (ADR-027).
        const notesExcluded = results.filter((a) => a.type === "note").length;
        results = results.filter((a) => a.type !== "note");

        // WS-A2: in Solo, hide the user's own annotations (and, below, their
        // replies) — this pull surface is one of the four the hold spans.
        // Server-authoritative live read; released implicitly once mode reads
        // tandem (no per-item flag needed). Read once for both filters.
        const modeState = readModeState();
        results = results.filter((a) => !hideFromAI(a, modeState));

        // ADR-027 + #1000: only comment parents expose replies, and `private`
        // replies (note-authored or imported Word threads) are stripped even
        // after a note→comment promotion. `channelVisibleReplies` enforces both
        // gates so this read site can't drift from the export path / observer.
        // The trailing Solo filter hides a user's own reply on a Claude comment
        // (the parent survives the annotation-level filter; the reply must not).
        const annotationsWithReplies = results.map((ann) => ({
          ...ann,
          replies: channelVisibleReplies(ann, (id) => store.listReplies(id)).filter(
            (r) => !hideFromAI(r, modeState),
          ),
        }));

        return mcpStructured({
          annotations: annotationsWithReplies,
          count: annotationsWithReplies.length,
          ...(notesExcluded > 0 ? { notesExcluded } : {}),
        });
      }),
    ),
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
      const store = getDocumentStore(documentId);
      if (!store) return noDocumentError();

      // Route through the AnnotationLifecycle module (ADR-035 part 2/N).
      // The lifecycle owns sanitize → status-check → rev-bump → tagged
      // result; the handler becomes a thin adapter translating
      // LifecycleResult arms to MCP error envelopes.
      const result = action === "accept" ? store.acceptAnnotation(id) : store.dismissAnnotation(id);

      switch (result.kind) {
        case "ok":
          return mcpSuccess({ id, status: result.data.status });
        case "not-found":
          return mcpError("NOT_FOUND", `Annotation ${id} not found`);
        case "not-pending":
          return mcpError(
            "ANNOTATION_NOT_PENDING",
            `Annotation ${id} is already ${result.currentStatus}`,
          );
      }
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
    gatedTool("tandem_removeAnnotation", async ({ id, documentId }) => {
      const store = getDocumentStore(documentId);
      if (!store) return noDocumentError();
      const result = store.removeAnnotation(id);
      if (!result.ok) return mcpError("NOT_FOUND", result.error);
      return mcpSuccess({ removed: true, id });
    }),
  );

  server.tool(
    "tandem_editAnnotation",
    "Edit the content of an existing annotation. Use newText to update replacement text, reason/content for the comment body.",
    {
      id: z.string().describe("Annotation ID"),
      content: z.string().optional().describe("New comment text"),
      newText: z.string().optional().describe("New replacement text (sets suggestedText)"),
      reason: z.string().optional().describe("Alias for content (legacy compat)"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    gatedTool("tandem_editAnnotation", async ({ id, content, newText, reason, documentId }) => {
      const store = getDocumentStore(documentId);
      if (!store) return noDocumentError();

      // `reason` is a legacy alias for `content`; an explicit `content` wins.
      // When all three are undefined the resolved patch is empty, which the
      // store reports as `empty-patch` (matching the pre-seam field check).
      const resolvedContent = content !== undefined ? content : reason;
      const result = store.editAnnotation(id, {
        ...(resolvedContent !== undefined ? { content: resolvedContent } : {}),
        ...(newText !== undefined ? { suggestedText: newText } : {}),
      });

      switch (result.kind) {
        case "not-found":
          return mcpError("NOT_FOUND", `Annotation ${id} not found`);
        case "invalid-note":
          // ADR-027: notes are user-private. Claude must not read or modify
          // them via MCP. The note→comment promotion path runs from the
          // browser, not through this tool.
          return mcpError(
            "INVALID_ARGUMENT",
            "Cannot edit a note via MCP — notes are user-private (ADR-027).",
          );
        case "not-pending":
          return mcpError(
            "ANNOTATION_RESOLVED",
            `Cannot edit a ${result.currentStatus} annotation`,
          );
        case "empty-patch":
          return mcpError(
            "INVALID_ARGUMENT",
            "No editable fields provided. Use content, newText, or reason.",
          );
        case "invalid-suggestion-target":
          return mcpError(
            "INVALID_ARGUMENT",
            `Cannot set replacement text on a ${result.annotationType} annotation. Only comments support suggestedText.`,
          );
        case "ok":
          return mcpSuccess({
            id,
            content: result.annotation.content,
            suggestedText: result.annotation.suggestedText,
            editedAt: result.annotation.editedAt,
          });
      }
    }),
  );

  server.tool(
    "tandem_exportAnnotations",
    "Export all annotations as a review summary (markdown or json). writeToDisk:true also writes a sharable sidecar file (e.g. `<doc>.annotations.json`) next to the document.",
    {
      format: ExportFormatSchema.optional().describe("Output format (default: markdown)"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
      writeToDisk: z
        .boolean()
        .optional()
        .describe(
          "Write the export to a sharable sidecar file next to the document (default <docPath>.annotations.{json|md}). Overwrites any existing sidecar.",
        ),
      outputPath: z
        .string()
        .optional()
        .refine((p) => p === undefined || path.isAbsolute(p), {
          message:
            "outputPath must be an absolute path (a relative path would silently resolve to the server's CWD).",
        })
        .refine((p) => p === undefined || rejectUnsafeWindowsPrefix(p) === null, {
          message: "outputPath must not use UNC or extended-length / device-namespace prefixes.",
        })
        .describe(
          "Custom absolute sidecar path (used with writeToDisk). A file path, or an existing directory to which the default filename is appended.",
        ),
    },
    withErrorBoundary(
      "tandem_exportAnnotations",
      async ({ format, documentId, writeToDisk, outputPath }) => {
        const store = getDocumentStore(documentId);
        if (!store) return noDocumentError();

        const annotations = store.listAnnotationsRefreshed();
        // Notes are user-private (ADR-027) — exclude from exports.
        const exportable = annotations.filter((a) => a.type !== "note");
        const { ydoc, filePath } = store;

        // Build the enriched JSON list up-front. It is derived from the already
        // note-filtered `exportable` and is the ONLY annotation collection
        // serialized to disk, so user-private notes (ADR-027) can never leak
        // into the sidecar.
        const fullText = extractText(ydoc);
        const enriched = exportable.map((ann) => ({
          ...ann,
          // ADR-027 + #1000: comment-only + `private`-stripped (see
          // tandem_getAnnotations / channelVisibleReplies).
          replies: channelVisibleReplies(ann, (id) => store.listReplies(id)),
          textSnippet: fullText.slice(
            Math.max(0, ann.range.from),
            Math.min(fullText.length, ann.range.to),
          ),
        }));

        const isJson = format === "json";
        // The markdown summary is computed once and reused for both the
        // response and (when requested) the sidecar — no double work.
        const markdown = isJson ? undefined : exportAnnotations(ydoc, exportable);

        // Sidecar write (#314): persist a sharable export next to the document.
        let writtenPath: string | undefined;
        if (writeToDisk) {
          // `upload://` (and scratchpad `upload://scratchpad/...`) paths are
          // synthetic — there is no stable filesystem location to write next to.
          if (filePath.startsWith("upload://")) {
            return mcpError(
              "INVALID_PATH",
              "Cannot write an annotation sidecar for an uploaded or scratchpad document — it has no file on disk. Save the document to a real path first.",
            );
          }

          // Overwrite-on-collision is intentional: the sidecar mirrors the
          // current annotation state, so a stale copy should be replaced.
          // Cross-platform reject of UNC + `\\?\` extended-length prefixes
          // (NTLM hardening; bare `\\` reject alone is bypassed by
          // `\\?\UNC\…` since `path.resolve` doesn't normalise it back to
          // `\\…`). See `windows-path-safety.ts`.
          const raw = outputPath ?? `${filePath}.annotations.${isJson ? "json" : "md"}`;
          const rejectReason = rejectUnsafeWindowsPrefix(raw);
          if (rejectReason) return mcpError("INVALID_PATH", rejectReason);
          let sidecarPath = path.resolve(raw);
          const resolvedReason = rejectUnsafeWindowsPrefix(sidecarPath);
          if (resolvedReason) return mcpError("INVALID_PATH", resolvedReason);
          // If outputPath points at an existing directory, append the default
          // sidecar filename — otherwise atomicWrite would surface a confusing
          // EISDIR. Stat is best-effort: ENOENT (no such path yet) is the
          // expected fresh-write case; surface any other unexpected error.
          //
          // Use `fs.realpath` (not `fs.stat`) so a legitimately symlinked
          // export directory (e.g. ~/Documents/exports → /mnt/backup) resolves
          // through; the realpath result is then stat'd and re-prefix-checked
          // so a symlink swap pointing into a UNC/extended-length location
          // can't slip past the earlier rejection.
          if (outputPath) {
            try {
              const real = await fs.realpath(sidecarPath);
              const realReason = rejectUnsafeWindowsPrefix(real);
              if (realReason) return mcpError("INVALID_PATH", realReason);
              const stat = await fs.stat(real);
              if (stat.isDirectory()) {
                const base = path.basename(filePath);
                sidecarPath = path.join(real, `${base}.annotations.${isJson ? "json" : "md"}`);
              } else {
                // Realpath resolved to a file (or other non-dir). Use the
                // resolved path so atomicWrite's rename lands deterministically.
                sidecarPath = real;
              }
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                return mcpError(
                  "INVALID_PATH",
                  `Could not resolve outputPath: ${(err as Error).message}`,
                );
              }
              // ENOENT — fresh write to a path that doesn't exist yet. Keep
              // the already-resolved `sidecarPath` as-is.
            }
          }
          const contents = isJson
            ? JSON.stringify({ annotations: enriched, count: enriched.length }, null, 2)
            : (markdown ?? "");
          await atomicWrite(sidecarPath, contents);
          writtenPath = sidecarPath;
        }

        if (isJson) {
          return mcpSuccess({
            annotations: enriched,
            count: enriched.length,
            ...(writtenPath ? { writtenPath } : {}),
          });
        }

        return mcpSuccess({
          markdown,
          count: exportable.length,
          ...(writtenPath ? { writtenPath } : {}),
        });
      },
    ),
  );

  server.tool(
    "tandem_annotationReply",
    "Reply to an annotation thread. Only works on pending annotations.",
    {
      annotationId: z.string().describe("The annotation ID to reply to"),
      text: z.string().describe("Reply text"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    gatedTool("tandem_annotationReply", async ({ annotationId, text, documentId }) => {
      const store = getDocumentStore(documentId);
      if (!store) return noDocumentError();

      // #651 presence: surface the typing indicator on the specific card being
      // replied to. ADR-027: `addReplyToAnnotation` already rejects non-comment
      // parents (notes return INVALID_ARGUMENT), but we belt-and-suspenders the
      // broadcast via `sanitizeAnnotationIdForPresence` — if the lookup says
      // note (or absent), the annotationId is dropped and the indicator falls
      // back to the generic status-bar one.
      const safeId = sanitizeAnnotationIdForPresence(
        getCurrentDoc(documentId)?.docName,
        annotationId,
        Y_MAP_ANNOTATIONS,
      );
      return withTypingPresence(
        {
          tool: "tandem_annotationReply",
          documentId,
          ...(safeId ? { annotationId: safeId } : {}),
        },
        async () => {
          const result = store.addReply(annotationId, text, "claude");
          if (!result.ok) {
            const code =
              result.code === "NOT_FOUND"
                ? "NOT_FOUND"
                : result.code === "ANNOTATION_RESOLVED"
                  ? "ANNOTATION_RESOLVED"
                  : result.code === "INVALID_ARGUMENT"
                    ? "INVALID_ARGUMENT"
                    : "INVALID_RANGE";
            return mcpError(code, result.error);
          }
          return mcpSuccess({ replyId: result.replyId, annotationId });
        },
      );
    }),
  );
}
