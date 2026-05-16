/**
 * Per-key Y.Map observer factory (ADR-035, sequenced before the annotation
 * lifecycle PR). Generalises the common shape shared by the annotations
 * and replies observers:
 *
 *   1. Subscribe to a Y.Map.
 *   2. Skip transactions whose origin is in the channel-skip set
 *      (mcp / file-sync / internal / reload — only `browser` emits).
 *   3. For each changed key, optionally derive zero or more TandemEvents
 *      and forward them through `pushEvent`.
 *
 * Stateful observers (awareness, ctrl-chat, ctrl-meta) keep their bespoke
 * shape — they read across multiple Y.Maps, buffer selections, or track
 * observer-level state that doesn't fit this contract. The factory is
 * deliberately narrow: it pays its keep on the two observers that fit and
 * doesn't paper over the cases where it would.
 */

import * as Y from "yjs";
import { FILE_SYNC_ORIGIN, MCP_ORIGIN } from "../origins.js";
import type { TandemEvent } from "../types.js";

/** Inputs available to the event-derivation callback. */
export interface PerKeyChangeContext<T> {
  /** The changed Y.Map key. */
  key: string;
  /** The CRDT change kind. */
  action: "add" | "update" | "delete";
  /** The current value at the key (already coerced to the value type), or
   *  `undefined` for deletes. */
  value: T | undefined;
  /** The pre-change value, as exposed by `YMapEvent.changes.keys[i].oldValue`.
   *  Useful for update/delete cases that need to compare old vs new. */
  oldValue: T | undefined;
  /** The transaction origin, for callbacks that want to branch further. */
  origin: unknown;
}

export interface PerKeyObserverDeps<T> {
  /** The Y.Map to observe. */
  map: Y.Map<unknown>;
  /** Push events derived from a per-key change. Return `undefined` (or an
   *  empty array) to emit nothing. Returning multiple events is supported
   *  for observers that emit several distinct event types from a single
   *  Y.Map mutation (e.g. annotation create vs note→comment promotion). */
  derive: (ctx: PerKeyChangeContext<T>) => TandemEvent | TandemEvent[] | undefined;
  /** Forwarder for derived events. */
  pushEvent: (e: TandemEvent) => void;
  /** Optional extra origin to skip alongside the channel-skip set. */
  extraSkipOrigins?: ReadonlyArray<unknown>;
}

/**
 * Register a per-key change observer. Returns a teardown function that
 * unsubscribes the listener.
 *
 * Origin skip-set today (pre-ADR-031 helpers): `mcp` + `file-sync`. After
 * the origin-helper migration lands, the channel-event observers widen to
 * `mcp` + `file-sync` + `internal` + `reload` via the
 * `shouldSkipChannel` predicate — see ADR-031 § "Skip-set matrix".
 */
export function makePerKeyChangeObserver<T>(deps: PerKeyObserverDeps<T>): () => void {
  const { map, derive, pushEvent, extraSkipOrigins } = deps;

  const skipOrigins = new Set<unknown>([MCP_ORIGIN, FILE_SYNC_ORIGIN, ...(extraSkipOrigins ?? [])]);

  const onChange = (event: Y.YMapEvent<unknown>, txn: Y.Transaction): void => {
    if (skipOrigins.has(txn.origin)) return;

    for (const [key, change] of event.changes.keys) {
      const action = change.action;
      const value = action === "delete" ? undefined : (map.get(key) as T | undefined);
      const oldValue = change.oldValue as T | undefined;
      const derived = derive({ key, action, value, oldValue, origin: txn.origin });
      if (!derived) continue;
      if (Array.isArray(derived)) {
        for (const ev of derived) pushEvent(ev);
      } else {
        pushEvent(derived);
      }
    }
  };

  map.observe(onChange);
  return () => map.unobserve(onChange);
}
