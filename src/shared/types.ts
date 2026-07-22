import { z } from "zod";
import { type ModelProvider, VALID_MODEL_PROVIDERS } from "./models/contract.js";
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

export const AnnotationTypeSchema = z.enum(["highlight", "note", "comment"]);

export const AnnotationStatusSchema = z.enum(["pending", "accepted", "dismissed"]);
export const HighlightColorSchema = z.enum(["yellow", "green", "blue", "pink"]);
export const SeveritySchema = z.enum(["info", "warning", "error", "success"]);
export const TandemModeSchema = z.enum(["solo", "tandem"]);
export const AuthorSchema = z.enum(["user", "claude", "import"]);
/** Reply authors. `import` carries Word-comment reply threads (#1000); such replies are user-private. */
export const ReplyAuthorSchema = z.enum(["user", "claude", "import"]);
/**
 * Provider enum as a Zod schema, sourced from the models contract's
 * `VALID_MODEL_PROVIDERS` so the two can't drift (#1123 M3). `z.enum` needs a
 * non-empty tuple; the contract array is non-empty by construction.
 */
export const ModelProviderSchema = z.enum(
  VALID_MODEL_PROVIDERS as unknown as [ModelProvider, ...ModelProvider[]],
);
/**
 * Max length of an agent `displayName` as persisted on a durable record. The
 * Models registry's own `displayName` is more permissive (client caps at 256,
 * the server `ModelsEntrySchema` is unbounded), so the resolver that builds an
 * `agentIdentity` snapshot MUST clamp to this bound — otherwise an over-long
 * registry name fails this schema on the durable round-trip and takes the whole
 * annotations file down with it (`parseAnnotationDoc` → corrupt). Shared here so
 * the clamp site and the schema can't drift (mirrors why `ModelProviderSchema`
 * is shared). See `resolveLocalModelConfig`.
 */
export const AGENT_DISPLAY_NAME_MAX = 120;
/**
 * Runtime schema for {@link AgentIdentity}. Bounded `displayName` (the value is
 * user-chosen in the Models registry); `provider` is the closed enum. Used by
 * the durable annotation/reply record schemas so a persisted identity
 * round-trips through validation rather than surviving only on `.passthrough()`.
 */
export const AgentIdentitySchema = z.object({
  provider: ModelProviderSchema,
  displayName: z.string().max(AGENT_DISPLAY_NAME_MAX),
});
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
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "ANNOTATION_RESOLVED",
  "FORMAT_ERROR",
  "PERMISSION_DENIED",
]);

/**
 * Identifier strings the channel shim or monitor can POST to
 * `/api/channel-error` on terminal failure. The server logs them; defining
 * them as a closed set lets call sites import the constants instead of
 * free-form strings, and the route handler can validate before logging.
 */
export const ChannelErrorCodeSchema = z.enum(["CHANNEL_CONNECT_FAILED", "MONITOR_CONNECT_FAILED"]);
export type ChannelErrorCode = z.infer<typeof ChannelErrorCodeSchema>;
export const CHANNEL_CONNECT_FAILED: ChannelErrorCode = "CHANNEL_CONNECT_FAILED";
export const MONITOR_CONNECT_FAILED: ChannelErrorCode = "MONITOR_CONNECT_FAILED";

// --- Derived TypeScript types ---

export type AnnotationType = z.infer<typeof AnnotationTypeSchema>;
export type AnnotationStatus = z.infer<typeof AnnotationStatusSchema>;
export type TandemMode = z.infer<typeof TandemModeSchema>;
export type HighlightColor = z.infer<typeof HighlightColorSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type ReplyAuthor = z.infer<typeof ReplyAuthorSchema>;

/**
 * Identity of the specific AI agent that authored a record (#1123 M3, ADR-039).
 *
 * Present ONLY on agent-authored records the local-model collaborator loop
 * writes (`author: "claude"` annotations/replies/chat messages); absent for
 * real Claude-via-MCP writes and everything that predates M3. A self-contained
 * snapshot — NOT a reference into the mutable Models registry — so it survives a
 * registry edit/delete and freezes who authored at the time. Carries NO secret:
 * the closed `provider` enum plus the user-chosen `displayName` only, never an
 * endpoint or key ref. See {@link AgentIdentitySchema} for the runtime shape.
 */
export interface AgentIdentity {
  provider: ModelProvider;
  displayName: string;
}

// --- Reply types ---

export interface AnnotationReply {
  id: string;
  annotationId: string;
  author: ReplyAuthor;
  text: string;
  timestamp: number;
  editedAt?: number;
  /**
   * ADR-027/#1000: when true, this reply is user-private and must NEVER reach
   * Claude — not via the channel, `tandem_getAnnotations`, or
   * `tandem_exportAnnotations`. Set at creation for replies authored on a note
   * and for imported Word replies. Privacy is a durable property of the reply,
   * not of the parent's current type, so a later note→comment promotion cannot
   * back-publish it. Claude-facing reads strip it via `channelVisibleReplies`.
   */
  private?: boolean;
  /**
   * For `author: "import"` replies: the original Word reviewer name, shown as a
   * byline in the client. Mirrors `Annotation.importSource.author`. Stored at
   * rest in the durable JSON; never serialized to any Claude-facing surface.
   */
  importAuthor?: string;
  /**
   * Durable-annotation last-writer-wins counter. Server-internal field
   * mirrored from the on-disk envelope schema (see
   * `src/server/annotations/schema.ts` `AnnotationReplyRecordV1`). Optional
   * here so client code and legacy in-memory state that predates the durable
   * store don't trip TS. Every server-side write bumps this; legacy entries
   * lacking `rev` are treated as `rev: 0` on merge.
   */
  rev?: number;
  /**
   * WS-A2: when true, this reply was authored while in Solo mode and is pending
   * release to Claude. Server-stamped in `addReplyToAnnotation` (replies are
   * created via an HTTP POST, not a client Y.Map write). Like the annotation
   * marker, it drives the held-count badge + the fail-closed-restart tiebreaker,
   * NOT live hiding (that is server-authoritative, mode-based).
   */
  heldInSolo?: boolean;
  /**
   * The specific AI agent that authored this reply (#1123 M3). Set only by the
   * local-model collaborator loop; absent on user, import, and real-Claude
   * replies. Drives the byline; the parent's `author` still governs privacy.
   */
  agentIdentity?: AgentIdentity;
}

// --- Annotation types ---

interface AnnotationBase {
  id: string;
  /**
   * Author ROLE, not literal identity: `"claude"` marks any AI agent (real
   * Claude via MCP *or* the local-model collaborator loop), which is what every
   * privacy/gating branch keys on. The specific agent, when it's a local model,
   * is carried separately in {@link agentIdentity} (#1123 M3).
   */
  author: "user" | "claude" | "import";
  range: DocumentRange;
  /** CRDT-anchored range that survives edits. Falls back to `range` if absent. */
  relRange?: RelativeRange;
  content: string;
  status: AnnotationStatus;
  timestamp: number;
  /** Snapshot of the annotated document text at creation time. Truncated to 200 chars. */
  textSnapshot?: string;
  /** Timestamp of last edit to the annotation content. */
  editedAt?: number;
  /**
   * Durable-annotation last-writer-wins counter. Server-internal field
   * mirrored from the on-disk envelope schema (see
   * `src/server/annotations/schema.ts` `AnnotationRecordV1`). Optional here
   * so legacy session-restored state (pre-durable-store) and client code
   * that doesn't care about durability still type-check. Every server-side
   * user-intent write bumps this; entries lacking `rev` are treated as
   * `rev: 0` by the merge/sync code.
   */
  rev?: number;
  /** When true, marks this annotation as created during Solo mode. Consumers use this to hold back display until mode changes. */
  heldInSolo?: boolean;
  /** Audience: 'private' = personal (note/highlight), 'outbound' = visible to Claude. Derived by AR1 migration on read for legacy annotations. */
  audience?: "private" | "outbound";
  /** Set when this annotation was promoted from a note via "Send to Claude". */
  promotedFrom?: "note";
  /**
   * For import-author annotations: original Word author and source file.
   * `commentId` is the original Word `w:id` from `comments.xml` (#1068) —
   * reused on .docx export so a promoted Word comment keeps its identity
   * across save → re-open (deterministic `importAnnotationId` dedup).
   */
  importSource?: { author: string; file: string; commentId?: string };
  /**
   * The specific AI agent that authored this annotation (#1123 M3). Set only by
   * the local-model collaborator loop on its `author: "claude"` comments; absent
   * on user/import annotations and real Claude-via-MCP writes. Drives the card
   * byline. MUST be listed in `sanitizeAnnotation`'s allowlist or it is stripped
   * on every Claude-facing read (see `src/shared/sanitize.ts`).
   */
  agentIdentity?: AgentIdentity;
}

/**
 * Discriminated union for annotations. Three canonical types:
 * - `highlight` — visual marker with color, not sent to Claude
 * - `note` — personal text annotation, findable but Claude doesn't act
 * - `comment` — text for Claude; optionally carries `suggestedText` (replacement)
 */
export type Annotation =
  | (AnnotationBase & {
      type: "highlight";
      color?: HighlightColor;
      suggestedText?: undefined;
    })
  | (AnnotationBase & {
      type: "note";
      color?: undefined;
      suggestedText?: undefined;
    })
  | (AnnotationBase & {
      type: "comment";
      color?: undefined;
      suggestedText?: string;
    });

/**
 * Returns true for annotations that should be reviewed (accepted/dismissed).
 * User-authored notes are personal and never review targets.
 * Import-authored (.docx Word comments) ARE review targets — the primary docx use case.
 */
export function isReviewTarget(a: Annotation): boolean {
  return a.author !== "user";
}

/** Convenience: pending status AND a review target — used at bulk-action and keyboard-nav callsites. */
export function isPendingReviewTarget(a: Annotation): boolean {
  return a.status === "pending" && isReviewTarget(a);
}

/**
 * Authorship tracking range stored in Y.Map('authorship').
 * Uses the same flat-offset coordinate system as annotations.
 * RelativePositions anchor the range to survive concurrent edits.
 */
export interface AuthorshipRange {
  id: string;
  author: "user" | "claude";
  range: DocumentRange;
  /** CRDT-anchored range for edit survival. */
  relRange?: RelativeRange;
  /** Timestamp of when this range was created. */
  timestamp: number;
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

/** Claude's awareness state as stored in Y.Map('awareness') key 'claude' */
export interface ClaudeAwareness {
  status: string;
  timestamp: number;
  active: boolean;
  focusParagraph: number | null;
  /** Flat character offset for character-level cursor positioning. */
  focusOffset: number | null;
  /**
   * Typing-presence indicator (#651). When set, Claude is actively executing
   * an MCP tool. `annotationId` (when present) lets per-card UI render an
   * inline typing indicator; an absent annotationId indicates a generic
   * "Claude is working" state surfaced in the status bar.
   *
   * ADR-027: never broadcast `annotationId` for `type === "note"` annotations
   * (the server middleware enforces this on write).
   */
  working?: {
    tool: string;
    annotationId?: string;
    /** Display-only wall-clock start time (ms). NOT an ownership key — see `token`. */
    startedAt: number;
    /**
     * Monotonic, collision-free ownership token (#823). Two same-doc tool calls
     * in the same millisecond would collide on `startedAt`; the clear path keys
     * identity on this counter instead so finishing one handler never wipes
     * another's still-active marker. Optional for back-compat with snapshots
     * written before #823.
     */
    token?: number;
  } | null;
}

export interface SessionData {
  filePath: string;
  format: string;
  ydocState: string; // Base64-encoded Y.encodeStateAsUpdate()
  sourceFileMtime: number; // Source file mtime at save — detect external changes on resume
  lastAccessed: number;
  /**
   * True when the Y.Doc held unsaved (not-written-to-disk) body edits at
   * session-save time (#1069). Drives the `.docx` restore-vs-reload prompt:
   * a dirty `.docx` session is the ONLY copy of those edits (binary formats
   * never auto-save to disk), so restore keeps it even when the source file
   * changed, and the user is prompted to keep or reload. Absent/false on
   * sessions written before this field existed — treated as clean.
   */
  dirty?: boolean;
}

/**
 * Per-document external-conflict state (#1069, `.docx` only). Stored in
 * Y_MAP_DOCUMENT_META under Y_MAP_EXTERNAL_CONFLICT while the document's
 * unsaved edits diverge from the on-disk source.
 */
export interface ExternalConflictState {
  /**
   * - "external-edit": the source file changed on disk while the open document
   *   holds unsaved edits (file-watcher detection). Explicit save is blocked by
   *   the external-modification guard until resolved.
   * - "unsaved-restore": a session carrying unsaved edits was restored on
   *   reopen/restart; the in-memory document diverges from the on-disk file.
   */
  kind: "external-edit" | "unsaved-restore";
  /** True when the on-disk mtime diverged from the session/save baseline. Always true for "external-edit". */
  diskChanged: boolean;
  detectedAt: number;
}

/**
 * Per-document docx fidelity report (#1145, `.docx` only) — the "honesty layer".
 * Tells the user what won't round-trip BEFORE they invest edits. Stored under
 * Y_MAP_DOCUMENT_META at Y_MAP_FIDELITY_REPORT; server write-only, client reads
 * it to render a calm, self-erasing notice (hidden while both lists are empty).
 */
export interface FidelityReport {
  /**
   * Word features mammoth dropped on import (footnotes, headers/footers,
   * tracked changes, custom styles — the round-trip ceiling). Set at open and
   * re-set on every re-import (force-reload, file-watcher reload).
   */
  importLosses: string[];
  /**
   * Content the export downgraded on the most recent save (unsupported blocks,
   * non-`data:` images). Refreshed each binary save; reset by a re-import.
   * These are ANNOUNCED, expected downgrades — rendered as a calm/info notice.
   */
  exportDowngrades: string[];
  /**
   * Post-write verification advisories (#1123 Phase 0e). Distinct from
   * `exportDowngrades`: these flag content the save may have lost UNEXPECTEDLY
   * (a comment or footnote body that didn't survive a verify reimport, a
   * gross-but-not-blocking text-retention shortfall) — a louder, warning-level
   * signal with a restore affordance, never folded into the "N features
   * simplified" count. CONTENT-FREE by construction: fixed strings + counts
   * only, never document text (the advisory is also Claude-visible via the
   * `tandem_save` MCP result). Optional for forward-compat: pre-0e reports lack
   * it, so every reader uses `?? []`. Refreshed each binary save; reset by a
   * re-import.
   */
  integrityWarnings?: string[];
  /** ms epoch of the last update. */
  updatedAt: number;
}

/**
 * A reconstructed Word footnote body (#1123 Tier-A #3 PR 2). Captured from
 * `word/footnotes.xml` on import, stored off-fragment under
 * Y_MAP_DOCUMENT_META at Y_MAP_FOOTNOTE_BODIES (keyed by the OOXML footnote id,
 * the same id mammoth puts in its `#footnote-N` href), and re-emitted as a real
 * `<w:footnote>` on export. Server write-only, opaque to the client and Claude.
 */
export interface FootnoteBody {
  /**
   * Plain body text. Rich body formatting (bold/italic, multi-paragraph) is
   * deliberately flattened to plain text in PR 2 and reported honestly via
   * `hadFormatting`; rich-body fidelity is a deferred fast-follow.
   */
  text: string;
  /**
   * Whether the source OOXML body carried formatting we drop on import
   * (`<w:b>`/`<w:i>`/`<w:u>`/`<w:hyperlink>` or >1 `<w:p>`). Drives a count-only
   * honesty line — NEVER thread the body text through the loss-line path (it
   * bypasses the mammoth-message redaction; see `footnoteLossLines`).
   */
  hadFormatting: boolean;
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
  /**
   * The specific AI agent that authored this message (#1123 M3). Set only by the
   * local-model collaborator's streamed reply; absent on user messages and real
   * Claude (`tandem_reply`). Chat is read raw from the Y.Map (NOT allowlist-
   * sanitized), so this needs no sanitize change to reach the byline.
   */
  agentIdentity?: AgentIdentity;
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
    | "review-pending"
    | "external-conflict"
    | "launcher";
  severity: "info" | "warning" | "error";
  message: string;
  documentId?: string;
  dedupKey?: string;
  timestamp: number;
  toolName?: string;
  errorCode?: string;
}
