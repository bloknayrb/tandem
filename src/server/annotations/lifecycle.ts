/**
 * Annotation lifecycle module (ADR-035, part 2/N — lifecycle module + adapter wiring).
 *
 * The lifecycle owns annotation mutations as a typed seam between MCP
 * tool handlers and the Y.Doc state. Each public method:
 *
 *   1. Sanitizes the raw Y.Map value (legacy annotations get coerced via
 *      `sanitizeAnnotation` — e.g. missing/legacy status fields, stripped
 *      directedAt). Without this, downstream branching reads raw legacy
 *      values that the on-the-wire MCP envelope shouldn't surface.
 *   2. Validates the mutation against the annotation's current state
 *      (e.g. accepting a non-pending annotation returns a `not-pending`
 *      result arm — the previous bug #694 becomes a typed branch).
 *   3. Computes the next `rev` via `nextRev`.
 *   4. Wraps the Y.Map write in a transaction with the correct origin.
 *   5. Returns a tagged `LifecycleResult` so callers branch on
 *      structurally-named failures instead of stringly-typed error codes.
 *
 * Part 2 covers `acceptPending` and `dismissPending` plus the MCP-handler
 * wiring (`tandem_resolveAnnotation` calls the lifecycle directly).
 * Subsequent parts:
 *
 *   - Part 3: `createAnnotation` / `removeAnnotation` / `editPending`
 *     migrated to lifecycle methods.
 *   - Part 4: `narrowForChannel` predicate + `ChannelEligible` branded
 *     type for the channel observer to gate on (depends on the
 *     observer factory in #706 settling).
 *
 * This module still uses raw `doc.transact(fn, MCP_ORIGIN)` to match the
 * current master shape. When PR 1 / #702 (origin helpers) merges, the
 * lifecycle swaps to `withMcp(doc, fn)` — a follow-up commit on this
 * branch (deliberately deferred to keep the merge window small; the
 * PreToolUse blocker introduced by #702 forces the swap to happen as
 * part of the next edit to this file).
 */

import type * as Y from "yjs";
import { type RawAnnotation, sanitizeAnnotation } from "../../shared/sanitize.js";
import type { Annotation, AnnotationStatus } from "../../shared/types.js";
import { MCP_ORIGIN } from "../events/queue.js";
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

  ydoc.transact(() => map.set(id, updated), MCP_ORIGIN);

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
