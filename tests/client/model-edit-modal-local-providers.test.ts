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
  LOCAL_SERVERS_LINE,
} from "../../src/client/utils/local-model-copy.js";
import {
  isLocalProvider,
  LOCAL_MODEL_PROVIDERS,
  type ModelProvider,
  VALID_MODEL_PROVIDERS,
} from "../../src/shared/models/contract.js";
import { LOCAL_ENDPOINT_PREFILL } from "../../src/shared/models/provider-ui.js";

afterEach(() => cleanup());

const CLOUD = VALID_MODEL_PROVIDERS.filter((p) => !isLocalProvider(p));

/**
 * `withEndpoint: false` mounts an entry of `provider` with no saved address,
 * which shows what a new entry of that provider shows. The select is a
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
const CLOUD_NOTE =
  "Cloud providers are coming in a future release. For now, choose a local provider.";

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

    it(`${p}: S1, S2 and S3 are shown, and the hint describes the Endpoint field`, async () => {
      const m = mountWith(p, false);
      const intro = m.getByTestId("model-edit-local-intro").textContent ?? "";
      expect(intro).toContain(LOCAL_SERVERS_LINE);
      expect(intro).toContain(LOCAL_REQUEST_LINE);
      const field = m.getByRole("textbox", { name: "Endpoint", description: HINT[p] });
      expect(field).toBe(m.getByTestId("model-edit-endpoint"));
      // The select's own name is untouched by the copy placed after it.
      expect(m.getByRole("combobox", { name: "Provider" })).toBe(
        m.getByTestId("model-edit-provider"),
      );
    });

    it(`${p}: the Display name and Model ID placeholders are blank`, async () => {
      const m = mountWith(p, false);
      expect((m.getByTestId("model-edit-displayname") as HTMLInputElement).placeholder).toBe("");
      expect((m.getByTestId("model-edit-modelid") as HTMLInputElement).placeholder).toBe("");
    });
  }

  it("a new entry's address starts empty (Ruling L-f)", () => {
    const field = mountWith().getByTestId("model-edit-endpoint") as HTMLInputElement;
    expect(field.value).toBe("");
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

describe("ModelEditModal — cloud entries keep today's copy", () => {
  for (const p of CLOUD) {
    it(`${p}: no S1/S2/S3, the cloud note (S4), and the cloud placeholders`, () => {
      const m = mountWith(p);
      expect(m.queryByTestId("model-edit-local-intro")).toBeNull();
      expect(m.queryByTestId("model-edit-endpoint-hint")).toBeNull();
      expect(
        m.getByTestId("model-edit-provider-note").textContent?.replace(/\s+/g, " ").trim(),
      ).toBe("Cloud providers are coming in a future release. For now, choose a local provider.");
      expect((m.getByTestId("model-edit-displayname") as HTMLInputElement).placeholder).toBe(
        "My Anthropic key",
      );
      expect((m.getByTestId("model-edit-modelid") as HTMLInputElement).placeholder).toBe(
        "e.g. claude-opus-4-7",
      );
    });
  }
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
    for (const s of [LOCAL_SERVERS_LINE, LOCAL_REQUEST_LINE, endpointHint(""), endpointHint("x")]) {
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
    expect(lines).toEqual([S1, S2]);
    expect(m.queryByTestId("model-edit-provider-note")).toBeNull();
    expect((m.getByTestId("model-edit-displayname") as HTMLInputElement).placeholder).toBe("");
    expect((m.getByTestId("model-edit-modelid") as HTMLInputElement).placeholder).toBe("");
  }

  for (const from of LOCAL_MODEL_PROVIDERS) {
    for (const to of LOCAL_MODEL_PROVIDERS) {
      if (from === to) continue;
      it(`a new entry, default → ${from} → ${to}: empty field, ${to}'s placeholder, hint and copy`, async () => {
        const m = mountWith();
        await switchTo(m, from);
        await switchTo(m, to);
        // Ruling L-f: no prefill is ever written into the field.
        expect(endpoint(m).value).toBe("");
        expectLocalCopy(m, to);
      });
    }
  }

  for (const p of LOCAL_MODEL_PROVIDERS) {
    it(`a new entry switched from the default to ${p}: the field stays empty`, async () => {
      const m = mountWith();
      await switchTo(m, p);
      expect(endpoint(m).value).toBe("");
      expectLocalCopy(m, p);
    });

    it(`an existing ${p} entry keeps its saved address through a switch to every other local provider`, async () => {
      const m = mountWith(p);
      for (const to of LOCAL_MODEL_PROVIDERS.filter((q) => q !== p)) {
        await switchTo(m, to);
        expect(endpoint(m).value).toBe("http://127.0.0.1:9");
        expectLocalCopy(m, to);
      }
    });
  }

  for (const cloud of CLOUD) {
    for (const p of LOCAL_MODEL_PROVIDERS) {
      // Ruling H-1: switched back to its (disabled) cloud value by the same
      // event, the only way a test sees S1/S2 removed on a provider change.
      it(`an existing ${cloud} entry → ${p} → ${cloud}: local copy shown, then the cloud note again`, async () => {
        const m = mountWith(cloud);
        await switchTo(m, p);
        expectLocalCopy(m, p);
        expect(endpoint(m).value).toBe("");
        await switchTo(m, cloud);
        expect(m.queryByTestId("model-edit-local-intro")).toBeNull();
        expect(m.queryByTestId("model-edit-endpoint-hint")).toBeNull();
        expect(m.queryByTestId("model-edit-endpoint")).toBeNull();
        expect(
          m.getByTestId("model-edit-provider-note").textContent?.replace(/\s+/g, " ").trim(),
        ).toBe(CLOUD_NOTE);
        expect((m.getByTestId("model-edit-displayname") as HTMLInputElement).placeholder).toBe(
          "My Anthropic key",
        );
        expect((m.getByTestId("model-edit-modelid") as HTMLInputElement).placeholder).toBe(
          "e.g. claude-opus-4-7",
        );
      });
    }
  }
});
