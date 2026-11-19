// @vitest-environment happy-dom

/**
 * Per-provider gating in the add/edit model modal (#1123; cloud providers
 * hidden, ADR-039 P4 and its "Shown as unavailable" pick).
 *
 * `ModelEditModal` has no internal `BYO_MODELS_ENABLED` gate — only its
 * call-site (`SettingsModelsTab`, mounted only when the flag is on) does — so a
 * direct mount renders the full flag-ON UI without any constant mock. The
 * contract under test: only local providers are offered (no cloud option, not
 * even a disabled one), a new entry defaults to a local provider, and an
 * existing cloud entry opens as unavailable — its name, its provider, "This
 * provider can't be used in Tandem." and Close, focused — with no form.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import ModelEditModal from "../../src/client/components/ModelEditModal.svelte";
import type { ModelRegistryEntry } from "../../src/client/hooks/useTandemSettings.svelte.js";
import { LOCAL_MODEL_PROVIDERS } from "../../src/shared/models/contract.js";

afterEach(() => {
  cleanup();
});

const LOCAL_VALUES = ["local-ollama", "local-llamacpp", "local-lmstudio", "local-other"];
const U1 = "This provider can't be used in Tandem.";
/** The cloud headings, as literals (never built from the product's maps). */
const U6: Readonly<Record<string, string>> = {
  anthropic: "Anthropic (API key)",
  openai: "OpenAI (API key)",
  gemini: "Gemini (API key)",
};
const CLOUD = ["anthropic", "openai", "gemini"] as const;
const norm = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim();

function mountAdd() {
  return render(ModelEditModal, {
    props: { onCancel: vi.fn(), onSave: vi.fn() },
  });
}

function mountEntry(entry: ModelRegistryEntry) {
  const onCancel = vi.fn();
  const onSave = vi.fn();
  const view = render(ModelEditModal, { props: { entry, onCancel, onSave } });
  return { ...view, onCancel, onSave };
}

function providerOptions(container: HTMLElement) {
  const select = container.querySelector<HTMLSelectElement>('[data-testid="model-edit-provider"]');
  if (!select) throw new Error("provider select not found");
  return { select, options: Array.from(select.options) };
}

/** The `role="dialog"` element (the scrim) and the description its
 *  `aria-describedby` points at, resolved through the DOM. */
function dialogOf(container: HTMLElement) {
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("dialog not found");
  const ids = (dialog.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  const description = ids.map((id) => norm(document.getElementById(id)?.textContent)).join(" ");
  return { dialog, ids, description };
}

describe("ModelEditModal — only local providers are offered", () => {
  it("defaults a new entry to a local provider", () => {
    const { container } = mountAdd();
    const { select } = providerOptions(container);
    expect(select.value).toBe("local-ollama");
  });

  const localCases: Array<[string, ModelRegistryEntry | undefined]> = [
    ["Add", undefined],
    ...LOCAL_MODEL_PROVIDERS.map((provider): [string, ModelRegistryEntry] => [
      `an ${provider} entry`,
      {
        id: `e-${provider}`,
        provider,
        displayName: "Mine",
        modelId: "m",
        endpoint: "http://127.0.0.1:9",
        enabled: true,
      },
    ]),
  ];

  for (const [name, entry] of localCases) {
    it(`${name}: the select offers exactly the four local providers, none disabled, and no cloud copy`, () => {
      const view = entry ? mountEntry(entry) : mountAdd();
      const { options } = providerOptions(view.container);
      expect(options.map((o) => o.value)).toEqual(LOCAL_VALUES);
      for (const o of options) expect(o.disabled).toBe(false);
      const { dialog, ids } = dialogOf(view.container);
      expect(dialog.textContent ?? "").not.toMatch(
        /coming soon|future release|OpenAI(?!-compatible)|Gemini|Anthropic/i,
      );
      expect(ids).not.toContain("model-edit-unavailable-text");
      expect(view.queryByTestId("model-edit-unavailable-close")).toBeNull();
      expect(view.queryByTestId("model-edit-provider-note")).toBeNull();
      // Moves no focus on mount (the edit window's focus is ADR-039 item 27's).
      expect(dialog.contains(document.activeElement)).toBe(false);
    });
  }

  it("a local provider uses the endpoint field, not an API key", () => {
    const { queryByTestId } = mountAdd();
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
});

describe("ModelEditModal — an old cloud entry is shown as unavailable", () => {
  const variants: Array<[string, Partial<ModelRegistryEntry>]> = [
    ["with a key, on", { apiKeyRef: "ref-abcd", enabled: true }],
    ["with a key, off", { apiKeyRef: "ref-abcd", enabled: false }],
    ["no key, on", { enabled: true }],
    ["no key, off", { enabled: false }],
  ];

  for (const provider of CLOUD) {
    for (const [variant, extra] of variants) {
      it(`${provider}, ${variant}: name, provider, the sentence and Close, focused; no form`, () => {
        const v = mountEntry({
          id: `c-${provider}`,
          provider,
          displayName: "My key",
          modelId: "some-model",
          enabled: true,
          ...extra,
        });
        const { dialog, description } = dialogOf(v.container);
        expect(dialog.getAttribute("aria-label")).toBe("Model unavailable");
        expect(norm(v.container.querySelector(".mem-title")?.textContent)).toBe(
          "Model unavailable",
        );
        expect(norm(v.getByTestId("model-edit-unavailable-provider").textContent)).toBe(
          U6[provider],
        );
        expect(norm(v.getByTestId("model-edit-provider-note").textContent)).toBe(U1);
        expect(description).toBe(U1);
        expect(dialog.textContent).toContain("My key");
        expect(v.getByTestId("model-edit-cancel")).toBeTruthy();
        const close = v.getByTestId("model-edit-unavailable-close");
        expect(norm(close.textContent)).toBe("Close");
        for (const sel of ["form", "select", "input"]) {
          expect(dialog.querySelector(sel), sel).toBeNull();
        }
        expect(v.queryByTestId("model-edit-save")).toBeNull();
        expect(v.queryByTestId("model-edit-apikey")).toBeNull();
        expect(v.queryByTestId("model-edit-apikey-replace-btn")).toBeNull();
        expect(document.activeElement).toBe(close);
      });
    }
  }

  it("an entry with no display name is named by its model ID", () => {
    const v = mountEntry({
      id: "c-1",
      provider: "openai",
      displayName: "  ",
      modelId: "gpt-model-x",
      enabled: true,
    });
    const name = v.container.querySelector(".mem-unavailable-name");
    expect(norm(name?.textContent)).toBe("gpt-model-x");
  });

  it("Escape on Close cancels once and stays in the dialog; Enter never saves; a click on Close cancels once", async () => {
    const v = mountEntry({
      id: "c-1",
      provider: "anthropic",
      displayName: "My Claude",
      modelId: "claude-x",
      apiKeyRef: "ref-abcd",
      enabled: true,
    });
    const reachedDocument = vi.fn();
    document.addEventListener("keydown", reachedDocument);
    try {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    } finally {
      document.removeEventListener("keydown", reachedDocument);
    }
    expect(v.onCancel).toHaveBeenCalledTimes(1);
    expect(reachedDocument).not.toHaveBeenCalled();

    const close = v.getByTestId("model-edit-unavailable-close");
    close.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(v.onSave).not.toHaveBeenCalled();

    v.onCancel.mockClear();
    await fireEvent.click(close);
    expect(v.onCancel).toHaveBeenCalledTimes(1);
    expect(v.onSave).not.toHaveBeenCalled();
  });
});

describe("ModelEditModal — source pins (a placeholder is an attribute, so text checks miss it)", () => {
  it("names none of the removed cloud strings", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "../../src/client/components/ModelEditModal.svelte"),
      "utf8",
    )
      .replace(/\r\n/g, "\n")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const gone of ["coming soon", "future release", "My Anthropic key", "claude-opus"]) {
      expect(src, gone).not.toContain(gone);
    }
  });
});

describe("ModelEditModal — Escape", () => {
  it("cancels and keeps the key from SettingsModal's document listener", () => {
    // The modal renders inside SettingsModal. With a real key press, Svelte's
    // flush removes this dialog in the microtask gap between its delegated
    // handler and Settings' document listener, so Settings' "another modal is
    // open" check no longer sees it — only stopPropagation keeps one press from
    // closing both. A synthetic dispatch has no such gap, so this pins the
    // stop itself.
    const onCancel = vi.fn();
    const { getByTestId } = render(ModelEditModal, { props: { onCancel, onSave: vi.fn() } });
    const reachedDocument = vi.fn();
    document.addEventListener("keydown", reachedDocument);
    try {
      getByTestId("model-edit-provider").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    } finally {
      document.removeEventListener("keydown", reachedDocument);
    }
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(reachedDocument).not.toHaveBeenCalled();
  });
});
