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
import type { TandemSettingsState } from "./useTandemSettings.svelte.js";

export interface AgentLabel {
  /** Brand/family ("Claude", "GPT", …). Inline identity + action buttons. */
  readonly family: string;
  /** Specific model ("Claude Opus 4.8"). Status pill only. */
  readonly specific: string;
}

export function createAgentLabel(settingsState: TandemSettingsState): AgentLabel {
  const family = $derived(resolveAgentLabel(settingsState.settings, "family"));
  const specific = $derived(resolveAgentLabel(settingsState.settings, "model"));
  return {
    get family() {
      return family;
    },
    get specific() {
      return specific;
    },
  };
}
