/**
 * Agent-agnostic display labels (#438).
 *
 * Tandem speaks MCP to any LLM (ADR-038: Claude is the default integration, not
 * the only one). The UI must not hardcode "Claude" — a user running GPT/Gemini/
 * a local model should see *their* model named. This module resolves a display
 * label for the user's currently-selected model from the Models registry.
 *
 * Two granularities, applied by a fixed per-surface rule (no user toggle):
 *  - `family`   — the brand ("Claude", "GPT", "Gemini"). Used for inline identity
 *                 everywhere: author labels, chat, presence, filters, and the
 *                 imperative "Send to {X}" buttons (concise).
 *  - `specific` — the precise model ("Claude Opus 4.8"). Used ONLY in the status
 *                 pill, the one place the verbose form is welcome.
 *
 * Pure + framework-free so it can be unit-tested directly. Reactivity lives in
 * the `createAgentLabel` rune wrapper (`hooks/useAgentLabel.svelte.ts`).
 */

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
