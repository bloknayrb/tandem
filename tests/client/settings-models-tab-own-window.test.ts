// @vitest-environment happy-dom

/**
 * #2404 R1.6 — the Models tab on a page that is not Tandem's own window.
 *
 * The two routes that change the local-model settings accept a request only
 * from Tandem's own window. A tab opened at `http://localhost:3479` cannot even
 * read the server's refusal, so the client decides for itself: the tab says
 * once, at the top, that these settings can only be changed in Tandem's own
 * window, shows every control that would write as unavailable instead of
 * failing on each click, and announces the message to a screen reader.
 *
 * The announcement is pinned by MECHANISM: the live region is in the DOM and
 * empty first, and the text arrives in that same node afterwards. A region
 * that mounts with its text already in it is commonly read out by nothing
 * (`LiveRegion.svelte`).
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetModelsWriteAccessForTests,
  _setPageOriginForTests,
} from "../../src/client/hooks/useModelsWriteAccess.svelte";
import type { ModelRegistryEntry } from "../../src/client/hooks/useTandemSettings";
import type { TandemSettings } from "../../src/client/hooks/useTandemSettings.svelte";
import { noteModelsWriteRefused } from "../../src/client/models/write-refusal";

interface ModelsPose {
  models?: ModelRegistryEntry[];
  defaultModelId?: string | null;
  saveError?: string | null;
  loading?: boolean;
  loadFailed?: boolean;
}
let modelsPose: ModelsPose = {};
const modelsApi = {
  reload: vi.fn(async () => {}),
  clearError: vi.fn(),
  addModel: vi.fn(async (): Promise<string | null> => "id"),
  updateModel: vi.fn(async () => true),
  deleteModel: vi.fn(async () => {}),
  toggleEnabled: vi.fn(async () => {}),
  setDefault: vi.fn(async () => true),
};

vi.mock(import("../../src/client/hooks/useModels.svelte"), () => ({
  createModels: () => ({
    get models() {
      return modelsPose.models ?? [];
    },
    get defaultModelId() {
      return modelsPose.defaultModelId ?? null;
    },
    get saveError() {
      return modelsPose.saveError ?? null;
    },
    get loading() {
      return modelsPose.loading ?? false;
    },
    get loadFailed() {
      return modelsPose.loadFailed ?? false;
    },
    ...modelsApi,
  }),
}));

interface EditingPose {
  editing: boolean;
  known: boolean;
  loading: boolean;
  loadFailed: boolean;
  saveNotice: string | null;
}
const SETTLED_ON: EditingPose = {
  editing: true,
  known: true,
  loading: false,
  loadFailed: false,
  saveNotice: null,
};
let pose: EditingPose = { ...SETTLED_ON };
const load = vi.fn(async () => {});
const setEditing = vi.fn(async (_value: boolean) => {});

vi.mock(import("../../src/client/hooks/useLocalModelSettings.svelte"), () => ({
  createLocalModelSettings: () => ({
    get editing() {
      return pose.editing;
    },
    get known() {
      return pose.known;
    },
    get loading() {
      return pose.loading;
    },
    get loadFailed() {
      return pose.loadFailed;
    },
    get saveNotice() {
      return pose.saveNotice;
    },
    load,
    setEditing,
  }),
}));

const { default: SettingsModelsTab } = await import(
  "../../src/client/components/settings-tabs/SettingsModelsTab.svelte"
);

function mount() {
  return render(SettingsModelsTab, {
    props: {
      open: true,
      settings: {
        selectionDwellMs: 1000,
        selectionToolbar: true,
        marginView: false,
      } as TandemSettings,
      onUpdate: vi.fn(),
      connected: true,
      reconnectAttempts: 0,
      readOnly: false,
      notify: vi.fn(),
    },
  });
}

const A: ModelRegistryEntry = {
  id: "a",
  provider: "local-ollama",
  displayName: "Model A",
  modelId: "qwen2.5:14b",
  endpoint: "http://127.0.0.1:11434",
  enabled: true,
};
const B: ModelRegistryEntry = { ...A, id: "b", displayName: "Model B" };

const FOREIGN_NOTICE =
  "These settings can only be changed in Tandem's own window. Open Tandem at http://127.0.0.1:3479, or use the Tandem desktop app.";

beforeEach(() => {
  vi.useFakeTimers();
  _resetModelsWriteAccessForTests();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  _resetModelsWriteAccessForTests();
  modelsPose = {};
  pose = { ...SETTLED_ON };
  for (const fn of Object.values(modelsApi)) fn.mockClear();
  load.mockClear();
  setEditing.mockClear();
});

describe("a page at http://localhost:3479 (the server's answers are unreadable there)", () => {
  beforeEach(() => _setPageOriginForTests("http://localhost:3479"));

  it.each<[string, ModelsPose]>([
    ["while the list is loading", { loading: true }],
    ["after the list failed to load", { loadFailed: true }],
    ["with no models", {}],
    ["with models", { models: [A, B], defaultModelId: "a" }],
  ])("shows the message exactly once, at the top, %s", (_what, list) => {
    modelsPose = list;
    const { container, getAllByTestId } = mount();
    const notices = getAllByTestId("models-own-window-notice");
    expect(notices).toHaveLength(1);
    expect(notices[0].textContent?.trim()).toBe(FOREIGN_NOTICE);
    // At the top: nothing that writes, and no other message, comes before it.
    const first = container.querySelector("[data-testid]");
    expect(first?.getAttribute("data-testid")).toBe("models-own-window-live");
    expect(container.querySelectorAll("[role='alert']")).toHaveLength(0);
  });

  it("announces it: the live region is mounted empty, then the text arrives in the same node", async () => {
    const { getByTestId } = mount();
    const region = getByTestId("models-own-window-live");
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent?.trim()).toBe("");
    // The visible copy is not read a second time.
    expect(getByTestId("models-own-window-notice").getAttribute("aria-hidden")).toBe("true");

    await vi.advanceTimersByTimeAsync(299);
    expect(region.textContent?.trim()).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    await tick();
    expect(getByTestId("models-own-window-live")).toBe(region);
    expect(region.textContent?.trim()).toBe(FOREIGN_NOTICE);
  });

  it("a tab closed before the delay leaves no timer behind", () => {
    const { unmount } = mount();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the failed-read state offers no Retry and no load-error alert: neither could ever succeed", () => {
    modelsPose = { loadFailed: true };
    pose = { ...SETTLED_ON, known: false, loadFailed: true };
    const { queryByTestId } = mount();
    expect(queryByTestId("models-load-error")).toBeNull();
    expect(queryByTestId("models-reload-btn")).toBeNull();
    expect(queryByTestId("local-model-editing-load-error")).toBeNull();
    expect(queryByTestId("local-model-editing-retry")).toBeNull();
    expect(queryByTestId("local-model-editing-force-off")).toBeNull();
    // It does not fall through to a claim that nothing is configured.
    expect(queryByTestId("models-empty-state")).toBeNull();
  });

  it("no 'Checking…' row and no Switch off while the read is in flight: Off follows the same rule as On", () => {
    pose = { ...SETTLED_ON, known: false, loading: true };
    const { queryByTestId } = mount();
    expect(queryByTestId("local-model-editing-loading")).toBeNull();
    expect(queryByTestId("local-model-editing-force-off-pending")).toBeNull();
  });

  it("every control that writes is unavailable but still focusable, and does nothing", async () => {
    modelsPose = { models: [A, B], defaultModelId: "a" };
    const { getByTestId } = mount();

    const controls = [
      "model-add-btn",
      "model-default-b",
      "model-toggle-a",
      "model-edit-btn-a",
      "model-delete-btn-a",
      "local-model-editing-toggle",
    ].map((id) => getByTestId(id) as HTMLInputElement | HTMLButtonElement);

    for (const control of controls) {
      expect(control.getAttribute("aria-disabled"), control.dataset.testid).toBe("true");
      // Not natively disabled: it keeps its place in the tab order.
      expect(control.disabled, control.dataset.testid).toBe(false);
      control.focus();
      expect(document.activeElement, control.dataset.testid).toBe(control);
    }

    const radioB = getByTestId("model-default-b") as HTMLInputElement;
    const toggleA = getByTestId("model-toggle-a") as HTMLInputElement;
    const editing = getByTestId("local-model-editing-toggle") as HTMLInputElement;
    await fireEvent.click(radioB);
    await fireEvent.click(toggleA);
    await fireEvent.click(editing);
    await fireEvent.click(getByTestId("model-add-btn"));
    await fireEvent.click(getByTestId("model-edit-btn-a"));
    await fireEvent.click(getByTestId("model-delete-btn-a"));

    // The DOM did not toggle, and nothing was sent.
    expect(radioB.checked).toBe(false);
    expect((getByTestId("model-default-a") as HTMLInputElement).checked).toBe(true);
    expect(toggleA.checked).toBe(true);
    expect(editing.checked).toBe(true);
    expect(modelsApi.setDefault).not.toHaveBeenCalled();
    expect(modelsApi.toggleEnabled).not.toHaveBeenCalled();
    expect(modelsApi.deleteModel).not.toHaveBeenCalled();
    expect(setEditing).not.toHaveBeenCalled();
    // No dialog opened, no delete confirmation appeared.
    expect(document.querySelector("[data-testid='model-edit-save']")).toBeNull();
    expect(document.querySelector("[data-testid='model-delete-confirm-a']")).toBeNull();
  });

  it("EVERY control that is unavailable for this reason is described by the message, so none is announced as unavailable with no reason", async () => {
    modelsPose = { models: [A, B], defaultModelId: "a" };
    const { getByTestId, container } = mount();
    const region = getByTestId("models-own-window-live");
    expect(region.id).toBe("models-own-window-msg");

    // Derived from the DOM, not from a list: whatever carries aria-disabled.
    const unavailable = [...container.querySelectorAll('[aria-disabled="true"]')];
    const ids = unavailable.map((el) => el.getAttribute("data-testid"));
    expect(ids).toEqual(
      expect.arrayContaining([
        "model-default-a",
        "model-default-b",
        "model-toggle-a",
        "model-toggle-b",
        "model-edit-btn-a",
        "model-delete-btn-a",
        "model-add-btn",
        "local-model-editing-toggle",
      ]),
    );
    for (const el of unavailable) {
      const refs = (el.getAttribute("aria-describedby") ?? "").split(" ");
      expect(refs, el.getAttribute("data-testid") ?? el.outerHTML).toContain(
        "models-own-window-msg",
      );
    }
    // The editing toggle keeps its help text as well.
    expect(getByTestId("local-model-editing-toggle").getAttribute("aria-describedby")).toBe(
      "local-model-editing-help models-own-window-msg",
    );
  });

  it("no second message: the save banners stay out while the notice is up", () => {
    modelsPose = { models: [A], saveError: "Failed to save model changes." };
    pose = { ...SETTLED_ON, saveNotice: "That change could not be saved." };
    const { queryByTestId } = mount();
    expect(queryByTestId("models-save-error")).toBeNull();
    expect(queryByTestId("local-model-editing-error")).toBeNull();
  });
});

describe("Tandem's own window", () => {
  beforeEach(() => _setPageOriginForTests("http://127.0.0.1:3479"));

  it("shows no notice, announces nothing, and its controls are live", async () => {
    modelsPose = { models: [A, B], defaultModelId: "a" };
    const { queryByTestId, getByTestId } = mount();
    await vi.advanceTimersByTimeAsync(1000);
    await tick();
    expect(queryByTestId("models-own-window-notice")).toBeNull();
    expect(getByTestId("models-own-window-live").textContent?.trim()).toBe("");
    expect(getByTestId("model-add-btn").getAttribute("aria-disabled")).toBe("false");
    await fireEvent.click(getByTestId("model-default-b"));
    expect(modelsApi.setDefault).toHaveBeenCalledWith("b");
  });
});

describe("a development page on another 127.0.0.1 port, refused by the server", () => {
  const DEV = "http://127.0.0.1:5173";
  const DEV_NOTICE = `These settings can only be changed in Tandem's own window. This page is served from ${DEV}. In a development setup, start Tandem's server with TANDEM_MODELS_DEV_ORIGIN=${DEV}, then reload this page.`;
  beforeEach(() => _setPageOriginForTests(DEV));

  it("is live until a write is refused; the refusal then shows and announces the message at once", async () => {
    modelsPose = { models: [A, B], defaultModelId: "a" };
    const { queryByTestId, getByTestId } = mount();
    await vi.advanceTimersByTimeAsync(300);
    await tick();
    const region = getByTestId("models-own-window-live");
    expect(queryByTestId("models-own-window-notice")).toBeNull();
    expect(region.textContent?.trim()).toBe("");

    // What each hook does when the server answers 403 OWN_WINDOW_ONLY.
    noteModelsWriteRefused();
    await tick();

    expect(getByTestId("models-own-window-notice").textContent?.trim()).toBe(DEV_NOTICE);
    // The region already existed, so this change is one a screen reader hears.
    expect(getByTestId("models-own-window-live")).toBe(region);
    expect(region.textContent?.trim()).toBe(DEV_NOTICE);
    expect(getByTestId("model-default-b").getAttribute("aria-disabled")).toBe("true");
  });

  it("a refusal that lands before the delay is still announced after it, not at mount", async () => {
    const { getByTestId } = mount();
    noteModelsWriteRefused();
    await tick();
    const region = getByTestId("models-own-window-live");
    expect(region.textContent?.trim()).toBe("");
    await vi.advanceTimersByTimeAsync(300);
    await tick();
    expect(region.textContent?.trim()).toBe(DEV_NOTICE);
  });

  it("a refused page can still read: a failed list load keeps its alert and a working Retry", async () => {
    modelsPose = { loadFailed: true };
    noteModelsWriteRefused();
    const { getByTestId } = mount();
    expect(getByTestId("models-own-window-notice")).toBeTruthy();
    expect(getByTestId("models-load-error")).toBeTruthy();
    await fireEvent.click(getByTestId("models-reload-btn"));
    expect(modelsApi.reload).toHaveBeenCalledTimes(1);
  });

  it("a delete refused on Confirm keeps the pair on screen, so the focused button does not unmount", async () => {
    modelsPose = { models: [A] };
    modelsApi.deleteModel.mockImplementationOnce(async () => {
      noteModelsWriteRefused(); // the hook, on 403 OWN_WINDOW_ONLY
    });
    const { getByTestId } = mount();
    await fireEvent.click(getByTestId("model-delete-btn-a"));
    const confirm = getByTestId("model-delete-confirm-a");
    confirm.focus();
    await fireEvent.click(confirm);
    await vi.advanceTimersByTimeAsync(0);
    await tick();
    expect(getByTestId("model-delete-confirm-a")).toBe(confirm);
    expect(document.activeElement).toBe(confirm);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
  });

  it("a refused page can still read the commenting setting: its read error and Retry stay, but neither Switch off is offered", async () => {
    noteModelsWriteRefused();
    pose = { ...SETTLED_ON, known: false, loadFailed: true };
    const failed = mount();
    load.mockClear(); // the mount itself reads once
    expect(failed.getByTestId("local-model-editing-load-error")).toBeTruthy();
    await fireEvent.click(failed.getByTestId("local-model-editing-retry"));
    expect(load).toHaveBeenCalledTimes(1);
    // Retry hands focus to the checkbox before its own row can be replaced.
    expect(document.activeElement).toBe(failed.getByTestId("local-model-editing-toggle"));
    expect(failed.queryByTestId("local-model-editing-force-off")).toBeNull();
    failed.unmount();

    pose = { ...SETTLED_ON, known: false, loading: true };
    const reading = mount();
    expect(reading.getByTestId("local-model-editing-loading")).toBeTruthy();
    expect(reading.queryByTestId("local-model-editing-force-off-pending")).toBeNull();
  });

  it("the Confirm of a pending delete, once unavailable, is described by the message too", async () => {
    modelsPose = { models: [A] };
    const { getByTestId } = mount();
    await fireEvent.click(getByTestId("model-delete-btn-a"));
    noteModelsWriteRefused();
    await tick();
    const confirm = getByTestId("model-delete-confirm-a");
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(confirm.getAttribute("aria-describedby")).toBe("models-own-window-msg");
  });

  it("a refusal from ANOTHER request while the edit dialog is open: Save is unavailable, the reason is in the dialog, and Save's description resolves", async () => {
    modelsPose = { models: [A] };
    const { getByTestId } = mount();
    await fireEvent.click(getByTestId("model-edit-btn-a"));
    const save = getByTestId("model-edit-save");
    expect(save.getAttribute("aria-disabled")).toBe("false");

    noteModelsWriteRefused(); // e.g. a row toggle's POST, or the boot reconcile
    await tick();

    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(getByTestId("model-edit-error").textContent?.trim()).toBe(DEV_NOTICE);
    const ref = save.getAttribute("aria-describedby");
    expect(ref).toBeTruthy();
    expect(document.getElementById(ref as string)).toBe(getByTestId("model-edit-error"));
    expect(modelsApi.updateModel).not.toHaveBeenCalled();
  });

  it("a pending delete: Confirm goes unavailable and does nothing, Cancel still works", async () => {
    modelsPose = { models: [A] };
    const { getByTestId, queryByTestId, getByText } = mount();
    await fireEvent.click(getByTestId("model-delete-btn-a"));
    const confirm = getByTestId("model-delete-confirm-a");
    noteModelsWriteRefused();
    await tick();
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    await fireEvent.click(confirm);
    expect(modelsApi.deleteModel).not.toHaveBeenCalled();
    await fireEvent.click(getByText("Cancel"));
    expect(queryByTestId("model-delete-confirm-a")).toBeNull();
  });

  it("a save refused while the edit dialog is open keeps the dialog and what was typed, says why, and Save does nothing more", async () => {
    modelsPose = { models: [A] };
    modelsApi.updateModel.mockImplementationOnce(async () => {
      noteModelsWriteRefused(); // the hook, on 403 OWN_WINDOW_ONLY
      return false;
    });
    const { getByTestId } = mount();
    await fireEvent.click(getByTestId("model-edit-btn-a"));
    const save = getByTestId("model-edit-save");
    const form = save.closest("form") as HTMLFormElement;
    await fireEvent.submit(form);
    await vi.advanceTimersByTimeAsync(0);
    await tick();

    expect(modelsApi.updateModel).toHaveBeenCalledTimes(1);
    expect(getByTestId("model-edit-error").textContent?.trim()).toBe(DEV_NOTICE);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    // The unavailable Save points at the reason shown in the dialog.
    const describedBy = save.getAttribute("aria-describedby");
    expect(describedBy).toBe(getByTestId("model-edit-error").id);
    expect(describedBy).toBeTruthy();
    // Click and Enter both end in the form's submit handler: nothing more goes out.
    await fireEvent.submit(form);
    await vi.advanceTimersByTimeAsync(0);
    expect(modelsApi.updateModel).toHaveBeenCalledTimes(1);
  });
});
