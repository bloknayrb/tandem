/**
 * `measureTabFloor` and the owner badge (#2358 PR 5b). happy-dom has no layout,
 * so each box's width and each element's computed lengths are stubbed; what is
 * pinned is the arithmetic: the badge counts at its CSS minimum, every other
 * child at its rendered width. The real-layout check is
 * `tests/e2e/tab-overflow.spec.ts` run with ownership on.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { measureTabFloor, TAB_FLOOR_PX } from "../../src/client/tabs/tab-floor.js";

const PILL_STYLE = {
  paddingLeft: "12px",
  paddingRight: "10px",
  borderLeftWidth: "1px",
  borderRightWidth: "1px",
  columnGap: "6px",
};

function child(tag: string, testid: string | null, width: number): HTMLElement {
  const el = document.createElement(tag);
  if (testid) el.dataset.testid = testid;
  el.getBoundingClientRect = () => ({ width }) as DOMRect;
  return el;
}

/** wrapper > pill[role=tab] > [indicator, name, badge?, close] */
function tab(opts: { badgeWidth?: number; badgeMin?: string }): HTMLElement {
  const wrapper = document.createElement("div");
  const pill = document.createElement("div");
  pill.setAttribute("role", "tab");
  const name = child("span", "tab-name-a", 999);
  Object.defineProperty(name, "scrollWidth", { value: 30 });
  pill.append(child("span", null, 8), name);
  if (opts.badgeWidth !== undefined) {
    pill.append(child("button", "tab-owner-badge", opts.badgeWidth));
  }
  pill.append(child("button", null, 14));
  wrapper.append(pill);

  vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
    if (el === pill) return PILL_STYLE as unknown as CSSStyleDeclaration;
    if (el === name) return { maxWidth: "240px" } as unknown as CSSStyleDeclaration;
    if ((el as HTMLElement).dataset.testid === "tab-owner-badge") {
      return { minWidth: opts.badgeMin ?? "24px" } as unknown as CSSStyleDeclaration;
    }
    return {} as CSSStyleDeclaration;
  });
  return wrapper;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("measureTabFloor and the owner badge (#2358 PR 5b)", () => {
  // chrome without a badge: 12 + 10 + 1 + 1 padding/borders, 2 gaps × 6,
  // indicator 8, close 14 = 58; name 30 + 1 rounding = 31.
  it("without a badge, the floor is chrome plus the name's natural width", () => {
    expect(measureTabFloor(tab({}))).toBe(58 + 31);
  });

  it("counts the badge at its CSS minimum, not its rendered label", () => {
    // One more gap (6) and the badge's 24px stub — not its 70px label, which
    // would push the floor to 165 and clamp every badged tab to TAB_FLOOR_PX.
    const floor = measureTabFloor(tab({ badgeWidth: 70 }));
    expect(floor).toBe(58 + 6 + 24 + 31);
    expect(floor).toBeLessThan(TAB_FLOOR_PX);
  });

  it("falls back to the badge's rendered width when its minimum is unreadable", () => {
    expect(measureTabFloor(tab({ badgeWidth: 20, badgeMin: "" }))).toBe(58 + 6 + 20 + 31);
  });
});
