import type * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES } from "../../shared/constants";
import type { ReplyBaseline } from "../notifications/thread-answer-detector";

/**
 * The body of a document provider's `synced` handler (#2360): on the FIRST
 * `state: true` for `ydoc`, the reply ids present right now and the time, as
 * the thread-answer detector's baseline. Returns the next map, or null when
 * nothing changes (`state: false`, or this doc already has a baseline — a
 * reconnect on the same doc delivers a delta the detector must still see).
 *
 * It runs synchronously inside the provider callback, for the same reason as
 * `ctrlInitialClaudeMessageIds`: a reply landing before Svelte runs the
 * detector's effect is live and must not join the baseline.
 */
export function captureReplyBaseline(
  ydoc: Y.Doc,
  current: ReadonlyMap<Y.Doc, ReplyBaseline>,
  state: boolean,
  now: number,
): Map<Y.Doc, ReplyBaseline> | null {
  if (!state || current.has(ydoc)) return null;
  const ids = Array.from(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).keys()).sort();
  return new Map(current).set(ydoc, { ids, capturedAt: now });
}
