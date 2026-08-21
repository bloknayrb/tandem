/**
 * The editor's anchor gesture intercept (#1420).
 *
 * `Editor.svelte` registered `onclick` and nothing else, so a middle click —
 * which fires `auxclick`, not `click` — never reached the intercept, never hit
 * `preventDefault()`, and never routed through `openHref`, the single trust
 * gate the whole link design rests on.
 *
 * What this file pins is the BUTTON AND MODIFIER MATRIX, which is the part of
 * the fix that can go subtly wrong: a handler that misses a modifier
 * combination, or that swallows the back/forward buttons, is a different bug.
 * It cannot prove the fix works end to end — `preventDefault()`'s effect on the
 * browser's default action is engine- and contenteditable-dependent and is
 * covered by `tests/e2e/relative-links.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  interceptAnchorGesture,
  MOUSE_BUTTON_MIDDLE,
} from "../../src/client/editor/utils/anchor-intercept";

const HOSTILE_HREF = "/\\evil.com/x.md";

let root: HTMLDivElement;
let anchor: HTMLAnchorElement;
let inner: HTMLSpanElement;
let plain: HTMLParagraphElement;
let openHref: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  anchor = document.createElement("a");
  anchor.setAttribute("href", HOSTILE_HREF);
  inner = document.createElement("span");
  inner.textContent = "link text";
  anchor.appendChild(inner);
  plain = document.createElement("p");
  plain.textContent = "not a link";
  root.append(anchor, plain);
  document.body.appendChild(root);
  openHref = vi.fn();
});

/** Dispatch a real event so `defaultPrevented` reflects a real `preventDefault`. */
function fire(
  target: Element,
  type: "click" | "auxclick",
  init: MouseEventInit = {},
): { handled: boolean; event: MouseEvent } {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  let handled = false;
  root.addEventListener(type, (e) => {
    handled = interceptAnchorGesture(e as MouseEvent, openHref);
  });
  target.dispatchEvent(event);
  return { handled, event };
}

const MODIFIERS: Array<[string, MouseEventInit]> = [
  ["no modifier", {}],
  ["ctrlKey", { ctrlKey: true }],
  ["metaKey", { metaKey: true }],
  ["shiftKey", { shiftKey: true }],
  ["altKey", { altKey: true }],
  ["ctrl+shift", { ctrlKey: true, shiftKey: true }],
];

describe("interceptAnchorGesture — the gesture that regressed", () => {
  it.each(MODIFIERS)("intercepts a middle click with %s", (_label, init) => {
    const { handled, event } = fire(inner, "auxclick", {
      button: MOUSE_BUTTON_MIDDLE,
      ...init,
    });
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(openHref).toHaveBeenCalledWith(HOSTILE_HREF);
  });

  it("passes the RAW href through, unnormalised", () => {
    // `openHref` is the gate; handing it anything but the attribute as written
    // would mean the gate judges a string the browser never saw.
    anchor.setAttribute("href", "  /\\evil.com/x.md");
    fire(inner, "auxclick", { button: MOUSE_BUTTON_MIDDLE });
    expect(openHref).toHaveBeenCalledWith("  /\\evil.com/x.md");
  });
});

describe("interceptAnchorGesture — buttons it must NOT claim", () => {
  // 2 belongs to the context menu (`context-menu/install.ts` owns `contextmenu`).
  // 3/4 are cancelable history navigations in Chromium: claiming them would turn
  // a back-button click that happens to land over a link into a link open.
  it.each([
    ["secondary / context menu", 2],
    ["back", 3],
    ["forward", 4],
  ])("ignores auxclick from the %s button", (_label, button) => {
    const { handled, event } = fire(inner, "auxclick", { button });
    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(openHref).not.toHaveBeenCalled();
  });

  it("ignores an auxclick reporting button 0", () => {
    // Not a real gesture, but a synthetic event defaults to button 0 — the
    // filter must key on the button, not on the event type alone.
    const { handled } = fire(inner, "auxclick", { button: 0 });
    expect(handled).toBe(false);
    expect(openHref).not.toHaveBeenCalled();
  });
});

describe("interceptAnchorGesture — the click path is unchanged", () => {
  it.each(MODIFIERS)("intercepts a left click with %s", (_label, init) => {
    const { handled, event } = fire(inner, "click", { button: 0, ...init });
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(openHref).toHaveBeenCalledWith(HOSTILE_HREF);
  });

  it("resolves the anchor from a nested element, not just a direct hit", () => {
    const { handled } = fire(inner, "click", { button: 0 });
    expect(handled).toBe(true);
  });
});

describe("interceptAnchorGesture — gestures it declines", () => {
  it.each(["click", "auxclick"] as const)("does not claim a non-anchor target (%s)", (type) => {
    const { handled, event } = fire(plain, type, {
      button: type === "auxclick" ? MOUSE_BUTTON_MIDDLE : 0,
    });
    // False is what lets the caller run its annotation-selection handling.
    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(openHref).not.toHaveBeenCalled();
  });

  const INERT_HREFS: Array<[string, string]> = [
    ["a pure fragment", "#section"],
    ["an empty href (a mark the render veto blanked)", ""],
  ];

  it.each(INERT_HREFS)("leaves the browser's in-page scroll alone for %s on click", (_l, href) => {
    anchor.setAttribute("href", href);
    const { handled, event } = fire(inner, "click", { button: 0 });
    // `true` stops the caller's annotation handling — the pre-#1420 behaviour of
    // the click path — while the browser keeps the in-page scroll.
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(openHref).not.toHaveBeenCalled();
  });

  it.each(
    INERT_HREFS,
  )("suppresses the duplicate-app-window default for %s on auxclick", (_l, href) => {
    // The aux default action is a NEW TAB, not a scroll: `href=""` resolves to
    // the current document URL and `#frag` to current-URL-plus-fragment, so the
    // middle click would open a second editor session against the same
    // documents. Reachable via the veto blanking a `\\fileserver\…` Word link
    // to `href=""` in the read-only changelog.
    anchor.setAttribute("href", href);
    const { handled, event } = fire(inner, "auxclick", { button: MOUSE_BUTTON_MIDDLE });
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(openHref).not.toHaveBeenCalled();
  });

  it("declines an anchor with no href attribute at all", () => {
    const bare = document.createElement("a");
    bare.textContent = "x";
    root.appendChild(bare);
    const { handled } = fire(bare, "auxclick", { button: MOUSE_BUTTON_MIDDLE });
    expect(handled).toBe(false);
  });
});
