/**
 * Per-agent authorship color (#1123 M4, ADR-039).
 *
 * Maps an annotation/reply/chat record's {@link AgentIdentity} to a CSS color
 * token, keyed on the closed `provider` enum (NOT the freeform, user-editable
 * `displayName` — `agentIdentity` is a frozen per-record snapshot, so hashing
 * the display name would repaint one agent across a rename). Keying on the
 * bounded enum lets each provider carry a hand-tuned light/dark token in
 * `index.html`, so theme adaptation is free and the token lint (which flags
 * only raw hex/rgba literals) is a non-issue.
 *
 * DARK-SAFETY: `agentIdentity` is set solely by the flag-gated collaborator
 * loop, so while `BYO_MODELS_ENABLED` is false no record carries it and every
 * caller hits the `undefined` branch, which returns the EXACT current
 * `var(--tandem-author-claude)` literal the decoration surfaces used before M4
 * — byte-identical output. `anthropic` reuses that same coral (Claude family);
 * only the `local-*` providers are exercised by the loop today (cloud BYO is
 * v1.1), but the full map is bounded and cheap.
 */
import type { ModelProvider } from "../../shared/models/contract.js";
import type { AgentIdentity } from "../../shared/types.js";

/** The pre-M4 author color — the byte-identical-dark fallback and the `anthropic`
 *  (Claude family) mapping both resolve to this exact literal. */
const CLAUDE = "var(--tandem-author-claude)";

const AGENT_COLOR_VARS: Record<ModelProvider, string> = {
  anthropic: CLAUDE,
  openai: "var(--tandem-agent-openai)",
  gemini: "var(--tandem-agent-gemini)",
  "local-ollama": "var(--tandem-agent-local-ollama)",
  "local-llamacpp": "var(--tandem-agent-local-llamacpp)",
};

/**
 * The decoration color for an agent-authored record. Returns the exact
 * `var(--tandem-author-claude)` fallback when `identity` is absent (every
 * dark-mode record) or names an unknown provider.
 */
export function agentColor(identity?: AgentIdentity): string {
  if (!identity) return CLAUDE;
  return AGENT_COLOR_VARS[identity.provider] ?? CLAUDE;
}

/**
 * The per-agent tint for a class-driven surface (reply byline, peek dot) that
 * must add NO inline style when no identity is present — returning `undefined`
 * so the element's CSS class keeps rendering `--tandem-author-claude` unchanged
 * (byte-identical DOM while dark). Use `agentColor` directly on surfaces that
 * already emit an inline color unconditionally (card dot, underline, leader).
 */
export function agentTintColor(identity?: AgentIdentity): string | undefined {
  return identity ? agentColor(identity) : undefined;
}
