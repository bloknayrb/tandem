// @vitest-environment happy-dom

/**
 * First-run model picker (#1123 M2b §3.3 + §3.5).
 *
 * Two contracts, both exercised by a direct mount (the component has no internal
 * `BYO_MODELS_ENABLED` gate — App's first-run block does):
 *
 *   §3.4 consistency — a fresh first run defaults to a LOCAL provider (Ollama),
 *   not a cloud one whose BYO key support is v1.1.
 *
 *   §3.3 rolled-back-add guard — `addModel` returns an id only when the write
 *   committed; on a rolled-back/reconciled write it returns null. The picker must
 *   NOT `setDefault`/`onComplete` on null (which would finish onboarding pointing
 *   at a phantom default) — it keeps the modal open and surfaces `saveError`.
 *
 * `createModels` is mocked so `addModel`'s outcome is controllable without a
 * server round-trip.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const addModel = vi.fn<(...args: unknown[]) => Promise<string | null>>();
const setDefault = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const clearError = vi.fn();
let storeSaveError: string | null = null;

vi.mock("../../src/client/hooks/useModels.svelte", () => ({
  createModels: () => ({
    addModel,
    setDefault,
    clearError,
    get saveError() {
      return storeSaveError;
    },
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

describe("FirstRunModelPickerModal — local-first default (§3.4)", () => {
  it("defaults to Ollama and shows the endpoint field, not an API key", () => {
    const { getByTestId, queryByTestId } = render(FirstRunModelPickerModal, {
      props: { onComplete: vi.fn() },
    });
    const ollama = getByTestId("first-run-provider-local-ollama") as HTMLInputElement;
    expect(ollama.checked).toBe(true);
    expect(queryByTestId("first-run-endpoint")).not.toBeNull();
    expect(queryByTestId("first-run-apikey")).toBeNull();
  });

  it("lists local providers before cloud providers", () => {
    const { getByTestId } = render(FirstRunModelPickerModal, {
      props: { onComplete: vi.fn() },
    });
    const fieldset = getByTestId("first-run-providers");
    const values = Array.from(fieldset.querySelectorAll("input[type=radio]")).map(
      (el) => (el as HTMLInputElement).value,
    );
    expect(values.slice(0, 2)).toEqual(["local-ollama", "local-llamacpp"]);
  });

  it("disables cloud radios and enables local ones (same local-only gate as the edit modal)", () => {
    const { getByTestId } = render(FirstRunModelPickerModal, {
      props: { onComplete: vi.fn() },
    });
    const radio = (v: string) => getByTestId(`first-run-provider-${v}`) as HTMLInputElement;
    for (const v of ["local-ollama", "local-llamacpp"]) expect(radio(v).disabled).toBe(false);
    for (const v of ["anthropic", "openai", "gemini"]) expect(radio(v).disabled).toBe(true);
  });
});

describe("FirstRunModelPickerModal — rolled-back-add guard (§3.3)", () => {
  it("does NOT setDefault/onComplete when addModel rolls back (returns null)", async () => {
    addModel.mockResolvedValue(null);
    storeSaveError = "Model registry changed elsewhere; reloaded.";
    const onComplete = vi.fn();
    const { getByTestId, findByTestId } = render(FirstRunModelPickerModal, {
      props: { onComplete },
    });

    // Ollama default → modelId + endpoint prefilled → canSave true.
    await fireEvent.click(getByTestId("first-run-save"));

    expect(addModel).toHaveBeenCalledTimes(1);
    expect(setDefault).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    // The store's error is surfaced and the modal stays mounted.
    const err = await findByTestId("first-run-error");
    expect(err.textContent).toMatch(/changed elsewhere/i);
    expect(getByTestId("first-run-model-modal")).toBeTruthy();
  });

  it("setDefault + onComplete run once addModel commits (returns an id)", async () => {
    addModel.mockResolvedValue("new-id");
    const onComplete = vi.fn();
    const { getByTestId } = render(FirstRunModelPickerModal, {
      props: { onComplete },
    });

    await fireEvent.click(getByTestId("first-run-save"));

    expect(addModel).toHaveBeenCalledTimes(1);
    expect(setDefault).toHaveBeenCalledWith("new-id");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("skip completes onboarding with no write and clears any store error", async () => {
    const onComplete = vi.fn();
    const { getByTestId } = render(FirstRunModelPickerModal, {
      props: { onComplete },
    });

    await fireEvent.click(getByTestId("first-run-skip-secondary"));

    expect(addModel).not.toHaveBeenCalled();
    expect(clearError).toHaveBeenCalledTimes(1); // don't leak a store error onto the singleton
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("a rolled-back setDefault keeps the modal open with a local error and does NOT complete", async () => {
    addModel.mockResolvedValue("new-id");
    setDefault.mockResolvedValue(false);
    const onComplete = vi.fn();
    const { getByTestId, findByTestId } = render(FirstRunModelPickerModal, {
      props: { onComplete },
    });

    await fireEvent.click(getByTestId("first-run-save"));

    expect(setDefault).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    const err = await findByTestId("first-run-error");
    expect(err.textContent).toMatch(/couldn't set it as the default/i);
    expect(getByTestId("first-run-model-modal")).toBeTruthy();
  });

  it("retrying after a setDefault failure re-attempts ONLY setDefault (no duplicate add)", async () => {
    addModel.mockResolvedValue("new-id");
    setDefault.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onComplete = vi.fn();
    const { getByTestId } = render(FirstRunModelPickerModal, {
      props: { onComplete },
    });

    await fireEvent.click(getByTestId("first-run-save")); // add commits, setDefault fails
    await fireEvent.click(getByTestId("first-run-save")); // retry

    expect(addModel).toHaveBeenCalledTimes(1); // NOT re-added
    expect(setDefault).toHaveBeenCalledTimes(2);
    expect(setDefault).toHaveBeenLastCalledWith("new-id");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
