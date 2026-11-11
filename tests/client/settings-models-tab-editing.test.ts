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
 *  - the checkbox is ALWAYS in the DOM. The value is "settled" when the store
 *    knows it and no read is in flight; otherwise the box is indeterminate,
 *    `aria-disabled` (never `disabled`, which would drop keyboard focus) and a
 *    click on it sends nothing — Retry and an explicit Switch off are the
 *    controls for that state;
 *  - live-region roles sit on the text only: "Checking…" is a status with no
 *    `aria-busy`, the load error is an alert that contains no button;
 *  - a tab remounted while its read is in flight shows the unknown state, not
 *    the last value as a live checkbox;
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
  loading: boolean;
  loadFailed: boolean;
  saveNotice: string | null;
}
const SETTLED_OFF: EditingPose = {
  editing: false,
  known: true,
  loading: false,
  loadFailed: false,
  saveNotice: null,
};
let pose: EditingPose = { ...SETTLED_OFF };
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

function toggle(getByTestId: (id: string) => HTMLElement): HTMLInputElement {
  return getByTestId("local-model-editing-toggle") as HTMLInputElement;
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
  pose = { ...SETTLED_OFF };
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

  it("when settled the box is live: not indeterminate, not aria-disabled, and a click sends the new value", async () => {
    pose = { ...SETTLED_OFF, editing: true };
    const { getByTestId, queryByTestId } = mount();
    const box = toggle(getByTestId);
    expect(box.indeterminate).toBe(false);
    expect(box.checked).toBe(true);
    expect(box.getAttribute("aria-disabled") ?? "false").toBe("false");
    expect(box.disabled).toBe(false);
    expect(queryByTestId("local-model-editing-loading")).toBeNull();
    expect(queryByTestId("local-model-editing-load-error")).toBeNull();
    await fireEvent.click(box);
    expect(setEditing).toHaveBeenCalledTimes(1);
    expect(setEditing).toHaveBeenCalledWith(false);
  });

  it("points aria-describedby at the experimental / review-every-suggestion help text", () => {
    const { getByTestId, container } = mount();
    const id = toggle(getByTestId).getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const matches = container.querySelectorAll(`[id="${id}"]`);
    expect(matches).toHaveLength(1); // the reference resolves, and to one element
    const help = matches[0]?.textContent ?? "";
    expect(help).toMatch(/Experimental/);
    expect(help).toMatch(/review every suggestion/);
  });

  describe.each<[string, Partial<EditingPose>]>([
    ["unknown and still being read", { known: false, loading: true }],
    ["unknown, before the read has started", { known: false }],
    ["unknown after a failed read", { known: false, loadFailed: true }],
    ["a failed read being retried", { known: false, loadFailed: true, loading: true }],
    ["known, but a fresh read is in flight", { known: true, loading: true }],
    ["known and on, but a fresh read is in flight", { known: true, editing: true, loading: true }],
  ])("not settled — %s", (_name, p) => {
    it("keeps the checkbox mounted, indeterminate and aria-disabled, never disabled", () => {
      pose = { ...SETTLED_OFF, ...p };
      const { getByTestId } = mount();
      const box = toggle(getByTestId);
      expect(box.indeterminate).toBe(true);
      expect(box.checked).toBe(false); // it claims neither on nor off
      expect(box.getAttribute("aria-disabled")).toBe("true");
      expect(box.disabled).toBe(false);
      expect(box.hasAttribute("disabled")).toBe(false);
    });

    it("a click on it sends nothing and leaves it indeterminate", async () => {
      pose = { ...SETTLED_OFF, ...p };
      const { getByTestId } = mount();
      const box = toggle(getByTestId);
      await fireEvent.click(box);
      await fireEvent.click(box);
      expect(setEditing).toHaveBeenCalledTimes(0);
      expect(box.indeterminate).toBe(true);
      expect(box.checked).toBe(false);
    });
  });

  it("while the value is being read: 'Checking…' is a status, with no aria-busy anywhere in the section", () => {
    pose = { ...SETTLED_OFF, known: false, loading: true };
    const { getByTestId, queryByTestId } = mount();
    const status = getByTestId("local-model-editing-loading");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toMatch(/Checking/);
    expect(status.hasAttribute("aria-busy")).toBe(false);
    expect(status.querySelector("button")).toBeNull();
    expect(getByTestId("local-model-editing-section").querySelector("[aria-busy]")).toBeNull();
    expect(queryByTestId("local-model-editing-load-error")).toBeNull();
    expect(queryByTestId("local-model-editing-retry")).toBeNull();
  });

  it("after a failed read: the error text is an alert that contains no button; Retry and Switch off work", async () => {
    pose = { ...SETTLED_OFF, known: false, loadFailed: true };
    const { getByTestId, queryByTestId } = mount();
    const alert = getByTestId("local-model-editing-load-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toMatch(/Couldn't read/);
    expect(alert.querySelector("button")).toBeNull();
    const retry = getByTestId("local-model-editing-retry");
    const forceOff = getByTestId("local-model-editing-force-off");
    // Neither control sits inside ANY live region, so pressing one is not announced as an alert.
    expect(retry.closest("[role='alert'], [role='status']")).toBeNull();
    expect(forceOff.closest("[role='alert'], [role='status']")).toBeNull();
    expect(queryByTestId("local-model-editing-loading")).toBeNull();

    load.mockClear();
    await fireEvent.click(retry);
    expect(load).toHaveBeenCalledTimes(1);
    expect(setEditing).toHaveBeenCalledTimes(0);
    await fireEvent.click(forceOff);
    expect(setEditing).toHaveBeenCalledTimes(1);
    expect(setEditing).toHaveBeenCalledWith(false);
  });

  it("a failed read that is being retried shows 'Checking…', not the stale error", () => {
    pose = { ...SETTLED_OFF, known: false, loadFailed: true, loading: true };
    const { queryByTestId } = mount();
    expect(queryByTestId("local-model-editing-loading")).not.toBeNull();
    expect(queryByTestId("local-model-editing-load-error")).toBeNull();
    expect(queryByTestId("local-model-editing-retry")).toBeNull();
  });

  it("offers Switch off while the value is still being read, so a hung read cannot block it", async () => {
    pose = { ...SETTLED_OFF, known: false, loading: true };
    const { getByTestId } = mount();
    const forceOff = getByTestId("local-model-editing-force-off-pending");
    expect(forceOff.closest("[role='alert'], [role='status']")).toBeNull();
    await fireEvent.click(forceOff);
    expect(setEditing).toHaveBeenCalledTimes(1);
    expect(setEditing).toHaveBeenCalledWith(false);
  });

  it("a tab remounted while its read is in flight shows the unknown state, not the last value as a live checkbox", async () => {
    // The store is a module singleton: on a remount it still holds the value
    // from the last visit (known, on) while this mount's own read is in flight.
    pose = { ...SETTLED_OFF, known: true, editing: true };
    const first = mount();
    expect(toggle(first.getByTestId).checked).toBe(true);
    first.unmount();

    pose.loading = true; // what `load()` does synchronously on the next mount
    const { getByTestId, queryByTestId } = mount();
    const box = toggle(getByTestId);
    expect(box.checked).toBe(false);
    expect(box.indeterminate).toBe(true);
    expect(box.getAttribute("aria-disabled")).toBe("true");
    expect(queryByTestId("local-model-editing-loading")).not.toBeNull();
    expect(queryByTestId("local-model-editing-force-off-pending")).not.toBeNull();
    await fireEvent.click(box);
    expect(setEditing).toHaveBeenCalledTimes(0);
  });
});
