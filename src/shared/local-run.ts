import type { EffectiveLocalRunState, LocalRunState } from "./types.js";

/**
 * A local-model run's state as it should be read NOW (#1123). The run state on
 * a user's chat row is written by the server that ran it; a server that stops
 * mid-run cannot write its end. So a `running` state stamped by any generation
 * other than the current one reads as stopped, reason `interrupted`. Pure: the
 * editor passes the generation it was given (`GET /api/info`), a test passes
 * its own. `currentGeneration` is the server process's run id
 * (`runGeneration` from `GET /api/models/chat-answerer`), never the Hocuspocus
 * generation token. A null `currentGeneration` (not known yet) leaves the state as
 * written.
 */
export function effectiveLocalRun(
  state: LocalRunState | undefined,
  currentGeneration: string | null,
): EffectiveLocalRunState | undefined {
  if (state === undefined) return undefined;
  if (
    state.status === "running" &&
    currentGeneration !== null &&
    state.generation !== currentGeneration
  ) {
    return {
      status: "stopped",
      reason: "interrupted",
      generation: state.generation,
      ...(state.replyId ? { replyId: state.replyId } : {}),
    };
  }
  return state;
}
