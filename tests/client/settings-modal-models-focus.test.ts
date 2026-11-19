// @vitest-environment happy-dom

/**
 * Focus in the Models tab, one frame later (#1123, ADR-039 item 27; the
 * brief's A2 and A5). Settings re-homes focus that one of its own controls
 * dropped (`rehomeStrandedFocus`, on the next animation frame), and would put
 * it on the Models nav button. The tab must have put focus back in the list
 * before that frame, so the recovery finds it inside Settings and stands down.
 *
 * Here, not in `settings-modal-focus.test.ts`: these need the flag lit and the
 * Models store mocked file-wide, which would add a Models tab to that file's
 * own cases.
 *
 * happy-dom raises no `focusout` when a focused element is removed (Chromium
 * does, at the detached node, and it reaches `document`), so each case raises
 * it at the document by hand, as `settings-modal-focus.test.ts` does. The
 * recovery reads its own `lastFocusedInside`, not the event's target.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../../src/client/hooks/useTandemSettings";
import { drain, installHeldFetch } from "../helpers/held-fetch";
import { installLocalStorageStub } from "../helpers/local-storage-stub.js";
import { modelsPose } from "../helpers/models-pose.svelte";
import { createStoreWrites } from "../helpers/models-store-writes";
import { asTandemOwnWindow } from "../helpers/models-write-access.svelte";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as typeof import("../../src/shared/constants.js").BYO_MODELS_ENABLED,
}));

const harness = vi.hoisted(() => ({
  writes: null as unknown as ReturnType<
    typeof import("../helpers/models-store-writes").createStoreWrites
  >,
}));

vi.mock(import("../../src/client/hooks/useModels.svelte"), async (importOriginal) => {
  const { modelsPose } = await import("../helpers/models-pose.svelte");
  return {
    ...(await importOriginal()),
    createModels: () => ({
      get models() {
        return modelsPose.models as never;
      },
      get defaultModelId() {
        return modelsPose.defaultModelId;
      },
      saveError: null,
      loaded: true,
      loading: false,
      loadFailed: false,
      clearError: vi.fn(),
      reload: vi.fn(async () => {}),
      setDefault: vi.fn(async () => true),
      addModel: (patch: Record<string, unknown>) => harness.writes.addModel(patch),
      updateModel: (id: string, patch: Record<string, unknown>) =>
        harness.writes.updateModel(id, patch),
      deleteModel: (id: string) => harness.writes.deleteModel(id),
      toggleEnabled: (id: string) => harness.writes.toggleEnabled(id),
    }),
  };
});

vi.mock(import("../../src/client/hooks/useLocalModelSettings.svelte"), () => ({
  createLocalModelSettings: () => ({
    editing: false,
    known: true,
    loading: false,
    loadFailed: false,
    saveNotice: null,
    load: vi.fn(async () => {}),
    setEditing: vi.fn(async () => {}),
  }),
}));

const { default: SettingsModal } = await import("../../src/client/components/SettingsModal.svelte");

asTandemOwnWindow();

beforeEach(() => {
  installLocalStorageStub();
  installHeldFetch(); // every read stays pending; nothing here needs one
  harness.writes = createStoreWrites();
  modelsPose.models = [];
  modelsPose.defaultModelId = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const local = (id: string) => ({
  id,
  provider: "local-ollama",
  displayName: `Model ${id}`,
  modelId: `m-${id}`,
  endpoint: "http://127.0.0.1:11434",
  enabled: true,
});

/** One rAF plus a macrotask: the recovery runs on an animation frame. */
function afterNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

/** What Chromium raises when the focused element is removed. */
function focusDropped() {
  document.dispatchEvent(new FocusEvent("focusout", { relatedTarget: null }));
}

async function mountOnModels() {
  const view = render(SettingsModal, {
    props: {
      open: true,
      onClose: vi.fn(),
      settings: loadSettings(),
      onUpdate: vi.fn(),
      connected: true,
      reconnectAttempts: 0,
    },
  });
  await fireEvent.click(view.getByTestId("settings-modal-tab-models"));
  await tick();
  const must = (testId: string) => view.getByTestId(testId);
  return { ...view, must };
}

describe("one frame later, focus is still where the Models tab put it", () => {
  it("empty-state Add, then Cancel: the empty state's button, not the Models nav button", async () => {
    const v = await mountOnModels();
    v.must("model-add-btn").focus();
    await fireEvent.click(v.must("model-add-btn"));
    expect(document.activeElement).toBe(v.must("model-edit-provider"));
    v.getByRole("button", { name: "Cancel" }).click();
    focusDropped();
    await afterNextFrame();
    expect(document.activeElement).toBe(v.must("model-add-btn"));
    expect(v.must("model-add-btn").textContent?.trim()).toBe("Add your first model");
  });

  it("Edit, then Escape: its Edit button", async () => {
    modelsPose.models = [local("a")];
    const v = await mountOnModels();
    await fireEvent.click(v.must("model-edit-btn-a"));
    await fireEvent.keyDown(v.must("model-edit-provider"), { key: "Escape" });
    focusDropped();
    await afterNextFrame();
    expect(document.activeElement).toBe(v.must("model-edit-btn-a"));
    // Escape closed the window, not Settings.
    expect(v.queryByTestId("settings-modal")).not.toBeNull();
  });

  it("Confirm on the only row, idle queue: the empty state's button", async () => {
    modelsPose.models = [local("a")];
    const v = await mountOnModels();
    await fireEvent.click(v.must("model-delete-btn-a"));
    v.must("model-delete-confirm-a").click();
    focusDropped();
    await afterNextFrame();
    expect(document.activeElement).toBe(v.must("model-add-btn"));
    harness.writes.release("commit");
    await drain();
    await afterNextFrame();
    expect(document.activeElement).toBe(v.must("model-add-btn"));
  });

  it("Confirm on the only row with an earlier write queued: Settings may first take focus to the nav button; the empty state's button after settle, never a detached one", async () => {
    modelsPose.models = [local("a")];
    const v = await mountOnModels();
    await fireEvent.click(v.must("model-toggle-a")); // an earlier write, held
    await drain();
    await fireEvent.click(v.must("model-delete-btn-a"));
    v.must("model-delete-confirm-a").focus();
    await fireEvent.click(v.must("model-delete-confirm-a"));
    await drain();
    expect(v.queryByTestId("model-row-a")).not.toBeNull();
    // The toggle settles; the delete's turn comes and removes the row with its
    // focused Confirm, while the delete's POST is still pending.
    harness.writes.release("commit");
    await drain();
    expect(v.queryByTestId("model-row-a")).toBeNull();
    expect(harness.writes.pendingCount).toBe(1);
    focusDropped();
    await afterNextFrame();
    // Accepted: Settings' recovery got there first.
    expect(document.activeElement).toBe(v.must("settings-modal-tab-models"));
    harness.writes.release("commit"); // the delete
    await drain();
    await afterNextFrame();
    const focused = document.activeElement as HTMLElement;
    expect(focused.isConnected).toBe(true);
    expect(focused).toBe(v.must("model-add-btn"));
    expect(focused.textContent?.trim()).toBe("Add your first model");
  });

  it("a rollback after Cancel during a pending Add from the empty state: the empty state's button", async () => {
    const v = await mountOnModels();
    await fireEvent.click(v.must("model-add-btn"));
    await fireEvent.input(v.must("model-edit-modelid"), { target: { value: "qwen" } });
    await fireEvent.submit(v.must("model-edit-save").closest("form") as HTMLFormElement);
    await drain();
    await fireEvent.click(v.getByRole("button", { name: "Cancel" }));
    await tick();
    harness.writes.release("rollback"); // the list's "+ Add model" goes
    focusDropped();
    await drain();
    await afterNextFrame();
    expect(document.activeElement).toBe(v.must("model-add-btn"));
    expect(v.must("model-add-btn").textContent?.trim()).toBe("Add your first model");
  });
});
