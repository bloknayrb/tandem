// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_MODEL_PROVIDERS, type ModelProvider } from "../../src/shared/models/contract.js";
import { asTandemOwnWindow } from "../helpers/models-write-access.svelte";

const addModel = vi.fn<(...args: unknown[]) => Promise<string | null>>();
const setDefault = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const clearError = vi.fn();
let storeSaveError: string | null = null;

vi.mock(import("../../src/client/hooks/useModels.svelte"), () => ({
  createModels: () => ({
    addModel,
    setDefault,
    clearError,
    get saveError() {
      return storeSaveError;
    },
    // The rest of `ModelsState`. This double named four members and matched
    // nothing before the typed mock overload (#1615).
    models: [],
    defaultModelId: null,
    // #1123: the list has loaded (the first-run window waits for it).
    loaded: true,
    loading: false,
    loadFailed: false,
    updateModel: vi.fn(async () => true),
    deleteModel: vi.fn(async () => {}),
    toggleEnabled: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
  }),
}));

const { default: FirstRunModelPickerModal } = await import(
  "../../src/client/components/FirstRunModelPickerModal.svelte"
);

beforeEach(() => {
  addModel.mockReset();
  setDefault.mockReset();
  clearError.mockReset();
  setDefault.mockResolvedValue(true);
  storeSaveError = null;
});

afterEach(() => {
  cleanup();
});

// The ordinary tab: these suites run as Tandem's own window (#2404). The
// blocked state has its own file, settings-models-tab-own-window.test.ts.
asTandemOwnWindow();

/**
 * #1123 (LM Studio and "another local server", 2026-11-15): the picker's
 * provider rows, its address prefill and swap rule (R2.3, string equality
 * only), the hint (S3), the subtitle (S6) and Other's name (Ruling L-h).
 */

/** Each local provider's prefill, as literals (never `LOCAL_ENDPOINT_PREFILL`). */
const PREFILL_LITERAL: Readonly<Record<string, string>> = {
  "local-ollama": "http://127.0.0.1:11434",
  "local-llamacpp": "",
  "local-lmstudio": "http://127.0.0.1:1234",
  "local-other": "",
};

/** S3 per local provider, as literals (never built with `endpointHint`). */
const HINT_WITH_PORT = (address: string) =>
  `The server's address on this computer, for example ${address}. Leave off /chat/completions; a trailing /v1 is ignored.`;
const HINT_NO_PORT =
  "The server's address on this computer, including its port, for example http://127.0.0.1 followed by the port. Leave off /chat/completions; a trailing /v1 is ignored.";
const HINT: Readonly<Record<string, string>> = {
  "local-ollama": HINT_WITH_PORT("http://127.0.0.1:11434"),
  "local-llamacpp": HINT_NO_PORT,
  "local-lmstudio": HINT_WITH_PORT("http://127.0.0.1:1234"),
  "local-other": HINT_NO_PORT,
};

function mount() {
  return render(FirstRunModelPickerModal, { props: { onComplete: vi.fn() } });
}

type Mounted = ReturnType<typeof mount>;
const endpointField = (m: Mounted) => m.getByTestId("first-run-endpoint") as HTMLInputElement;
async function choose(m: Mounted, p: ModelProvider) {
  await fireEvent.click(m.getByTestId(`first-run-provider-${p}`));
}
async function typeEndpoint(m: Mounted, value: string) {
  await fireEvent.input(endpointField(m), { target: { value } });
}

describe("first-run picker — local providers offered", () => {
  it("offers every local provider, enabled, in contract order, and no cloud row (P4)", () => {
    const m = mount();
    for (const p of LOCAL_MODEL_PROVIDERS) {
      const radio = m.getByTestId(`first-run-provider-${p}`) as HTMLInputElement;
      expect(radio.disabled).toBe(false);
    }
    expect(m.getByText("LM Studio (local)")).toBeTruthy();
    expect(m.getByText("Other local server (OpenAI-compatible)")).toBeTruthy();
    // The radios' DOM order, as a literal list: the locals only.
    const order = Array.from(
      m
        .getByTestId("first-run-providers")
        .querySelectorAll<HTMLInputElement>("input[type='radio']"),
    ).map((r) => r.value);
    expect(order).toEqual(["local-ollama", "local-llamacpp", "local-lmstudio", "local-other"]);
  });
});

describe("first-run picker — address prefill (R2.3)", () => {
  it("opens on Ollama with Ollama's prefill, written with 127.0.0.1", () => {
    expect(endpointField(mount()).value).toBe("http://127.0.0.1:11434");
  });

  for (const p of LOCAL_MODEL_PROVIDERS) {
    it(`switching from an untouched field to ${p} sets its prefill`, async () => {
      const m = mount();
      await choose(m, p);
      expect(endpointField(m).value).toBe(PREFILL_LITERAL[p]);
    });
  }

  it("a typed address that equals no prefill survives every switch", async () => {
    const m = mount();
    await typeEndpoint(m, "http://127.0.0.1:5000");
    for (const p of [...LOCAL_MODEL_PROVIDERS, ...LOCAL_MODEL_PROVIDERS].reverse()) {
      await choose(m, p);
      expect(endpointField(m).value).toBe("http://127.0.0.1:5000");
    }
  });

  it("Ollama, cleared by hand, then Other: stays empty; then LM Studio: LM Studio's prefill", async () => {
    const m = mount();
    await typeEndpoint(m, "");
    await choose(m, "local-other");
    // Empty is not Ollama's prefill, so the field is left alone.
    expect(endpointField(m).value).toBe("");
    await choose(m, "local-lmstudio");
    // Empty IS Other's prefill (it has none), so the switch fills it.
    expect(endpointField(m).value).toBe("http://127.0.0.1:1234");
  });

  // #2437's carried Low: one provider's prefill typed under ANOTHER provider is
  // a typed address, so a rule that compared against any prefill would fail.
  it("LM Studio, Ollama's prefill typed, then Other: the typed address is kept", async () => {
    const m = mount();
    await choose(m, "local-lmstudio");
    await typeEndpoint(m, "http://127.0.0.1:11434");
    await choose(m, "local-other");
    expect(endpointField(m).value).toBe("http://127.0.0.1:11434");
  });

  it("Ollama, LM Studio's prefill typed, then llama.cpp by a bare change event: kept", async () => {
    const m = mount();
    await typeEndpoint(m, "http://127.0.0.1:1234");
    // No click: pins only that the handler runs on `change` (Ruling H-2), not
    // anything about keyboard selection in a real browser.
    await fireEvent.change(m.getByTestId("first-run-provider-local-llamacpp"));
    expect(endpointField(m).value).toBe("http://127.0.0.1:1234");
    // The switch happened: llama.cpp's hint (no port) describes the field.
    expect(m.getByTestId("first-run-endpoint-hint").textContent?.trim()).toBe(HINT_NO_PORT);
  });

  it("an address typed equal to Ollama's prefill is treated as the prefill and replaced", async () => {
    const m = mount();
    await typeEndpoint(m, "");
    await typeEndpoint(m, "http://127.0.0.1:11434");
    await choose(m, "local-lmstudio");
    expect(endpointField(m).value).toBe("http://127.0.0.1:1234");
  });

  // V8: no provider prefills the Model ID, so Save cannot save until it is
  // filled; it stays focusable and says why (V14).
  for (const p of LOCAL_MODEL_PROVIDERS) {
    it(`${p} starts with no model id, so Save cannot save until it is filled`, async () => {
      const m = mount();
      await choose(m, p);
      expect((m.getByTestId("first-run-modelid") as HTMLInputElement).value).toBe("");
      await typeEndpoint(m, "http://127.0.0.1:1234");
      const save = m.getByTestId("first-run-save") as HTMLButtonElement;
      expect(save.getAttribute("aria-disabled")).toBe("true");
      expect(m.getByTestId("first-run-save-reason").textContent?.trim()).toBe(
        "Enter a Model ID to save.",
      );
      await fireEvent.input(m.getByTestId("first-run-modelid"), { target: { value: "qwen" } });
      expect(save.getAttribute("aria-disabled")).toBe("false");
      expect(m.queryByTestId("first-run-save-reason")).toBeNull();
    });
  }

  it("the Model ID stays empty through every switch, and a typed one is kept", async () => {
    const m = mount();
    const id = () => (m.getByTestId("first-run-modelid") as HTMLInputElement).value;
    for (const p of [...LOCAL_MODEL_PROVIDERS].reverse()) {
      await choose(m, p);
      expect(id()).toBe("");
    }
    await fireEvent.input(m.getByTestId("first-run-modelid"), { target: { value: "mine" } });
    for (const p of LOCAL_MODEL_PROVIDERS) {
      await choose(m, p);
      expect(id()).toBe("mine");
    }
  });

  // V2: llama.cpp and Other have no address prefill, so Save names both fields.
  it("llama.cpp and Other: Save names the Endpoint URL and the Model ID", async () => {
    for (const p of ["local-llamacpp", "local-other"] as const) {
      const m = mount();
      await choose(m, p);
      expect(m.getByTestId("first-run-save-reason").textContent?.trim()).toBe(
        "Enter an Endpoint URL and a Model ID to save.",
      );
      cleanup();
    }
  });
});

describe("first-run picker — copy (S3, the subtitle, Ruling L-h)", () => {
  for (const p of LOCAL_MODEL_PROVIDERS) {
    it(`${p}: the hint describes the Endpoint URL field, outside its label`, async () => {
      const m = mount();
      await choose(m, p);
      const hint = HINT[p];
      // Fails if the hint is inside the label (the name would change) or not linked.
      const field = m.getByRole("textbox", { name: "Endpoint URL", description: hint });
      expect(field).toBe(endpointField(m));
      expect(m.getByTestId("first-run-endpoint-hint").textContent?.trim()).toBe(hint);
      // The subtitle no longer counts steps (#1123 item 21).
      expect(m.getByTestId("first-run-subtitle").textContent?.trim()).toBe(
        "Chat stays set to Claude. Your model server must be running on this computer for Tandem to use the model; you can also add models any time in Settings → Models.",
      );
      expect(m.queryByText(/OS keychain/)).toBeNull();
    });
  }

  it("the hint names the prefill when there is one, and no port when there is none", async () => {
    const m = mount();
    expect(m.getByTestId("first-run-endpoint-hint").textContent?.trim()).toBe(
      "The server's address on this computer, for example http://127.0.0.1:11434. Leave off /chat/completions; a trailing /v1 is ignored.",
    );
    await choose(m, "local-other");
    const text = m.getByTestId("first-run-endpoint-hint").textContent?.trim() ?? "";
    expect(text).toBe(
      "The server's address on this computer, including its port, for example http://127.0.0.1 followed by the port. Leave off /chat/completions; a trailing /v1 is ignored.",
    );
    expect(text).not.toMatch(/:\d{2,5}\b/);
  });

  it("Other: the Display name placeholder and the blank-name fallback are 'Local server'", async () => {
    addModel.mockResolvedValue("new-id");
    const m = mount();
    await choose(m, "local-other");
    const name = m.getByTestId("first-run-displayname") as HTMLInputElement;
    expect(name.placeholder).toBe("Local server");
    await typeEndpoint(m, "http://127.0.0.1:8000");
    await fireEvent.input(m.getByTestId("first-run-modelid"), { target: { value: "m" } });
    await fireEvent.click(m.getByTestId("first-run-save"));
    expect(addModel).toHaveBeenCalledTimes(1);
    expect(addModel.mock.calls[0][0]).toMatchObject({
      provider: "local-other",
      displayName: "Local server",
      endpoint: "http://127.0.0.1:8000",
    });
  });

  it("LM Studio: the Display name placeholder and fallback are its label", async () => {
    addModel.mockResolvedValue("new-id");
    const m = mount();
    await choose(m, "local-lmstudio");
    expect((m.getByTestId("first-run-displayname") as HTMLInputElement).placeholder).toBe(
      "LM Studio (local)",
    );
    // No model id is prefilled (V8), so one is typed before Save.
    await fireEvent.input(m.getByTestId("first-run-modelid"), { target: { value: "m" } });
    await fireEvent.click(m.getByTestId("first-run-save"));
    expect(addModel.mock.calls[0][0]).toMatchObject({
      provider: "local-lmstudio",
      displayName: "LM Studio (local)",
      endpoint: "http://127.0.0.1:1234",
    });
  });

  it("no text in the picker says a model 'answers'", async () => {
    const m = mount();
    for (const p of LOCAL_MODEL_PROVIDERS) {
      await choose(m, p);
      expect(m.getByTestId("first-run-model-modal").textContent).not.toMatch(/answers/i);
    }
  });
});
