// @vitest-environment happy-dom

/**
 * The "Let local models comment and suggest changes" control in the Models tab
 * (#1123, ADR-039's opt-in tier). Both stores are mocked so each state can be
 * posed without a server.
 *
 * Contracts pinned:
 *  - the control is present in EVERY state of the models list (loading, load
 *    failed, empty, populated) — it is the off switch;
 *  - it carries ADR-039's "experimental, review every suggestion" wording;
 *  - with the server's value unknown there is no checkbox (an unticked box
 *    would claim "off" and could only be clicked to On) — only Retry and an
 *    explicit Switch off;
 *  - it is not disabled by `readOnly`;
 *  - after a save the server did not take, the DOM follows the store, not the click.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRegistryEntry } from "../../src/client/hooks/useTandemSettings";
import type { TandemSettings } from "../../src/client/hooks/useTandemSettings.svelte";

interface ModelsPose {
  models?: ModelRegistryEntry[];
  loading?: boolean;
  loadFailed?: boolean;
}
let modelsPose: ModelsPose = {};

vi.mock(import("../../src/client/hooks/useModels.svelte"), () => ({
  createModels: () => ({
    get models() {
      return modelsPose.models ?? [];
    },
    defaultModelId: null,
    saveError: null,
    get loading() {
      return modelsPose.loading ?? false;
    },
    get loadFailed() {
      return modelsPose.loadFailed ?? false;
    },
    reload: vi.fn(async () => {}),
    clearError: vi.fn(),
    addModel: vi.fn(async () => "id"),
    updateModel: vi.fn(async () => true),
    deleteModel: vi.fn(async () => {}),
    toggleEnabled: vi.fn(async () => {}),
    setDefault: vi.fn(async () => true),
  }),
}));

interface EditingPose {
  editing: boolean;
  known: boolean;
  loadFailed: boolean;
  saveNotice: string | null;
}
let pose: EditingPose = { editing: false, known: true, loadFailed: false, saveNotice: null };
const load = vi.fn(async () => {});
/** What the fake server makes of a save: by default it takes it. */
let onSave: (value: boolean) => void = (value) => {
  pose.editing = value;
};
const setEditing = vi.fn(async (value: boolean) => {
  onSave(value);
});

vi.mock(import("../../src/client/hooks/useLocalModelSettings.svelte"), () => ({
  createLocalModelSettings: () => ({
    get editing() {
      return pose.editing;
    },
    get known() {
      return pose.known;
    },
    loading: false,
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

function mount(readOnly = false) {
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
      readOnly,
      notify: vi.fn(),
    },
  });
}

const LOCAL: ModelRegistryEntry = {
  id: "m1",
  provider: "local-ollama",
  displayName: "Local",
  modelId: "qwen2.5:14b",
  endpoint: "http://127.0.0.1:11434",
  enabled: true,
};

afterEach(() => {
  modelsPose = {};
  pose = { editing: false, known: true, loadFailed: false, saveNotice: null };
  onSave = (value) => {
    pose.editing = value;
  };
  load.mockClear();
  setEditing.mockClear();
  cleanup();
});

describe("SettingsModelsTab — local-model editing control", () => {
  it("loads the setting when the tab mounts", () => {
    mount();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each<[string, ModelsPose]>([
    ["loading", { loading: true }],
    ["load failed", { loadFailed: true }],
    ["empty", { models: [] }],
    ["populated", { models: [LOCAL] }],
  ])("is present while the models list is %s", (_name, p) => {
    modelsPose = p;
    const { queryByTestId } = mount();
    expect(queryByTestId("local-model-editing-toggle")).not.toBeNull();
  });

  it("says that replies in comment threads are part of what it switches", () => {
    const { getByTestId } = mount();
    expect(getByTestId("local-model-editing-section").textContent).toMatch(
      /reply in comment threads/,
    );
  });

  it("is off by default and carries the experimental / review wording", () => {
    const { getByTestId } = mount();
    expect((getByTestId("local-model-editing-toggle") as HTMLInputElement).checked).toBe(false);
    const text = getByTestId("local-model-editing-section").textContent ?? "";
    expect(text).toMatch(/Let local models comment and suggest changes/);
    expect(text).toMatch(/Experimental/);
    expect(text).toMatch(/review every suggestion/);
    expect(text).toMatch(/reply in chat only/);
  });

  it("reflects the server's value", () => {
    pose.editing = true;
    const { getByTestId } = mount();
    expect((getByTestId("local-model-editing-toggle") as HTMLInputElement).checked).toBe(true);
  });

  it("sends the clicked value", async () => {
    const { getByTestId } = mount();
    const box = getByTestId("local-model-editing-toggle") as HTMLInputElement;
    await fireEvent.click(box);
    expect(setEditing).toHaveBeenCalledWith(true);
  });

  it("follows the store, not the click, when the server did not take the save", async () => {
    pose.editing = true;
    onSave = () => {}; // the Off did not land: the server still says on
    const { getByTestId } = mount();
    const box = getByTestId("local-model-editing-toggle") as HTMLInputElement;
    await fireEvent.click(box);
    await vi.waitFor(() => expect(setEditing).toHaveBeenCalledWith(false));
    await vi.waitFor(() => expect(box.checked).toBe(true));
  });

  it("is not disabled by readOnly — switching off must always be possible", () => {
    pose.editing = true;
    const { getByTestId } = mount(true);
    expect((getByTestId("local-model-editing-toggle") as HTMLInputElement).disabled).toBe(false);
  });

  it("shows a save notice as an alert", () => {
    pose.saveNotice = "This could not be switched on. It is off for now.";
    const { getByTestId } = mount();
    const alert = getByTestId("local-model-editing-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toMatch(/off for now/);
  });

  it("with the value unknown after a failed load: no checkbox, Retry and an explicit Switch off", async () => {
    pose = { editing: false, known: false, loadFailed: true, saveNotice: null };
    const { queryByTestId, getByTestId } = mount();
    expect(queryByTestId("local-model-editing-toggle")).toBeNull();
    load.mockClear();
    await fireEvent.click(getByTestId("local-model-editing-retry"));
    expect(load).toHaveBeenCalledTimes(1);
    await fireEvent.click(getByTestId("local-model-editing-force-off"));
    expect(setEditing).toHaveBeenCalledWith(false);
  });

  it("with the value unknown and still loading: no checkbox yet", () => {
    pose = { editing: false, known: false, loadFailed: false, saveNotice: null };
    const { queryByTestId } = mount();
    expect(queryByTestId("local-model-editing-toggle")).toBeNull();
    expect(queryByTestId("local-model-editing-loading")).not.toBeNull();
  });

  it("offers Switch off while the value is still being read, so a hung read cannot block it", async () => {
    pose = { editing: false, known: false, loadFailed: false, saveNotice: null };
    const { getByTestId } = mount();
    await fireEvent.click(getByTestId("local-model-editing-force-off-pending"));
    expect(setEditing).toHaveBeenCalledWith(false);
  });
});
