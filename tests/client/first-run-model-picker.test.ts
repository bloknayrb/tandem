// @vitest-environment happy-dom

/**
 * The first-run window, "Add a local model (optional)" (#1123; ADR-039 items
 * 21–23, Requirement 2 of the PR 4a part 1 brief).
 *
 * Exercised by a direct mount (the component has no internal
 * `BYO_MODELS_ENABLED` gate — App's mount is). `createModels` is mocked so the
 * add and the default are controllable without a server round-trip.
 *
 * Contracts:
 *   - only local providers are listed, Ollama first (P4);
 *   - the copy is the exports of `local-model-copy.ts`, the dialog named by its
 *     title (R2.1);
 *   - no model id is prefilled, and a hint names no model (V8);
 *   - Save says why it cannot save, focusable and described by the reason (V14);
 *   - a rolled-back add keeps the window open with the store's error;
 *   - a failed default closes as a success and clears the store's error (RW-5);
 *   - a close during a save neither sets the default nor leaves an error (R2.4).
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PICKER_LOCAL_SUBTITLE,
  PICKER_MODEL_ID_HINT,
  PICKER_TITLE,
} from "../../src/client/utils/local-model-copy.js";
import { isLocalProvider, VALID_MODEL_PROVIDERS } from "../../src/shared/models/contract.js";
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

function mount(onComplete = vi.fn()) {
  const m = render(FirstRunModelPickerModal, { props: { onComplete } });
  return { ...m, onComplete };
}
type Mounted = ReturnType<typeof mount>;
const modelIdField = (m: Mounted) => m.getByTestId("first-run-modelid") as HTMLInputElement;
const saveButton = (m: Mounted) => m.getByTestId("first-run-save") as HTMLButtonElement;
async function typeModelId(m: Mounted, value: string) {
  await fireEvent.input(modelIdField(m), { target: { value } });
}
/** A promise and its resolver, for an add or default held in flight. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("FirstRunModelPickerModal — local providers only (P4)", () => {
  it("defaults to Ollama and shows the endpoint field, not an API key", () => {
    const m = mount();
    const ollama = m.getByTestId("first-run-provider-local-ollama") as HTMLInputElement;
    expect(ollama.checked).toBe(true);
    expect(m.queryByTestId("first-run-endpoint")).not.toBeNull();
    expect(m.queryByTestId("first-run-apikey")).toBeNull();
  });

  it("lists no cloud provider and no 'coming soon'", () => {
    const m = mount();
    for (const v of VALID_MODEL_PROVIDERS.filter((p) => !isLocalProvider(p))) {
      expect(m.queryByTestId(`first-run-provider-${v}`)).toBeNull();
    }
    const text = m.getByTestId("first-run-model-modal").textContent ?? "";
    // "OpenAI-compatible" is Other's label, not the OpenAI row.
    expect(text).not.toMatch(/coming soon|OpenAI(?!-compatible)|Gemini|Anthropic/i);
  });
});

describe("FirstRunModelPickerModal — copy (R2.1)", () => {
  it("the dialog is named by its title, which is the exported string", () => {
    const m = mount();
    const dialog = m.getByRole("dialog", { name: PICKER_TITLE });
    expect(dialog).toBeTruthy();
    expect(PICKER_TITLE).toBe("Add a local model (optional)");
  });

  it("the subtitle is the two sentences, with no step count", () => {
    const m = mount();
    const subtitle = m.getByTestId("first-run-subtitle").textContent?.trim();
    expect(subtitle).toBe(PICKER_LOCAL_SUBTITLE);
    expect(PICKER_LOCAL_SUBTITLE).toBe(
      "Chat stays set to Claude. Your model server must be running on this computer for Tandem to use the model; you can also add models any time in Settings → Models.",
    );
    expect(m.getByTestId("first-run-model-modal").textContent).not.toMatch(/Step 1 of 2/);
  });

  it("the × is named Close, the secondary button No thanks, Save is Save", () => {
    const m = mount();
    expect(m.getByTestId("first-run-skip").getAttribute("aria-label")).toBe("Close");
    expect(m.getByTestId("first-run-skip-secondary").textContent?.trim()).toBe("No thanks");
    expect(saveButton(m).textContent?.trim()).toBe("Save");
    expect(m.getByRole("button", { name: "Close" })).not.toBe(
      m.getByRole("button", { name: "No thanks" }),
    );
  });
});

describe("FirstRunModelPickerModal — no prefilled model id (V8)", () => {
  it("the Model ID starts empty and is described by a hint that names no model", () => {
    const m = mount();
    expect(modelIdField(m).value).toBe("");
    const field = m.getByRole("textbox", { name: "Model ID", description: PICKER_MODEL_ID_HINT });
    expect(field).toBe(modelIdField(m));
    expect(PICKER_MODEL_ID_HINT).toBe("The model's name exactly as your server lists it.");
    expect(PICKER_MODEL_ID_HINT).not.toMatch(/llama|qwen|gemma|local-model|:\d/i);
  });
});

describe("FirstRunModelPickerModal — Save says why (V14)", () => {
  const REASON_ID = "Enter a Model ID to save.";
  const REASON_ENDPOINT = "Enter an Endpoint URL to save.";
  const REASON_BOTH = "Enter an Endpoint URL and a Model ID to save.";

  function expectInertWith(m: Mounted, reason: string) {
    const shown = m.getByTestId("first-run-save-reason");
    expect(shown.textContent?.trim()).toBe(reason);
    const save = saveButton(m);
    expect(save.disabled).toBe(false); // focusable
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.getAttribute("aria-describedby")).toBe(shown.id);
    expect(shown.id).toBeTruthy();
  }

  it("names each missing field, exactly while Save cannot save", async () => {
    const m = mount();
    expectInertWith(m, REASON_ID);
    await fireEvent.input(m.getByTestId("first-run-endpoint"), { target: { value: "" } });
    expectInertWith(m, REASON_BOTH);
    await typeModelId(m, "qwen");
    expectInertWith(m, REASON_ENDPOINT);
    await fireEvent.input(m.getByTestId("first-run-endpoint"), {
      target: { value: "http://127.0.0.1:11434" },
    });
    expect(m.queryByTestId("first-run-save-reason")).toBeNull();
    expect(saveButton(m).getAttribute("aria-disabled")).toBe("false");
    expect(saveButton(m).getAttribute("aria-describedby")).toBeNull();
  });

  it("a whitespace-only Model ID counts as missing", async () => {
    const m = mount();
    await typeModelId(m, "   ");
    expectInertWith(m, REASON_ID);
  });

  it("a click or Enter while Save cannot save does nothing", async () => {
    const m = mount();
    await fireEvent.click(saveButton(m));
    await fireEvent.submit(saveButton(m).closest("form") as HTMLFormElement);
    expect(addModel).not.toHaveBeenCalled();
    expect(m.onComplete).not.toHaveBeenCalled();
  });
});

describe("FirstRunModelPickerModal — saving", () => {
  it("a rolled-back add (null) keeps the window open with the store's error, no default", async () => {
    addModel.mockResolvedValue(null);
    storeSaveError = "Model registry changed elsewhere; reloaded.";
    const m = mount();
    await typeModelId(m, "qwen");
    await fireEvent.click(saveButton(m));

    expect(addModel).toHaveBeenCalledTimes(1);
    expect(setDefault).not.toHaveBeenCalled();
    expect(m.onComplete).not.toHaveBeenCalled();
    const err = await m.findByTestId("first-run-error");
    expect(err.textContent).toMatch(/changed elsewhere/i);
    expect(m.getByTestId("first-run-model-modal")).toBeTruthy();
  });

  it("a committed add sets it as the default and completes", async () => {
    addModel.mockResolvedValue("new-id");
    const m = mount();
    await typeModelId(m, "qwen");
    await fireEvent.click(saveButton(m));

    expect(addModel.mock.calls[0][0]).toMatchObject({ modelId: "qwen" });
    expect(setDefault).toHaveBeenCalledWith("new-id");
    expect(m.onComplete).toHaveBeenCalledTimes(1);
  });

  it("No thanks completes with no write and clears any store error", async () => {
    const m = mount();
    await fireEvent.click(m.getByTestId("first-run-skip-secondary"));
    expect(addModel).not.toHaveBeenCalled();
    expect(clearError).toHaveBeenCalledTimes(1);
    expect(m.onComplete).toHaveBeenCalledTimes(1);
  });

  it("a failed default after a committed add closes as a success and clears the store's error (RW-5)", async () => {
    addModel.mockResolvedValue("new-id");
    setDefault.mockResolvedValue(false);
    const m = mount();
    await typeModelId(m, "qwen");
    await fireEvent.click(saveButton(m));
    await flush();

    expect(setDefault).toHaveBeenCalledTimes(1);
    expect(clearError).toHaveBeenCalled();
    expect(m.onComplete).toHaveBeenCalledTimes(1);
    expect(m.queryByText(/couldn't set it as the default/i)).toBeNull();
  });
});

describe("FirstRunModelPickerModal — closed during a save (R2.4)", () => {
  for (const exit of ["first-run-skip", "first-run-skip-secondary"] as const) {
    it(`${exit} during a pending add, then the add commits: no default, the error cleared after`, async () => {
      const add = deferred<string | null>();
      addModel.mockReturnValue(add.promise);
      const m = mount();
      await typeModelId(m, "qwen");
      await fireEvent.click(saveButton(m));
      expect(addModel).toHaveBeenCalledTimes(1);

      await fireEvent.click(m.getByTestId(exit)); // the exit stays live during a save
      expect(m.onComplete).toHaveBeenCalledTimes(1);
      clearError.mockClear();

      add.resolve("new-id");
      await flush();
      expect(setDefault).not.toHaveBeenCalled();
      expect(clearError).toHaveBeenCalledTimes(1);
      expect(m.onComplete).toHaveBeenCalledTimes(1);
    });
  }

  it("Escape during a pending add, then the add rolls back: the error is cleared after", async () => {
    const add = deferred<string | null>();
    addModel.mockReturnValue(add.promise);
    const m = mount();
    await typeModelId(m, "qwen");
    await fireEvent.click(saveButton(m));
    await fireEvent.keyDown(m.getByRole("dialog"), { key: "Escape" });
    expect(m.onComplete).toHaveBeenCalledTimes(1);
    clearError.mockClear();

    storeSaveError = "Failed to save model changes.";
    add.resolve(null);
    await flush();
    expect(clearError).toHaveBeenCalledTimes(1);
    expect(setDefault).not.toHaveBeenCalled();
    expect(m.onComplete).toHaveBeenCalledTimes(1);
  });
});

// #2404: a save refused because this page is not Tandem's own window. The
// window stays (the refusal must be explained where the user is looking), shows
// the server's plain reason, and Save does nothing more; the exits still work.
describe("FirstRunModelPickerModal — a save the server refused as not Tandem's own window", () => {
  const REASON = "Local-model settings can only be changed in Tandem's own window.";

  it("keeps the window open with the reason, makes Save unavailable and inert, and leaves Close live", async () => {
    const { noteModelsWriteRefused } = await import("../../src/client/models/write-refusal");
    addModel.mockImplementationOnce(async () => {
      noteModelsWriteRefused(); // what the store does on 403 OWN_WINDOW_ONLY
      storeSaveError = REASON;
      return null;
    });
    const m = mount();
    await typeModelId(m, "qwen");
    const save = saveButton(m);
    expect(save.getAttribute("aria-disabled")).toBe("false");

    await fireEvent.click(save);

    // One sentence for this state: the same notice the window shows when it
    // opens already blocked (here the page is Tandem's own address, refused
    // all the same, so it is the plain sentence).
    expect((await m.findByTestId("first-run-error")).textContent?.trim()).toBe(
      REASON.replace("Local-model settings", "These settings"),
    );
    expect(m.getByTestId("first-run-model-modal")).toBeTruthy();
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.disabled).toBe(false); // still focusable
    // The refusal wins over Save's reason.
    expect(m.queryByTestId("first-run-save-reason")).toBeNull();
    // Click and Enter both end in the form's submit handler.
    await fireEvent.click(save);
    await fireEvent.submit(save.closest("form") as HTMLFormElement);
    expect(addModel).toHaveBeenCalledTimes(1);
    expect(m.onComplete).not.toHaveBeenCalled();

    await fireEvent.click(m.getByTestId("first-run-skip"));
    expect(m.onComplete).toHaveBeenCalledTimes(1);
  });

  it("already refused before the window opened (the boot reconcile): Save is unavailable AND the reason is on screen, described to the button", async () => {
    const { noteModelsWriteRefused } = await import("../../src/client/models/write-refusal");
    const { _setPageOriginForTests } = await import(
      "../../src/client/hooks/useModelsWriteAccess.svelte"
    );
    _setPageOriginForTests("http://127.0.0.1:5173");
    noteModelsWriteRefused();
    const m = mount();

    const save = saveButton(m);
    const reason = m.getByTestId("first-run-error");
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(reason.textContent?.trim()).toContain(
      "These settings can only be changed in Tandem's own window.",
    );
    expect(reason.textContent).toContain("TANDEM_MODELS_DEV_ORIGIN=http://127.0.0.1:5173");
    expect(save.getAttribute("aria-describedby")).toBe(reason.id);
    expect(reason.id).toBeTruthy();
    // The refusal wins: no "Enter a Model ID" line beside it.
    expect(m.queryByTestId("first-run-save-reason")).toBeNull();

    await fireEvent.click(save);
    expect(addModel).not.toHaveBeenCalled();
  });

  it("on Tandem's own window, with both fields filled, there is no message and Save is not described by one", async () => {
    const m = mount();
    await typeModelId(m, "qwen");
    expect(m.queryByTestId("first-run-error")).toBeNull();
    expect(saveButton(m).getAttribute("aria-describedby")).toBeNull();
  });
});
