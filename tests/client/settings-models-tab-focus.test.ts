// @vitest-environment happy-dom

/**
 * Focus through the Models tab (#1123, ADR-039 item 27; the brief's A2, A3 and
 * A5; the review session's Rulings R-b, R-c and R-d).
 *
 * Here, not in `settings-models-tab.test.ts`: that file's `createModels` mock
 * has non-reactive getters and inert mutators, so a list change never
 * re-renders, and its cases rely on that. These need the list to change the
 * way the store changes it (`tests/helpers/models-store-writes.ts`): queued,
 * optimistic on a later microtask, settled by hand, rolled back as new DOM.
 *
 * What happens a frame later (Settings' stranded-focus recovery) is pinned in
 * `settings-modal-models-focus.test.ts`, which mounts Settings itself.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TandemSettings } from "../../src/client/hooks/useTandemSettings.svelte";
import { noteModelsWriteRefused } from "../../src/client/models/write-refusal";
import { drain, installHeldFetch } from "../helpers/held-fetch";
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
  calls: { addModel: 0, updateModel: 0, deleteModel: 0 },
}));

vi.mock(import("../../src/client/hooks/useModels.svelte"), async () => {
  const { modelsPose } = await import("../helpers/models-pose.svelte");
  return {
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
      addModel: (patch: Record<string, unknown>) => {
        harness.calls.addModel++;
        return harness.writes.addModel(patch);
      },
      updateModel: (id: string, patch: Record<string, unknown>) => {
        harness.calls.updateModel++;
        return harness.writes.updateModel(id, patch);
      },
      deleteModel: (id: string) => {
        harness.calls.deleteModel++;
        return harness.writes.deleteModel(id);
      },
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

const { default: SettingsModelsTab } = await import(
  "../../src/client/components/settings-tabs/SettingsModelsTab.svelte"
);

asTandemOwnWindow();

beforeEach(() => {
  harness.writes = createStoreWrites();
  harness.calls = { addModel: 0, updateModel: 0, deleteModel: 0 };
  modelsPose.models = [];
  modelsPose.defaultModelId = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  installHeldFetch(); // the chat-answerer read stays pending; nothing here needs it
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Entry = Record<string, unknown> & { id: string };
const local = (id: string, provider = "local-ollama"): Entry => ({
  id,
  provider,
  displayName: `Model ${id}`,
  modelId: `m-${id}`,
  endpoint: "http://127.0.0.1:11434",
  enabled: true,
});

function mount() {
  const view = render(SettingsModelsTab, {
    props: {
      open: true,
      settings: { selectionDwellMs: 1000 } as TandemSettings,
      onUpdate: vi.fn(),
      connected: true,
      reconnectAttempts: 0,
      readOnly: false,
      notify: vi.fn(),
    },
  });
  const el = (testId: string) => view.queryByTestId(testId) as HTMLElement | null;
  const must = (testId: string) => {
    const found = el(testId);
    if (!found) throw new Error(`${testId} not found`);
    return found;
  };
  const form = () => must("model-edit-save").closest("form") as HTMLFormElement;
  return { ...view, el, must, form };
}
type View = ReturnType<typeof mount>;

const active = () => document.activeElement;
/** Past every queued microtask continuation and Svelte's flush. */
const settle = () => drain();

async function openAddFrom(v: View, button: HTMLElement) {
  button.focus();
  await fireEvent.click(button);
  expect(v.el("model-edit-modal")).not.toBeNull();
}

async function fillAndSave(v: View, modelId = "qwen") {
  await fireEvent.input(v.must("model-edit-modelid"), { target: { value: modelId } });
  v.must("model-edit-save").focus();
  await fireEvent.submit(v.form());
}

const CLOSES: Array<[string, (v: View) => Promise<void>]> = [
  [
    "Cancel",
    async (v) => {
      await fireEvent.click(v.getByRole("button", { name: "Cancel" }));
    },
  ],
  [
    "the × button",
    async (v) => {
      await fireEvent.click(v.must("model-edit-cancel"));
    },
  ],
  [
    "Escape",
    async (v) => {
      await fireEvent.keyDown(v.must("model-edit-provider"), { key: "Escape" });
    },
  ],
  [
    "a click on the scrim",
    async (v) => {
      await fireEvent.click(v.must("model-edit-modal"));
    },
  ],
];

describe("A2: focus out of the window", () => {
  for (const [how, close] of CLOSES) {
    it(`Edit, then ${how}: its Edit button`, async () => {
      modelsPose.models = [local("a"), local("b")];
      const v = mount();
      v.must("model-edit-btn-b").focus();
      await fireEvent.click(v.must("model-edit-btn-b"));
      expect(active()).toBe(v.must("model-edit-provider"));
      await close(v);
      expect(v.el("model-edit-modal")).toBeNull();
      await tick();
      expect(active()).toBe(v.must("model-edit-btn-b"));
    });

    it(`bottom Add, then ${how}: "+ Add model"`, async () => {
      modelsPose.models = [local("a")];
      const v = mount();
      await openAddFrom(v, v.must("model-add-btn"));
      await close(v);
      await tick();
      expect(active()).toBe(v.must("model-add-btn"));
      expect(v.must("model-add-btn").textContent?.trim()).toBe("+ Add model");
    });

    it(`empty-state Add, then ${how}: its button`, async () => {
      const v = mount();
      await openAddFrom(v, v.must("model-add-btn"));
      await close(v);
      await tick();
      expect(active()).toBe(v.must("model-add-btn"));
      expect(v.must("model-add-btn").textContent?.trim()).toBe("Add your first model");
    });
  }

  it("an old cloud entry's View, then Close: its View button", async () => {
    modelsPose.models = [
      { id: "c", provider: "openai", displayName: "Old", modelId: "x", enabled: true },
      local("a"),
    ];
    const v = mount();
    await fireEvent.click(v.must("model-edit-btn-c"));
    expect(active()).toBe(v.must("model-edit-unavailable-close"));
    await fireEvent.click(v.must("model-edit-unavailable-close"));
    await tick();
    expect(active()).toBe(v.must("model-edit-btn-c"));
  });

  it("Edit, committed Save: its Edit button", async () => {
    harness.writes.settleAutomatically("commit");
    modelsPose.models = [local("a"), local("b")];
    const v = mount();
    await fireEvent.click(v.must("model-edit-btn-a"));
    await fillAndSave(v, "renamed");
    await settle();
    expect(v.el("model-edit-modal")).toBeNull();
    expect(active()).toBe(v.must("model-edit-btn-a"));
  });

  it("Edit with a provider change, committed Save: the Edit button in its new bucket", async () => {
    harness.writes.settleAutomatically("commit");
    modelsPose.models = [local("a"), local("b")];
    const v = mount();
    const before = v.must("model-edit-btn-a");
    await fireEvent.click(before);
    const select = v.must("model-edit-provider") as HTMLSelectElement;
    select.value = "local-lmstudio";
    await fireEvent.change(select);
    await fillAndSave(v, "moved");
    await settle();
    const after = v.must("model-edit-btn-a");
    expect(after).not.toBe(before);
    expect(active()).toBe(after);
    const heading = after
      .closest("[data-testid^='model-row-']")
      ?.parentElement?.parentElement?.querySelector(".settings-section-label");
    expect(heading?.textContent?.trim()).toBe("LM Studio (local)");
  });

  it('bottom Add, committed Save: "+ Add model"', async () => {
    harness.writes.settleAutomatically("commit");
    modelsPose.models = [local("a")];
    const v = mount();
    await openAddFrom(v, v.must("model-add-btn"));
    await fillAndSave(v);
    await settle();
    expect(v.el("model-edit-modal")).toBeNull();
    expect(active()).toBe(v.must("model-add-btn"));
  });

  it('empty-state Add, committed Save: the list\'s "+ Add model"', async () => {
    harness.writes.settleAutomatically("commit");
    const v = mount();
    await openAddFrom(v, v.must("model-add-btn"));
    await fillAndSave(v);
    await settle();
    expect(v.el("model-edit-modal")).toBeNull();
    expect(active()).toBe(v.must("model-add-btn"));
    expect(v.must("model-add-btn").textContent?.trim()).toBe("+ Add model");
  });

  it("a Save that does not commit: the window stays open, focus unmoved", async () => {
    harness.writes.settleAutomatically("rollback");
    modelsPose.models = [local("a")];
    const v = mount();
    await fireEvent.click(v.must("model-edit-btn-a"));
    await fillAndSave(v, "x");
    const save = v.must("model-edit-save");
    await settle();
    expect(v.el("model-edit-modal")).not.toBeNull();
    expect(active()).toBe(save);
    expect(v.el("model-edit-error")).not.toBeNull();
  });

  it("a stale save: the first Add's save settling never closes or empties the second window", async () => {
    modelsPose.models = [local("a")];
    const v = mount();
    await openAddFrom(v, v.must("model-add-btn"));
    await fillAndSave(v, "first");
    await settle();
    expect(harness.writes.pendingCount).toBe(1);
    await fireEvent.click(v.getByRole("button", { name: "Cancel" }));
    await tick();
    await openAddFrom(v, v.must("model-add-btn"));
    await fillAndSave(v, "second");
    const save = v.must("model-edit-save");
    expect(harness.calls.addModel).toBe(2);

    harness.writes.release("commit"); // the first
    await settle();
    expect(v.el("model-edit-modal")).not.toBeNull();
    expect((v.must("model-edit-modelid") as HTMLInputElement).value).toBe("second");
    expect(active()).toBe(save);
    expect(v.el("model-edit-error")).toBeNull();
  });

  it("Cancel during a pending Add from the empty state, then a rollback to empty: the empty state's button", async () => {
    const v = mount();
    await openAddFrom(v, v.must("model-add-btn"));
    await fillAndSave(v);
    await settle();
    // The optimistic add shows the list and its "+ Add model".
    expect(v.el("models-empty-state")).toBeNull();
    await fireEvent.click(v.getByRole("button", { name: "Cancel" }));
    await tick();
    expect(active()?.textContent?.trim()).toBe("+ Add model");

    harness.writes.release("rollback");
    await settle();
    expect(v.el("models-empty-state")).not.toBeNull();
    expect(active()).toBe(v.must("model-add-btn"));
    expect(v.must("model-add-btn").textContent?.trim()).toBe("Add your first model");
  });

  it("an Edit that changed provider, Cancel, then a rollback: that entry's Edit button, back in its bucket", async () => {
    modelsPose.models = [local("a"), local("b")];
    const v = mount();
    await fireEvent.click(v.must("model-edit-btn-a"));
    const select = v.must("model-edit-provider") as HTMLSelectElement;
    select.value = "local-lmstudio";
    await fireEvent.change(select);
    await fillAndSave(v, "moved");
    await settle();
    await fireEvent.click(v.getByRole("button", { name: "Cancel" }));
    await tick();
    const moved = v.must("model-edit-btn-a");
    expect(active()).toBe(moved);

    harness.writes.release("rollback");
    await settle();
    const back = v.must("model-edit-btn-a");
    expect(back).not.toBe(moved);
    expect(active()).toBe(back);
  });
});

describe("A3 through the tab: one save per press", () => {
  it("two submits while the add is pending call addModel once; a non-commit, then one more Save calls it again", async () => {
    modelsPose.models = [local("a")];
    const v = mount();
    await openAddFrom(v, v.must("model-add-btn"));
    await fillAndSave(v);
    await fireEvent.submit(v.form());
    await settle();
    expect(harness.calls.addModel).toBe(1);
    expect(v.must("model-edit-save").textContent?.trim()).toBe("Saving…");

    harness.writes.release("rollback"); // addModel resolves null
    await settle();
    expect(v.el("model-edit-modal")).not.toBeNull();
    expect(v.must("model-edit-save").textContent?.trim()).toBe("Add model");
    await fireEvent.submit(v.form());
    await settle();
    expect(harness.calls.addModel).toBe(2);
  });
});

describe("A5: focus through Delete", () => {
  it("Delete focuses Cancel; Cancel focuses Delete", async () => {
    modelsPose.models = [local("a"), local("b")];
    const v = mount();
    await fireEvent.click(v.must("model-delete-btn-a"));
    await tick();
    expect(active()).toBe(v.must("model-delete-cancel-a"));
    await fireEvent.click(v.must("model-delete-cancel-a"));
    await tick();
    expect(active()).toBe(v.must("model-delete-btn-a"));
  });

  it("Confirm on a middle row: the next row's Delete, before the call settles", async () => {
    modelsPose.models = [local("a"), local("b"), local("c")];
    const v = mount();
    await fireEvent.click(v.must("model-delete-btn-b"));
    await tick();
    const next = v.must("model-delete-btn-c");
    await fireEvent.click(v.must("model-delete-confirm-b"));
    expect(active()).toBe(next);
    harness.writes.release("commit");
    await settle();
    expect(v.el("model-row-b")).toBeNull();
    expect(active()).toBe(next);
  });

  it("Confirm on the last of several: the previous row's Delete", async () => {
    modelsPose.models = [local("a"), local("b"), local("c")];
    const v = mount();
    await fireEvent.click(v.must("model-delete-btn-c"));
    await tick();
    await fireEvent.click(v.must("model-delete-confirm-c"));
    expect(active()).toBe(v.must("model-delete-btn-b"));
    harness.writes.release("commit");
    await settle();
    expect(active()).toBe(v.must("model-delete-btn-b"));
  });

  it("Confirm on the only row, idle queue: the empty state's button right after tick, before the call settles", async () => {
    modelsPose.models = [local("a")];
    const v = mount();
    await fireEvent.click(v.must("model-delete-btn-a"));
    await tick();
    await fireEvent.click(v.must("model-delete-confirm-a"));
    await tick();
    await tick();
    expect(harness.writes.pendingCount).toBe(1);
    expect(v.el("models-empty-state")).not.toBeNull();
    expect(active()).toBe(v.must("model-add-btn"));
    harness.writes.release("commit");
    await settle();
    expect(active()).toBe(v.must("model-add-btn"));
  });

  it("Confirm on the only row with an earlier write queued: the empty state's button after settle, never a detached one", async () => {
    modelsPose.models = [local("a")];
    const v = mount();
    await fireEvent.click(v.must("model-toggle-a")); // an earlier write, held
    await settle();
    expect(harness.writes.pendingCount).toBe(1);
    await fireEvent.click(v.must("model-delete-btn-a"));
    await tick();
    v.must("model-delete-confirm-a").focus();
    await fireEvent.click(v.must("model-delete-confirm-a"));
    await settle();
    // The row is still there: nothing is focused for it yet (focus stays on
    // Confirm, never on the list's "+ Add model", which the delete will remove).
    expect(v.el("model-row-a")).not.toBeNull();
    expect(v.el("models-empty-state")).toBeNull();
    expect(active()).toBe(v.must("model-delete-confirm-a"));
    harness.writes.release("commit"); // the toggle
    await settle();
    harness.writes.release("commit"); // the delete
    await settle();
    expect(v.el("models-empty-state")).not.toBeNull();
    const focused = active() as HTMLElement;
    expect(focused.isConnected).toBe(true);
    expect(focused).toBe(v.must("model-add-btn"));
  });

  for (const shape of ["a middle row", "the only row"] as const) {
    it(`a rollback on ${shape}: the restored row's Delete, even with an Add button`, async () => {
      modelsPose.models =
        shape === "the only row" ? [local("b")] : [local("a"), local("b"), local("c")];
      const v = mount();
      await fireEvent.click(v.must("model-delete-btn-b"));
      await tick();
      await fireEvent.click(v.must("model-delete-confirm-b"));
      await settle();
      expect(v.el("model-row-b")).toBeNull();
      harness.writes.release("rollback");
      await settle();
      expect(v.el("model-row-b")).not.toBeNull();
      expect(v.el("model-add-btn")).not.toBeNull();
      expect(active()).toBe(v.must("model-delete-btn-b"));
    });
  }

  it("blocked: Confirm moves no focus and its pair stays", async () => {
    modelsPose.models = [local("a"), local("b")];
    const v = mount();
    await fireEvent.click(v.must("model-delete-btn-a"));
    await tick();
    noteModelsWriteRefused();
    await tick();
    const confirm = v.must("model-delete-confirm-a");
    confirm.focus();
    await fireEvent.click(confirm);
    await settle();
    expect(harness.calls.deleteModel).toBe(0);
    expect(active()).toBe(confirm);
    expect(v.el("model-delete-cancel-a")).not.toBeNull();
  });

  it("Confirm on row 1, then Delete on the focused row 2 before row 1's call settles: row 2's Cancel stays mounted and focused", async () => {
    modelsPose.models = [local("a"), local("b")];
    const v = mount();
    await fireEvent.click(v.must("model-delete-btn-a"));
    await tick();
    await fireEvent.click(v.must("model-delete-confirm-a"));
    expect(active()).toBe(v.must("model-delete-btn-b"));
    await fireEvent.click(v.must("model-delete-btn-b"));
    await tick();
    const cancelB = v.must("model-delete-cancel-b");
    expect(active()).toBe(cancelB);
    harness.writes.release("commit");
    await settle();
    expect(v.el("model-row-a")).toBeNull();
    expect(v.el("model-delete-cancel-b")).toBe(cancelB);
    expect(active()).toBe(cancelB);
  });

  it("the only row, then Add before the delete settles: focus stays in the Add window", async () => {
    modelsPose.models = [local("a")];
    const v = mount();
    await fireEvent.click(v.must("model-delete-btn-a"));
    await tick();
    await fireEvent.click(v.must("model-delete-confirm-a"));
    await tick();
    await tick();
    expect(active()).toBe(v.must("model-add-btn"));
    await fireEvent.click(v.must("model-add-btn")); // a doubled Enter
    const provider = v.must("model-edit-provider");
    expect(active()).toBe(provider);
    harness.writes.release("commit");
    await settle();
    expect(active()).toBe(provider);
  });

  it("a rollback after the user moved on to row 2's Cancel leaves focus there", async () => {
    modelsPose.models = [local("a"), local("b")];
    const v = mount();
    await fireEvent.click(v.must("model-delete-btn-a"));
    await tick();
    await fireEvent.click(v.must("model-delete-confirm-a"));
    await fireEvent.click(v.must("model-delete-btn-b"));
    await tick();
    const cancelB = v.must("model-delete-cancel-b");
    expect(active()).toBe(cancelB);
    harness.writes.release("rollback");
    await settle();
    expect(v.el("model-row-a")).not.toBeNull();
    expect(active()).toBe(cancelB);
  });
});

// The stale path restores by the window that closed LAST (`lastReturnId`), not
// by the save's own window. No sequence found here detaches that window's button
// while the save's own one survives, so this case pins only that a late
// rollback never pulls focus off where the last close put it.
describe("A2: a stale save leaves the last close's focus alone", () => {
  it("Edit A, Save pending, Cancel, Edit B, Cancel, then A rolls back: still B's Edit button", async () => {
    modelsPose.models = [local("a"), local("b")];
    const v = mount();
    await fireEvent.click(v.must("model-edit-btn-a"));
    const select = v.must("model-edit-provider") as HTMLSelectElement;
    select.value = "local-lmstudio";
    await fireEvent.change(select);
    await fillAndSave(v, "moved");
    await settle();
    await fireEvent.click(v.getByRole("button", { name: "Cancel" }));
    await tick();
    await fireEvent.click(v.must("model-edit-btn-b"));
    await fireEvent.click(v.getByRole("button", { name: "Cancel" }));
    await tick();
    expect(active()).toBe(v.must("model-edit-btn-b"));
    harness.writes.release("rollback");
    await settle();
    const focused = active() as HTMLElement;
    expect(focused.isConnected).toBe(true);
    expect(focused).toBe(v.must("model-edit-btn-b"));
  });
});

describe("review round 1: catch, display order, the Confirm latch, settled sequences", () => {
  it("a save that THROWS after its window closed changes nothing in the next window (the generation check in catch)", async () => {
    modelsPose.models = [local("a")];
    const v = mount();
    await openAddFrom(v, v.must("model-add-btn"));
    await fillAndSave(v, "first");
    await settle();
    await fireEvent.click(v.getByRole("button", { name: "Cancel" }));
    await tick();
    await openAddFrom(v, v.must("model-add-btn"));
    await fillAndSave(v, "second");
    const save = v.must("model-edit-save");

    harness.writes.release("throw"); // the first
    await settle();
    expect(v.el("model-edit-modal")).not.toBeNull();
    expect((v.must("model-edit-modelid") as HTMLInputElement).value).toBe("second");
    expect(v.el("model-edit-error")).toBeNull();
    expect(active()).toBe(save);
  });

  it("a save that throws in its own window keeps it open and shows the error", async () => {
    modelsPose.models = [local("a")];
    const v = mount();
    await fireEvent.click(v.must("model-edit-btn-a"));
    await fillAndSave(v, "x");
    const save = v.must("model-edit-save");
    await settle();
    harness.writes.release("throw");
    await settle();
    expect(v.el("model-edit-modal")).not.toBeNull();
    expect(v.must("model-edit-error").textContent?.trim()).toBe("Keychain unavailable");
    expect(active()).toBe(save);
  });

  it("the successor is the next row in DISPLAY order, not store order (two providers)", async () => {
    // Store order: x (LM Studio), a, b (Ollama). Shown: a, b under Ollama, then x.
    modelsPose.models = [local("x", "local-lmstudio"), local("a"), local("b")];
    const v = mount();
    await fireEvent.click(v.must("model-delete-btn-b"));
    await tick();
    await fireEvent.click(v.must("model-delete-confirm-b"));
    expect(active()).toBe(v.must("model-delete-btn-x"));
    harness.writes.release("commit");
    await settle();
    expect(active()).toBe(v.must("model-delete-btn-x"));
  });

  it("the previous row in display order, when the deleted row is shown last", async () => {
    modelsPose.models = [local("x", "local-lmstudio"), local("a"), local("b")];
    const v = mount();
    await fireEvent.click(v.must("model-delete-btn-x"));
    await tick();
    await fireEvent.click(v.must("model-delete-confirm-x"));
    expect(active()).toBe(v.must("model-delete-btn-b"));
  });

  it("a doubled Confirm while its delete waits behind another write sends one delete", async () => {
    modelsPose.models = [local("a"), local("b")];
    const v = mount();
    await fireEvent.click(v.must("model-toggle-b")); // an earlier write, held
    await settle();
    await fireEvent.click(v.must("model-delete-btn-a"));
    await tick();
    const confirm = v.must("model-delete-confirm-a");
    await fireEvent.click(confirm);
    await fireEvent.click(confirm);
    await settle();
    expect(harness.calls.deleteModel).toBe(1);
    harness.writes.release("commit"); // the toggle
    await settle();
    harness.writes.release("commit"); // the delete
    await settle();
    expect(v.el("model-row-a")).toBeNull();
    // Once settled, the latch is clear: the row is gone, nothing more to send.
    expect(harness.writes.pendingCount).toBe(0);
  });

  it("Confirm row a, then Confirm row b (now the only row) before a settles, then a rolls back: focus ends on a's restored Delete", async () => {
    modelsPose.models = [local("a"), local("b")];
    const v = mount();
    await fireEvent.click(v.must("model-delete-btn-a"));
    await tick();
    await fireEvent.click(v.must("model-delete-confirm-a"));
    await settle();
    expect(v.el("model-row-a")).toBeNull();
    await fireEvent.click(v.must("model-delete-btn-b"));
    await tick();
    v.must("model-delete-confirm-b").focus();
    await fireEvent.click(v.must("model-delete-confirm-b"));
    await settle();
    // a rolls back; b's turn then removes b with its focused Confirm, so focus
    // is lost when a's flow looks, and a's restored Delete takes it.
    harness.writes.release("rollback");
    await settle();
    expect(v.el("model-row-a")).not.toBeNull();
    expect(v.el("model-row-b")).toBeNull();
    const deleteA = v.must("model-delete-btn-a");
    expect(active()).toBe(deleteA);
    // b's settle finds focus somewhere real that its flow did not put there.
    harness.writes.release("commit");
    await settle();
    expect(active()).toBe(deleteA);
  });
});

describe("carry-overs from #2491's merge review", () => {
  it("the Confirm latch is cleared after a rollback: a second Confirm on the same row sends again", async () => {
    modelsPose.models = [local("a"), local("b")];
    const v = mount();
    await fireEvent.click(v.must("model-delete-btn-a"));
    await tick();
    await fireEvent.click(v.must("model-delete-confirm-a"));
    await settle();
    harness.writes.release("rollback");
    await settle();
    expect(v.el("model-row-a")).not.toBeNull();
    await fireEvent.click(v.must("model-delete-btn-a"));
    await tick();
    await fireEvent.click(v.must("model-delete-confirm-a"));
    await settle();
    expect(harness.calls.deleteModel).toBe(2);
  });

  it("the Confirm latch is per row: Confirm on row b while row a's delete is pending sends b's", async () => {
    modelsPose.models = [local("a"), local("b"), local("c")];
    const v = mount();
    await fireEvent.click(v.must("model-delete-btn-a"));
    await tick();
    await fireEvent.click(v.must("model-delete-confirm-a"));
    await settle();
    expect(harness.writes.pendingCount).toBe(1);
    await fireEvent.click(v.must("model-delete-btn-b"));
    await tick();
    await fireEvent.click(v.must("model-delete-confirm-b"));
    await settle();
    expect(harness.calls.deleteModel).toBe(2);
  });

  it("Cancel during a pending Add from the empty state, then the add THROWS: the empty state's button (the stale path in catch)", async () => {
    const v = mount();
    await openAddFrom(v, v.must("model-add-btn"));
    await fillAndSave(v);
    await settle();
    expect(v.el("models-empty-state")).toBeNull();
    await fireEvent.click(v.getByRole("button", { name: "Cancel" }));
    await tick();
    expect(active()?.textContent?.trim()).toBe("+ Add model");

    harness.writes.release("throw");
    await settle();
    expect(v.el("models-empty-state")).not.toBeNull();
    expect(active()).toBe(v.must("model-add-btn"));
    expect(v.must("model-add-btn").textContent?.trim()).toBe("Add your first model");
  });
});
