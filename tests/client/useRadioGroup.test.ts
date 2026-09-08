// @vitest-environment happy-dom

/**
 * #1778 item 3 — this suite used to exercise `hooks/useRadioGroup.ts`, which
 * had zero importers in `src/`. The shipped hook is `createRadioGroup`
 * (`hooks/useRadioGroup.svelte.ts`), which all three consumers import and which
 * nothing tested — including the `radios?.[domIdx]?.focus()` call that is the
 * only behavioural difference between the two. The dead module is deleted and
 * this suite is retargeted; `value` becomes a `() => value` getter.
 */

import { describe, expect, it, vi } from "vitest";
import { createRadioGroup } from "../../src/client/hooks/useRadioGroup.svelte.js";

function callHook<T extends string>(
  value: T,
  values: readonly T[],
  isDisabled?: (v: T) => boolean,
) {
  const setValue = vi.fn();
  const { handleKeyDown, tabIndexFor } = createRadioGroup(
    () => value,
    values,
    setValue,
    isDisabled,
  );
  return { setValue, handleKeyDown, tabIndexFor };
}

describe("createRadioGroup — tabIndexFor", () => {
  it("puts the checked value in the tab order, others out", () => {
    const { tabIndexFor } = callHook("m", ["s", "m", "l"] as const);
    expect(tabIndexFor("s")).toBe(-1);
    expect(tabIndexFor("m")).toBe(0);
    expect(tabIndexFor("l")).toBe(-1);
  });

  it("keeps disabled values out of the tab order", () => {
    const { tabIndexFor } = callHook(
      "tabbed",
      ["tabbed", "three-panel"] as const,
      (v) => v === "three-panel",
    );
    expect(tabIndexFor("three-panel")).toBe(-1);
  });

  it("falls back to first enabled when the checked value itself is disabled", () => {
    // User saved "three-panel" then narrowed the viewport — current value
    // becomes unavailable. The group still needs a Tab stop.
    const { tabIndexFor } = callHook(
      "three-panel",
      ["tabbed", "three-panel"] as const,
      (v) => v === "three-panel",
    );
    expect(tabIndexFor("tabbed")).toBe(0);
    expect(tabIndexFor("three-panel")).toBe(-1);
  });
});

describe("createRadioGroup — handleKeyDown", () => {
  // Minimal KeyboardEvent stub — we only need the fields the handler reads
  // plus a querySelectorAll on currentTarget that returns an empty list so
  // focus() is skipped. The `.focus()` call itself is covered by the real
  // dispatch below, which is the only harness that can see it.
  function keyEvt(key: string) {
    let prevented = false;
    const evt = {
      key,
      preventDefault: () => {
        prevented = true;
      },
      currentTarget: {
        querySelectorAll: () => [] as unknown as NodeListOf<HTMLButtonElement>,
      },
    } as unknown as KeyboardEvent;
    return { evt, prevented: () => prevented };
  }

  it("ArrowRight moves to the next value and calls setValue", () => {
    const { setValue, handleKeyDown } = callHook("s", ["s", "m", "l"] as const);
    const { evt, prevented } = keyEvt("ArrowRight");
    handleKeyDown(evt);
    expect(setValue).toHaveBeenCalledWith("m");
    expect(prevented()).toBe(true);
  });

  it("ArrowLeft from first wraps to last", () => {
    const { setValue, handleKeyDown } = callHook("s", ["s", "m", "l"] as const);
    const { evt } = keyEvt("ArrowLeft");
    handleKeyDown(evt);
    expect(setValue).toHaveBeenCalledWith("l");
  });

  it("Home jumps to first enabled, End to last enabled", () => {
    const { setValue, handleKeyDown } = callHook("m", ["s", "m", "l"] as const);
    handleKeyDown(keyEvt("Home").evt);
    expect(setValue).toHaveBeenLastCalledWith("s");
    handleKeyDown(keyEvt("End").evt);
    expect(setValue).toHaveBeenLastCalledWith("l");
  });

  it("skips disabled values — ArrowRight from tabbed cycles to tabbed, not three-panel", () => {
    // With only one enabled value, ArrowRight wraps back to itself. This is
    // the regression guard for the pre-fix bug where arrow keys could write
    // a disabled value (three-panel on narrow viewports) into settings.
    const { setValue, handleKeyDown } = callHook(
      "tabbed",
      ["tabbed", "three-panel"] as const,
      (v) => v === "three-panel",
    );
    handleKeyDown(keyEvt("ArrowRight").evt);
    expect(setValue).toHaveBeenCalledWith("tabbed");
    expect(setValue).not.toHaveBeenCalledWith("three-panel");
  });

  it("ignores non-navigation keys", () => {
    const { setValue, handleKeyDown } = callHook("m", ["s", "m", "l"] as const);
    const { evt, prevented } = keyEvt("a");
    handleKeyDown(evt);
    expect(setValue).not.toHaveBeenCalled();
    expect(prevented()).toBe(false);
  });
});

describe("createRadioGroup — roving focus (the shipped hook's one extra behaviour)", () => {
  // Spelled out because the obvious shortcut does not test the code:
  // `e.currentTarget` is null outside a real dispatch, and the implementation's
  // `container?.querySelectorAll(...)` / `radios?.[domIdx]?.focus()` optional
  // chaining makes that a silent no-op — so a hand-built
  // `{ key: "ArrowRight", currentTarget: el } as any` passes even with the
  // `.focus()` line deleted. Only a real `dispatchEvent` on a real container
  // populates `currentTarget`.
  function mountGroup(values: readonly string[]) {
    const container = document.createElement("div");
    container.setAttribute("role", "radiogroup");
    const radios = values.map((v) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.textContent = v;
      container.appendChild(b);
      return b;
    });
    document.body.appendChild(container);
    return { container, radios };
  }

  it("moves DOM focus onto the newly selected radio", () => {
    const values = ["s", "m", "l"] as const;
    const { container, radios } = mountGroup(values);
    const setValue = vi.fn();
    const { handleKeyDown } = createRadioGroup(() => "s", values, setValue);
    container.addEventListener("keydown", handleKeyDown);

    radios[0].focus();
    radios[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

    expect(setValue).toHaveBeenCalledWith("m");
    expect(document.activeElement).toBe(radios[1]);
    container.remove();
  });
});
