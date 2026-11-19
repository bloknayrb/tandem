// @vitest-environment happy-dom

/**
 * The first-run window, "Add a local model (optional)" (#1123; ADR-039 items
 * 21–23, Requirement 2 of the PR 4a part 1 brief).
 *
 * Exercised by a direct mount (the component has no internal
 * `BYO_MODELS_ENABLED` gate — App's mount is). `createModels` is mocked so the
 * add is controllable without a server round-trip. The window's model
 * becomes the Default (Bryan's pick from options, 2026-11-18): when the store
 * already marked it inside the add's own write there is no `setDefault`;
 * otherwise the window sets it. The real-store half is first-run-model-picker-store.test.ts.
 *
 * Contracts:
 *   - only local providers are listed, Ollama first (P4);
 *   - the copy is the exports of `local-model-copy.ts`, the dialog named by its
 *     title (R2.1);
 *   - no model id is prefilled, and a hint names no model (V8);
 *   - Save says why it cannot save, focusable and described by the reason (V14);
 *   - a rolled-back add keeps the window open with the store's error;
 *   - a committed add the store marked completes once, with no `setDefault`;
 *   - a committed add the store did not mark sets it as the default, once;
 *   - a failed default closes as a success, clears the store's error, and
 *     then, when the model is still saved and still not the Default, raises
 *     one warning notice through `onNotify`, after `onComplete` (R0.1);
 *     a model removed or made the Default meanwhile raises none;
 *   - a close during a save leaves no error and never completes twice (R2.4).
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
// The store's saved list, read through a getter so a case can REASSIGN it
// (never mutate it in place) while a write is pending (R0.1).
let storeModels: { id: string }[] = [];
let storeSaveError: string | null = null;
// The store's default after the add: what the window reads to decide whether
// its model still needs `setDefault`.
let storeDefault: string | null = null;

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
    get models() {
      // Only `id` is read by the window.
      return storeModels as never;
    },
    get defaultModelId() {
      return storeDefault;
    },
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
  storeDefault = null;
  storeModels = [];
});

/** An add that commits and that the store's rule marked as the default. */
const markedAdd = (id: string) => async () => {
  storeDefault = id;
  return id;
};

afterEach(() => {
  cleanup();
});

// The ordinary tab: these suites run as Tandem's own window (#2404). The
// blocked state has its own file, settings-models-tab-own-window.test.ts.
asTandemOwnWindow();

function mount(onComplete = vi.fn(), onNotify = vi.fn()) {
  const m = render(FirstRunModelPickerModal, { props: { onComplete, onNotify } });
  return { ...m, onComplete, onNotify };
}

/** R0.1's notice, exactly: a warning with no CTA (one argument). */
const DEFAULT_NOT_SET = {
  id: expect.any(String),
  type: "general-error",
  severity: "warning",
  message:
    "Your local model was saved, but Tandem could not make it your Default model. You can mark it as Default in Settings → Models.",
  dedupKey: "first-run-default-not-set",
  timestamp: expect.any(Number),
};
/** The saved entry, in the mocked list where a notice is expected. */
const SAVED = { id: "new-id" };
type Mounted = ReturnType<typeof mount>;
const modelIdField = (m: Mounted) => m.getByTestId("first-run-modelid") as HTMLInputElement;
const saveButton = (m: Mounted) => m.getByTestId("first-run-save") as HTMLButtonElement;
async function typeModelId(m: Mounted, value: string) {
  await fireEvent.input(modelIdField(m), { target: { value } });
}
/** A promise and its resolver, for an add held in flight. */
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

  it("the subtitle describes the dialog (ADR-039 item 27, A7)", () => {
    const m = mount();
    const dialog = m.getByRole("dialog", {
      name: PICKER_TITLE,
      description: PICKER_LOCAL_SUBTITLE,
    });
    expect(dialog.getAttribute("aria-describedby")).toBe("first-run-subtitle-text");
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
  it("a rolled-back add (null) keeps the window open with the store's error and the typed fields, no default", async () => {
    addModel.mockResolvedValue(null);
    storeSaveError = "Model registry changed elsewhere; reloaded.";
    const m = mount();
    await fireEvent.input(m.getByTestId("first-run-displayname"), { target: { value: "Mine" } });
    await typeModelId(m, "qwen");
    await fireEvent.click(saveButton(m));
    await flush(); // the continuation has run

    expect(addModel).toHaveBeenCalledTimes(1);
    expect(setDefault).not.toHaveBeenCalled();
    expect(m.onComplete).not.toHaveBeenCalled();
    const err = await m.findByTestId("first-run-error");
    expect(err.textContent).toMatch(/changed elsewhere/i);
    expect(m.getByTestId("first-run-model-modal")).toBeTruthy();
    // Nothing typed is lost.
    expect((m.getByTestId("first-run-displayname") as HTMLInputElement).value).toBe("Mine");
    expect(modelIdField(m).value).toBe("qwen");
    expect((m.getByTestId("first-run-endpoint") as HTMLInputElement).value).toBe(
      "http://127.0.0.1:11434",
    );
  });

  it("a failed save from a focused Save gives focus back to Save", async () => {
    addModel.mockResolvedValue(null);
    const m = mount();
    await typeModelId(m, "qwen");
    saveButton(m).focus();
    await fireEvent.click(saveButton(m));
    await flush();
    await flush();
    expect(m.getByTestId("first-run-error")).toBeTruthy();
    expect(saveButton(m).disabled).toBe(false);
    expect(document.activeElement).toBe(saveButton(m));
  });

  // CD-7: whichever control submitted, a failed save leaves focus on Save.
  // After Enter from a field that is Save, not the field.
  it("a failed save by Enter from the Model ID field puts focus on Save", async () => {
    addModel.mockResolvedValue(null);
    const m = mount();
    await typeModelId(m, "qwen");
    modelIdField(m).focus();
    await fireEvent.submit(modelIdField(m).closest("form") as HTMLFormElement);
    await flush();
    await flush();
    expect(addModel).toHaveBeenCalledTimes(1);
    expect(m.getByTestId("first-run-error")).toBeTruthy();
    expect(document.activeElement).toBe(saveButton(m));
  });

  it("a committed add the store marked completes once, with one addModel and no setDefault", async () => {
    storeModels = [SAVED];
    addModel.mockImplementation(markedAdd("new-id"));
    const m = mount();
    await typeModelId(m, "qwen");
    await fireEvent.click(saveButton(m));
    await flush();

    expect(addModel).toHaveBeenCalledTimes(1);
    expect(addModel.mock.calls[0][0]).toMatchObject({ modelId: "qwen", enabled: true });
    expect(setDefault).not.toHaveBeenCalled();
    // A committed add is a success: nothing to clear (R0.4).
    expect(clearError).not.toHaveBeenCalled();
    expect(m.onComplete).toHaveBeenCalledTimes(1);
    expect(m.onNotify).not.toHaveBeenCalled();
  });

  it("No thanks completes with no write and clears any store error", async () => {
    const m = mount();
    await fireEvent.click(m.getByTestId("first-run-skip-secondary"));
    expect(addModel).not.toHaveBeenCalled();
    expect(clearError).toHaveBeenCalledTimes(1);
    expect(m.onComplete).toHaveBeenCalledTimes(1);
  });
});

describe("FirstRunModelPickerModal — the window's model becomes the Default (Bryan's pick from options, 2026-11-18)", () => {
  for (const [what, before] of [
    ["another model is the default", "other-id"],
    ["no default (the rule stayed silent)", null],
  ] as const) {
    it(`a committed add the store did not mark (${what}): setDefault once with its id, completes once, no notice`, async () => {
      storeDefault = before;
      // The saved entry is in the list and the default is another id, so only
      // setDefault's `true` suppresses the notice.
      storeModels = [SAVED, { id: "other-id" }];
      addModel.mockResolvedValue("new-id");
      const m = mount();
      await typeModelId(m, "qwen");
      await fireEvent.click(saveButton(m));
      await flush();

      expect(addModel).toHaveBeenCalledTimes(1);
      expect(setDefault).toHaveBeenCalledTimes(1);
      expect(setDefault).toHaveBeenCalledWith("new-id");
      expect(clearError).not.toHaveBeenCalled();
      expect(m.onComplete).toHaveBeenCalledTimes(1);
      expect(m.onNotify).not.toHaveBeenCalled();
    });
  }

  it("a failed default after a committed add closes as a success, clears the store's error, then raises one notice (R0.1)", async () => {
    storeDefault = "other-id";
    storeModels = [SAVED, { id: "other-id" }];
    addModel.mockResolvedValue("new-id");
    const def = deferred<boolean>();
    setDefault.mockReturnValue(def.promise);
    const m = mount();
    await typeModelId(m, "qwen");
    await fireEvent.click(saveButton(m));
    await flush();

    // The default is in flight: nothing cleared, nothing completed yet.
    expect(setDefault).toHaveBeenCalledTimes(1);
    expect(clearError).not.toHaveBeenCalled();
    expect(m.onComplete).not.toHaveBeenCalled();
    expect(m.onNotify).not.toHaveBeenCalled();

    def.resolve(false); // the store has rolled back and set its error
    await flush();
    expect(clearError).toHaveBeenCalledTimes(1);
    expect(m.onComplete).toHaveBeenCalledTimes(1);
    expect(m.queryByTestId("first-run-error")).toBeNull();
    expect(m.onNotify).toHaveBeenCalledTimes(1);
    expect(m.onNotify).toHaveBeenCalledWith(DEFAULT_NOT_SET);
    // The window closes first; the notice follows.
    expect(m.onComplete.mock.invocationCallOrder[0]).toBeLessThan(
      m.onNotify.mock.invocationCallOrder[0],
    );
  });

  // The state changes INSIDE the setDefault mock, after the call and before it
  // resolves false: a build that read it before the await would still notify.
  it("a failed default, the model removed meanwhile: no notice", async () => {
    storeDefault = "other-id";
    storeModels = [SAVED, { id: "other-id" }];
    addModel.mockResolvedValue("new-id");
    setDefault.mockImplementation(async () => {
      storeModels = [{ id: "other-id" }]; // a new array without the entry
      return false;
    });
    const m = mount();
    await typeModelId(m, "qwen");
    await fireEvent.click(saveButton(m));
    await flush();
    expect(setDefault).toHaveBeenCalledTimes(1);
    expect(m.onComplete).toHaveBeenCalledTimes(1);
    expect(m.onNotify).not.toHaveBeenCalled();
  });

  it("a failed default, the model already the Default meanwhile: no notice", async () => {
    storeDefault = "other-id";
    storeModels = [SAVED, { id: "other-id" }];
    addModel.mockResolvedValue("new-id");
    setDefault.mockImplementation(async () => {
      storeDefault = "new-id";
      return false;
    });
    const m = mount();
    await typeModelId(m, "qwen");
    await fireEvent.click(saveButton(m));
    await flush();
    expect(setDefault).toHaveBeenCalledTimes(1);
    expect(m.onComplete).toHaveBeenCalledTimes(1);
    expect(m.onNotify).not.toHaveBeenCalled();
  });

  it("closed while setDefault is pending: completes once, a failed default is cleared, and the notice still comes", async () => {
    storeDefault = "other-id";
    storeModels = [SAVED, { id: "other-id" }];
    addModel.mockResolvedValue("new-id");
    const def = deferred<boolean>();
    setDefault.mockReturnValue(def.promise);
    const m = mount();
    await typeModelId(m, "qwen");
    await fireEvent.click(saveButton(m));
    await flush();
    expect(setDefault).toHaveBeenCalledTimes(1);
    await fireEvent.click(m.getByTestId("first-run-skip-secondary"));
    expect(m.onComplete).toHaveBeenCalledTimes(1);
    clearError.mockClear();
    def.resolve(false);
    await flush();
    expect(clearError).toHaveBeenCalledTimes(1);
    expect(m.onComplete).toHaveBeenCalledTimes(1);
    expect(m.onNotify).toHaveBeenCalledTimes(1);
    expect(m.onNotify).toHaveBeenCalledWith(DEFAULT_NOT_SET);
  });

  it("closed while setDefault is pending, then unmounted (as App does), then it fails: one notice", async () => {
    storeDefault = "other-id";
    storeModels = [SAVED, { id: "other-id" }];
    addModel.mockResolvedValue("new-id");
    const def = deferred<boolean>();
    setDefault.mockReturnValue(def.promise);
    const m = mount();
    await typeModelId(m, "qwen");
    await fireEvent.click(saveButton(m));
    await flush();
    expect(setDefault).toHaveBeenCalledTimes(1);
    await fireEvent.click(m.getByTestId("first-run-skip"));
    expect(m.onComplete).toHaveBeenCalledTimes(1);
    m.unmount();
    def.resolve(false);
    await flush();
    expect(m.onComplete).toHaveBeenCalledTimes(1);
    expect(m.onNotify).toHaveBeenCalledTimes(1);
    expect(m.onNotify).toHaveBeenCalledWith(DEFAULT_NOT_SET);
  });

  it("closed while setDefault is pending, and it commits: completes once, nothing cleared, no notice", async () => {
    storeDefault = "other-id";
    storeModels = [SAVED, { id: "other-id" }];
    addModel.mockResolvedValue("new-id");
    const def = deferred<boolean>();
    setDefault.mockReturnValue(def.promise);
    const m = mount();
    await typeModelId(m, "qwen");
    await fireEvent.click(saveButton(m));
    await flush();
    await fireEvent.click(m.getByTestId("first-run-skip"));
    clearError.mockClear();
    def.resolve(true);
    await flush();
    expect(clearError).not.toHaveBeenCalled();
    expect(m.onComplete).toHaveBeenCalledTimes(1);
    expect(m.onNotify).not.toHaveBeenCalled();
  });
});

describe("FirstRunModelPickerModal — closed during a save (R2.4)", () => {
  it("closed during the add, which then commits unmarked: no setDefault and no notice (CD-2)", async () => {
    // The saved entry is in the list and the Default another id: a build that
    // notified on a close during the add would fire here.
    storeDefault = "other-id";
    storeModels = [SAVED, { id: "other-id" }];
    const add = deferred<string | null>();
    addModel.mockReturnValue(add.promise);
    const m = mount();
    await typeModelId(m, "qwen");
    await fireEvent.click(saveButton(m));
    await fireEvent.click(m.getByTestId("first-run-skip"));
    expect(m.onComplete).toHaveBeenCalledTimes(1);
    add.resolve("new-id");
    await flush();
    expect(setDefault).not.toHaveBeenCalled();
    expect(m.onComplete).toHaveBeenCalledTimes(1);
    expect(m.onNotify).not.toHaveBeenCalled();
  });

  for (const exit of ["first-run-skip", "first-run-skip-secondary"] as const) {
    it(`${exit} during a pending add, then the add commits: the error cleared after`, async () => {
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

  it("a click on the scrim during a pending add, then the add commits: the error cleared after", async () => {
    const add = deferred<string | null>();
    addModel.mockReturnValue(add.promise);
    const m = mount();
    await typeModelId(m, "qwen");
    await fireEvent.click(saveButton(m));
    await fireEvent.click(m.getByTestId("first-run-model-modal")); // the scrim itself
    expect(m.onComplete).toHaveBeenCalledTimes(1);
    clearError.mockClear();

    add.resolve("new-id");
    await flush();
    expect(setDefault).not.toHaveBeenCalled();
    expect(clearError).toHaveBeenCalledTimes(1);
    expect(m.onComplete).toHaveBeenCalledTimes(1);
  });

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

describe("FirstRunModelPickerModal — while a save is in flight", () => {
  it("Save is natively disabled, and focus stays in the dialog so Escape still closes it", async () => {
    const add = deferred<string | null>();
    addModel.mockReturnValue(add.promise);
    const m = mount();
    await typeModelId(m, "qwen");
    const save = saveButton(m);
    save.focus();
    await fireEvent.click(save);
    expect(save.disabled).toBe(true);
    const dialog = m.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);
    await fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(m.onComplete).toHaveBeenCalledTimes(1);
    add.resolve(null);
    await flush();
  });

  it("an add that throws after the window closed leaves no store error", async () => {
    let reject!: (e: Error) => void;
    addModel.mockReturnValue(
      new Promise<string | null>((_, r) => {
        reject = r;
      }),
    );
    const m = mount();
    await typeModelId(m, "qwen");
    await fireEvent.click(saveButton(m));
    await fireEvent.click(m.getByTestId("first-run-skip"));
    clearError.mockClear();
    reject(new Error("network"));
    await flush();
    expect(clearError).toHaveBeenCalledTimes(1);
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
