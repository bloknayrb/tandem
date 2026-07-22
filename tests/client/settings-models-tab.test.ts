// @vitest-environment happy-dom

/**
 * SettingsModelsTab load/error/empty states + banner suppression (#1123 M2b
 * review fixes). The tab has no internal `BYO_MODELS_ENABLED` gate (its call-site
 * filter does), so a direct mount renders the flag-ON UI. `createModels` is
 * mocked so the store's `loading`/`loadFailed`/`models`/`saveError` can be posed
 * without a server.
 *
 * Contracts pinned:
 *  - during a load, show a skeleton — never assert "No models configured";
 *  - on a failed load, show a distinct "couldn't load — retry" state (not the
 *    empty state), and Retry calls `reload()`;
 *  - the list-level saveError banner is suppressed while the editor modal is open
 *    (the modal owns error display) and while loadFailed (that state owns it).
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

const reload = vi.fn(async () => {});

interface StoreState {
  models?: Array<Record<string, unknown>>;
  defaultModelId?: string | null;
  saveError?: string | null;
  loading?: boolean;
  loadFailed?: boolean;
}
let storeState: StoreState = {};

vi.mock("../../src/client/hooks/useModels.svelte", () => ({
  createModels: () => ({
    get models() {
      return storeState.models ?? [];
    },
    get defaultModelId() {
      return storeState.defaultModelId ?? null;
    },
    get saveError() {
      return storeState.saveError ?? null;
    },
    get loading() {
      return storeState.loading ?? false;
    },
    get loadFailed() {
      return storeState.loadFailed ?? false;
    },
    reload,
    clearError: vi.fn(),
    addModel: vi.fn(async () => "id"),
    updateModel: vi.fn(async () => true),
    deleteModel: vi.fn(async () => {}),
    toggleEnabled: vi.fn(async () => {}),
    setDefault: vi.fn(async () => true),
  }),
}));

const { default: SettingsModelsTab } = await import(
  "../../src/client/components/settings-tabs/SettingsModelsTab.svelte"
);

function mount() {
  return render(SettingsModelsTab, { props: { readOnly: false } });
}

afterEach(() => {
  storeState = {};
  reload.mockClear();
  cleanup();
});

describe("SettingsModelsTab — load / error / empty states", () => {
  it("shows a skeleton (not the empty state) while loading", () => {
    storeState = { loading: true, models: [] };
    const { queryByTestId } = mount();
    expect(queryByTestId("models-loading")).not.toBeNull();
    expect(queryByTestId("models-empty-state")).toBeNull();
  });

  it("shows a distinct load-error state with a working Retry, not 'No models configured'", async () => {
    storeState = {
      loadFailed: true,
      models: [],
      saveError: "Failed to load models from the server.",
    };
    const { queryByTestId, getByTestId } = mount();
    expect(queryByTestId("models-load-error")).not.toBeNull();
    expect(queryByTestId("models-empty-state")).toBeNull();
    // The bottom banner is suppressed while loadFailed owns the message.
    expect(queryByTestId("models-save-error")).toBeNull();

    await fireEvent.click(getByTestId("models-reload-btn"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state only when genuinely empty (loaded, no error)", () => {
    storeState = { models: [] };
    const { queryByTestId } = mount();
    expect(queryByTestId("models-empty-state")).not.toBeNull();
    expect(queryByTestId("models-loading")).toBeNull();
    expect(queryByTestId("models-load-error")).toBeNull();
  });

  it("suppresses the list saveError banner while the editor modal is open", async () => {
    storeState = {
      saveError: "Model registry changed elsewhere; reloaded.",
      models: [
        {
          id: "m1",
          provider: "local-ollama",
          displayName: "Local",
          modelId: "qwen2.5:14b",
          endpoint: "http://127.0.0.1:11434",
          enabled: true,
        },
      ],
    };
    const { queryByTestId, getByTestId } = mount();
    // With models present and no modal open, the banner shows.
    expect(queryByTestId("models-save-error")).not.toBeNull();
    // Open the add modal → the modal owns error display, banner is hidden.
    await fireEvent.click(getByTestId("model-add-btn"));
    expect(queryByTestId("models-save-error")).toBeNull();
    expect(queryByTestId("model-edit-modal")).not.toBeNull();
  });
});
