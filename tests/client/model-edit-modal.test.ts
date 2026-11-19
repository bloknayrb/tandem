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
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import ModelEditModal from "../../src/client/components/ModelEditModal.svelte";
import type { ModelRegistryEntry } from "../../src/client/hooks/useTandemSettings.svelte.js";
import { LOCAL_REQUEST_LINE, LOCAL_SERVERS_LINE } from "../../src/client/utils/local-model-copy.js";
import { LOCAL_MODEL_PROVIDERS, type ModelProvider } from "../../src/shared/models/contract.js";

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

/** A mounted window, with every query `render` gives it. */
type View = ReturnType<typeof mountAdd>;

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
      // Focus moves in on mount, to the Provider select (ADR-039 item 27, A1).
      expect(document.activeElement).toBe(view.getByTestId("model-edit-provider"));
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
    // llama.cpp has no usual address, so its field starts empty (V2).
    const select = getByTestId("model-edit-provider") as HTMLSelectElement;
    select.value = "local-llamacpp";
    await fireEvent.change(select);
    await fireEvent.input(getByTestId("model-edit-modelid"), { target: { value: "qwen2.5:14b" } });
    // Model ID filled but endpoint still blank → Save stays inert, never disabled.
    expect(save().disabled).toBe(false);
    expect(save().getAttribute("aria-disabled")).toBe("true");
    await fireEvent.input(getByTestId("model-edit-endpoint"), {
      target: { value: "http://127.0.0.1:11434" },
    });
    expect(save().disabled).toBe(false);
    expect(save().getAttribute("aria-disabled")).toBe("false");
  });
});

// #1123, the add-model window's fields (R3): one line under Save says why it is
// greyed out. Strings are literals, never built from the product's.
describe("ModelEditModal — Save's reason (P10(5), V2, V9)", () => {
  const U1 = "Enter a Model ID to save.";
  const U2 = "Enter an Endpoint to save.";
  const U3 =
    "The Endpoint must start with http:// and name this computer as 127.0.0.1, localhost or [::1], with no user name or password.";
  const U4 =
    "The Endpoint is not a complete address. Check it, including the port number (for example http://127.0.0.1:11434).";

  type Mode = "Add" | "Edit";
  const EDIT_ENTRY: ModelRegistryEntry = {
    id: "e1",
    provider: "local-ollama",
    displayName: "Mine",
    modelId: "m",
    endpoint: "http://127.0.0.1:11434",
    enabled: true,
  };
  function mountMode(mode: Mode, provider: ModelProvider = "local-ollama") {
    return mode === "Add"
      ? (() => {
          const onSave = vi.fn();
          const v = render(ModelEditModal, { props: { onCancel: vi.fn(), onSave } });
          return { ...v, onSave };
        })()
      : mountEntry({ ...EDIT_ENTRY, provider });
  }
  async function choose(v: View, p: ModelProvider) {
    const select = v.getByTestId("model-edit-provider") as HTMLSelectElement;
    select.value = p;
    await fireEvent.change(select);
  }
  async function fill(v: View, modelId: string, endpoint: string) {
    await fireEvent.input(v.getByTestId("model-edit-modelid"), { target: { value: modelId } });
    await fireEvent.input(v.getByTestId("model-edit-endpoint"), { target: { value: endpoint } });
  }
  const saveName = (mode: Mode) => (mode === "Add" ? "Add model" : "Save changes");

  /** R3.1: the line, Save's state and its description, and the invariant. */
  function expectRow(v: View, mode: Mode, reason: string | null) {
    const save = v.getByTestId("model-edit-save") as HTMLButtonElement;
    const line = v.queryByTestId("model-edit-save-reason");
    expect(save.disabled).toBe(false);
    if (reason === null) {
      expect(line).toBeNull();
      expect(save.getAttribute("aria-disabled")).toBe("false");
      expect(save.hasAttribute("aria-describedby")).toBe(false);
      expect(v.getByRole("button", { name: saveName(mode) })).toBe(save);
      return;
    }
    expect(norm(line?.textContent)).toBe(reason);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.getAttribute("aria-describedby")).toBe("model-edit-save-reason");
    for (const id of (save.getAttribute("aria-describedby") ?? "").split(/\s+/)) {
      expect(document.getElementById(id), id).not.toBeNull();
    }
    expect(v.getByRole("button", { name: saveName(mode), description: reason })).toBe(save);
  }

  /** Rows 2 to 5: neither a form submit nor a click saves. */
  async function expectNoSave(v: View, onSave: ReturnType<typeof vi.fn>) {
    const save = v.getByTestId("model-edit-save");
    await fireEvent.submit(save.closest("form") as HTMLFormElement);
    await fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  }

  const MODEL_ID_CASES: Array<[string, string]> = [
    ["", "http://127.0.0.1:1234"],
    ["   ", "http://127.0.0.1:1234"],
  ];
  const ENDPOINT_CASES: Array<[string, string | null]> = [
    ["http://127.0.0.1:99999", U4],
    ["http://127.0.0.1:12a", U4],
    ["http://", U4],
    [" http://127.0.0.1:99999", U4],
    ["HTTP://127.0.0.1:99999", U4],
    ["127.0.0.1:1234", U3],
    ["localhost:11434", U3],
    ["https://127.0.0.1:1234", U3],
    ["http://u:p@127.0.0.1:1234", U3],
    ["http://192.168.1.5:11434", U3],
    ["http://localhost.example:1", U3],
    ["http://0.0.0.0:1", U3],
    ["", U2],
    ["   ", U2],
    ["http://127.0.0.1:1234", null],
    ["http://localhost:1234", null],
    ["http://[::1]:1234", null],
    ["  http://127.0.0.1:1  ", null],
  ];

  for (const mode of ["Add", "Edit"] as const) {
    for (const [modelId, ep] of MODEL_ID_CASES) {
      it(`${mode}, row 2: Model ID ${JSON.stringify(modelId)} reads U1, and fixing it saves once`, async () => {
        const v = mountMode(mode);
        await fill(v, modelId, ep);
        expectRow(v, mode, U1);
        await expectNoSave(v, v.onSave);
        await fireEvent.input(v.getByTestId("model-edit-modelid"), { target: { value: "m" } });
        expectRow(v, mode, null);
        await fireEvent.submit(v.getByTestId("model-edit-save").closest("form") as HTMLFormElement);
        expect(v.onSave).toHaveBeenCalledTimes(1);
      });
    }

    for (const [ep, reason] of ENDPOINT_CASES) {
      it(`${mode}: Endpoint ${JSON.stringify(ep)} reads ${reason === null ? "nothing" : reason.slice(0, 24)}`, async () => {
        const v = mountMode(mode);
        await fill(v, "m", ep);
        expectRow(v, mode, reason);
        if (reason !== null) {
          await expectNoSave(v, v.onSave);
          await fireEvent.input(v.getByTestId("model-edit-endpoint"), {
            target: { value: "http://127.0.0.1:1234" },
          });
          expectRow(v, mode, null);
        }
        await fireEvent.submit(v.getByTestId("model-edit-save").closest("form") as HTMLFormElement);
        expect(v.onSave).toHaveBeenCalledTimes(1);
      });
    }
  }

  for (const p of ["local-llamacpp", "local-other"] as const) {
    it(`Add, row 3 on ${p}: no usual address, so U2 with a Model ID typed`, async () => {
      const v = mountMode("Add");
      await choose(v, p);
      await fireEvent.input(v.getByTestId("model-edit-modelid"), { target: { value: "m" } });
      expectRow(v, "Add", U2);
      await expectNoSave(v, v.onSave);
    });
  }

  it("first match: Model ID blank and the address refused gives U1", async () => {
    const v = mountMode("Add");
    await fill(v, "", "http://192.168.1.5:11434");
    expectRow(v, "Add", U1);
  });

  it("row 1: a refused page shows no line, and Save is described by the refusal alone", async () => {
    const v = render(ModelEditModal, {
      props: { saveUnavailable: true, error: "x", onCancel: vi.fn(), onSave: vi.fn() },
    });
    const save = v.getByTestId("model-edit-save") as HTMLButtonElement;
    expect(v.queryByTestId("model-edit-save-reason")).toBeNull();
    expect(save.disabled).toBe(false);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.getAttribute("aria-describedby")).toBe("model-edit-error-text");
    expect(document.getElementById("model-edit-error-text")).not.toBeNull();
  });

  it("P10(4): a provider change announces nothing (no live region in the dialog)", async () => {
    const v = mountMode("Add");
    const dialog = v.getByTestId("model-edit-modal");
    const noLive = () =>
      expect(dialog.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
    await fireEvent.input(v.getByTestId("model-edit-modelid"), { target: { value: "m" } });
    expect(v.queryByTestId("model-edit-save-reason")).toBeNull();
    noLive();
    await choose(v, "local-llamacpp");
    expect(norm(v.getByTestId("model-edit-save-reason").textContent)).toBe(U2);
    noLive();
  });
});

// #1123 V18 as cut down by the final review: on Add a blank name saves as the
// selected provider's fallback; on Edit the field's text is saved, "" too.
describe("ModelEditModal — the Display name (V18)", () => {
  const nameField = (v: View) => v.getByTestId("model-edit-displayname") as HTMLInputElement;
  async function choose(v: View, p: ModelProvider) {
    const select = v.getByTestId("model-edit-provider") as HTMLSelectElement;
    select.value = p;
    await fireEvent.change(select);
  }
  const submit = (v: View) =>
    fireEvent.submit(v.getByTestId("model-edit-save").closest("form") as HTMLFormElement);
  function mountAddWithSave() {
    const onSave = vi.fn();
    const v = render(ModelEditModal, { props: { onCancel: vi.fn(), onSave } });
    return { ...v, onSave };
  }
  const editEntry = (displayName: string): ModelRegistryEntry => ({
    id: "e1",
    provider: "local-ollama",
    displayName,
    modelId: "m",
    endpoint: "http://127.0.0.1:11434",
    enabled: true,
  });

  it('the field is labelled "Display name (optional)"', () => {
    const v = mountAdd();
    expect(v.getByRole("textbox", { name: "Display name (optional)" })).toBe(nameField(v));
  });

  it('Add Ollama, name blank: saves "Ollama (local)" (the placeholder)', async () => {
    const v = mountAddWithSave();
    expect(nameField(v).placeholder).toBe("Ollama (local)");
    await fireEvent.input(v.getByTestId("model-edit-modelid"), { target: { value: "m" } });
    await submit(v);
    expect(v.onSave).toHaveBeenCalledTimes(1);
    expect(v.onSave).toHaveBeenCalledWith({
      provider: "local-ollama",
      displayName: "Ollama (local)",
      modelId: "m",
      endpoint: "http://127.0.0.1:11434",
      enabled: true,
    });
  });

  it('Add, name "   ": saves the fallback', async () => {
    const v = mountAddWithSave();
    await fireEvent.input(nameField(v), { target: { value: "   " } });
    await fireEvent.input(v.getByTestId("model-edit-modelid"), { target: { value: "m" } });
    await submit(v);
    expect(v.onSave).toHaveBeenCalledTimes(1);
    expect(v.onSave).toHaveBeenCalledWith({
      provider: "local-ollama",
      displayName: "Ollama (local)",
      modelId: "m",
      endpoint: "http://127.0.0.1:11434",
      enabled: true,
    });
  });

  it('Add, switched to Other with a typed address, name blank: saves "Local server"', async () => {
    const v = mountAddWithSave();
    await choose(v, "local-other");
    expect(nameField(v).placeholder).toBe("Local server");
    await fireEvent.input(v.getByTestId("model-edit-endpoint"), {
      target: { value: "http://127.0.0.1:8000" },
    });
    await fireEvent.input(v.getByTestId("model-edit-modelid"), { target: { value: "m" } });
    await submit(v);
    expect(v.onSave).toHaveBeenCalledTimes(1);
    expect(v.onSave).toHaveBeenCalledWith({
      provider: "local-other",
      displayName: "Local server",
      modelId: "m",
      endpoint: "http://127.0.0.1:8000",
      enabled: true,
    });
  });

  it('Add, typed "Mine", provider switched: saves "Mine"', async () => {
    const v = mountAddWithSave();
    await fireEvent.input(nameField(v), { target: { value: "Mine" } });
    await choose(v, "local-lmstudio");
    expect(nameField(v).value).toBe("Mine");
    await fireEvent.input(v.getByTestId("model-edit-modelid"), { target: { value: "m" } });
    await submit(v);
    expect(v.onSave).toHaveBeenCalledTimes(1);
    expect(v.onSave).toHaveBeenCalledWith({
      provider: "local-lmstudio",
      displayName: "Mine",
      modelId: "m",
      endpoint: "http://127.0.0.1:1234",
      enabled: true,
    });
  });

  it('Edit, stored "", address edited: saves "" (placeholder "")', async () => {
    const v = mountEntry(editEntry(""));
    expect(nameField(v).placeholder).toBe("");
    await fireEvent.input(v.getByTestId("model-edit-endpoint"), {
      target: { value: "http://127.0.0.1:9" },
    });
    await submit(v);
    expect(v.onSave).toHaveBeenCalledTimes(1);
    expect(v.onSave).toHaveBeenCalledWith({
      provider: "local-ollama",
      displayName: "",
      modelId: "m",
      endpoint: "http://127.0.0.1:9",
      enabled: true,
    });
  });

  it('Edit, stored "Old", cleared: saves ""', async () => {
    const v = mountEntry(editEntry("Old"));
    await fireEvent.input(nameField(v), { target: { value: "" } });
    await submit(v);
    expect(v.onSave).toHaveBeenCalledTimes(1);
    expect(v.onSave).toHaveBeenCalledWith({
      provider: "local-ollama",
      displayName: "",
      modelId: "m",
      endpoint: "http://127.0.0.1:11434",
      enabled: true,
    });
  });

  it('Edit, stored "Ollama (local)", switched to LM Studio: the name is kept', async () => {
    const v = mountEntry(editEntry("Ollama (local)"));
    await choose(v, "local-lmstudio");
    expect(nameField(v).value).toBe("Ollama (local)");
    expect(nameField(v).placeholder).toBe("");
    await submit(v);
    expect(v.onSave).toHaveBeenCalledTimes(1);
    expect(v.onSave).toHaveBeenCalledWith({
      provider: "local-lmstudio",
      displayName: "Ollama (local)",
      modelId: "m",
      endpoint: "http://127.0.0.1:11434",
      enabled: true,
    });
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
        // No local copy: the intro, its two small-print lines and the hint.
        expect(v.queryByTestId("model-edit-local-intro")).toBeNull();
        expect(v.queryByTestId("model-edit-endpoint-hint")).toBeNull();
        expect(dialog.textContent).not.toContain(LOCAL_SERVERS_LINE);
        expect(dialog.textContent).not.toContain(LOCAL_REQUEST_LINE);
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

describe("ModelEditModal — focus moves in once, on open (#1123 A1)", () => {
  const LOCAL_ENTRY: ModelRegistryEntry = {
    id: "e-1",
    provider: "local-ollama",
    displayName: "Mine",
    modelId: "m",
    endpoint: "http://127.0.0.1:11434",
    enabled: true,
  };

  for (const [mode, entry] of [
    ["Add", undefined],
    ["Edit", LOCAL_ENTRY],
  ] as const) {
    it(`${mode}: the Provider select has focus after mount`, () => {
      const v = entry ? mountEntry(entry) : mountAdd();
      expect(document.activeElement).toBe(v.getByTestId("model-edit-provider"));
    });

    it(`${mode}: a provider change leaves focus where it is (on Model ID)`, async () => {
      const v = entry ? mountEntry(entry) : mountAdd();
      const modelId = v.getByTestId("model-edit-modelid") as HTMLInputElement;
      modelId.focus();
      const select = v.getByTestId("model-edit-provider") as HTMLSelectElement;
      select.value = "local-lmstudio";
      await fireEvent.change(select);
      expect(select.value).toBe("local-lmstudio");
      expect(document.activeElement).toBe(modelId);
    });

    it(`${mode}: Escape on the select calls onCancel once`, async () => {
      const onCancel = vi.fn();
      const v = render(ModelEditModal, {
        props: { ...(entry ? { entry } : {}), onCancel, onSave: vi.fn() },
      });
      const select = v.getByTestId("model-edit-provider");
      expect(document.activeElement).toBe(select);
      await fireEvent.keyDown(select, { key: "Escape" });
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  }
});

describe("ModelEditModal — one save per press (#1123 A3, Ruling R-b)", () => {
  function deferred() {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  const LOCAL_ENTRY: ModelRegistryEntry = {
    id: "e-1",
    provider: "local-ollama",
    displayName: "Mine",
    modelId: "m",
    endpoint: "http://127.0.0.1:11434",
    enabled: true,
  };

  async function mountReady(mode: "Add" | "Edit", onSave: () => Promise<void>) {
    const v = render(ModelEditModal, {
      props: { ...(mode === "Edit" ? { entry: LOCAL_ENTRY } : {}), onCancel: vi.fn(), onSave },
    });
    if (mode === "Add") {
      await fireEvent.input(v.getByTestId("model-edit-modelid"), { target: { value: "qwen" } });
    }
    const save = v.getByTestId("model-edit-save") as HTMLButtonElement;
    const form = save.closest("form") as HTMLFormElement;
    return { v, save, form };
  }

  for (const mode of ["Add", "Edit"] as const) {
    const idle = mode === "Add" ? "Add model" : "Save changes";

    it(`${mode}: two submits while the save is pending call onSave once; Save reads "Saving…", aria-disabled, never disabled`, async () => {
      const d = deferred();
      const onSave = vi.fn(() => d.promise);
      const { v, save, form } = await mountReady(mode, onSave);
      expect(norm(save.textContent)).toBe(idle);
      await fireEvent.submit(form);
      await fireEvent.submit(form);
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(v.getByRole("button", { name: "Saving…" })).toBe(save);
      expect(save.getAttribute("aria-disabled")).toBe("true");
      expect(save.disabled).toBe(false);
      d.resolve();
      await d.promise;
      await tick();
      expect(norm(save.textContent)).toBe(idle);
      expect(save.getAttribute("aria-disabled")).toBe("false");
      await fireEvent.submit(form);
      expect(onSave).toHaveBeenCalledTimes(2);
    });

    it(`${mode}: a rejecting onSave logs a warning, leaves no unhandled rejection, and the next submit calls it again`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const d = deferred();
        const onSave = vi.fn(() => d.promise);
        const { save, form } = await mountReady(mode, onSave);
        await fireEvent.submit(form);
        d.reject(new Error("boom"));
        await d.promise.catch(() => {});
        await tick();
        await new Promise((r) => setTimeout(r, 0));
        expect(warn).toHaveBeenCalledWith("[models] save failed", expect.any(Error));
        expect(unhandled).not.toHaveBeenCalled();
        expect(norm(save.textContent)).toBe(idle);
        await fireEvent.submit(form);
        expect(onSave).toHaveBeenCalledTimes(2);
      } finally {
        process.off("unhandledRejection", unhandled);
        warn.mockRestore();
      }
    });
  }
});

describe("ModelEditModal — A1's focus is moved in onMount, never an $effect (source pin)", () => {
  // An $effect that reads nothing reactive also runs once on mount, so the
  // behaviour cases above cannot tell it from onMount; the brief asks for
  // onMount, which can never re-run.
  it("the select and Close are focused inside onMount, and no $effect moves focus", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(import.meta.dirname, "../../src/client/components/ModelEditModal.svelte"),
      "utf8",
    )
      .replace(/\r\n/g, "\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    // Top-level calls: each starts at column 0 and ends at the next "\n});".
    const block = (start: number) => src.slice(start, src.indexOf("\n});", start));
    const mounts = [...src.matchAll(/^onMount\(/gm)].map((m) => block(m.index ?? 0));
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toContain('[data-testid="model-edit-provider"]');
    expect(mounts[0]).toContain('[data-testid="model-edit-unavailable-close"]');
    expect(mounts[0]).toMatch(/\.focus\(\)/);
    const effects = [...src.matchAll(/^\$effect(?:\.pre)?\(/gm)].map((m) => block(m.index ?? 0));
    expect(effects.length).toBeGreaterThan(0);
    // Every call an $effect makes is on this list, so one that reaches focus
    // through a helper of this file fails here, not only a direct `.focus(`.
    const ALLOWED = new Set([
      "$effect",
      "addEventListener",
      "removeEventListener",
      "closest",
      "contains",
      "trapTab",
      "preventDefault",
      "onCancel",
      // The stranded-focus Escape branch: is another modal open above?
      "querySelectorAll",
      "from",
      "some",
    ]);
    const KEYWORDS = new Set(["if", "return", "for", "while", "switch", "function"]);
    for (const e of effects) {
      expect(e).not.toMatch(/\.focus\s*(\?\.)?\(/);
      const calls = [...e.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)]
        .map((m) => m[1])
        .filter((name) => !KEYWORDS.has(name));
      for (const name of calls) expect(ALLOWED.has(name), `$effect calls ${name}()`).toBe(true);
    }
    // And every `.focus(` in the script sits inside the onMount block.
    const script = src.slice(0, src.indexOf("</script>"));
    const focusCalls = [...script.matchAll(/\.focus\s*(\?\.)?\(/g)].length;
    expect([...mounts[0].matchAll(/\.focus\s*(\?\.)?\(/g)].length).toBe(focusCalls);
  });
});

describe("ModelEditModal — Escape with focus stranded on the page (carried item 4)", () => {
  const LOCAL: ModelRegistryEntry = {
    id: "e-1",
    provider: "local-ollama",
    displayName: "Mine",
    modelId: "m",
    endpoint: "http://127.0.0.1:11434",
    enabled: true,
  };
  const escape = () =>
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });

  for (const [mode, entry] of [
    ["Add", undefined],
    ["Edit", LOCAL],
  ] as const) {
    it(`${mode}: Escape with focus on <body> cancels once`, () => {
      const onCancel = vi.fn();
      render(ModelEditModal, { props: { ...(entry ? { entry } : {}), onCancel, onSave: vi.fn() } });
      (document.activeElement as HTMLElement | null)?.blur();
      expect(document.activeElement).toBe(document.body);
      document.body.dispatchEvent(escape());
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  }

  it("Escape with focus inside still cancels once, never twice", () => {
    const onCancel = vi.fn();
    const v = render(ModelEditModal, { props: { onCancel, onSave: vi.fn() } });
    v.getByTestId("model-edit-provider").dispatchEvent(escape());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("another modal open above it owns that Escape: nothing is cancelled here", () => {
    const onCancel = vi.fn();
    render(ModelEditModal, { props: { onCancel, onSave: vi.fn() } });
    const above = document.createElement("div");
    above.setAttribute("role", "dialog");
    above.setAttribute("aria-modal", "true");
    document.body.appendChild(above);
    try {
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.dispatchEvent(escape());
      expect(onCancel).not.toHaveBeenCalled();
    } finally {
      above.remove();
    }
  });

  it("an Escape already handled (defaultPrevented) or mid-composition is left alone", () => {
    const onCancel = vi.fn();
    render(ModelEditModal, { props: { onCancel, onSave: vi.fn() } });
    (document.activeElement as HTMLElement | null)?.blur();
    const handled = escape();
    handled.preventDefault();
    document.body.dispatchEvent(handled);
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true }),
    );
    expect(onCancel).not.toHaveBeenCalled();
  });
});
