/**
 * MCP `outputSchema` declarations for data-returning tools (#1080).
 *
 * These zod raw shapes describe the `data` payload that the tool also emits as
 * `structuredContent`, so typed non-Claude MCP clients can validate responses
 * end-to-end. The text content keeps the legacy `{ error: false, data }`
 * envelope — structured content is additive and carries the exact same object.
 *
 * INVARIANT (ADR-027): no schema here may declare a field that could carry
 * user-private note content. Notes are filtered out before serialization
 * (`tandem_getAnnotations` excludes `type: "note"`; `tandem_checkInbox`
 * buckets only surface user comments and Claude annotations), so the
 * annotation `type` enums below deliberately omit `"note"` — if a note ever
 * reached these payloads, schema validation would fail loudly (fail-closed)
 * instead of leaking. `directedAt` is likewise absent: it is deprecated and
 * stripped on read by `sanitizeAnnotation`.
 *
 * Keep these shapes in lockstep with the handler payloads — unit tests in
 * `tests/server/mcp-output-schemas.test.ts` validate emitted structuredContent
 * against strict versions of these schemas.
 */

import { z } from "zod";
import {
  AnnotationStatusSchema,
  AuthorSchema,
  HighlightColorSchema,
  TandemModeSchema,
} from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

/** Flat-offset range (includes heading prefixes and \n separators). */
const FlatRangeSchema = z.object({
  from: z.number().describe("Flat text offset (inclusive)"),
  to: z.number().describe("Flat text offset (exclusive)"),
});

/** CRDT-anchored range. The rel positions are opaque serialized Y.js values. */
const RelativeRangeSchema = z.object({
  fromRel: z.unknown().describe("Opaque serialized Y.js RelativePosition"),
  toRel: z.unknown().describe("Opaque serialized Y.js RelativePosition"),
});

/** Annotation types that may ever reach Claude-facing payloads (ADR-027: never "note"). */
const VisibleAnnotationTypeSchema = z
  .enum(["highlight", "comment"])
  .describe('User-private notes are never surfaced (ADR-027), so "note" cannot appear here.');

/** Sanitized annotation shape shared by tandem_getAnnotations and tandem_checkInbox. */
const annotationBaseShape = {
  id: z.string(),
  author: AuthorSchema,
  type: VisibleAnnotationTypeSchema,
  range: FlatRangeSchema,
  relRange: RelativeRangeSchema.optional(),
  content: z.string(),
  status: AnnotationStatusSchema,
  timestamp: z.number(),
  textSnapshot: z.string().optional().describe("Document text at creation time (≤200 chars)"),
  editedAt: z.number().optional(),
  rev: z.number().optional().describe("Durable-store last-writer-wins counter"),
  audience: z.enum(["private", "outbound"]),
  promotedFrom: z.literal("note").optional(),
  importSource: z
    .object({ author: z.string(), file: z.string() })
    .optional()
    .describe("Original Word author/file for imported .docx comments"),
  color: HighlightColorSchema.optional().describe("Highlight annotations only"),
  suggestedText: z.string().optional().describe("Replacement proposal (comment annotations only)"),
};

/**
 * Reply surfaced to Claude. `import`-authored and `private` replies are
 * stripped by `channelVisibleReplies` before serialization (ADR-027/#1000),
 * so the author enum here omits "import".
 */
const VisibleReplySchema = z.object({
  id: z.string(),
  annotationId: z.string(),
  author: z.enum(["user", "claude"]),
  text: z.string(),
  timestamp: z.number(),
  editedAt: z.number().optional(),
  rev: z.number().optional(),
});

// ---------------------------------------------------------------------------
// tandem_status
// ---------------------------------------------------------------------------

const openDocumentEntry = z.object({
  documentId: z.string(),
  filePath: z.string(),
  format: z.string(),
  readOnly: z.boolean(),
});

/** Read mode returns the editor summary fields; write mode echoes `status` (+ optional `warning`). */
export const statusOutputShape = {
  // Write mode (text param passed)
  status: z.string().optional().describe("Echo of the status text just set (write mode only)"),
  warning: z
    .string()
    .optional()
    .describe("Write mode: set when no document is open so the status was not broadcast"),
  // Read mode (no text param)
  running: z.boolean().optional().describe("Read mode: always true when the server responds"),
  mode: TandemModeSchema.optional().describe('Read mode: "solo" (hold annotations) or "tandem"'),
  storeReadOnly: z.boolean().optional(),
  activeDocument: openDocumentEntry.omit({ readOnly: true }).nullable().optional(),
  openDocuments: z.array(openDocumentEntry).optional(),
  documentCount: z.number().optional(),
};

// ---------------------------------------------------------------------------
// tandem_getTextContent
// ---------------------------------------------------------------------------

export const getTextContentOutputShape = {
  text: z.string().describe("Plain text with heading prefixes; offsets match annotation ranges"),
  filePath: z.string(),
  documentId: z.string().optional().describe("Present on full-document reads"),
  section: z.string().optional().describe("Present on section reads (echoes the section param)"),
};

// ---------------------------------------------------------------------------
// tandem_getAnnotations
// ---------------------------------------------------------------------------

const annotationWithRepliesSchema = z.object({
  ...annotationBaseShape,
  replies: z.array(VisibleReplySchema),
});

export const getAnnotationsOutputShape = {
  annotations: z.array(annotationWithRepliesSchema),
  count: z.number(),
  notesExcluded: z
    .number()
    .optional()
    .describe("How many user-private notes were filtered out (ADR-027); omitted when zero"),
};

// ---------------------------------------------------------------------------
// tandem_checkInbox
// ---------------------------------------------------------------------------

const userActionSchema = z.object({
  ...annotationBaseShape,
  author: z.literal("user"),
  type: z.literal("comment"),
  textSnippet: z.string().describe("Current document text at the annotation range (≤100 chars)"),
  edited: z.literal(true).optional().describe("Set when re-surfaced after a user edit"),
});

const userResponseSchema = z.object({
  ...annotationBaseShape,
  author: z.literal("claude"),
  status: z.enum(["accepted", "dismissed"]),
  textSnippet: z.string(),
});

const inboxChatMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  timestamp: z.number(),
  documentId: z.string().optional(),
  anchor: z
    .object({ from: z.number(), to: z.number(), textSnapshot: z.string() })
    .optional()
    .describe("Text selection the user attached to this message"),
  replyTo: z.string().optional(),
});

export const checkInboxOutputShape = {
  summary: z.string(),
  hasNew: z.boolean(),
  mode: TandemModeSchema,
  storeReadOnly: z.boolean(),
  userActions: z.array(userActionSchema).describe("New/edited user comments awaiting Claude"),
  userResponses: z
    .array(userResponseSchema)
    .describe("User accept/dismiss decisions on Claude's annotations"),
  chatMessages: z.array(inboxChatMessageSchema),
  activity: z.object({
    isTyping: z.boolean(),
    cursor: z.number().nullable(),
    lastEdit: z.number().nullable(),
    selectedText: z.string().nullable(),
  }),
};

// ---------------------------------------------------------------------------
// tandem_listDocuments
// ---------------------------------------------------------------------------

export const listDocumentsOutputShape = {
  documents: z.array(
    z.object({
      id: z.string(),
      filePath: z.string(),
      fileName: z.string(),
      format: z.string(),
      readOnly: z.boolean(),
      source: z.enum(["file", "upload"]),
      isActive: z.boolean(),
    }),
  ),
  activeDocumentId: z.string().nullable(),
  count: z.number(),
};

// ---------------------------------------------------------------------------
// tandem_search
// ---------------------------------------------------------------------------

export const searchOutputShape = {
  matches: z.array(z.object({ from: z.number(), to: z.number(), text: z.string() })),
  count: z.number(),
};
