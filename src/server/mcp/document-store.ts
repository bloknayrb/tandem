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
 * `removeAnnotationById`, `refreshAllRanges`) and, for the families that have
 * migrated, to {@link DocumentStore.lifecycle}. That delegation is the parity
 * contract: the underlying Y.Map structures and origin tagging (`withMcp`,
 * ADR-031) are byte-identical to the pre-refactor behavior. The helpers stay
 * exported because the HTTP routes and the existing test suite (the parity
 * floor) still call them directly.
 *
 * **Direction of travel (ADR-035).** This store is a compatibility shell, not
 * the destination. Unit 8b settled that `AnnotationLifecycle` is the seam
 * callers program against and that Unit 8j collapses or deletes this file. Two
 * consequences for anyone editing here: new mutation work goes on the
 * lifecycle, not on a new method here; and `ydoc` / `transactMcp` are the
 * escape hatches the Unit 8 epic in
 * `docs/plans/2026-08-24-ai-assisted-maintainability-remediation.md` exists to
 * remove (ADR-035 predates this store and never names it), so nothing new
 * should reach for them.
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
import {
  type AnnotationLifecycle,
  createAnnotationLifecycle,
  type EditPatch,
  type EditResult,
  type LifecycleResult,
  type MintExtras,
} from "../annotations/lifecycle.js";
import { relaySanitizationEvent } from "../annotations/migration-log.js";
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
  /**
   * The ADR-035 mutation seam for this document (Unit 8b).
   *
   * **This is the interface callers program against from here on; the store is
   * a compatibility shell Unit 8j deletes.** It is reached through the store
   * only because document *resolution* still lives here — moving
   * `getCurrentDoc` / `getOrCreateDocument` into `annotations/lifecycle.ts`
   * would make `annotations/ → mcp/` an import cycle. 8j moves the lookup.
   *
   * Per the lifecycle's lifetime rule this is safe only because
   * {@link getDocumentStore} constructs a fresh store per handler call. Do not
   * cache a store — or this lifecycle — across an `await` that could span a
   * Hocuspocus `onLoadDocument` doc swap.
   */
  readonly lifecycle: AnnotationLifecycle;
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
   *
   * @deprecated ADR-035 Unit 8b — use {@link DocumentStore.lifecycle}`.create`.
   * It has **no production callers left**: what survives is the test floor,
   * which builds `note` and `highlight` fixtures through it and which the seam
   * deliberately cannot express. (The not-yet-migrated families, Units 8c–8h,
   * do not reach for this method either — `.docx` import has its own
   * `withInternal` path.) Unit 8j removes it.
   */
  createAnnotation(
    type: AnnotationType,
    anchored: AnchoredRangeResult,
    content: string,
    extras?: MintExtras,
  ): string;

  /**
   * Edit the mutable fields of a pending annotation. Returns the updated
   * record, or a tagged failure (`not-found` / `invalid-note` /
   * `not-pending` / `empty-patch` / `invalid-suggestion-target`) so the
   * handler can map it to the right MCP error envelope. The failure-arm
   * order mirrors the pre-seam handler's sequential guards exactly.
   */
  editAnnotation(id: string, patch: EditPatch): EditAnnotationResult;

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

/**
 * Tagged outcome of {@link DocumentStore.editAnnotation}.
 *
 * @deprecated Use `EditResult` from `annotations/lifecycle.ts`.
 *
 * An ALIAS, not a copy. Restating the union here would leave two structurally
 * identical types free to drift, which is the failure the lifecycle module
 * exists to prevent.
 *
 * It survives only as a name. Review measured that the MCP adapter never
 * mentions it — `mcp/annotations.ts` switches on `result.kind` off an
 * unannotated `store.editAnnotation(...)` — so this alias is not load-bearing
 * for any consumer, and Unit 8j deletes it.
 */
export type EditAnnotationResult = EditResult;

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
  /**
   * The open document's stable id (the Hocuspocus room name).
   *
   * Distinct from `docHash`, which is derived from `filePath` and therefore
   * CHANGES on rename and on scratchpad promotion — `renameDocument` deliberately
   * keeps the docId and swaps the path so clients keep their Y.Doc and room. Any
   * per-document server-side bookkeeping keyed across a document's lifetime must
   * use this, not `docHash` and not `filePath`.
   */
  readonly documentId: string;
  /** Annotations Y.Map — kept private; the seam is the method surface. */
  private readonly map: Y.Map<unknown>;
  readonly lifecycle: AnnotationLifecycle;

  constructor(ydoc: Y.Doc, filePath: string, documentId: string) {
    this.ydoc = ydoc;
    this.filePath = filePath;
    this.documentId = documentId;
    this.docHash = docHash(filePath);
    this.map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    this.lifecycle = createAnnotationLifecycle(ydoc);
  }

  private onLossy(event: SanitizationEvent): void {
    relaySanitizationEvent(this.docHash, event);
  }

  getText(): string {
    return extractText(this.ydoc);
  }

  /** @deprecated see {@link DocumentStore.createAnnotation}. */
  createAnnotation(
    type: AnnotationType,
    anchored: AnchoredRangeResult,
    content: string,
    extras?: MintExtras,
  ): string {
    return createAnnotation(this.map, this.ydoc, type, anchored, content, extras);
  }

  /**
   * Delegates to the lifecycle (ADR-034/035 Unit 8c). The guards, the `rev`
   * bump and the `withMcp` tag all live there now.
   *
   * **The sink is passed, not defaulted.** `transitionPending` supplies a no-op
   * whose wiring is deferred to Unit 8d; edit already had a real relay at this
   * caller, and handing it down is what stops 8d's decision from silently
   * becoming edit's.
   */
  editAnnotation(id: string, patch: EditPatch): EditAnnotationResult {
    return this.lifecycle.editPending(id, patch, (e) => this.onLossy(e));
  }

  acceptAnnotation(id: string): LifecycleResult<Annotation> {
    return this.lifecycle.accept(id);
  }

  dismissAnnotation(id: string): LifecycleResult<Annotation> {
    return this.lifecycle.dismiss(id);
  }

  /**
   * Remove an annotation on CLAUDE's behalf.
   *
   * **The ADR-027 note guard lives here rather than in `removeAnnotationById`,
   * and the altitude is the whole point.** That helper is shared with
   * `mcp/routes/remove-annotation.ts`, the browser's own Archive action — a
   * guard down there refuses the user access to their own note. This method's
   * only production caller is the `tandem_removeAnnotation` handler, so it is
   * the MCP-only chokepoint.
   *
   * Remove is the destructive path: it deletes the annotation AND sweeps every
   * reply keyed to it, which for a note is a private thread. `getAnnotation`
   * sanitizes through the store's real relay, so a stored legacy `flag` — a
   * note only once normalized — is caught, and the relay is deduped rather than
   * the unconditional `console.error` an undefined docHash produces.
   */
  removeAnnotation(
    id: string,
  ): { ok: true; id: string } | { ok: false; code: string; error: string } {
    if (this.getAnnotation(id)?.type === "note") {
      return {
        ok: false,
        code: "INVALID_ARGUMENT",
        error: `Annotation ${id} is a private note and cannot be removed by Claude`,
      };
    }
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
  return new YDocStore(ydoc, doc.filePath, doc.id);
}
