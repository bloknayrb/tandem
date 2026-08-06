import { beforeEach, describe, expect, it, vi } from "vitest";
import { focusMenuEntryPoint, handleMenuArrowKeys } from "../../../src/client/utils/menuKeys";

/**
 * `menuKeys` is pure DOM logic, so its branches are cheap to pin here. The E2E
 * suite presses ArrowDown once and ArrowUp once inside a browser run; Home, End,
 * wrap-around, the modifier bail-out and both item filters have no signal at all
 * without this file.
 *
 * The decay path this guards is concrete: tightening the `[role^="menuitem"]`
 * selector to an exact match would silently disable the whole decorations menu
 * (every row is a `menuitemcheckbox`) while the E2E test keeps passing on the
 * other two menus, because that test uses its own selector rather than this
 * module's.
 */

function buildMenu(html: string): HTMLElement {
  document.body.innerHTML = `<div role="menu">${html}</div>`;
  return document.querySelector<HTMLElement>('[role="menu"]')!;
}

/** Three plain items, plus one of each thing `items()` is meant to filter out. */
function standardMenu(): HTMLElement {
  return buildMenu(`
    <button role="menuitem" id="a">A</button>
    <button role="menuitem" id="b">B</button>
    <button role="menuitem" id="c">C</button>
    <button role="menuitem" id="d" disabled>D</button>
    <button role="menuitem" id="e" aria-hidden="true">E</button>
    <button role="menuitem" id="f" aria-disabled="true">F</button>
  `);
}

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  const preventDefault = vi.spyOn(e, "preventDefault");
  const stopPropagation = vi.spyOn(e, "stopPropagation");
  Object.defineProperty(e, "target", { value: target });
  const consumed = handleMenuArrowKeys(e);
  return { consumed, preventDefault, stopPropagation };
}

const focusedId = () => (document.activeElement as HTMLElement | null)?.id ?? null;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("handleMenuArrowKeys", () => {
  it("ArrowDown moves to the next item and consumes the key", () => {
    const menu = standardMenu();
    const a = menu.querySelector<HTMLElement>("#a")!;
    const { consumed, preventDefault, stopPropagation } = press(a, "ArrowDown");
    expect(consumed).toBe(true);
    expect(focusedId()).toBe("b");
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it("ArrowDown wraps from the last item to the first", () => {
    const menu = standardMenu();
    expect(press(menu.querySelector<HTMLElement>("#c")!, "ArrowDown").consumed).toBe(true);
    expect(focusedId()).toBe("a");
  });

  it("ArrowUp moves back and wraps from the first item to the last", () => {
    const menu = standardMenu();
    expect(press(menu.querySelector<HTMLElement>("#b")!, "ArrowUp").consumed).toBe(true);
    expect(focusedId()).toBe("a");
    expect(press(menu.querySelector<HTMLElement>("#a")!, "ArrowUp").consumed).toBe(true);
    expect(focusedId()).toBe("c");
  });

  it("Home and End jump to the ends", () => {
    const menu = standardMenu();
    expect(press(menu.querySelector<HTMLElement>("#b")!, "End").consumed).toBe(true);
    expect(focusedId()).toBe("c");
    expect(press(menu.querySelector<HTMLElement>("#c")!, "Home").consumed).toBe(true);
    expect(focusedId()).toBe("a");
  });

  it("enters the menu from the container itself — down at the top, up at the bottom", () => {
    const menu = standardMenu();
    expect(press(menu, "ArrowDown").consumed).toBe(true);
    expect(focusedId()).toBe("a");
    expect(press(menu, "ArrowUp").consumed).toBe(true);
    expect(focusedId()).toBe("c");
  });

  it("bails out on a modifier chord without consuming the event", () => {
    const menu = standardMenu();
    const a = menu.querySelector<HTMLElement>("#a")!;
    a.focus();
    for (const mod of ["altKey", "ctrlKey", "metaKey"] as const) {
      const { consumed, preventDefault } = press(a, "ArrowDown", { [mod]: true });
      expect(consumed, mod).toBe(false);
      expect(preventDefault, mod).not.toHaveBeenCalled();
      expect(focusedId(), mod).toBe("a");
    }
  });

  it("leaves unrelated keys alone", () => {
    const menu = standardMenu();
    const { consumed, preventDefault } = press(menu.querySelector<HTMLElement>("#a")!, "x");
    expect(consumed).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("returns false when the target is not inside a role=menu", () => {
    document.body.innerHTML = `<button role="menuitem" id="loose">L</button>`;
    expect(press(document.querySelector<HTMLElement>("#loose")!, "ArrowDown").consumed).toBe(false);
  });

  it("skips disabled, aria-disabled and aria-hidden items", () => {
    // #c is the last *eligible* item; #d/#e/#f follow it in the DOM. Wrapping
    // past #c is what proves all three filters applied.
    const menu = standardMenu();
    expect(press(menu.querySelector<HTMLElement>("#c")!, "ArrowDown").consumed).toBe(true);
    expect(focusedId()).toBe("a");
  });
});

describe("focusMenuEntryPoint", () => {
  it("focuses the first item when nothing is checked", () => {
    focusMenuEntryPoint(standardMenu());
    expect(focusedId()).toBe("a");
  });

  it("focuses the checked menuitemradio instead of the first item", () => {
    focusMenuEntryPoint(
      buildMenu(`
        <button role="menuitemradio" id="sys" aria-checked="false">System</button>
        <button role="menuitemradio" id="dark" aria-checked="true">Dark</button>
        <button role="menuitemradio" id="warm" aria-checked="false">Warm</button>
      `),
    );
    expect(focusedId()).toBe("dark");
  });

  it("falls back to the first item when no radio is checked", () => {
    focusMenuEntryPoint(
      buildMenu(`
        <button role="menuitemradio" id="sys" aria-checked="false">System</button>
        <button role="menuitemradio" id="dark" aria-checked="false">Dark</button>
      `),
    );
    expect(focusedId()).toBe("sys");
  });

  it("ignores a checked menuitemCHECKBOX — those are independent toggles", () => {
    // DecorationsMenu's rows are all checkboxes and all checked by default; if
    // this rule applied to them, the entry point would depend on user settings.
    focusMenuEntryPoint(
      buildMenu(`
        <button role="menuitemcheckbox" id="auth" aria-checked="false">Authorship</button>
        <button role="menuitemcheckbox" id="comments" aria-checked="true">Comments</button>
      `),
    );
    expect(focusedId()).toBe("auth");
  });

  it("skips a filtered-out first item", () => {
    focusMenuEntryPoint(
      buildMenu(`
        <button role="menuitem" id="hidden" aria-hidden="true">H</button>
        <button role="menuitem" id="real">R</button>
      `),
    );
    expect(focusedId()).toBe("real");
  });

  it("is a no-op for a null menu", () => {
    document.body.innerHTML = `<button id="outside">O</button>`;
    const outside = document.querySelector<HTMLElement>("#outside")!;
    outside.focus();
    focusMenuEntryPoint(null);
    expect(focusedId()).toBe("outside");
  });
});
