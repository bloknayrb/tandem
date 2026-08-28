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
 *      returns a tagged `LifecycleResult` arm (e.g. `not-pending`) instead
 *      of throwing a stringly-typed error.
 *   3. Computes the next `rev` via `nextRev` and writes via `withMcp`.
 *
 * Current scope: `create` (Unit 8b) plus `accept` / `dismiss`. Edit, remove,
 * replies, note promotion and `.docx` import creation each migrate here in
 * their own separately-revertible PR (Units 8c–8h).
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
import { type RawAnnotation, sanitizeAnnotation } from "../../shared/sanitize.js";
import type { Annotation, AnnotationStatus, AnnotationType } from "../../shared/types.js";
import { generateAnnotationId, generateNotificationId } from "../../shared/utils.js";
import { pushNotification } from "../notifications.js";
import { nextRev } from "./schema.js";

// ---------------------------------------------------------------------------
// Result variants
// ---------------------------------------------------------------------------

/** Tagged outcome of a lifecycle mutation. */
export type LifecycleResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "not-found"; id: string }
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
  /** Accept a pending annotation (pending → accepted). */
  accept(id: string): LifecycleResult<Annotation>;
  /** Dismiss a pending annotation (pending → dismissed). */
  dismiss(id: string): LifecycleResult<Annotation>;
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
    accept: (id) => transitionPending(id, ydoc, map, "accepted"),
    dismiss: (id) => transitionPending(id, ydoc, map, "dismissed"),
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
): LifecycleResult<Annotation> {
  const raw = map.get(id);
  if (raw === undefined) return { kind: "not-found", id };

  // Sanitize first so the status check + result arm both see normalized
  // fields. `sanitizeAnnotation` accepts a `RawAnnotation` shape (which
  // permits legacy fields); the lifecycle uses a no-op sink for migration
  // events because docHash-keyed relay belongs upstream of the lifecycle
  // (scoped to the doc context, not the per-mutation seam).
  //
  // Unit 8b deliberately left this a no-op. Wiring the real
  // `relaySanitizationEvent` here would change accept/dismiss behavior —
  // accepting a legacy `flag` would begin emitting a migration log line and
  // consuming a dedup slot — inside a PR whose subject is create, which would
  // make it non-cleanly revertible against Unit 8d. The upgrade belongs to 8d,
  // where accept/dismiss is the subject and can be tested.
  const ann = sanitizeAnnotation(raw as RawAnnotation, () => {});
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

export function acceptPending(
  id: string,
  ydoc: Y.Doc,
  map: Y.Map<unknown>,
): LifecycleResult<Annotation> {
  return transitionPending(id, ydoc, map, "accepted");
}

export function dismissPending(
  id: string,
  ydoc: Y.Doc,
  map: Y.Map<unknown>,
): LifecycleResult<Annotation> {
  return transitionPending(id, ydoc, map, "dismissed");
}
