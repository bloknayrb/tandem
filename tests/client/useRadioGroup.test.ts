import { describe, expect, it, vi } from "vitest";
import { useRadioGroup } from "../../src/client/hooks/useRadioGroup.js";

// The hook body runs synchronously when called — we don't need renderHook,
// we just invoke it as a function and exercise the returned handlers.
function callHook<T extends string>(
  value: T,
  values: readonly T[],
  isDisabled?: (v: T) => boolean,
) {
  const setValue = vi.fn();
  const { handleKeyDown, tabIndexFor } = useRadioGroup(value, values, setValue, isDisabled);
  return { setValue, handleKeyDown, tabIndexFor };
}

describe("useRadioGroup — tabIndexFor", () => {
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

describe("useRadioGroup — handleKeyDown", () => {
  // Minimal KeyboardEvent stub — we only need the fields the handler reads
  // plus a querySelectorAll on currentTarget that returns an empty list so
  // focus() is skipped (no DOM in the vitest node env).
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
    } as unknown as React.KeyboardEvent<HTMLDivElement>;
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
