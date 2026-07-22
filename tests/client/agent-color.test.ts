import { describe, expect, it } from "vitest";
import { agentColor } from "../../src/client/utils/agent-color";
import type { AgentIdentity, ModelProvider } from "../../src/shared/types";

function id(provider: ModelProvider, displayName = "Model"): AgentIdentity {
  return { provider, displayName };
}

describe("agentColor (#1123 M4)", () => {
  it("returns the EXACT current claude token for an absent identity (byte-identical dark)", () => {
    // This literal is copy-identical to the pre-M4 decoration sites' color, so
    // any drift (a stray space, an equivalent-but-different token) would break
    // the byte-identical-while-dark guarantee. Pin it as an exact string.
    expect(agentColor(undefined)).toBe("var(--tandem-author-claude)");
  });

  it("maps each provider to its pinned token (guards silent map drift)", () => {
    // Hardcoded expected vectors, NOT self-comparison — a self-equal assertion
    // passes even if the whole mapping is rewritten, which would repaint every
    // existing agent's annotations.
    expect(agentColor(id("anthropic"))).toBe("var(--tandem-author-claude)");
    expect(agentColor(id("openai"))).toBe("var(--tandem-agent-openai)");
    expect(agentColor(id("gemini"))).toBe("var(--tandem-agent-gemini)");
    expect(agentColor(id("local-ollama"))).toBe("var(--tandem-agent-local-ollama)");
    expect(agentColor(id("local-llamacpp"))).toBe("var(--tandem-agent-local-llamacpp)");
  });

  it("colors a non-anthropic agent distinctly from the claude fallback", () => {
    // The whole point of the wiring tests downstream: a present identity must
    // NOT collapse to the claude token (that would be indistinguishable from
    // the dark fallback and hide an unwired call site).
    expect(agentColor(id("local-ollama"))).not.toBe("var(--tandem-author-claude)");
  });

  it("is deterministic and independent of displayName (keys on provider only)", () => {
    expect(agentColor(id("local-ollama", "Qwen 2.5"))).toBe(
      agentColor(id("local-ollama", "Renamed Later")),
    );
  });

  it("emits only var() tokens, never a raw hex/rgba literal (token-lint safe)", () => {
    for (const provider of [
      "anthropic",
      "openai",
      "gemini",
      "local-ollama",
      "local-llamacpp",
    ] as const) {
      const color = agentColor(id(provider));
      expect(color).toMatch(/^var\(--tandem-/);
      expect(color).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(/);
    }
  });
});
