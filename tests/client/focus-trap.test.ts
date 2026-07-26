/**
 * `src/client/utils/focus-trap.ts`.
 *
 * Extracted from the fifth hand-written copy of this logic in the client. The
 * copies had drifted — two filtered `[inert]`, two filtered `offsetParent`, one
 * filtered nothing, and the newest had silently lost the recover-focus branch
 * two of the others have. This file pins the behaviour so the shared version
 * can't drift the same way.
 */
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { focusablesWithin, trapTab } from "../../src/client/utils/focus-trap";

function mount(html: string): HTMLElement {
  document.body.innerHTML = `<button id="outside">outside</button><div id="c" tabindex="-1">${html}</div>`;
  return document.getElementById("c") as HTMLElement;
}

function tab(shift = false): KeyboardEvent & { defaultPrevented: boolean } {
  return new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey: shift,
    cancelable: true,
  }) as KeyboardEvent & { defaultPrevented: boolean };
}

describe("focusablesWithin", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("finds buttons, inputs, links and summaries in DOM order", () => {
    const c = mount(
      `<button id="a">a</button><input id="b" /><a href="#" id="d">d</a><summary id="e">e</summary>`,
    );
    expect(focusablesWithin(c).map((el) => el.id)).toEqual(["a", "b", "d", "e"]);
  });

  it("skips disabled controls", () => {
    const c = mount(`<button id="a">a</button><button id="b" disabled>b</button>`);
    expect(focusablesWithin(c).map((el) => el.id)).toEqual(["a"]);
  });

  it("skips [tabindex=-1]", () => {
    const c = mount(`<button id="a">a</button><div id="b" tabindex="-1">b</div>`);
    expect(focusablesWithin(c).map((el) => el.id)).toEqual(["a"]);
  });
});

describe("trapTab", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("wraps forward from the last element to the first", () => {
    const c = mount(`<button id="a">a</button><button id="b">b</button>`);
    document.getElementById("b")?.focus();
    const e = tab();
    trapTab(e, c);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("a");
  });

  it("wraps backward from the first element to the last", () => {
    const c = mount(`<button id="a">a</button><button id="b">b</button>`);
    document.getElementById("a")?.focus();
    const e = tab(true);
    trapTab(e, c);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("b");
  });

  it("wraps backward from the container itself to the last element", () => {
    // The dialog is `tabindex="-1"` and takes focus on open, so this is the
    // very first Shift+Tab a keyboard user presses.
    const c = mount(`<button id="a">a</button><button id="b">b</button>`);
    c.focus();
    const e = tab(true);
    trapTab(e, c);
    expect(document.activeElement?.id).toBe("b");
  });

  it("lets an interior Tab through untouched", () => {
    const c = mount(`<button id="a">a</button><button id="b">b</button>`);
    document.getElementById("a")?.focus();
    const e = tab();
    trapTab(e, c);
    // Not the last element, so the browser's own order should apply.
    expect(e.defaultPrevented).toBe(false);
  });

  it("ignores non-Tab keys and a null container", () => {
    const c = mount(`<button id="a">a</button>`);
    const esc = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    trapTab(esc, c);
    expect(esc.defaultPrevented).toBe(false);
    expect(() => trapTab(tab(), null)).not.toThrow();
  });

  it("does nothing when the container holds nothing focusable", () => {
    const c = mount(`<p>no controls here</p>`);
    const e = tab();
    trapTab(e, c);
    expect(e.defaultPrevented).toBe(false);
  });

  /**
   * The recovery branch — this is the one two of the hand-copies have and the
   * newest had lost.
   *
   * NOTE ON REACHABILITY: `LicenseWall` binds `onkeydown` to the container, so
   * a keypress originating outside it never reaches this function and the
   * branch cannot fire there. It is meaningful only for a window/document-level
   * listener, which is how `SettingsModal` and `CoworkAdminDeclinedModal` bind.
   * Keeping and testing it means the shared helper is correct for both wirings
   * rather than silently wrong for one.
   */
  it("pulls focus back when it has escaped the container", () => {
    const c = mount(`<button id="a">a</button><button id="b">b</button>`);
    document.getElementById("outside")?.focus();
    expect(document.activeElement?.id).toBe("outside");

    const e = tab();
    trapTab(e, c);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("a");
  });

  it("pulls focus back to the LAST element on Shift+Tab from outside", () => {
    const c = mount(`<button id="a">a</button><button id="b">b</button>`);
    document.getElementById("outside")?.focus();
    const e = tab(true);
    trapTab(e, c);
    expect(document.activeElement?.id).toBe("b");
  });

  it("recovers when focus fell to <body> because the focused control vanished", () => {
    // The real scenario: clicking Activate disables the submit button, the
    // browser drops focus to <body>, and without recovery the next Tab walks
    // the page behind the scrim.
    const c = mount(`<button id="a">a</button><button id="b">b</button>`);
    document.getElementById("b")?.focus();
    document.getElementById("b")?.remove();
    expect(document.activeElement).toBe(document.body);

    const e = tab();
    trapTab(e, c);
    expect(document.activeElement?.id).toBe("a");
  });
});
