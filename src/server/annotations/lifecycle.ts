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
 * Current scope: `acceptPending` / `dismissPending`. Create / remove / edit
 * paths still live on the handlers and will migrate here when their MCP
 * envelopes are reworked alongside.
 */

import type * as Y from "yjs";
import { withMcp } from "../../shared/origins.js";
import { type RawAnnotation, sanitizeAnnotation } from "../../shared/sanitize.js";
import type { Annotation, AnnotationStatus } from "../../shared/types.js";
import { nextRev } from "./schema.js";

// ---------------------------------------------------------------------------
// Result variant
// ---------------------------------------------------------------------------

/** Tagged outcome of a lifecycle mutation. */
export type LifecycleResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "not-found"; id: string }
  | { kind: "not-pending"; id: string; currentStatus: AnnotationStatus };

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
