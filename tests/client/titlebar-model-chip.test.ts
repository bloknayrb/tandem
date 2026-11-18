// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The title bar's model chip (#1123, ADR-039 Label decision L2; R3.1's
 * strings): the visible text is the name alone, and the hover and accessible
 * text say chat is set to that local model. Outside Tauri `onMount` returns
 * before touching any window API, so no Tauri mocks are needed; both
 * specifiers are mocked, as titlebar-listener-leak.test.ts does.
 */
vi.mock(import("@client/cowork/cowork-helpers.js"), () => ({
  isTauriRuntime: () => false,
}));
vi.mock(import("@client/cowork/cowork-helpers"), () => ({
  isTauriRuntime: () => false,
}));

const { default: TitleBar } = await import("../../src/client/shell/TitleBar.svelte");

afterEach(() => cleanup());

describe("TitleBar model chip (#1123 L2)", () => {
  it("names the model, says chat is set to it, and opens Settings → Models", async () => {
    const onOpenModelsSettings = vi.fn();
    const v = render(TitleBar, { props: { defaultModelLabel: "Qwen", onOpenModelsSettings } });
    const chip = v.getByTestId("titlebar-default-model");
    expect(chip.textContent?.trim()).toBe("Qwen");
    expect(chip.getAttribute("aria-label")).toBe(
      "Chat is set to your local model: Qwen. Open Settings → Models.",
    );
    expect(chip.getAttribute("title")).toBe("Chat is set to your local model: Qwen");
    await fireEvent.click(chip);
    expect(onOpenModelsSettings).toHaveBeenCalledTimes(1);
  });

  it("no chip with a null label", () => {
    const v = render(TitleBar, {
      props: { defaultModelLabel: null, onOpenModelsSettings: vi.fn() },
    });
    expect(v.queryByTestId("titlebar-default-model")).toBeNull();
  });

  it("no chip without a click handler", () => {
    const v = render(TitleBar, { props: { defaultModelLabel: "Qwen" } });
    expect(v.queryByTestId("titlebar-default-model")).toBeNull();
  });
});
