// @vitest-environment happy-dom

/**
 * Per-provider gating in the add/edit model modal (#1123 M2b §3.4).
 *
 * `ModelEditModal` has no internal `BYO_MODELS_ENABLED` gate — only its
 * call-site (`SettingsModelsTab`, mounted only when the flag is on) does — so a
 * direct mount renders the full flag-ON UI without any constant mock. The
 * contract under test: v1.0 ships local providers only, so cloud `<option>`s are
 * disabled with a "coming soon" label, a new entry defaults to a local provider,
 * and an existing cloud entry keeps its (now-disabled) provider without silently
 * disappearing.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import ModelEditModal from "../../src/client/components/ModelEditModal.svelte";
import type { ModelRegistryEntry } from "../../src/client/hooks/useTandemSettings.svelte.js";

afterEach(() => {
  cleanup();
});

function mountAdd() {
  return render(ModelEditModal, {
    props: { onCancel: vi.fn(), onSave: vi.fn() },
  });
}

function providerOptions(container: HTMLElement) {
  const select = container.querySelector<HTMLSelectElement>('[data-testid="model-edit-provider"]');
  if (!select) throw new Error("provider select not found");
  return { select, options: Array.from(select.options) };
}

describe("ModelEditModal — per-provider gating (§3.4)", () => {
  it("defaults a new entry to a local provider", () => {
    const { container } = mountAdd();
    const { select } = providerOptions(container);
    expect(select.value).toBe("local-ollama");
  });

  it("disables cloud providers and enables local ones, cloud labelled 'coming soon'", () => {
    const { container } = mountAdd();
    const { options } = providerOptions(container);

    const byValue = Object.fromEntries(options.map((o) => [o.value, o]));
    // Local providers: enabled, no "coming soon".
    for (const v of ["local-ollama", "local-llamacpp"]) {
      expect(byValue[v].disabled).toBe(false);
      expect(byValue[v].textContent).not.toMatch(/coming soon/i);
    }
    // Cloud providers: disabled, labelled "coming soon".
    for (const v of ["anthropic", "openai", "gemini"]) {
      expect(byValue[v].disabled).toBe(true);
      expect(byValue[v].textContent).toMatch(/coming soon/i);
    }
  });

  it("orders local providers first in the picker", () => {
    const { container } = mountAdd();
    const { options } = providerOptions(container);
    expect(options.slice(0, 2).map((o) => o.value)).toEqual(["local-ollama", "local-llamacpp"]);
  });

  it("shows no cloud 'coming soon' note while a local provider is selected", () => {
    const { queryByTestId } = mountAdd();
    // Default provider is local-ollama → the note is gated off.
    expect(queryByTestId("model-edit-provider-note")).toBeNull();
    // Local providers use the endpoint field, not an API key.
    expect(queryByTestId("model-edit-endpoint")).not.toBeNull();
    expect(queryByTestId("model-edit-apikey")).toBeNull();
  });

  it("requires an endpoint before a new local model can be saved", async () => {
    const { getByTestId } = mountAdd();
    const save = () => getByTestId("model-edit-save") as HTMLButtonElement;
    // Default provider is local-ollama → endpoint field is present and empty.
    await fireEvent.input(getByTestId("model-edit-displayname"), { target: { value: "My local" } });
    await fireEvent.input(getByTestId("model-edit-modelid"), { target: { value: "qwen2.5:14b" } });
    // displayName + modelId filled but endpoint still blank → save stays disabled.
    expect(save().disabled).toBe(true);
    await fireEvent.input(getByTestId("model-edit-endpoint"), {
      target: { value: "http://127.0.0.1:11434" },
    });
    expect(save().disabled).toBe(false);
  });

  it("keeps an existing cloud entry's provider selected and surfaces the note (no silent hide)", () => {
    const cloudEntry: ModelRegistryEntry = {
      id: "c-1",
      provider: "anthropic",
      displayName: "My Claude",
      modelId: "claude-opus-4-8",
      apiKeyRef: "ref-abcd",
      enabled: true,
    };
    const { container, queryByTestId } = render(ModelEditModal, {
      props: { entry: cloudEntry, onCancel: vi.fn(), onSave: vi.fn() },
    });
    const { select, options } = providerOptions(container);
    // The stored cloud provider is still the selected value — not dropped.
    expect(select.value).toBe("anthropic");
    // The option itself stays disabled (can't re-pick cloud), but present.
    expect(options.find((o) => o.value === "anthropic")?.disabled).toBe(true);
    // A cloud selection surfaces the "choose a local provider" note.
    expect(queryByTestId("model-edit-provider-note")).not.toBeNull();
  });
});
