/**
 * Reactive agent-label accessor (#438).
 *
 * Thin rune wrapper over `resolveAgentLabel` that tracks the Models-registry
 * selection in the settings singleton. Same getter-export idiom as
 * `createLayoutModel` (`layout/model.svelte.ts`): `$derived` at factory scope,
 * exposed via getters so consumers see reactivity through the settings store.
 *
 * IMPORTANT (reactivity contract):
 *  - NEVER destructure the returned object (`const { family } = ...` freezes it).
 *    Always read `agentLabel.family` / `agentLabel.specific`.
 *  - When passing a label into a pure helper (e.g. `getAuthorLabel`), wrap the
 *    call in `$derived` at the call site so it re-runs when the model changes.
 */

import { resolveAgentLabel } from "../utils/agentLabel.js";
import { agentLabelSource } from "./useModels.svelte.js";

export interface AgentLabel {
  /** Brand/family ("Claude", "GPT", …). Inline identity + action buttons. */
  readonly family: string;
  /** Specific model ("Claude Opus 4.8"). Status pill only. */
  readonly specific: string;
}

/**
 * No-arg since M2: the label sources from `agentLabelSource()` — the
 * server-authoritative store when lit, localStorage settings while dark (so a
 * v0.13.x cohort's configured-model byline stays byte-identical; see the store
 * doc). Reading the store's `$state` inside `$derived` keeps the ~10
 * always-mounted consumers reactive to model changes when lit.
 */
export function createAgentLabel(): AgentLabel {
  const family = $derived(resolveAgentLabel(agentLabelSource(), "family"));
  const specific = $derived(resolveAgentLabel(agentLabelSource(), "model"));
  return {
    get family() {
      return family;
    },
    get specific() {
      return specific;
    },
  };
}
