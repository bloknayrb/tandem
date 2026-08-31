/**
 * `YDocStore` — a testable seam over the in-memory Y.Doc / Y.Map layer used by
 * the MCP tool handlers (issue #315).
 *
 * Before this seam, every annotation/text tool reached straight into a raw
 * `Y.Doc` + `Y.Map` (via `getDocAndAnnotations`, which handed back the Y.Map
 * itself). That coupled the tool logic to Yjs internals and made the handlers
 * awkward to test without standing up a full document service. This class names
 * the operations the handlers actually perform — read text, list/edit/resolve/
 * remove annotations, add/list replies, refresh CRDT ranges — so an MCP tool
 * handler never writes `Y.Map.get`/`set`. (Routes and seeding paths still do:
 * `routes/mode-release.ts` and `tutorial-annotations.ts` take the map
 * directly. The claim is about the tool handlers, not all of `src/server/mcp`.)
 *
 * `YDocStore` is the one implementation, and as of Unit 8j the only type: it
 * delegates the annotation mutations to {@link YDocStore.lifecycle} and
 * everything else to the same standalone helpers the handlers used before
 * (`collectAnnotations`, `refreshAllRanges`). **Not a clean read/write split**
 * — `listAnnotationsRefreshed` and `refreshAnnotation` persist range updates
 * back into the Y.Map, and `transactMcp` is an unmediated write hatch, so
 * calling the second group "reads" would be wrong. That delegation is the
 * parity
 * contract: the underlying Y.Map structures and origin tagging (`withMcp`,
 * ADR-031) are byte-identical to the pre-refactor behavior. The helpers stay
 * exported because the HTTP routes and the existing test suite (the parity
 * floor) still call them directly.
 *
 * **Direction of travel (ADR-035).** This store is a compatibility shell, not
 * the destination. Unit 8b settled that `AnnotationLifecycle` is the seam
 * callers program against. Two consequences for anyone editing here: new
 * mutation work goes on the lifecycle, not on a new method here; and `ydoc` /
 * `transactMcp` are the escape hatches the Unit 8 epic in
 * `docs/plans/2026-08-24-ai-assisted-maintainability-remediation.md` exists to
 * remove (ADR-035 predates this store and never names it), so nothing new
 * should reach for them. **Unit 8j-2 closes them; until it lands they are
 * still here and still reachable.**
 *
 * Scope note: this wraps the *in-memory* Y.Doc/Y.Map layer the MCP handlers
 * touch — NOT the durable annotation file-store (`src/server/annotations/`).
 * `FileOnlyStore` is intentionally out of scope.
 */

import type * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { withMcp } from "../../shared/origins.js";
import type { SanitizationEvent } from "../../shared/sanitize.js";
import type { Annotation, AnnotationReply } from "../../shared/types.js";
import { docHash } from "../annotations/doc-hash.js";
import {
  type AnnotationLifecycle,
  type ClaudeReplyResult,
  createAnnotationLifecycle,
  type EditPatch,
  type EditResult,
  type LifecycleResult,
  type RemoveResult,
} from "../annotations/lifecycle.js";
import { relaySanitizationEvent } from "../annotations/migration-log.js";
import { refreshAllRanges, refreshRange } from "../positions.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import { collectAnnotations, collectRepliesForAnnotation } from "./annotations.js";
import { extractText } from "./document-model.js";
import { getCurrentDoc } from "./document-service.js";

/**
 * The operations MCP tool handlers perform against a single document's
 * in-memory Y.Doc / Y.Map state. Method names and argument shapes are derived
 * from what the handlers do, not from the underlying Y.Map API.
 *
 * **There is no `DocumentStore` interface any more (Unit 8j).** It had zero
 * importers anywhere in `src/` or `tests/` — every consumer either called
 * {@link getDocumentStore}, which returns this class, or constructed it
 * directly. It was also already dead as a type: `awareness.ts` reads
 * `store.documentId`, declared here and never on the interface, so returning
 * the concrete class was the only reason that compiled. A one-implementation
 * interface nothing imports is documentation wearing a type's clothes.
 */
export class YDocStore {
  readonly ydoc: Y.Doc;
  /**
   * Absolute (or `upload://`) path of the backing document.
   *
   * Read by the `tandem_exportAnnotations` handler through a DESTRUCTURE —
   * `const { ydoc, filePath } = store` — which is why two independent census
   * passes over this field reported zero readers and Unit 8j briefly deleted
   * it. A member-name grep does not see a destructured bind.
   *
   * (Cited by handler rather than by line: the first draft of this comment said
   * `mcp/annotations.ts:632` and was off by one on the branch that wrote it,
   * which makes the point better than the citation did.)
   */
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

  /**
   * Delegates to the lifecycle (ADR-034/035 Unit 8c). The guards, the `rev`
   * bump and the `withMcp` tag all live there now.
   *
   * **The sink is passed, not defaulted**, and as of Unit 8d every mutation
   * method on this store does the same.
   */
  editAnnotation(id: string, patch: EditPatch): EditResult {
    return this.lifecycle.editPending(id, patch, (e) => this.onLossy(e));
  }

  /**
   * Delegates to the lifecycle, passing the store's real relay (Unit 8d).
   *
   * `(e) => this.onLossy(e)` rather than `this.onLossy` — the method reads
   * `this.docHash`, and an unbound reference loses it. That failure is not
   * loud: `logLegacyMigration` treats an undefined docHash as a reason to skip
   * dedup and log unconditionally, so the relay would still print and only the
   * per-document keying would be gone.
   */
  acceptAnnotation(id: string): LifecycleResult<Annotation> {
    return this.lifecycle.accept(id, (e) => this.onLossy(e));
  }

  /** See {@link acceptAnnotation}. */
  dismissAnnotation(id: string): LifecycleResult<Annotation> {
    return this.lifecycle.dismiss(id, (e) => this.onLossy(e));
  }

  /**
   * Remove an annotation on CLAUDE's behalf.
   *
   * **The ADR-027 note guard moved down to `AnnotationLifecycle.remove` in Unit
   * 8e, and the altitude did not change with it.** That member is Claude's
   * remove; the shared mechanism it calls, `removeAnnotationRecord`, is what the
   * browser's Archive action reaches, and a guard down THERE refuses the user
   * access to their own note (#1680). This method's only production caller is
   * the `tandem_removeAnnotation` handler, so the store remains an MCP-only
   * seam — it just no longer holds the branch itself.
   *
   * Remove is the destructive path: it deletes the annotation AND sweeps every
   * reply keyed to it, which for a note is a private thread. The sink is passed
   * rather than defaulted, so the guard's sanitize reports a legacy shape
   * through the store's deduped relay rather than the unconditional
   * `console.error` an undefined docHash produces.
   */
  removeAnnotation(id: string): RemoveResult {
    return this.lifecycle.remove(id, (e) => this.onLossy(e));
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

  addReply(annotationId: string, text: string): ClaudeReplyResult {
    return this.lifecycle.reply(annotationId, text, (e) => this.onLossy(e));
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
