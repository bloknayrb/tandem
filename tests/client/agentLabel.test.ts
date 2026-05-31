import { describe, expect, it } from "vitest";
import type { ModelProvider, ModelRegistryEntry } from "../../src/client/hooks/useTandemSettings";
import { FALLBACK_AGENT_LABEL, resolveAgentLabel } from "../../src/client/utils/agentLabel";

function model(
  over: Partial<ModelRegistryEntry> & { provider: ModelProvider },
): ModelRegistryEntry {
  return {
    id: over.id ?? crypto.randomUUID(),
    displayName: over.displayName ?? "",
    modelId: over.modelId ?? "some-model",
    enabled: over.enabled ?? true,
    ...over,
  };
}

describe("resolveAgentLabel", () => {
  it("maps each cloud provider to its brand family", () => {
    const cases: Array<[ModelProvider, string]> = [
      ["anthropic", "Claude"],
      ["openai", "GPT"],
      ["gemini", "Gemini"],
    ];
    for (const [provider, family] of cases) {
      const m = model({ provider, displayName: "X" });
      const settings = { models: [m], defaultModelId: m.id };
      expect(resolveAgentLabel(settings, "family")).toBe(family);
    }
  });

  it("uses displayName for the specific (model) style", () => {
    const m = model({
      provider: "anthropic",
      displayName: "Claude Opus 4.8",
      modelId: "claude-opus-4-8",
    });
    const settings = { models: [m], defaultModelId: m.id };
    expect(resolveAgentLabel(settings, "model")).toBe("Claude Opus 4.8");
    expect(resolveAgentLabel(settings, "family")).toBe("Claude");
  });

  it("falls back to modelId when displayName is blank in model style", () => {
    const m = model({ provider: "openai", displayName: "", modelId: "gpt-4o" });
    const settings = { models: [m], defaultModelId: m.id };
    expect(resolveAgentLabel(settings, "model")).toBe("gpt-4o");
  });

  it("labels local providers 'Local model' in family style (not empty)", () => {
    for (const provider of ["local-ollama", "local-llamacpp"] as const) {
      const m = model({ provider, displayName: "", modelId: "llama3.1:70b" });
      const settings = { models: [m], defaultModelId: m.id };
      expect(resolveAgentLabel(settings, "family")).toBe("Local model");
      // model style still surfaces the concrete id when there's no displayName
      expect(resolveAgentLabel(settings, "model")).toBe("llama3.1:70b");
    }
  });

  it("returns 'Assistant' when no model is configured", () => {
    const settings = { models: [], defaultModelId: null };
    expect(resolveAgentLabel(settings, "family")).toBe(FALLBACK_AGENT_LABEL);
    expect(resolveAgentLabel(settings, "model")).toBe(FALLBACK_AGENT_LABEL);
  });

  it("uses the sole model when exactly one exists and no default is set (S5)", () => {
    const m = model({ provider: "anthropic", displayName: "Claude" });
    const settings = { models: [m], defaultModelId: null };
    expect(resolveAgentLabel(settings, "family")).toBe("Claude");
  });

  it("returns 'Assistant' when multiple models exist but none is default (ambiguous)", () => {
    const a = model({ provider: "anthropic", displayName: "Claude" });
    const b = model({ provider: "openai", displayName: "GPT" });
    const settings = { models: [a, b], defaultModelId: null };
    expect(resolveAgentLabel(settings, "family")).toBe(FALLBACK_AGENT_LABEL);
  });

  it("resolves the explicit default among several models", () => {
    const a = model({ provider: "anthropic", displayName: "Claude" });
    const b = model({ provider: "gemini", displayName: "Gemini 2.0" });
    const settings = { models: [a, b], defaultModelId: b.id };
    expect(resolveAgentLabel(settings, "family")).toBe("Gemini");
    expect(resolveAgentLabel(settings, "model")).toBe("Gemini 2.0");
  });
});
