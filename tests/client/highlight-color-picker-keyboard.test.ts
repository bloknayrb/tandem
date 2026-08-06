// @vitest-environment happy-dom

/**
 * Mounted keyboard/focus regression net for HighlightColorPicker.
 *
 * #1304 is what makes this menu keyboard-operable at all (before it, the
 * trigger had only `onmousedown`, so Enter/Space did nothing). Everything
 * asserted here is a property that arrived with that: the `detail === 0`
 * activation route, focus restored to the trigger on every deliberate
 * dismissal, focus-out dismissal, and the Escape hand-off with the selection
 * popup's capture-phase `window` listener.
 *
 * A mounted unit test rather than an E2E addition on purpose: the E2E spec's
 * own header documents that headless ProseMirror loses the selection around
 * synthesised clicks, which is exactly what puts this flow out of reach there.
 * happy-dom models focus, `relatedTarget` and event-phase ordering faithfully
 * enough for all of it.
 */

import { fireEvent } from "@testing-library/dom";
import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import HighlightColorPicker from "../../src/client/editor/toolbar/HighlightColorPicker.svelte";
import { escapeIsClaimed } from "../../src/client/utils/escape-owner";

afterEach(() => cleanup());

function mount(props: Partial<{ disabled: boolean; onHighlight: (c: string) => void }> = {}) {
  const onHighlight = vi.fn();
  const result = render(HighlightColorPicker, {
    props: { disabled: false, onHighlight, ...props },
  });
  const toggle = document.querySelector(
    "[data-testid='toolbar-highlight-color-toggle']",
  ) as HTMLButtonElement;
  return { ...result, onHighlight, toggle };
}

/** Enter/Space on a focused native button — a click with `detail === 0`. */
const keyClick = (el: Element) => fireEvent.click(el, { detail: 0 });
/** A real pointer click — `detail === 1`; the mouse path owns this via mousedown. */
const mouseClick = (el: Element) => fireEvent.click(el, { detail: 1 });

const popover = () => document.querySelector(".highlight-picker-popover");

describe("HighlightColorPicker keyboard operation", () => {
  it("Enter/Space on the trigger opens the menu; a mouse click does not toggle it back", async () => {
    const { toggle } = mount();
    expect(popover()).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await keyClick(toggle);
    expect(popover()).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    // The mouse route runs off `mousedown`; if `click` also fired the toggle the
    // menu would close again the instant the button was released.
    await mouseClick(toggle);
    expect(popover()).not.toBeNull();
  });

  it("selecting a swatch closes the menu and returns focus to the trigger", async () => {
    const { toggle } = mount();
    await keyClick(toggle);

    const pink = document.querySelector(
      "[data-testid='toolbar-highlight-color-pink']",
    ) as HTMLButtonElement;
    pink.focus();
    await keyClick(pink);

    expect(popover()).toBeNull();
    // Without the focus restore the focused button is unmounted and
    // activeElement falls to <body>, so the next Tab restarts from the top of
    // the document.
    expect(document.activeElement).toBe(toggle);
  });

  it("the close button closes the menu and returns focus to the trigger", async () => {
    const { toggle } = mount();
    await keyClick(toggle);

    const close = document.querySelector("[data-testid='color-picker-close']") as HTMLButtonElement;
    close.focus();
    await keyClick(close);

    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it("Escape closes the picker and is NOT consumed by the selection popup's capture listener", async () => {
    const { toggle } = mount();
    await keyClick(toggle);

    // Replica of Toolbar.svelte's selection-popup handler (capture phase at
    // `window`, stopPropagation on Escape) — including its yield. Without the
    // yield the picker's own bubble-phase handler never runs and the user's
    // first Escape dismisses the POPUP instead of the menu they just opened.
    let popupDismissed = false;
    const onWindowKey = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== "Escape") return;
      if (escapeIsClaimed(ke.target)) return;
      ke.stopPropagation();
      popupDismissed = true;
    };
    window.addEventListener("keydown", onWindowKey, { capture: true });
    try {
      const yellow = document.querySelector(
        "[data-testid='toolbar-highlight-color-yellow']",
      ) as HTMLButtonElement;
      yellow.focus();
      await fireEvent.keyDown(yellow, { key: "Escape", bubbles: true });

      expect(popupDismissed).toBe(false);
      expect(popover()).toBeNull();
      expect(document.activeElement).toBe(toggle);

      // Control: with the picker closed the wrap no longer claims Escape, so the
      // popup handler runs exactly as it does today.
      await fireEvent.keyDown(document.body, { key: "Escape", bubbles: true });
      expect(popupDismissed).toBe(true);
    } finally {
      window.removeEventListener("keydown", onWindowKey, { capture: true });
    }
  });

  it("focus leaving the wrap closes the menu; focus moving within it does not", async () => {
    const { toggle } = mount();
    const outside = document.createElement("button");
    document.body.appendChild(outside);

    await keyClick(toggle);
    const wrap = document.querySelector(".highlight-picker-wrap") as HTMLElement;
    const yellow = document.querySelector(
      "[data-testid='toolbar-highlight-color-yellow']",
    ) as HTMLButtonElement;

    await fireEvent.focusOut(wrap, { relatedTarget: yellow });
    expect(popover(), "focus moving inside the wrap must not dismiss").not.toBeNull();

    await fireEvent.focusOut(wrap, { relatedTarget: outside });
    // A keyboard user Tabbing past the popover has no other dismissal: Escape
    // needs focus inside, and the outside-mousedown guard never fires.
    expect(popover()).toBeNull();

    outside.remove();
  });

  it("the Highlight button itself is keyboard-activatable", async () => {
    const { onHighlight } = mount();
    const highlight = document.querySelector(
      "[data-testid='toolbar-highlight-btn']",
    ) as HTMLButtonElement;

    await mouseClick(highlight);
    expect(onHighlight, "mouse route runs off mousedown, not click").not.toHaveBeenCalled();

    await keyClick(highlight);
    expect(onHighlight).toHaveBeenCalledWith("yellow");
  });

  it("a disabled trigger publishes no aria-expanded, so the bar's z-lift cannot stick", async () => {
    const { toggle, rerender } = mount();
    await keyClick(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    // A selection collapse disables the control without closing the menu.
    // FormattingBar lifts the whole bar to --tandem-z-toast while any descendant
    // reports aria-expanded="true"; a disabled button must not hold that open.
    await rerender({ disabled: true, onHighlight: vi.fn() });
    expect(toggle.hasAttribute("aria-expanded")).toBe(false);
  });
});
