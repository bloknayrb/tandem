/**
 * Agent display labels (#438; the rule changed by #1123's agent-labels PR,
 * ADR-039 amendment 2026-11-17 (agent labels)).
 *
 * Tandem speaks MCP to any client (ADR-038: Claude is the default integration,
 * not the only one). Which label a surface shows depends on the flag:
 *
 *  - **`BYO_MODELS_ENABLED` on:** work that came through MCP reads "Claude"
 *    whatever the Models registry holds and whoever answers chat (P10(1), V3,
 *    and Label decisions L1 and L4 of 2026-11-17: plain "Claude" in 0.32). That rule lives in
 *    `createAgentLabel` (`hooks/useAgentLabel.svelte.ts`) and in
 *    `annotation.ts`'s `readAgentFamilyLabel`, not here. A local model's name
 *    appears only on a record it wrote, read from the record's `agentIdentity`
 *    (`agentBylineLabel` below).
 *  - **`BYO_MODELS_ENABLED` off (as shipped):** the label is resolved from the
 *    registry by `resolveAgentLabel`, unchanged since pre-M2, so a v0.13.x cohort
 *    that configured a model keeps its byline.
 *
 * `resolveAgentLabel` has two styles (`createAgentLabel` exposes them as
 * `family` and `specific`):
 *  - `"family"` — the brand ("Claude", "GPT", "Gemini", "Local model").
 *  - `"model"`  — the precise model, used ONLY in the status pill.
 *
 * Pure + framework-free so it can be unit-tested directly.
 */

import type { AgentIdentity } from "../../shared/types.js";
import type { ModelProvider, ModelRegistryEntry } from "../hooks/useTandemSettings.js";

export type AgentLabelStyle = "family" | "model";

/**
 * The registry projection this module resolves against — the Models store's
 * synchronous snapshot (`getModelsSnapshot()`), server-authoritative since M2.
 * `readonly` because the store hands out its live `$state` array.
 */
export interface AgentLabelSource {
  models: readonly ModelRegistryEntry[];
  defaultModelId: string | null;
}

/**
 * Brand/family name per provider. Small fixed map — deliberately NOT a
 * per-model lookup table (those drift). Local providers have no brand, so they
 * fall back to a neutral "Local model" in family mode.
 */
const PROVIDER_FAMILY: Record<ModelProvider, string> = {
  anthropic: "Claude",
  openai: "GPT",
  gemini: "Gemini",
  "local-ollama": "Local model",
  "local-llamacpp": "Local model",
  "local-lmstudio": "Local model",
  "local-other": "Local model",
};

/** Neutral label when no model is configured (or the selection is ambiguous). */
export const FALLBACK_AGENT_LABEL = "Assistant";

/**
 * Resolve the active model entry: the explicit default, or — when no default is
 * set but exactly one model exists — that sole model. A stale `defaultModelId`
 * is already coerced to `null` by `mergeAndClampSettings`, so a missing match
 * here genuinely means "none / ambiguous".
 */
function activeEntry(source: AgentLabelSource): ModelRegistryEntry | undefined {
  const byDefault = source.defaultModelId
    ? source.models.find((m) => m.id === source.defaultModelId)
    : undefined;
  if (byDefault) return byDefault;
  return source.models.length === 1 ? source.models[0] : undefined;
}

/**
 * Display label for the active agent.
 *
 * `family`  → brand ("Claude" / "GPT" / "Gemini" / "Local model").
 * `model`   → the entry's `displayName`, falling back to `modelId`, then family.
 * No model  → `"Assistant"`.
 */
export function resolveAgentLabel(source: AgentLabelSource, style: AgentLabelStyle): string {
  const entry = activeEntry(source);
  if (!entry) return FALLBACK_AGENT_LABEL;
  const family = PROVIDER_FAMILY[entry.provider] || FALLBACK_AGENT_LABEL;
  if (style === "family") return family;
  return entry.displayName || entry.modelId || family;
}

/** What Claude-side work reads while local models are on (P10(1), V3). */
export const CLAUDE_AGENT_LABEL = "Claude";

/**
 * A local-model record whose stamped `displayName` is empty (AL-7). The same
 * text the registry uses for a local provider's family.
 */
export const LOCAL_MODEL_LABEL = "Local model";

/**
 * The comment filter's agent chip and its summary while local models are on
 * (Label decision L3 of 2026-11-17, AL-3): one chip for comments from any AI.
 */
export const AI_FILTER_LABEL = "AI";

/**
 * Byline for an agent-authored row: the record's own stamped name when it
 * carries an `agentIdentity` (only the local-model collaborator writes one),
 * "Local model" when that stamped name is empty (AL-7), else `family` — the
 * label for Claude-side work. No flag: a dark build never writes
 * `agentIdentity`, so dark rows always take `family`.
 *
 * `||`, not `??`, on the name (an empty string must not render as an empty
 * byline), and the identity test first (a Claude-side row must never read
 * "Local model").
 */
export function agentBylineLabel(identity: AgentIdentity | undefined, family: string): string {
  return identity ? identity.displayName || LOCAL_MODEL_LABEL : family;
}
