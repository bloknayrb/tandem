// @vitest-environment happy-dom

/**
 * #1123 (LM Studio and "another local server", 2026-11-15): the edit modal's
 * providers, placeholders, hint (S3) and copy (S1, S2, S4). The modal has no
 * flag gate of its own (its call site does), so a direct mount is flag-on.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import ModelEditModal from "../../src/client/components/ModelEditModal.svelte";
import type { ModelRegistryEntry } from "../../src/client/hooks/useTandemSettings.svelte.js";
import {
  endpointHint,
  LOCAL_REQUEST_LINE,
  LOCAL_SENT_TO_LINE,
  LOCAL_SERVERS_LINE,
} from "../../src/client/utils/local-model-copy.js";
import {
  isLocalProvider,
  LOCAL_MODEL_PROVIDERS,
  type ModelProvider,
} from "../../src/shared/models/contract.js";
import { LOCAL_ENDPOINT_PREFILL } from "../../src/shared/models/provider-ui.js";

afterEach(() => cleanup());

/**
 * `withEndpoint: false` mounts an entry of `provider` with no saved address,
 * which shows an empty field with the provider's usual address as placeholder
 * (a new entry instead starts with the address filled in, V2). The select is a
 * `value` plus an `onchange` that reads the select's own value (#1123, the
 * test-hardening PR, R3.1), so a change event switches the provider here too:
 * see "the provider switch, driven" below.
 */
function mountWith(provider?: ModelProvider, withEndpoint = true) {
  const entry: ModelRegistryEntry | undefined = provider
    ? {
        id: `e-${provider}`,
        provider,
        displayName: "Mine",
        modelId: "m",
        enabled: true,
        ...(isLocalProvider(provider)
          ? withEndpoint
            ? { endpoint: "http://127.0.0.1:9" }
            : {}
          : { apiKeyRef: "ref-abcd" }),
      }
    : undefined;
  return render(ModelEditModal, { props: { entry, onCancel: vi.fn(), onSave: vi.fn() } });
}

// Literal tables (#2437's carried Low): never built from the product's maps.
const PLACEHOLDER: Readonly<Record<string, string>> = {
  "local-ollama": "http://127.0.0.1:11434",
  "local-llamacpp": "",
  "local-lmstudio": "http://127.0.0.1:1234",
  "local-other": "",
};
/** The Display name placeholder on Add, per provider (R5's existing names). */
const NAME_PLACEHOLDER: Readonly<Record<string, string>> = {
  "local-ollama": "Ollama (local)",
  "local-llamacpp": "llama.cpp (local)",
  "local-lmstudio": "LM Studio (local)",
  "local-other": "Local server",
};
/** S7 as a literal: two sentences, one paragraph (26c). */
const S7 =
  "For this model, Tandem sends your document's text only to the Endpoint address you enter. The model server at that address may pass it on.";
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
const S1 =
  "Tandem can use a model server on this computer that offers the OpenAI-compatible chat API, such as Ollama, LM Studio or llama.cpp. Hugging Face models can be used through one of these if the server runs them. Tandem does not download models.";
const S2 =
  'When Tandem sends your local model a message, it includes your document\'s text when the document is short, tools for reading your document, and, in Tandem mode if you allow it under "Local models and your document", tools for adding comments and suggestions. Tandem reads the reply as a stream. A server or model that does not support tool calling may fail. Models differ in how well they do this.';

describe("ModelEditModal — every local provider", () => {
  for (const p of LOCAL_MODEL_PROVIDERS) {
    it(`${p}: an existing entry opens with its provider selected`, () => {
      const m = mountWith(p);
      expect((m.getByTestId("model-edit-provider") as HTMLSelectElement).value).toBe(p);
      // ...and keeps its saved address, never a prefill.
      expect((m.getByTestId("model-edit-endpoint") as HTMLInputElement).value).toBe(
        "http://127.0.0.1:9",
      );
    });

    it(`${p}: no saved address shows empty, with the provider's prefill as placeholder`, () => {
      const m = mountWith(p, false);
      const field = m.getByTestId("model-edit-endpoint") as HTMLInputElement;
      expect(field.value).toBe("");
      expect(field.placeholder).toBe(PLACEHOLDER[p]);
    });

    it(`${p}: S1, S2, S7 and S3 are shown, and the hint describes the Endpoint field`, async () => {
      const m = mountWith(p, false);
      const intro = m.getByTestId("model-edit-local-intro").textContent ?? "";
      expect(intro).toContain(LOCAL_SERVERS_LINE);
      expect(intro).toContain(LOCAL_REQUEST_LINE);
      expect(intro).toContain(S7);
      const field = m.getByRole("textbox", { name: "Endpoint", description: HINT[p] });
      expect(field).toBe(m.getByTestId("model-edit-endpoint"));
      // The select's own name is untouched by the copy placed after it.
      expect(m.getByRole("combobox", { name: "Provider" })).toBe(
        m.getByTestId("model-edit-provider"),
      );
    });

    it(`${p}: an existing entry's Display name and Model ID placeholders are blank`, async () => {
      const m = mountWith(p, false);
      expect((m.getByTestId("model-edit-displayname") as HTMLInputElement).placeholder).toBe("");
      expect((m.getByTestId("model-edit-modelid") as HTMLInputElement).placeholder).toBe("");
    });
  }

  it("A1: a new entry starts at Ollama's usual address (V2)", () => {
    const field = mountWith().getByTestId("model-edit-endpoint") as HTMLInputElement;
    expect(field.value).toBe("http://127.0.0.1:11434");
    expect(field.placeholder).toBe("http://127.0.0.1:11434");
  });

  it("the placeholders per provider are the documented ones", () => {
    expect(LOCAL_ENDPOINT_PREFILL).toMatchObject({
      "local-ollama": "http://127.0.0.1:11434",
      "local-lmstudio": "http://127.0.0.1:1234",
      "local-llamacpp": "",
      "local-other": "",
    });
  });
});

describe("ModelEditModal — the hint's two shapes (S3)", () => {
  it("with a prefill it names it; without one it names no port", () => {
    expect(endpointHint("http://127.0.0.1:1234")).toBe(
      "The server's address on this computer, for example http://127.0.0.1:1234. Leave off /chat/completions; a trailing /v1 is ignored.",
    );
    const none = endpointHint("");
    expect(none).toBe(
      "The server's address on this computer, including its port, for example http://127.0.0.1 followed by the port. Leave off /chat/completions; a trailing /v1 is ignored.",
    );
    expect(none).not.toMatch(/:\d{2,5}\b/);
  });

  it("no new string says a model 'answers', promises quality or names a model", () => {
    for (const s of [
      LOCAL_SERVERS_LINE,
      LOCAL_REQUEST_LINE,
      LOCAL_SENT_TO_LINE,
      endpointHint(""),
      endpointHint("x"),
    ]) {
      expect(s).not.toMatch(/answers/i);
    }
    expect(LOCAL_SERVERS_LINE).toBe(
      "Tandem can use a model server on this computer that offers the OpenAI-compatible chat API, such as Ollama, LM Studio or llama.cpp. Hugging Face models can be used through one of these if the server runs them. Tandem does not download models.",
    );
  });
});

describe("ModelEditModal — the provider switch, driven (#2437 M1, R3.2)", () => {
  type Mounted = ReturnType<typeof mountWith>;
  const select = (m: Mounted) => m.getByTestId("model-edit-provider") as HTMLSelectElement;
  const endpoint = (m: Mounted) => m.getByTestId("model-edit-endpoint") as HTMLInputElement;
  /** As a user's choice reaches the page: the select's value, then `change`. */
  async function switchTo(m: Mounted, p: ModelProvider) {
    select(m).value = p;
    await fireEvent.change(select(m));
    expect(select(m).value).toBe(p);
  }
  function expectLocalCopy(m: Mounted, p: ModelProvider) {
    expect(endpoint(m).placeholder).toBe(PLACEHOLDER[p]);
    expect(m.getByRole("textbox", { name: "Endpoint", description: HINT[p] })).toBe(endpoint(m));
    const lines = Array.from(m.getByTestId("model-edit-local-intro").querySelectorAll("p")).map(
      (el) => el.textContent,
    );
    expect(lines).toEqual([S1, S2, S7]);
    expect(m.queryByTestId("model-edit-provider-note")).toBeNull();
    expect((m.getByTestId("model-edit-modelid") as HTMLInputElement).placeholder).toBe("");
  }
  const name = (m: Mounted) => m.getByTestId("model-edit-displayname") as HTMLInputElement;

  for (const from of LOCAL_MODEL_PROVIDERS) {
    for (const to of LOCAL_MODEL_PROVIDERS) {
      if (from === to) continue;
      it(`a new entry, default → ${from} → ${to}: ${to}'s usual address, placeholder, hint and copy (A2, A3)`, async () => {
        const m = mountWith();
        await switchTo(m, from);
        await switchTo(m, to);
        // V2: the field still held the previous provider's usual address.
        expect(endpoint(m).value).toBe(PLACEHOLDER[to]);
        expectLocalCopy(m, to);
        expect(name(m).placeholder).toBe(NAME_PLACEHOLDER[to]);
      });
    }
  }

  for (const p of LOCAL_MODEL_PROVIDERS) {
    it(`a new entry switched from the default to ${p}: ${p}'s usual address`, async () => {
      const m = mountWith();
      await switchTo(m, p);
      expect(endpoint(m).value).toBe(PLACEHOLDER[p]);
      expectLocalCopy(m, p);
    });

    it(`an existing ${p} entry keeps its saved address through a switch to every other local provider`, async () => {
      const m = mountWith(p);
      for (const to of LOCAL_MODEL_PROVIDERS.filter((q) => q !== p)) {
        await switchTo(m, to);
        expect(endpoint(m).value).toBe("http://127.0.0.1:9");
        expectLocalCopy(m, to);
        // On Edit the Display name has no placeholder, whatever the provider.
        expect(name(m).placeholder).toBe("");
      }
    });
  }

  // R1.2's rows, one case each (A2 and A3 are also the every-pair loop above).
  async function typeEndpoint(m: Mounted, value: string) {
    await fireEvent.input(endpoint(m), { target: { value } });
    expect(endpoint(m).value).toBe(value);
  }
  it("A2: Ollama's address, Ollama to LM Studio / llama.cpp / Other", async () => {
    for (const [to, after] of [
      ["local-lmstudio", "http://127.0.0.1:1234"],
      ["local-llamacpp", ""],
      ["local-other", ""],
    ] as const) {
      const m = mountWith();
      await switchTo(m, to);
      expect(endpoint(m).value).toBe(after);
      cleanup();
    }
  });
  it("A3: empty, llama.cpp to Ollama; Other to LM Studio", async () => {
    let m = mountWith();
    await switchTo(m, "local-llamacpp");
    expect(endpoint(m).value).toBe("");
    await switchTo(m, "local-ollama");
    expect(endpoint(m).value).toBe("http://127.0.0.1:11434");
    cleanup();
    m = mountWith();
    await switchTo(m, "local-other");
    await switchTo(m, "local-lmstudio");
    expect(endpoint(m).value).toBe("http://127.0.0.1:1234");
  });
  it("A4: a typed address is kept through a switch to every other local provider", async () => {
    const m = mountWith();
    await typeEndpoint(m, "http://127.0.0.1:5555");
    for (const to of ["local-lmstudio", "local-llamacpp", "local-other", "local-ollama"] as const) {
      await switchTo(m, to);
      expect(endpoint(m).value).toBe("http://127.0.0.1:5555");
    }
  });
  it("A5: Ollama's address with a trailing space is kept (strict, untrimmed)", async () => {
    const m = mountWith();
    await typeEndpoint(m, "http://127.0.0.1:11434 ");
    await switchTo(m, "local-lmstudio");
    expect(endpoint(m).value).toBe("http://127.0.0.1:11434 ");
  });
  it("A6: Ollama's address with a trailing slash is kept", async () => {
    const m = mountWith();
    await typeEndpoint(m, "http://127.0.0.1:11434/");
    await switchTo(m, "local-lmstudio");
    expect(endpoint(m).value).toBe("http://127.0.0.1:11434/");
  });
  it("A7: an emptied field on Ollama stays empty through a switch to LM Studio", async () => {
    const m = mountWith();
    await typeEndpoint(m, "");
    await switchTo(m, "local-lmstudio");
    expect(endpoint(m).value).toBe("");
  });
  it("A8: Edit, an Ollama entry at Ollama's address, to LM Studio: kept", async () => {
    const m = render(ModelEditModal, {
      props: {
        entry: {
          id: "e1",
          provider: "local-ollama",
          displayName: "x",
          modelId: "m",
          endpoint: "http://127.0.0.1:11434",
          enabled: true,
        },
        onCancel: vi.fn(),
        onSave: vi.fn(),
      },
    });
    await switchTo(m, "local-lmstudio");
    expect(endpoint(m).value).toBe("http://127.0.0.1:11434");
  });
  it("A9: Edit, an entry with no address, to Ollama: stays empty", async () => {
    const m = mountWith("local-llamacpp", false);
    await switchTo(m, "local-ollama");
    expect(endpoint(m).value).toBe("");
  });

  it("Add: the Display name placeholder is the selected provider's fallback, and follows a switch", async () => {
    const m = mountWith();
    expect(name(m).value).toBe("");
    expect(name(m).placeholder).toBe("Ollama (local)");
    for (const p of LOCAL_MODEL_PROVIDERS) {
      await switchTo(m, p);
      expect(name(m).placeholder).toBe(NAME_PLACEHOLDER[p]);
      expect(name(m).value).toBe("");
    }
  });

  // R4 / P2: the window carries no model-size advice (the docs do).
  for (const p of LOCAL_MODEL_PROVIDERS) {
    it(`Add, ${p}: no "smaller models", "recommend" or "14B" in the window`, async () => {
      const m = mountWith();
      await switchTo(m, p);
      expect(m.getByTestId("model-edit-modal").textContent ?? "").not.toMatch(
        /smaller models|recommend|14B/i,
      );
    });
  }
});

describe("ModelEditModal — the document-text sentences (26c)", () => {
  it("LOCAL_SENT_TO_LINE is the two sentences, verbatim", () => {
    expect(LOCAL_SENT_TO_LINE).toBe(S7);
  });
  for (const p of LOCAL_MODEL_PROVIDERS) {
    it(`${p}: Add and Edit show S7 as the third paragraph`, () => {
      for (const mount of [() => mountWith(), () => mountWith(p)]) {
        const m = mount();
        const lines = Array.from(m.getByTestId("model-edit-local-intro").querySelectorAll("p")).map(
          (el) => el.textContent,
        );
        expect(lines[2]).toBe(S7);
        cleanup();
      }
    });
  }
});

// 26b: the whole "Advanced parameters" disclosure is gone, in both modes.
describe("ModelEditModal — no 'Advanced parameters' (26b)", () => {
  for (const p of LOCAL_MODEL_PROVIDERS) {
    for (const mode of ["Add", "Edit"] as const) {
      it(`${p}, ${mode}: no such text and no disclosure`, () => {
        const m = mode === "Add" ? mountWith() : mountWith(p);
        const dialog = m.getByRole("dialog");
        expect(dialog.textContent).not.toMatch(
          /Advanced parameters|not editable in this preview|Wave 6|forward-compat/,
        );
        expect(dialog.querySelector("details")).toBeNull();
      });
    }
  }
});
