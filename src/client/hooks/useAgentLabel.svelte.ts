/**
 * Reactive agent-label accessor (#438; the lit rule is #1123's agent-labels PR,
 * ADR-039 amendment 2026-11-17 (agent labels)).
 *
 * The label for Claude-side work: work and controls that come through MCP, as
 * opposed to a record a local model wrote (that one carries `agentIdentity` and
 * its byline comes from `agentBylineLabel`).
 *
 *  - **Lit (`BYO_MODELS_ENABLED` on):** always "Claude", for `family` and
 *    `specific` alike, whatever the Models store holds and whoever answers chat
 *    (P10(1), V3, AL-1). A registry entry is no evidence of which client is
 *    connected, and a note sent to Claude while chat is local still goes to
 *    Claude after the switch back.
 *  - **Dark (as shipped):** master's rule, `resolveAgentLabel` over
 *    `agentLabelSource()` (localStorage settings while dark), so a v0.13.x
 *    cohort's configured-model byline stays byte-identical.
 *
 * Same getter-export idiom as `createLayoutModel` (`layout/model.svelte.ts`).
 *
 * IMPORTANT (reactivity contract):
 *  - NEVER destructure the returned object (`const { family } = ...` freezes it).
 *    Always read `agentLabel.family` / `agentLabel.specific`.
 *  - When passing a label into a pure helper (e.g. `getAuthorLabel`), wrap the
 *    call in `$derived` at the call site so it re-runs when the label changes.
 */

import { BYO_MODELS_ENABLED } from "../../shared/constants";
import { CLAUDE_AGENT_LABEL, resolveAgentLabel } from "../utils/agentLabel.js";
import { agentLabelSource } from "./useModels.svelte.js";

export interface AgentLabel {
  /** Brand/family: "Claude" lit; dark, "Claude", "GPT", … from the registry. */
  readonly family: string;
  /** Status pill only: "Claude" lit; dark, the registry's model name. */
  readonly specific: string;
}

export function createAgentLabel(): AgentLabel {
  const family = $derived(
    BYO_MODELS_ENABLED ? CLAUDE_AGENT_LABEL : resolveAgentLabel(agentLabelSource(), "family"),
  );
  const specific = $derived(
    BYO_MODELS_ENABLED ? CLAUDE_AGENT_LABEL : resolveAgentLabel(agentLabelSource(), "model"),
  );
  return {
    get family() {
      return family;
    },
    get specific() {
      return specific;
    },
  };
}
