/**
 * Wire-protocol event types — barrel re-export from shared layer.
 *
 * All types and functions have moved to `src/shared/events/types.ts` so that
 * `src/channel/` and `src/monitor/` can import them without crossing the
 * server layer boundary.  Server-internal consumers (queue.ts, sse.ts) continue
 * to import through this barrel, which keeps the server's internal import graph
 * unchanged.
 */

export * from "../../shared/events/types.js";

/**
 * Per-document selection buffer entry. Produced by the awareness observer
 * after a dwell timeout and consumed by the ctrl-chat observer when attaching
 * selection context to a chat message.
 */
export type BufferedSelection = {
  from: number; // FlatOffset
  to: number; // FlatOffset
  selectedText: string;
};
