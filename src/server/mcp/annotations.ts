import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Y from "yjs";
import { z } from "zod";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import type { RangeValidation } from "../../shared/positions/index.js";
import type { SanitizationEvent } from "../../shared/sanitize.js";
import { sanitizeAnnotation } from "../../shared/sanitize.js";
import { SNAPSHOT_CAP } from "../../shared/snapshot.js";
import type { Annotation, AnnotationReply } from "../../shared/types.js";
import {
  AnnotationActionSchema,
  AnnotationStatusSchema,
  AuthorSchema,
  ExportFormatSchema,
  HighlightColorSchema,
  toFlatOffset,
} from "../../shared/types.js";
import { generateNotificationId } from "../../shared/utils.js";
import { rejectUnsafeWindowsPrefix } from "../../shared/windows-path-safety.js";
import { describeReplyWriteRefusal } from "../annotations/lifecycle.js";
import { relaySanitizationEvent } from "../annotations/migration-log.js";
import { exportAnnotations } from "../file-io/docx.js";
import { atomicWrite } from "../file-io/index.js";
import { hideFromAI, readModeState } from "../mode.js";
import { pushNotification } from "../notifications.js";
import { anchoredRange } from "../positions.js";
import { extractText, getCurrentDoc } from "./document.js";
import type { FlatBreak } from "./document-model.js";
import { extractTextWithBreaks } from "./document-model.js";
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

/**
 * Capture a text snapshot from the document at the given range, capped at
 * {@link SNAPSHOT_CAP} chars.
 *
 * Reports `truncated` out of band rather than marking the cut with a trailing
 * `"..."` (#1486). Undo restores this string verbatim into the document, so a
 * snapshot cut short deletes everything past the cap — and the old ellipsis was
 * written INTO the user's document as three literal characters when it did. An
 * in-band marker is also ambiguous by construction: prose that legitimately
 * ends in an ellipsis is indistinguishable from a cut, so the reader had to
 * choose between refusing honest undos and missing dishonest ones. A separate
 * boolean has neither problem. `isSnapshotTruncated` still sniffs for the old
 * marker, but only on records that carry no flag — see `shared/snapshot.ts` for
 * why that residual ambiguity is acceptable there and not here.
 *
 * The cap itself stays. It bounds annotation record size against pathological
 * ranges (#1000 security review R2); the fix is for the consumers that need the
 * text lossless to know when it isn't.
 *
 * `breaks` is the other half of the same problem. The flat string spells a
 * block boundary, a hard break and a literal newline all as `"\n"`, so undo
 * cannot tell which to put back — and each one serializes differently, so
 * guessing writes a change the user never made. Only the non-literal ones are
 * listed, rebased to snapshot-relative offsets; an empty list is the common
 * case and is dropped by the caller rather than stored.
 */
export function captureSnapshot(
  ydoc: Y.Doc,
  from: number,
  to: number,
): { text: string; truncated: boolean; breaks: FlatBreak[] } {
  const { text: fullText, breaks: allBreaks } = extractTextWithBreaks(ydoc);
  const text = fullText.slice(from, to);
  const capped = text.length > SNAPSHOT_CAP;
  const kept = capped ? text.slice(0, SNAPSHOT_CAP) : text;
  // `at < from + kept.length`, not `<= to`: a break AT the range's end is the
  // separator to whatever comes NEXT and is not part of this range. Bounding on
  // the kept text also drops anything past the cap in one step.
  const breaks = allBreaks
    .filter((b) => b.at >= from && b.at < from + kept.length)
    .map((b) => ({ at: b.at - from, kind: b.kind }));
  return { text: kept, truncated: capped, breaks };
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
          // ADR-035: creates go through the lifecycle seam, not the store.
          // `create` has no `type` parameter — it mints a comment, which is
          // the only thing Claude may author.
          const { annotation } = store.lifecycle.create({
            anchored: result,
            content: text,
            extras: {
              textSnapshot: snap.text,
              ...(snap.truncated ? { textSnapshotTruncated: true } : {}),
              // Dropped when empty rather than stored as `[]`: the single-block
              // annotation is the overwhelming majority, and an empty array on
              // every record is bytes on disk that say nothing.
              ...(snap.breaks.length > 0 ? { textSnapshotBreaks: snap.breaks } : {}),
              ...(suggestedText !== undefined ? { suggestedText } : {}),
            },
          });
          return mcpSuccess({ annotationId: annotation.id });
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
        case "invalid-note":
          // Same envelope `tandem_editAnnotation` returns for a note, so the two
          // write paths now answer identically rather than disagreeing.
          return mcpError(
            "INVALID_ARGUMENT",
            `Annotation ${id} is a private note and cannot be resolved by Claude`,
          );
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
      // ADR-035 Unit 8e: the store delegates to `AnnotationLifecycle.remove`,
      // and this handler is the thin adapter translating arms to envelopes.
      // Arm-by-arm rather than a flattened `NOT_FOUND` — collapsing them made
      // the error code and the error text disagree, and the `INVALID_ARGUMENT`
      // envelope is what `tandem_editAnnotation` and `tandem_resolveAnnotation`
      // already return for a note.
      const result = store.removeAnnotation(id);
      switch (result.kind) {
        case "ok":
          return mcpSuccess({ removed: true, id });
        case "not-found":
          return mcpError("NOT_FOUND", `Annotation ${id} not found`);
        case "invalid-note":
          return mcpError(
            "INVALID_ARGUMENT",
            `Annotation ${id} is a private note and cannot be removed by Claude`,
          );
        default: {
          // A new `RemoveResult` arm errors HERE, naming it. Without this the
          // switch falls off the end and the only complaint is `gatedTool`
          // rejecting the inferred `Promise<… | undefined>` — a message that
          // never mentions the arm or this switch, and whose obvious fix is a
          // generic `default` that swallows it.
          const unhandled: never = result;
          return mcpError("INTERNAL", `unhandled remove outcome: ${JSON.stringify(unhandled)}`);
        }
      }
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
          "Custom absolute sidecar path (used with writeToDisk). A file path whose name must end in `.annotations.md` or `.annotations.json` (matching `format`), or an existing directory to which the default filename is appended. The directory is unrestricted; only the filename is.",
        ),
    },
    withErrorBoundary(
      "tandem_exportAnnotations",
      async ({ format, documentId, writeToDisk, outputPath }) => {
        const store = getDocumentStore(documentId);
        if (!store) return noDocumentError();

        const annotations = store.listAnnotationsRefreshed();
        // Notes are user-private (ADR-027) — exclude from exports.
        const notesFiltered = annotations.filter((a) => a.type !== "note");

        // WS-A2: the Solo hold applies here too. This was previously exempt, on a
        // documented rationale ("an export is an explicit give-Claude-everything
        // action") that is false by construction: there is no user-invocable path
        // to this tool — no route, no button, no palette entry, no CLI subcommand.
        // It is registered only as an MCP tool, so the only actor who can perform
        // that "explicit user action" is Claude, unilaterally, with no signal to
        // the user. Meanwhile the editor was showing an amber Held pill asserting
        // those very items were being withheld.
        const modeState = readModeState();
        const exportable = notesFiltered.filter((a) => !hideFromAI(a, modeState));
        // Disclosed below. Filtering silently would trade a privacy bug for an
        // honesty bug — see `heldFromExport` in the return payloads.
        const heldFromExport = notesFiltered.length - exportable.length;
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
          //
          // The second filter is NOT redundant: `channelVisibleReplies` carries
          // only the ADR-027 gates and has no Solo dimension, so a user reply on
          // a CLAUDE-authored comment survives the annotation-level filter above
          // (its parent isn't user-authored) and would leak. tandem_getAnnotations
          // chains both for the same reason.
          replies: channelVisibleReplies(ann, (id) => store.listReplies(id)).filter(
            (r) => !hideFromAI(r, modeState),
          ),
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
              // ENOENT — the leaf does not exist yet, which is the first
              // export to any given outputPath. Keeping `sidecarPath` as-is
              // skipped the post-realpath prefix re-check above on exactly
              // that path, so a symlinked parent was never followed. Same
              // defect as `convert.ts`, one file away; the shapes differ only
              // in that this surface returns mcpError rather than throwing.
              const parent = path.dirname(sidecarPath);
              try {
                const realParent = await fs.realpath(parent);
                const parentReason = rejectUnsafeWindowsPrefix(realParent);
                if (parentReason) return mcpError("INVALID_PATH", parentReason);
                sidecarPath = path.join(realParent, path.basename(sidecarPath));
              } catch (parentErr) {
                // FILE_NOT_FOUND, matching `convert.ts` for the identical
                // condition. INVALID_PATH tells an AI caller the path is
                // MALFORMED, so it reformats the path instead of creating the
                // directory — the one action that would work. And the message
                // is written rather than interpolated from the errno: a raw
                // Node error string is exactly what the response scrubber
                // exists to keep out of responses.
                if ((parentErr as NodeJS.ErrnoException).code !== "ENOENT") {
                  return mcpError(
                    "INVALID_PATH",
                    `Could not resolve the directory for outputPath: ${path.dirname(sidecarPath)}`,
                  );
                }
                return mcpError(
                  "FILE_NOT_FOUND",
                  `Output directory does not exist: ${path.dirname(sidecarPath)}`,
                );
              }
            }
          }
          // #1654 suffix pin. The sidecar this tool produces is named
          // `<doc>.annotations.{md,json}`, so requiring that suffix is an
          // allowlist BY CONSTRUCTION rather than a denylist of dangerous
          // names: `CLAUDE.md`, `AGENTS.md`, `.cursorrules`,
          // `.github/copilot-instructions.md` and `settings.json` are all
          // refused without being enumerated, while an arbitrary destination
          // DIRECTORY stays legal -- which is the documented point of
          // `outputPath` and what a directory confinement would have deleted.
          // (A denylist was rejected because the attack composes what survives
          // it; a bare extension pin was rejected because `.md` is the
          // extension the vector requires.)
          //
          // THREE THINGS THIS CHECK DEPENDS ON. Change any of them and it stops
          // being sound:
          //
          // 1. It runs on the POST-realpath `sidecarPath`, not on the caller's
          //    string. `:866` above assigns `sidecarPath = real` when realpath
          //    hits an existing leaf, so a conforming name that is a SYMLINK to
          //    `CLAUDE.md` would otherwise launder itself past a check placed
          //    even one line earlier.
          // 2. `atomicWrite` is temp-file + `rename` (`file-io/index.ts`).
          //    `rename` REPLACES a symlink at the destination rather than
          //    writing through it, which is the only reason a check on the
          //    NAME implies anything about the INODE written. A "simplification"
          //    to a direct `fs.writeFile` makes this pin decorative.
          // 3. It is `endsWith`, never an anchored full-basename pattern. The
          //    default is `${filePath}.annotations.${ext}`, so an ordinary
          //    document like `My Report (final).md` yields
          //    `My Report (final).md.annotations.json`.
          //
          // The default and directory-append forms both satisfy it by
          // construction; only a caller-named file path can fail. The check is
          // deliberately NOT in the Zod schema: `outputPath` may legitimately be
          // an existing DIRECTORY (appended to at `:860-862`), and a
          // schema-level pin would also annex the UNC specs that currently
          // prove the schema refines fire.
          const sidecarName = path.basename(sidecarPath);
          const requiredSuffix = `.annotations.${isJson ? "json" : "md"}`;
          if (!sidecarName.toLowerCase().endsWith(requiredSuffix)) {
            return mcpError(
              "INVALID_PATH",
              `outputPath must name a file ending in ${requiredSuffix} (rename the file; the directory is unrestricted).`,
            );
          }
          // An NTFS alternate data stream (`CLAUDE.md:x.annotations.md`)
          // satisfies the suffix while naming a stream on a different file.
          // `validate_open_candidate` screens ADS on the file-open path; this
          // keeps the write path from being the one surface that does not.
          if (sidecarName.includes(":")) {
            return mcpError(
              "INVALID_PATH",
              "outputPath must not contain a colon in the filename (NTFS alternate data stream).",
            );
          }
          const contents = isJson
            ? JSON.stringify(
                {
                  annotations: enriched,
                  count: enriched.length,
                  ...(heldFromExport > 0 ? { heldFromExport } : {}),
                },
                null,
                2,
              )
            : (markdown ?? "");
          await atomicWrite(sidecarPath, contents);
          writtenPath = sidecarPath;
        }

        // Disclose what the Solo hold withheld. Without this the export ASSERTS a
        // completeness it does not have — on a document whose annotations are all
        // user comments, `exportable` is empty and the markdown arm returns
        // "No annotations found", which is a false statement rather than a partial
        // one. Mirrors the `notesExcluded` precedent on tandem_getAnnotations.
        //
        // The count is not itself a WS-A2 leak: checkInbox already reports
        // `mode: "solo"`, so the existence of a hold is known. This adds
        // cardinality, not content — and it is what makes the artifact honest.
        const heldDisclosure = heldFromExport > 0 ? { heldFromExport } : {};

        if (isJson) {
          return mcpSuccess({
            annotations: enriched,
            count: enriched.length,
            ...heldDisclosure,
            ...(writtenPath ? { writtenPath } : {}),
          });
        }

        return mcpSuccess({
          markdown,
          count: exportable.length,
          ...heldDisclosure,
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
      // replied to. ADR-027: the seam already rejects a note parent for Claude
      // (`lifecycle.reply` returns `invalid-note`), but we belt-and-suspenders the
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
          const result = store.addReply(annotationId, text);
          if (result.kind === "ok") {
            return mcpSuccess({ replyId: result.replyId, annotationId });
          }
          // The wire codes are unchanged from the ternary chain this replaces;
          // what moved is that a new arm now fails to compile inside
          // `describeReplyWriteRefusal` instead of falling into a catch-all.
          const { code, message } = describeReplyWriteRefusal(result);
          return mcpError(code, message);
        },
      );
    }),
  );
}
