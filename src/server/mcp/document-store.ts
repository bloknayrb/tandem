/**
 * DocumentStore — a testable seam over the in-memory Y.Doc / Y.Map layer used
 * by the MCP tool handlers (issue #315).
 *
 * Before this seam, every annotation/text tool reached straight into a raw
 * `Y.Doc` + `Y.Map` (via `getDocAndAnnotations`). That coupled the tool logic
 * to Yjs internals and made the handlers awkward to test without standing up a
 * full document service. `DocumentStore` names the operations the handlers
 * actually perform — read text, create/list/edit/resolve/remove annotations,
 * add/list replies, refresh CRDT ranges — so handlers depend on an interface
 * instead of `Y.Map.get`/`set`.
 *
 * `YDocStore` is the one implementation. It is intentionally a thin wrapper:
 * it delegates to the same standalone helpers the handlers used before
 * (`createAnnotation`, `collectAnnotations`, `addReplyToAnnotation`,
 * `removeAnnotationById`, `acceptPending`/`dismissPending`, `refreshAllRanges`).
 * That delegation is the parity contract: the underlying Y.Map structures and
 * origin tagging (`withMcp`, ADR-031) are byte-identical to the pre-refactor
 * behavior. The helpers stay exported because the HTTP routes and the existing
 * test suite (the parity floor) still call them directly.
 *
 * Scope note: this wraps the *in-memory* Y.Doc/Y.Map layer the MCP handlers
 * touch — NOT the durable annotation file-store (`src/server/annotations/`).
 * `FileOnlyStore` is intentionally out of scope; only the interface +
 * `YDocStore` ship here.
 */

import type * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { withMcp } from "../../shared/origins.js";
import type { AnchoredRangeResult } from "../../shared/positions/index.js";
import type { SanitizationEvent } from "../../shared/sanitize.js";
import { sanitizeAnnotation } from "../../shared/sanitize.js";
import type {
  Annotation,
  AnnotationReply,
  AnnotationType,
  ReplyAuthor,
} from "../../shared/types.js";
import { docHash } from "../annotations/doc-hash.js";
import { acceptPending, dismissPending, type LifecycleResult } from "../annotations/lifecycle.js";
import { relaySanitizationEvent } from "../annotations/migration-log.js";
import { nextRev } from "../annotations/schema.js";
import { refreshAllRanges, refreshRange } from "../positions.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import {
  addReplyToAnnotation,
  collectAnnotations,
  collectRepliesForAnnotation,
  createAnnotation,
  removeAnnotationById,
} from "./annotations.js";
import { extractText } from "./document-model.js";
import { getCurrentDoc } from "./document-service.js";

/**
 * Operations the MCP tool handlers perform against a single document's
 * in-memory Y.Doc / Y.Map state. Methods mirror the handler call sites:
 * the names and argument shapes are derived from what the handlers do, not
 * from the underlying Y.Map API.
 */
export interface DocumentStore {
  /** Underlying Y.Doc — escape hatch for range anchoring and text extraction. */
  readonly ydoc: Y.Doc;
  /** Absolute (or `upload://`) path of the backing document. */
  readonly filePath: string;
  /** Stable hash of `filePath`, used to key migration-log relays. */
  readonly docHash: string;

  // --- Text ---

  /**
   * Full document text in the annotation coordinate system (flat offsets,
   * heading prefixes included). Always `extractText`, never `extractMarkdown`
   * (Critical Rule #5).
   */
  getText(): string;

  // --- Annotations: write ---

  /**
   * Create a Claude-authored annotation from an already-anchored range and
   * store it in the annotations Y.Map. Returns the new annotation ID.
   */
  createAnnotation(
    type: AnnotationType,
    anchored: AnchoredRangeResult,
    content: string,
    extras?: Partial<Annotation>,
  ): string;

  /**
   * Edit the mutable fields of a pending annotation. Returns the updated
   * record, or a tagged failure (`not-found` / `invalid-note` /
   * `not-pending` / `empty-patch` / `invalid-suggestion-target`) so the
   * handler can map it to the right MCP error envelope. The failure-arm
   * order mirrors the pre-seam handler's sequential guards exactly.
   */
  editAnnotation(
    id: string,
    patch: { content?: string; suggestedText?: string },
  ): EditAnnotationResult;

  /** Accept a pending annotation (pending → accepted). */
  acceptAnnotation(id: string): LifecycleResult<Annotation>;
  /** Dismiss a pending annotation (pending → dismissed). */
  dismissAnnotation(id: string): LifecycleResult<Annotation>;

  /** Remove an annotation and its orphaned replies. */
  removeAnnotation(
    id: string,
  ): { ok: true; id: string } | { ok: false; code: string; error: string };

  // --- Annotations: read ---

  /** Get a single annotation by ID (sanitized), or undefined if absent. */
  getAnnotation(id: string): Annotation | undefined;

  /** Collect all annotations as a sanitized array (skips malformed rows). */
  listAnnotations(): Annotation[];

  /**
   * Collect annotations and refresh their CRDT-anchored ranges in one pass,
   * persisting any range updates back to the Y.Map. Returns the refreshed
   * annotations.
   */
  listAnnotationsRefreshed(): Annotation[];

  /**
   * Refresh a single annotation's CRDT-anchored range, persisting any update
   * back to the Y.Map, and return the refreshed annotation. Used by the inbox
   * surfacer, which refreshes a surfaced-gated subset rather than the whole
   * collection. The caller is responsible for the enclosing origin-tagged
   * transaction (see {@link DocumentStore.transactMcp}).
   */
  refreshAnnotation(ann: Annotation): Annotation;

  /** Run `fn` inside an MCP-origin Y.Doc transaction (ADR-031 `withMcp`). */
  transactMcp(fn: () => void): void;

  // --- Replies ---

  /**
   * Add a reply to a comment thread. Returns the reply ID or a tagged failure
   * mirroring `addReplyToAnnotation`.
   */
  addReply(
    annotationId: string,
    text: string,
    author: ReplyAuthor,
  ): { ok: true; replyId: string } | { ok: false; error: string; code?: string };

  /** Collect all replies for an annotation, sorted chronologically. */
  listReplies(annotationId: string): AnnotationReply[];
}

/** Tagged outcome of {@link DocumentStore.editAnnotation}. */
export type EditAnnotationResult =
  | { kind: "ok"; annotation: Annotation }
  | { kind: "not-found" }
  | { kind: "invalid-note" }
  | { kind: "not-pending"; currentStatus: Annotation["status"] }
  | { kind: "empty-patch" }
  | { kind: "invalid-suggestion-target"; annotationType: AnnotationType };

/**
 * The lone {@link DocumentStore} implementation. Wraps a document's Y.Doc and
 * its annotations Y.Map, delegating every mutation to the existing helpers so
 * the Y.Map structures and origin tagging are unchanged from the pre-seam
 * handlers.
 */
export class YDocStore implements DocumentStore {
  readonly ydoc: Y.Doc;
  readonly filePath: string;
  readonly docHash: string;
  /** Annotations Y.Map — kept private; the seam is the method surface. */
  private readonly map: Y.Map<unknown>;

  constructor(ydoc: Y.Doc, filePath: string) {
    this.ydoc = ydoc;
    this.filePath = filePath;
    this.docHash = docHash(filePath);
    this.map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  }

  private onLossy(event: SanitizationEvent): void {
    relaySanitizationEvent(this.docHash, event);
  }

  getText(): string {
    return extractText(this.ydoc);
  }

  createAnnotation(
    type: AnnotationType,
    anchored: AnchoredRangeResult,
    content: string,
    extras?: Partial<Annotation>,
  ): string {
    return createAnnotation(this.map, this.ydoc, type, anchored, content, extras);
  }

  editAnnotation(
    id: string,
    patch: { content?: string; suggestedText?: string },
  ): EditAnnotationResult {
    const raw = this.map.get(id) as Annotation | undefined;
    if (!raw) return { kind: "not-found" };

    // Sanitize legacy shapes before editing (matches the pre-seam handler).
    const ann = sanitizeAnnotation(raw, (e) => this.onLossy(e));

    // ADR-027: notes are user-private. Claude must not modify them via MCP.
    if (ann.type === "note") return { kind: "invalid-note" };

    if (ann.status !== "pending") return { kind: "not-pending", currentStatus: ann.status };

    // Guard ordering mirrors the pre-seam handler: the empty-patch check sits
    // after the note / status guards and before the suggestion-target check.
    if (patch.content === undefined && patch.suggestedText === undefined) {
      return { kind: "empty-patch" };
    }

    if (patch.suggestedText !== undefined && ann.type !== "comment") {
      return { kind: "invalid-suggestion-target", annotationType: ann.type };
    }

    const updated = {
      ...ann,
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.suggestedText !== undefined ? { suggestedText: patch.suggestedText } : {}),
      editedAt: Date.now(),
      rev: nextRev(ann),
    } as Annotation;

    withMcp(this.ydoc, () => this.map.set(id, updated));
    return { kind: "ok", annotation: updated };
  }

  acceptAnnotation(id: string): LifecycleResult<Annotation> {
    return acceptPending(id, this.ydoc, this.map);
  }

  dismissAnnotation(id: string): LifecycleResult<Annotation> {
    return dismissPending(id, this.ydoc, this.map);
  }

  removeAnnotation(
    id: string,
  ): { ok: true; id: string } | { ok: false; code: string; error: string } {
    return removeAnnotationById(this.ydoc, this.map, this.filePath, id);
  }

  getAnnotation(id: string): Annotation | undefined {
    const raw = this.map.get(id) as Annotation | undefined;
    if (!raw) return undefined;
    return sanitizeAnnotation(raw, (e) => this.onLossy(e));
  }

  listAnnotations(): Annotation[] {
    return collectAnnotations(this.map, this.docHash);
  }

  listAnnotationsRefreshed(): Annotation[] {
    return refreshAllRanges(this.listAnnotations(), this.ydoc, this.map).map((r) => r.annotation);
  }

  refreshAnnotation(ann: Annotation): Annotation {
    return refreshRange(ann, this.ydoc, this.map).annotation;
  }

  transactMcp(fn: () => void): void {
    withMcp(this.ydoc, fn);
  }

  addReply(
    annotationId: string,
    text: string,
    author: ReplyAuthor,
  ): { ok: true; replyId: string } | { ok: false; error: string; code?: string } {
    return addReplyToAnnotation(this.ydoc, this.map, annotationId, text, author, withMcp);
  }

  /**
   * Raw accessor: returns ALL replies for the id regardless of parent type or
   * `private` flag. Any output bound for Claude MUST route through
   * `channelVisibleReplies` instead (ADR-027, #1000).
   */
  listReplies(annotationId: string): AnnotationReply[] {
    const repliesMap = this.ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    return collectRepliesForAnnotation(repliesMap, annotationId);
  }
}

/**
 * Resolve the active (or named) document into a {@link YDocStore}, or null if
 * no matching document is open. Replaces the handlers' `getDocAndAnnotations`.
 */
export function getDocumentStore(documentId?: string): YDocStore | null {
  const doc = getCurrentDoc(documentId);
  if (!doc) return null;
  const ydoc = getOrCreateDocument(doc.docName);
  return new YDocStore(ydoc, doc.filePath);
}
