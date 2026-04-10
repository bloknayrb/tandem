import { z } from "zod";
import type { DocumentRange, RelativeRange } from "./positions/types.js";

// Canonical definitions live in the positions module; re-exported for backward compatibility.
export type {
  DocumentRange,
  FlatOffset,
  PmPos,
  RelativeRange,
  SerializedRelPos,
} from "./positions/types.js";
export { toFlatOffset, toPmPos, toSerializedRelPos } from "./positions/types.js";

// --- Zod schemas (source of truth) ---

export const AnnotationTypeSchema = z.enum([
  "highlight",
  "comment",
  "suggestion",
  "overlay",
  "question",
  "flag",
]);
export const AnnotationStatusSchema = z.enum(["pending", "accepted", "dismissed"]);
export const HighlightColorSchema = z.enum(["yellow", "red", "green", "blue", "purple"]);
export const SeveritySchema = z.enum(["info", "warning", "error", "success"]);
export const TandemModeSchema = z.enum(["solo", "tandem"]);
export const AuthorSchema = z.enum(["user", "claude", "import"]);
export const AnnotationActionSchema = z.enum(["accept", "dismiss"]);
export const ExportFormatSchema = z.enum(["markdown", "json"]);
export const DocumentFormatSchema = z.enum(["md", "txt", "html", "docx"]);
export const ToolErrorCodeSchema = z.enum([
  "RANGE_GONE",
  "RANGE_MOVED",
  "FILE_LOCKED",
  "FILE_NOT_FOUND",
  "NO_DOCUMENT",
  "INVALID_RANGE",
  "FORMAT_ERROR",
  "PERMISSION_DENIED",
]);

// --- Derived TypeScript types ---

export type AnnotationType = z.infer<typeof AnnotationTypeSchema>;
export type AnnotationStatus = z.infer<typeof AnnotationStatusSchema>;
export type TandemMode = z.infer<typeof TandemModeSchema>;
export type WidthMode = "reading" | "full";
export type HighlightColor = z.infer<typeof HighlightColorSchema>;
export type Severity = z.infer<typeof SeveritySchema>;

// --- Interfaces (not worth converting to Zod — no runtime validation needed) ---

export interface Annotation {
  id: string;
  author: "user" | "claude" | "import";
  type: AnnotationType;
  range: DocumentRange;
  /** CRDT-anchored range that survives edits. Falls back to `range` if absent. */
  relRange?: RelativeRange;
  content: string;
  status: AnnotationStatus;
  timestamp: number;
  color?: HighlightColor;
  /** Snapshot of the annotated document text at creation time. Truncated to 200 chars. */
  textSnapshot?: string;
  /** Timestamp of last edit to the annotation content. */
  editedAt?: number;
}

export interface AnchoredRange {
  start: { nodeId: string; offset: number };
  end: { nodeId: string; offset: number };
  textSnapshot: string;
  stale: boolean;
}

export interface OverlayEntry {
  id: string;
  overlayId: string;
  range: AnchoredRange;
  score: string;
  numericScore?: number;
  detail: {
    summary: string;
    explanation: string;
    suggestion?: string;
    severity?: Severity;
    references?: Array<{ label: string; url?: string; documentNodeId?: string }>;
  };
  dismissed: boolean;
  accepted?: boolean;
  data: Record<string, unknown>;
}

export interface OverlayDefinition {
  id: string;
  label: string;
  type: string;
  visible: boolean;
  mode: "snapshot" | "live";
  entries: OverlayEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface DocumentGroup {
  id: string;
  name: string;
  documents: DocumentInfo[];
  createdAt: number;
}

export interface DocumentInfo {
  id: string;
  filePath: string;
  fileName: string;
  format: z.infer<typeof DocumentFormatSchema>;
  tokenEstimate: number;
  pageEstimate: number;
  readOnly: boolean;
}

export interface ServerInfo {
  port: number;
  url: string;
  pid: number;
  startedAt: number;
}

export interface ToolSuccess<T = unknown> {
  error: false;
  data: T;
  version?: string;
}

export interface ToolError {
  error: true;
  code: z.infer<typeof ToolErrorCodeSchema>;
  message: string;
  details?: Record<string, unknown>;
}

export type ToolResponse<T = unknown> = ToolSuccess<T> | ToolError;

export interface AwarenessState {
  user: string;
  color: string;
  cursor?: { from: number; to: number };
  status?: string;
  isTyping?: boolean;
  lastActivity?: number;
}

/** Claude's awareness state as stored in Y.Map('awareness') key 'claude' */
export interface ClaudeAwareness {
  status: string;
  timestamp: number;
  active: boolean;
  focusParagraph: number | null;
}

export interface SessionData {
  filePath: string;
  format: string;
  ydocState: string; // Base64-encoded Y.encodeStateAsUpdate()
  sourceFileMtime: number; // Source file mtime at save — detect external changes on resume
  lastAccessed: number;
}

/** Text selection snapshot captured when opening chat, attached to the next outgoing ChatMessage as its anchor. */
export interface CapturedAnchor extends DocumentRange {
  textSnapshot: string;
}

/** Chat message between user and Claude, stored in Y.Map('chat') on CTRL_ROOM */
export interface ChatMessage {
  id: string;
  author: "user" | "claude";
  text: string;
  timestamp: number;
  documentId?: string;
  anchor?: CapturedAnchor;
  replyTo?: string;
  read: boolean;
}

/** Server-to-client ephemeral notification (toast). Not persisted via CRDT. */
export interface TandemNotification {
  id: string;
  type:
    | "annotation-error"
    | "save-error"
    | "session-restored"
    | "general-error"
    | "file-reloaded"
    | "review-pending";
  severity: "info" | "warning" | "error";
  message: string;
  documentId?: string;
  dedupKey?: string;
  timestamp: number;
  toolName?: string;
  errorCode?: string;
}
