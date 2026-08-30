/**
 * Annotation lifecycle module (ADR-035).
 *
 * The lifecycle owns annotation mutations as a typed seam between MCP tool
 * handlers and the Y.Doc state. Each public method:
 *
 *   1. Sanitizes the raw Y.Map value so legacy records (missing fields,
 *      stripped directedAt, etc.) are coerced through the canonical
 *      normalizer before status branching reads them.
 *   2. Validates the mutation against the annotation's current state and
 *      returns a TAGGED RESULT arm (e.g. `not-pending`) instead of throwing a
 *      stringly-typed error. The union is per-family, not shared:
 *      `LifecycleResult` for accept/dismiss, `CreateResult`, `EditResult` —
 *      see {@link EditResult} for why they did not converge.
 *   3. Computes the next `rev` via `nextRev` and writes via `withMcp`.
 *
 * Current scope: `create` (Unit 8b), `editPending` (Unit 8c), plus `accept` /
 * `dismiss`. Remove, replies, note promotion and `.docx` import creation each
 * migrate here in their own separately-revertible PR (Units 8d–8h).
 *
 * ## The layering, settled by Unit 8b
 *
 * **`AnnotationLifecycle` is the seam callers hold. `DocumentStore` is a
 * compatibility shell that Unit 8j deletes.** Three facts decide it:
 *
 * - Unit 8's own instruction ends "collapse or delete `DocumentStore`". A seam
 *   scheduled for deletion cannot be the seam callers program against.
 * - `DocumentStore` advertises `readonly ydoc` as an "escape hatch" and
 *   `transactMcp`. Removing exactly those two is Unit 8's own instruction in
 *   `docs/plans/2026-08-24-ai-assisted-maintainability-remediation.md` — ADR-035
 *   itself predates the store and never names it. **The lifecycle must never
 *   acquire either** — that is an invariant for Units 8c–8j, not a stylistic
 *   note.
 * - `local-model/tools.ts` structurally cannot reach `DocumentStore`: its
 *   `DispatchCtx` carries a `Y.Doc`, a license flag and an agent identity, and
 *   no store. A seam that one of the two production writers cannot hold is not
 *   the seam.
 *
 * Document *resolution* stays in `mcp/document-store.ts` for now (the
 * `getCurrentDoc` / `getOrCreateDocument` lookup lives there, and importing it
 * from this module would make `annotations/ → mcp/` a cycle). Unit 8j moves
 * the lookup. Resolution is not the seam; the interface is.
 *
 * ## Lifetime rule
 *
 * **A lifecycle is constructed per synchronous operation and is never stored
 * on a long-lived object.** Hocuspocus replaces the Y.Doc in `onLoadDocument`
 * and destroys the old one, so anything holding a pre-swap doc — or a `Y.Map`
 * obtained from it — writes into a destroyed doc silently. `YDocStore` is safe
 * today only because `getDocumentStore()` builds a fresh one per handler call;
 * the lifecycle inherits that bound and must not widen it. This is why
 * `DispatchCtx` deliberately does NOT carry a lifecycle field: `dispatch()`
 * builds one from `ctx.ydoc` on each call, which also keeps the anchor and the
 * write structurally targeted at the same document. A lifecycle injected
 * alongside a different `ydoc` would resolve flat offsets against one document
 * and write them into another, with nothing to typecheck the mismatch.
 */

import type * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { withMcp } from "../../shared/origins.js";
import type { AnchoredRangeResult } from "../../shared/positions/index.js";
import { type OnLossy, type RawAnnotation, sanitizeAnnotation } from "../../shared/sanitize.js";
import type { Annotation, AnnotationStatus, AnnotationType } from "../../shared/types.js";
import { generateAnnotationId, generateNotificationId } from "../../shared/utils.js";
import { pushNotification } from "../notifications.js";
import { nextRev } from "./schema.js";

// ---------------------------------------------------------------------------
// Result variants
// ---------------------------------------------------------------------------

/**
 * Tagged outcome of a lifecycle mutation.
 *
 * `invalid-note` was added by #1680 and carries no payload. Note that this is
 * **inconsistent with its own union** — every other non-`ok` arm here carries
 * `id` — and consistent instead with the edit path's identically-named arm. It
 * is harmless because the sole consumer already closes over `id` from the tool
 * arguments, but "it mirrors `EditResult`" is not a justification for a shape
 * inside `LifecycleResult`; the honest reason is that the shared-`LifecycleError`
 * refactor this union needs has not happened yet. **The arm was
 * chosen over `not-found` knowing `not-found` was the alternative.** Notes are
 * structurally unenumerable through the read surface, so answering `not-found`
 * would be the more consistent story; it is also a silent-failure shape, and it
 * buys nothing here, because a note-typed id CAN be one Claude legitimately
 * read and still holds — `file-io/docx-comments.ts` migrates a legacy imported
 * `comment` to a `note` in place, under an id that is a content hash with no
 * timestamp. `editPending` and `addReplyToAnnotation` already disclose "this id
 * is a note", so this discloses nothing new.
 *
 * **"Nothing new" is the honest phrasing, and the pre-existing oracle is
 * stronger than it looks.** `importAnnotationId` is
 * `sha256(commentId from to bodyText)` — a Word comment id is a small integer,
 * and `from`/`to` are flat offsets Claude can obtain from
 * `tandem_getTextContent`. So for an imported note the id is *offline
 * computable* from a guess at the body, and any arm that confirms "this id
 * exists and is a note" is a content-guessing oracle over short private
 * bodies, not merely a type disclosure. That predates #1680 —
 * `editPendingAnnotation` and `addReplyToAnnotation` both answer it — and
 * answering `not-found` here while edit answers `invalid-note` would leave the
 * oracle intact while making the family inconsistent. It is a family-wide
 * question, tracked as such rather than solved by this arm's spelling.
 */
export type LifecycleResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "not-found"; id: string }
  | { kind: "invalid-note" }
  | { kind: "not-pending"; id: string; currentStatus: AnnotationStatus };

/**
 * Tagged outcome of {@link AnnotationLifecycle.create}.
 *
 * **One arm, and that is honest rather than lazy.** Everything that can reject
 * a create is refused before the seam is reached, by a type rather than by a
 * runtime branch:
 *
 * - Range validity (Critical Rule 4) is settled by `anchoredRange()`, whose
 *   failure arms are a *separate* type (`RangeValidation & {ok: false}`, see
 *   `server/positions.ts`). `AnchoredRangeResult` has only `ok: true` arms, so
 *   an unvalidated range cannot be typed into {@link CreateInput}. Heading
 *   overlap is a weaker claim, stated deliberately weakly: rejection is opt-in
 *   via `anchoredRange`'s `rejectHeadingOverlap`, both production callers pass
 *   it, and the type cannot tell you whether they did.
 * - A Claude-authored note (ADR-027) is unconstructible *at runtime*: `create`
 *   has no `type` parameter, and {@link stripOwnedFields} deletes `type` and
 *   `audience` from whatever a caller passes. The matching `Omit` in
 *   {@link CreateExtras} is the legibility half, not the enforcing one — see
 *   its docblock.
 *
 * Kept a tagged union so Units 8c–8h can add arms without changing the call
 * shape at every site.
 */
export type CreateResult = { kind: "created"; annotation: Annotation };

/**
 * The edit family's result. Deliberately NOT a widened {@link LifecycleResult}.
 *
 * Two of these arms — `empty-patch` and `invalid-suggestion-target` — are
 * unreachable from `accept`/`dismiss`, so folding them into `LifecycleResult`
 * would make a `switch` over an accept stop telling the reader which arms can
 * actually occur. (`invalid-note` used to be a third; #1680 gave
 * `LifecycleResult` its own, so it no longer counts toward this argument.)
 *
 * **DEFERRED, not rejected — and the cost is smaller than it looks.** The
 * honest end state is a shared `LifecycleError` base holding the two arms that
 * really are one concept, extended per family; that way `not-pending`'s payload
 * cannot change in one family and not the other. The only thing in the way is
 * `LifecycleResult`'s `id` field, which these arms do not carry — and review
 * measured that `id` is read by **no production consumer** (`annotations.ts`
 * has the id in scope from the tool's own arguments; one test reads it). So
 * "reconciling two payload shapes across every consumer" — which is what this
 * docblock used to claim — was never true. It is deferred because Unit 8c's
 * whole contract is that behaviour does not change, not because it is
 * expensive. Do not read this paragraph as an argument against doing it.
 *
 * Note also that `AnnotationStatus` and `Annotation["status"]` below are the
 * same type spelled two ways; that is drift, not divergence.
 *
 * Structurally identical to the `EditAnnotationResult` it replaces, so no
 * adapter's arm-mapping moves. `document-store.ts` aliases that name.
 */
export type EditResult =
  | { kind: "ok"; annotation: Annotation }
  | { kind: "not-found" }
  | { kind: "invalid-note" }
  | { kind: "not-pending"; currentStatus: Annotation["status"] }
  | { kind: "empty-patch" }
  | { kind: "invalid-suggestion-target"; annotationType: AnnotationType };

/**
 * The mutable fields an edit may set.
 *
 * **What keeps a caller from stamping `rev` or `status` is the IMPLEMENTATION,
 * not this type.** `editPendingAnnotation` reads `patch.content` and
 * `patch.suggestedText` by name; it never spreads `patch`. Narrowness here is
 * legibility — excess-property checking catches only fresh object literals, so
 * a widened variable (`const p: Partial<Annotation> = …`) is assignable to this
 * with no cast and no error. That is the same caveat {@link CreateExtras}
 * spells out, and the reason `mintAnnotation` needs `stripOwnedFields` while
 * this path does not is that `mintAnnotation` spreads its extras last.
 * Refactoring the object literal to `...patch` reintroduces the whole hazard
 * with the type unchanged.
 *
 * `undefined` means "leave alone", so **there is no way to CLEAR a
 * `suggestedText` through this path** — a comment that acquired one keeps it.
 * If clearing is ever wanted the shape is `suggestedText?: string | null`.
 */
export interface EditPatch {
  content?: string;
  suggestedText?: string;
}

/**
 * Fields a caller may stamp onto a newly created annotation.
 *
 * **The exclusions are the point.** `extras` is spread last, so anything left
 * writable overrides what the lifecycle stamps:
 *
 * - `type` and `audience` — together these are the entire ADR-035 projection
 *   predicate (`type !== "note" && audience === "outbound"`, see
 *   `annotations/projection.ts`). Leaving them writable means the seam that
 *   exists to own the privacy stamp declines to own it: a caller could mint a
 *   Claude-authored note stamped `audience: "outbound"`, or a comment stamped
 *   `audience: "private"`.
 * - `relRange` — `AnchoredRangeResult` ties `relRange` to `fullyAnchored: true`
 *   structurally. `extras` was the one way to attach a CRDT anchor to a range
 *   that was never fully anchored, which is silent range corruption in the
 *   coordinate system Critical Rule 4 protects.
 * - `range`, `rev`, `id`, `content` — the lifecycle computes or is handed all
 *   four. A caller-supplied `rev` in particular would let a fresh record land
 *   above `rev: 1` and survive a tombstone merge it should lose (the delete
 *   rule is `stone.rev > ymapAnn.rev`, `annotations/sync.ts`). `content` is
 *   excluded because {@link CreateInput} already declares it a *required*
 *   parameter and `extras` is spread last: leaving it writable means two
 *   spellings of one field where the optional one silently wins.
 *
 * **What this type does and does not enforce.** Excess-property checking is
 * what rejects `extras: { audience: "private" }`, and that applies to a fresh
 * object literal only. A widened variable —
 * `const wide: Partial<Annotation> = {...}; create({ ..., extras: wide })` —
 * compiles with no cast. So the `Omit` catches the common literal spelling and
 * documents intent, while {@link stripOwnedFields} is what actually holds. Any
 * Unit 8c–8h author adding an `EditExtras`/`RemoveExtras` needs both halves;
 * the type alone is not the control.
 *
 * `author` stays writable: tests construct user-authored fixtures through this
 * path, and authorship is not part of the projection predicate. `status` stays
 * writable for the same reason.
 *
 * Verified against every `createAnnotation` call site in `src/` and `tests/`:
 * none passes any excluded key.
 */
export type CreateExtras = Omit<
  Partial<Extract<Annotation, { type: "comment" }>>,
  LifecycleOwnedField
>;

/**
 * The wide extras of the pre-ADR-035 entry point {@link mintAnnotation}.
 *
 * `Omit` is **not** distributive, so `Omit<Partial<Annotation>, …>` flattens the
 * three-arm union into one object whose `color` and `suggestedText` become
 * independently settable — which is exactly what the `color?: undefined` arms in
 * `shared/types.ts` exist to forbid. The seam therefore derives its
 * {@link CreateExtras} from the comment arm alone, and this wider alias carries
 * the flattening for the legacy path that genuinely mints a `highlight` (with a
 * `color`) and a `note`. Unit 8j deletes it along with its one caller.
 */
export type MintExtras = Omit<Partial<Annotation>, LifecycleOwnedField>;

/**
 * The excluded fields, written once. {@link CreateExtras} omits them at the
 * type level and {@link stripOwnedFields} deletes them at runtime; deriving
 * both from this array is what stops the two halves from drifting apart, which
 * would be silent — a field dropped from only the type is still stripped, and a
 * field dropped from only the array is still rejected by the compiler.
 */
const LIFECYCLE_OWNED_FIELDS = [
  "id",
  "type",
  "range",
  "relRange",
  "rev",
  "audience",
  "content",
] as const satisfies readonly (keyof Annotation)[];

type LifecycleOwnedField = (typeof LIFECYCLE_OWNED_FIELDS)[number];

/** Input to {@link AnnotationLifecycle.create}. */
export interface CreateInput {
  /** An already-validated, already-anchored range. */
  anchored: AnchoredRangeResult;
  /** Annotation body text. */
  content: string;
  extras?: CreateExtras;
}

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

/**
 * The ADR-035 mutation seam for one document.
 *
 * Deliberately exposes no `ydoc` and no `transact` escape hatch — see the
 * module header.
 */
export interface AnnotationLifecycle {
  /**
   * Mint a Claude-authored comment.
   *
   * There is no `type` parameter. Claude authors comments only: a note is
   * user-private (ADR-027) and a highlight is user-only, so a Claude-mutation
   * seam that accepted either would be the wrong type. The pre-ADR-035
   * wide-typed entry point survives as {@link mintAnnotation} for the paths
   * that have not migrated yet, and Unit 8j removes it.
   */
  create(input: CreateInput): CreateResult;
  /**
   * Edit the mutable fields of a PENDING annotation.
   *
   * Named for the invariant rather than the operation, matching the private
   * `transitionPending` and ADR-035's own text — `editAnnotation` reads as
   * though any annotation is editable, and the pending guard says otherwise.
   *
   * `onLossy` is a REQUIRED parameter rather than a lifecycle-owned default.
   * `transitionPending` passes a no-op sink whose wiring is deferred to Unit
   * 8d; edit arrives with a real relay already attached at its caller, and
   * taking the sink as an argument is what stops 8d's decision from silently
   * becoming edit's. What the relay does is narrow — a deduped `console.error`
   * via `logLegacyMigration`, nothing functional — so the cost of dropping it
   * is forensic visibility into legacy-shape migrations, not correctness.
   * Worth carrying anyway: a silent untested regression is the shape this
   * programme exists to stop.
   */
  editPending(id: string, patch: EditPatch, onLossy: OnLossy): EditResult;
  /**
   * Accept a pending annotation (pending → accepted).
   *
   * `onLossy` is required for the same reason it is on {@link editPending}: a
   * sink with a default is a sink a caller can neuter without saying so. Unit
   * 8d wired the real relay here; before that this path sanitized into
   * `() => {}` and every legacy-shape migration performed on an accept was
   * invisible.
   */
  accept(id: string, onLossy: OnLossy): LifecycleResult<Annotation>;
  /** Dismiss a pending annotation (pending → dismissed). See {@link accept}. */
  dismiss(id: string, onLossy: OnLossy): LifecycleResult<Annotation>;
}

/**
 * The create-only half of {@link AnnotationLifecycle}.
 *
 * The local-model loop (#1123, ships dark) has `comment_on_quote`,
 * `propose_replacement` and `reply_to_annotation` and **no** accept/dismiss
 * tool, so it structurally cannot resolve an annotation today. Handing it a
 * three-method lifecycle would grant that capability for the first time, in a
 * subsystem whose review surface is thin. It gets this instead.
 *
 * **Scope of the guarantee.** This binds at the `annotateFromQuote` call
 * boundary: that function cannot reach `accept`/`dismiss`, and the narrowing is
 * not recoverable from `creator` without a cast. It is *not* a capability
 * boundary for the module — `local-model/tools.ts` imports
 * {@link createAnnotationLifecycle} itself, so a future edit there is one line
 * from the full lifecycle. Closing that means injecting an `AnnotationCreator`
 * from `dispatch`'s caller, which is Unit 8j's restructuring, not 8b's.
 *
 * **A `Pick` does not grow when its source interface does, and that is load-
 * bearing rather than incidental.** Unit 8c added `editPending` to
 * `AnnotationLifecycle` and the local-model loop stayed edit-incapable with no
 * decision required — but nothing in the code distinguishes that from an
 * oversight, so it is written down here. Every later mutation family (8d–8h)
 * inherits the same property: adding a method grants local-model nothing. If a
 * future unit wants it to have one, widening this `Pick` is the deliberate act
 * that does it.
 */
export type AnnotationCreator = Pick<AnnotationLifecycle, "create">;

/**
 * Build a lifecycle bound to one document.
 *
 * Obey the lifetime rule in the module header: construct per synchronous
 * operation, never cache on a long-lived object.
 */
export function createAnnotationLifecycle(ydoc: Y.Doc): AnnotationLifecycle {
  // Critical Rule 1: the Y.Map key comes from the shared constant.
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  return {
    create: (input) => ({
      kind: "created",
      annotation: mintAnnotation(ydoc, map, "comment", input.anchored, input.content, input.extras),
    }),
    editPending: (id, patch, onLossy) => editPendingAnnotation(id, ydoc, map, patch, onLossy),
    accept: (id, onLossy) => transitionPending(id, ydoc, map, "accepted", onLossy),
    dismiss: (id, onLossy) => transitionPending(id, ydoc, map, "dismissed", onLossy),
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Drop the lifecycle-owned fields from a caller's `extras`.
 *
 * **This is the enforcing half, not the belt to the `Omit`'s braces.** The
 * `Omit` in {@link CreateExtras} is an excess-property check on fresh object
 * literals; a widened variable, a cast, an untyped caller or a `.js` consumer
 * all reach this function with the same object, and `extras` is spread last, so
 * without the delete a runtime `extras` carrying `rev` or `audience` would win.
 * Unit 8a learned the same lesson about its `ChannelEligible` brand.
 *
 * Measured before adding: no call site in `src/` passes any of these keys, so
 * production behaviour is unchanged. The only callers that do are the
 * runtime-strip specs in `tests/server/annotation-create-lifecycle.test.ts`,
 * which exist to prove this function fires. Deleting rather than reordering the
 * spread is deliberate — it leaves the key order of every field a caller *does*
 * pass exactly where it was.
 */
function stripOwnedFields(extras: MintExtras | undefined): MintExtras {
  if (!extras) return {};
  const copy = { ...extras } as Record<string, unknown>;
  for (const key of LIFECYCLE_OWNED_FIELDS) delete copy[key];
  return copy as MintExtras;
}

/**
 * Build an annotation record, write it under the MCP origin, and raise the
 * review-pending notification.
 *
 * **The wide `type` parameter is compatibility, not design.** The public seam
 * is {@link AnnotationLifecycle.create}, which always mints a comment. This
 * entry point stays only for `mcp/annotations.ts::createAnnotation` — the
 * pre-ADR-035 export that the not-yet-migrated families and the existing test
 * floor still call with `note` and `highlight`. Unit 8j deletes both.
 *
 * It takes `map` explicitly rather than deriving it from `ydoc` so that the
 * legacy signature's map argument is actually used: a delegator that silently
 * discarded it would let the two drift apart with nothing able to observe it.
 *
 * `pushNotification` fires **outside** the transaction, matching the
 * pre-ADR-035 ordering. It lives here rather than at the callers because both
 * production callers raise the same toast and duplicating the label /
 * `dedupKey` derivation across two files is how the two would diverge.
 */
export function mintAnnotation(
  ydoc: Y.Doc,
  map: Y.Map<unknown>,
  type: AnnotationType,
  anchored: AnchoredRangeResult,
  content: string,
  extras?: MintExtras,
): Annotation {
  const id = generateAnnotationId();
  const safeExtras = stripOwnedFields(extras);

  const annotation = {
    id,
    author: "claude" as const,
    type,
    // Claude-created annotations are always outbound (visible to Claude).
    audience: "outbound" as const,
    range: anchored.range,
    // Omit the key entirely rather than storing an explicit `undefined`: the
    // record reaches the durable envelope serializer and the Y.Map values
    // browsers observe, and `{relRange: undefined}` is not the same document
    // state as `{}` even though most deep-equality helpers say it is.
    ...(anchored.relRange ? { relRange: anchored.relRange } : {}),
    content,
    status: "pending" as const,
    timestamp: Date.now(),
    // Argument-free, deliberately: a fresh record is always `rev: 1`. The
    // transition path below calls `nextRev(ann)` from the prior record, and the
    // two sit close enough that "make them consistent" is a plausible edit —
    // but `nextRev(undefined)` is also 1, so that edit would pass every test
    // while letting a caller-supplied prior `rev` bump a fresh record above 1.
    // `CreateExtras` excludes `rev` for the same reason.
    rev: nextRev(),
    ...safeExtras,
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

  return annotation;
}

// ---------------------------------------------------------------------------
// Pending-only transitions
// ---------------------------------------------------------------------------

/**
 * Transition an annotation from `pending → accepted` (or `dismissed`).
 *
 * Refuses non-pending annotations as a typed result arm. The previous
 * runtime check in `tandem_resolveAnnotation` (#694) becomes a typed
 * `LifecycleResult.not-pending` — callers handle the case explicitly or
 * fail to compile.
 *
 * Sanitizes the raw Y.Map value before status branching so legacy
 * records (missing fields, stripped directedAt, etc.) are coerced via
 * the canonical normalizer instead of leaking raw values to the caller.
 */
function transitionPending(
  id: string,
  ydoc: Y.Doc,
  map: Y.Map<unknown>,
  nextStatus: "accepted" | "dismissed",
  onLossy: OnLossy,
): LifecycleResult<Annotation> {
  const raw = map.get(id);
  if (raw === undefined) return { kind: "not-found", id };

  // Sanitize first so the status check + result arm both see normalized
  // fields. `sanitizeAnnotation` accepts a `RawAnnotation` shape, which permits
  // legacy fields.
  //
  // **Unit 8d replaced the `() => {}` that stood here.** Until then, accepting a
  // legacy-shaped record silently performed the migration and reported nothing:
  // the sink was a no-op, so `flag→note`, `question→comment`, a malformed
  // suggestion JSON and an unknown type all normalized without a log line.
  //
  // **This emits even when the write is then refused**, and that ordering is
  // worth stating because it reads backwards. A stored `flag` sanitizes to a
  // note, fires `flag-to-note` HERE, and only then hits the ADR-027 guard below
  // and returns `invalid-note` — so the migration is reported for a transition
  // that never happened. That is correct: the event describes what sanitize
  // read, not what the lifecycle wrote, and the relay is an observability sink
  // rather than an audit of mutations.
  const ann = sanitizeAnnotation(raw as RawAnnotation, onLossy);

  // ADR-027 (#1680): notes are user-private. Claude must not resolve them.
  //
  // **After sanitize, and before the pending check — both halves matter.**
  // After, because a stored `flag` is a note only once sanitized, so a raw-type
  // check lets one through; that is the same constraint `editPendingAnnotation`
  // documents. Before, because reporting `not-pending` on a resolved note tells
  // a caller the note exists and is merely resolved, which is a disclosure
  // ADR-027 does not make. Only a spec seeding an ALREADY-RESOLVED note
  // distinguishes this ordering from the other one.
  if (ann.type === "note") return { kind: "invalid-note" };

  if (ann.status !== "pending") {
    return { kind: "not-pending", id, currentStatus: ann.status };
  }

  const updated: Annotation = {
    ...ann,
    status: nextStatus,
    rev: nextRev(ann),
  };

  withMcp(ydoc, () => map.set(id, updated));

  return { kind: "ok", data: updated };
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

/**
 * Edit a pending annotation's mutable fields.
 *
 * **The guard ORDER is the contract, not an implementation detail**, and it is
 * asserted in three suites (`edit-annotation.test.ts`, `document-store.test.ts`
 * and `annotation-edit-lifecycle.test.ts`). not-found → sanitize → note
 * (ADR-027) → pending → empty-patch → suggestion-target. Two of those orderings
 * are load-bearing and look arbitrary:
 *
 * - The **note check precedes the pending check**, so editing a resolved note
 *   reports `invalid-note`, not `not-pending`. Swapping them tells a caller the
 *   note exists and is merely resolved, which is a disclosure ADR-027 does not
 *   make. `edit-annotation.test.ts` pins exactly this.
 * - **Sanitize runs before every guard**, so a legacy-shaped note is recognised
 *   as a note by its sanitized type rather than its stored one — a stored
 *   `flag` sanitizes to `note`, and a raw-type check would let Claude edit it.
 *
 * The empty-patch / suggestion-target order is NOT in that set, despite sitting
 * in the same sequence: `empty-patch` needs both fields absent and
 * `invalid-suggestion-target` needs `suggestedText` present, so the two are
 * mutually exclusive and no input can observe which comes first. Nothing pins
 * it, and nothing can.
 *
 * Moved from `YDocStore.editAnnotation` by ADR-034/035 Unit 8c with the body
 * unchanged; the store now delegates.
 */
function editPendingAnnotation(
  id: string,
  ydoc: Y.Doc,
  map: Y.Map<unknown>,
  patch: EditPatch,
  onLossy: OnLossy,
): EditResult {
  const raw = map.get(id) as Annotation | undefined;
  if (!raw) return { kind: "not-found" };

  // Sanitize legacy shapes before editing (matches the pre-seam handler).
  const ann = sanitizeAnnotation(raw, onLossy);

  // ADR-027: notes are user-private. Claude must not modify them via MCP.
  if (ann.type === "note") return { kind: "invalid-note" };

  if (ann.status !== "pending") return { kind: "not-pending", currentStatus: ann.status };

  if (patch.content === undefined && patch.suggestedText === undefined) {
    return { kind: "empty-patch" };
  }

  if (patch.suggestedText !== undefined && ann.type !== "comment") {
    return { kind: "invalid-suggestion-target", annotationType: ann.type };
  }

  const updated = {
    ...ann,
    // Field-by-field, never `...patch` — see {@link EditPatch}. This literal is
    // what stops a caller-supplied `rev` or `status` from riding into the store,
    // and the type is not what holds that line.
    ...(patch.content !== undefined ? { content: patch.content } : {}),
    ...(patch.suggestedText !== undefined ? { suggestedText: patch.suggestedText } : {}),
    editedAt: Date.now(),
    // `nextRev(ann)`, never `nextRev()`. The argument-free form returns 1, which
    // pins every later edit at the same number — see the note at the mint site.
    // **Measured, so state it precisely:** an exact-value pin of `2` cannot tell
    // the two apart, because a record at `rev: 1` gives 2 under BOTH. The
    // pre-existing `toBeGreaterThan(before.rev ?? 0)` in `document-store.test.ts`
    // does kill it. The specs here edit twice and seed a prior rev, which kills
    // it two further ways that do not depend on the seeded rev being 1.
    rev: nextRev(ann),
    // The cast is what makes the spread compile: the discriminant correlation is
    // lost across `...ann`, so `Annotation`'s "a highlight has no suggestedText"
    // arm is not re-checked here. The suggestion-target guard above is what makes
    // it sound — move that guard after this literal and the cast starts lying.
  } as Annotation;

  // `withMcp`, and the wrong helper fails in two different directions.
  //
  // Toward the CHANNEL: only browser-origin writes reach it (`CHANNEL_SKIP` in
  // `shared/origins.ts` holds the other five), so `withBrowser` here would emit an
  // `annotation:edited` for a server-initiated write — specifically when Claude
  // edits a USER-authored pending comment, the one shape the observer's update
  // branch admits. Pinned by an origin spec rather than left to review.
  //
  // Toward DISK, which is the half a "they all skip the channel anyway" reading
  // misses: `withFileSync` and `withInternal` also sit in `DURABLE_SKIP`, so
  // either one leaves the channel correct and silently stops the edit reaching
  // the durable store. No test in this suite would notice.
  withMcp(ydoc, () => map.set(id, updated));
  return { kind: "ok", annotation: updated };
}

/**
 * Pre-ADR-035 accept entry point.
 *
 * **No production caller reaches these two** — `YDocStore` goes through
 * {@link createAnnotationLifecycle}, and a census of `src/` finds only these
 * definitions. They survive because the seam census
 * (`tests/server/annotation-create-seam-census.test.ts`) names them and roughly
 * thirty specs drive them; retiring them is Unit 8j's, along with
 * {@link mintAnnotation}.
 *
 * `onLossy` is required here too rather than defaulted, so a test driving this
 * export cannot accidentally be measuring a different sanitize contract from
 * the one production runs.
 */
export function acceptPending(
  id: string,
  ydoc: Y.Doc,
  map: Y.Map<unknown>,
  onLossy: OnLossy,
): LifecycleResult<Annotation> {
  return transitionPending(id, ydoc, map, "accepted", onLossy);
}

/** Pre-ADR-035 dismiss entry point. See {@link acceptPending}. */
export function dismissPending(
  id: string,
  ydoc: Y.Doc,
  map: Y.Map<unknown>,
  onLossy: OnLossy,
): LifecycleResult<Annotation> {
  return transitionPending(id, ydoc, map, "dismissed", onLossy);
}
