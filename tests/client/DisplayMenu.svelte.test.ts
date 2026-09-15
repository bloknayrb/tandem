// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EDITOR_MEASURES } from "../../src/client/hooks/useTandemSettings";
import DisplayMenu from "../../src/client/shell/DisplayMenu.svelte";

/**
 * #1705 / #1706 — the Display menu is a second VIEW of the existing
 * `textSize` / `editorMeasure` settings, never a second state. These specs pin
 * the two directions the issues require at the component seam:
 *
 *   Settings → quick: a new prop value (what App passes after any settings
 *   write, including one from the modal) is what the trigger and the checked
 *   item show.
 *   Quick → Settings: a pick emits exactly one `onUpdate` partial, which App
 *   routes to `settingsState.updateSettings` — the modal's own write path.
 *
 * The App wiring and real persistence are covered end-to-end in
 * `tests/e2e/display-menu.spec.ts`.
 */

afterEach(() => cleanup());

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-testid='${id}']`);

function mount(props: Partial<{ textSize: "s" | "m" | "l"; editorMeasure: string }> = {}) {
  const onUpdate = vi.fn();
  const r = render(DisplayMenu, {
    props: {
      textSize: "m",
      editorMeasure: "comfortable",
      onUpdate,
      ...props,
      // biome-ignore lint/suspicious/noExplicitAny: partial test props
    } as any,
  });
  const trigger = byTestId(r.container, "display-menu-trigger")!;
  return { ...r, onUpdate, trigger };
}

describe("DisplayMenu — text size (#1705)", () => {
  it("Settings → quick: the trigger label and the checked item follow the prop", async () => {
    const { container, trigger, rerender } = mount({ textSize: "m" });
    expect(trigger.getAttribute("aria-label")).toContain("Medium");

    await rerender({ textSize: "s" });
    expect(trigger.getAttribute("aria-label")).toContain("Small");

    await fireEvent.click(trigger);
    expect(byTestId(container, "display-menu-text-size-s")?.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(byTestId(container, "display-menu-text-size-m")?.getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("keyboard: opening focuses the checked item; Escape closes and returns focus", async () => {
    const { container, trigger } = mount({ textSize: "l" });
    trigger.focus();
    // A native <button> turns Enter/Space into a click; happy-dom does not
    // synthesize that activation, so the click IS the Enter press here.
    await fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(byTestId(container, "display-menu-text-size-l"));

    await fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(byTestId(container, "display-menu")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("one write: a pick emits exactly one textSize partial and closes the menu", async () => {
    const { container, trigger, onUpdate } = mount({ textSize: "m" });
    await fireEvent.click(trigger);
    await fireEvent.click(byTestId(container, "display-menu-text-size-l")!);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ textSize: "l" });
    expect(byTestId(container, "display-menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("DisplayMenu — reading measure (#1706)", () => {
  it("four presets: one item per EDITOR_MEASURES entry, in order", async () => {
    const { container, trigger } = mount();
    await fireEvent.click(trigger);
    const ids = [
      ...container.querySelectorAll<HTMLElement>("[data-testid^='display-menu-measure-']"),
    ].map((el) => el.dataset.testid);
    expect(ids).toHaveLength(4);
    expect(ids).toEqual(EDITOR_MEASURES.map((m) => `display-menu-measure-${m}`));
  });

  it("narrow write: a pick emits exactly one editorMeasure partial", async () => {
    const { container, trigger, onUpdate } = mount();
    await fireEvent.click(trigger);
    await fireEvent.click(byTestId(container, "display-menu-measure-narrow")!);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ editorMeasure: "narrow" });
  });

  it("Settings → quick: the checked item and trigger label follow the prop", async () => {
    const { container, trigger, rerender } = mount({ editorMeasure: "comfortable" });
    expect(trigger.getAttribute("aria-label")).toContain("Comfortable");
    await rerender({ editorMeasure: "full" });
    expect(trigger.getAttribute("aria-label")).toContain("Full");
    await fireEvent.click(trigger);
    expect(byTestId(container, "display-menu-measure-full")?.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      byTestId(container, "display-menu-measure-comfortable")?.getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("keyboard across groups: ArrowDown from Large reaches Narrow", async () => {
    const { container, trigger } = mount({ textSize: "l" });
    await fireEvent.click(trigger);
    const large = byTestId(container, "display-menu-text-size-l")!;
    expect(document.activeElement).toBe(large);
    await fireEvent.keyDown(large, { key: "ArrowDown" });
    expect(document.activeElement).toBe(byTestId(container, "display-menu-measure-narrow"));
  });
});
