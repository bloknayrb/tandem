/**
 * Annotation lifecycle module (ADR-035, part 1/N).
 *
 * The lifecycle owns annotation mutations as a typed seam between MCP
 * tool handlers and the Y.Doc state. Each public method:
 *
 *   1. Validates the mutation against the annotation's current state
 *      (structural — type system rejects mutations that violate the
 *      lifecycle, e.g. accepting a non-pending annotation).
 *   2. Computes the next `rev` via `nextRev`.
 *   3. Wraps the Y.Map write in a transaction with the correct origin.
 *   4. Returns a tagged `LifecycleResult` so callers can branch on
 *      structurally-named failures instead of stringly-typed error codes.
 *
 * Part 1 covers the high-leverage methods: `acceptPending` and
 * `dismissPending`. Both refuse non-pending annotations at the
 * type level — the previous bug (#694, fixed at runtime in PR 0a)
 * becomes structurally impossible. Subsequent parts:
 *
 *   - Part 2: `createAnnotation` / `removeAnnotation` / `editPending`
 *     migrated to lifecycle methods; MCP tool handlers become thin
 *     adapters that translate `LifecycleResult` into MCP envelopes.
 *   - Part 3: `narrowForChannel` predicate + `ChannelEligible` branded
 *     type for the channel observer to gate on (depends on the
 *     observer factory in #706 settling).
 *
 * This PR uses raw `doc.transact(fn, MCP_ORIGIN)` to match the current
 * master shape. When PR 1 / #702 (origin helpers) merges, the lifecycle
 * swaps to `withMcp(doc, fn)` — a follow-up commit on this branch.
 */

import type * as Y from "yjs";
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
 * Refuses non-pending annotations at the kind level. The previous
 * runtime check in `tandem_resolveAnnotation` (#694) becomes a typed
 * `LifecycleResult` arm — callers handle the `not-pending` case
 * explicitly or fail to compile.
 */
function transitionPending(
  id: string,
  ydoc: Y.Doc,
  map: Y.Map<unknown>,
  nextStatus: "accepted" | "dismissed",
): LifecycleResult<Annotation> {
  const raw = map.get(id) as Annotation | undefined;
  if (!raw) return { kind: "not-found", id };
  if (raw.status !== "pending") {
    return { kind: "not-pending", id, currentStatus: raw.status };
  }

  const updated: Annotation = {
    ...raw,
    status: nextStatus,
    rev: nextRev(raw),
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
