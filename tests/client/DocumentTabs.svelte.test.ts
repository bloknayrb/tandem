// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import DocumentTabs from "../../src/client/tabs/DocumentTabs.svelte";
import type { OpenTab } from "../../src/client/types.js";

function makeTab(id: string): OpenTab {
  return {
    id,
    fileName: `${id}.md`,
    filePath: `/tmp/${id}.md`,
    format: "md",
    readOnly: false,
    ydoc: new Y.Doc(),
    // provider isn't read by DocumentTabs or TabItem on the paths these tests exercise
    provider: {} as unknown as OpenTab["provider"],
  };
}

// happy-dom's PointerEvent constructor ignores clientX/clientY/pointerId/button
// in the init dict (same quirk the old DragEvent helper worked around). Build a
// generic Event and override the properties.
function makePointerEvent(
  type: string,
  opts: { clientX?: number; clientY?: number; pointerId?: number; button?: number } = {},
): PointerEvent {
  const evt = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperty(evt, "clientX", { value: opts.clientX ?? 0, configurable: true });
  Object.defineProperty(evt, "clientY", { value: opts.clientY ?? 0, configurable: true });
  Object.defineProperty(evt, "pointerId", { value: opts.pointerId ?? 1, configurable: true });
  Object.defineProperty(evt, "button", { value: opts.button ?? 0, configurable: true });
  return evt;
}

function baseProps(tabs: OpenTab[], reorder: (...args: unknown[]) => void) {
  return {
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    onTabSwitch: vi.fn(),
    onTabClose: vi.fn(),
    reorder,
  };
}

// happy-dom doesn't implement pointer capture; stub the methods so the gesture
// machine doesn't throw. elementFromPoint is stubbed per-test to control which
// tab the pointer is "over".
beforeEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  (Element.prototype as any).setPointerCapture = vi.fn();
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  (Element.prototype as any).releasePointerCapture = vi.fn();
  // happy-dom doesn't implement the Web Animations API. Closing/removing a tab
  // fires TabItem's `out:tabExit` outro, which Svelte runs via `element.animate`
  // (case C removes a tab mid-drag). Stub a minimal Animation so the css-only
  // outro doesn't throw — Svelte's css path only assigns `onfinish`/`effect` and
  // calls `cancel()`; it never needs the animation to actually progress here.
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  (Element.prototype as any).animate = () => ({
    cancel() {},
    currentTime: 0,
    playState: "finished",
    effect: null,
    onfinish: null,
  });
  // The tab-reorder FLIP (s3, #798) wraps each TabItem in an `animate:flip`
  // host; when a remaining tab moves (case C: removing "a" shifts "b" to the
  // front), Svelte 5's flip calls `element.getAnimations()` to coordinate with
  // any in-flight animation before measuring the delta. happy-dom doesn't
  // implement it — return an empty list (nothing is mid-flight synchronously).
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  (Element.prototype as any).getAnimations = () => [];
});

afterEach(async () => {
  // Flush the macrotask queue so any pending click-suppressor cleanup
  // (setTimeout(0) in handlePointerUp) fires and removes its window listener,
  // keeping tests isolated.
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.restoreAllMocks();
});

// Stub document.elementFromPoint to report `el` as the element under the cursor.
function overElement(el: Element | null) {
  vi.spyOn(document, "elementFromPoint").mockReturnValue(el);
}

describe("DocumentTabs pointer reorder", () => {
  it("case A: drag from A to B calls reorder(a, b, side) once", async () => {
    const reorder = vi.fn();
    const tabs = [makeTab("a"), makeTab("b")];
    const { container } = render(DocumentTabs, { props: baseProps(tabs, reorder) });
    await tick();

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    const tabB = container.querySelector('[data-testid="tab-b"]') as HTMLElement;
    expect(tabA).toBeTruthy();
    expect(tabB).toBeTruthy();
    overElement(tabB);

    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    // Move well past the 5px threshold so `dragging` flips and dropTarget is set.
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 80, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 80, clientY: 0 }));
    await tick();

    expect(reorder).toHaveBeenCalledTimes(1);
    expect(reorder).toHaveBeenCalledWith("a", "b", expect.stringMatching(/^(left|right)$/));
  });

  it("case B: drag survives a tabs prop re-render WITHOUT id removal (regression guard for #625)", async () => {
    const reorder = vi.fn();
    const tabsInit = [makeTab("a"), makeTab("b")];
    const { container, rerender } = render(DocumentTabs, {
      props: baseProps(tabsInit, reorder),
    });
    await tick();

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    expect(tabA).toBeTruthy();
    const tabB = container.querySelector('[data-testid="tab-b"]') as HTMLElement;
    overElement(tabB);

    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 80, clientY: 0 }));
    await tick();

    // Mid-drag: tabs prop re-derives with the same a/b plus a new c (the shape
    // of a Yjs awareness ping recomputing orderedTabs). The narrow $effect must
    // NOT null draggedId because "a" is still present.
    const tabsExpanded = [tabsInit[0], tabsInit[1], makeTab("c")];
    await rerender(baseProps(tabsExpanded, reorder));
    await tick();

    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 80, clientY: 0 }));
    await tick();

    expect(reorder).toHaveBeenCalledTimes(1);
    expect(reorder).toHaveBeenCalledWith("a", "b", expect.stringMatching(/^(left|right)$/));
  });

  it("case C: dragged tab removed mid-drag → $effect nulls draggedId, drop is a no-op", async () => {
    const reorder = vi.fn();
    const tabsInit = [makeTab("a"), makeTab("b")];
    const { container, rerender } = render(DocumentTabs, {
      props: baseProps(tabsInit, reorder),
    });
    await tick();

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    const tabB = container.querySelector('[data-testid="tab-b"]') as HTMLElement;
    overElement(tabB);

    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 80, clientY: 0 }));
    await tick();

    // Mid-drag: tab "a" disappears (server-driven tandem_close race). The narrow
    // $effect detects draggedId is no longer in tabs and nulls it.
    await rerender({
      tabs: [tabsInit[1]],
      activeTabId: "b",
      onTabSwitch: vi.fn(),
      onTabClose: vi.fn(),
      reorder,
    });
    await tick();

    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 80, clientY: 0 }));
    await tick();

    expect(reorder).not.toHaveBeenCalled();
  });

  it("case D: pointerdown on the close button does NOT start a drag", async () => {
    const reorder = vi.fn();
    const tabs = [makeTab("a"), makeTab("b")];
    const { container } = render(DocumentTabs, { props: baseProps(tabs, reorder) });
    await tick();

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    const closeBtn = tabA.querySelector("button") as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    const tabB = container.querySelector('[data-testid="tab-b"]') as HTMLElement;
    overElement(tabB);

    // The close button stops pointerdown propagation, so the tab's
    // handleTabPointerDown never runs and no gesture starts.
    closeBtn.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 80, clientY: 0 }));
    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 80, clientY: 0 }));
    await tick();

    expect(reorder).not.toHaveBeenCalled();
  });

  it("case E: side is 'right' for the right half, 'left' for the left half", async () => {
    const reorder = vi.fn();
    const tabs = [makeTab("a"), makeTab("b")];
    const { container } = render(DocumentTabs, { props: baseProps(tabs, reorder) });
    await tick();

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    const tabB = container.querySelector('[data-testid="tab-b"]') as HTMLElement;
    overElement(tabB);

    // happy-dom getBoundingClientRect returns zeros; stub a 100px-wide rect so
    // clientX positions land cleanly on either side of midX (=50).
    vi.spyOn(tabB, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 100,
      width: 100,
      top: 0,
      bottom: 20,
      height: 20,
      x: 0,
      y: 0,
      toJSON() {},
    } as DOMRect);

    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 10 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 80, clientY: 10 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 80, clientY: 10 }));
    await tick();

    expect(reorder).toHaveBeenCalledTimes(1);
    expect(reorder).toHaveBeenCalledWith("a", "b", "right");

    // Second drag, drop on the left half of the same tab.
    reorder.mockClear();
    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 10 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 20, clientY: 10 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 20, clientY: 10 }));
    await tick();

    expect(reorder).toHaveBeenCalledTimes(1);
    expect(reorder).toHaveBeenCalledWith("a", "b", "left");
  });

  it("a sub-threshold press is a click, not a drag: reorder not called, switch fires", async () => {
    const reorder = vi.fn();
    const props = baseProps([makeTab("a"), makeTab("b")], reorder);
    const { container } = render(DocumentTabs, { props });
    await tick();

    const tabB = container.querySelector('[data-testid="tab-b"]') as HTMLElement;
    overElement(tabB);
    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;

    // Press and release with movement under the 5px threshold.
    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 2, clientY: 1 }));
    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 2, clientY: 1 }));
    await tick();
    // The browser would emit a click; the gesture installs no suppressor here.
    tabA.click();
    await tick();

    expect(reorder).not.toHaveBeenCalled();
    expect(props.onTabSwitch).toHaveBeenCalledWith("a");
  });

  it("a completed drag suppresses the trailing click so the active tab does not switch", async () => {
    const reorder = vi.fn();
    const props = baseProps([makeTab("a"), makeTab("b")], reorder);
    const { container } = render(DocumentTabs, { props });
    await tick();

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    const tabB = container.querySelector('[data-testid="tab-b"]') as HTMLElement;
    overElement(tabB);

    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 80, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 80, clientY: 0 }));
    await tick();

    // The trailing synthetic click must be swallowed by the one-shot capture
    // listener, so onTabSwitch is NOT called for the dragged tab.
    tabA.click();
    await tick();

    expect(reorder).toHaveBeenCalledTimes(1);
    expect(props.onTabSwitch).not.toHaveBeenCalled();
  });

  it("singleTab: a lone tab cannot be dragged", async () => {
    const reorder = vi.fn();
    const { container } = render(DocumentTabs, { props: baseProps([makeTab("a")], reorder) });
    await tick();

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    overElement(tabA);

    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 80, clientY: 0 }));
    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 80, clientY: 0 }));
    await tick();

    expect(reorder).not.toHaveBeenCalled();
  });

  it("Escape mid-drag aborts: no reorder, drop indicator cleared", async () => {
    const reorder = vi.fn();
    const tabs = [makeTab("a"), makeTab("b")];
    const { container } = render(DocumentTabs, { props: baseProps(tabs, reorder) });
    await tick();

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    const tabB = container.querySelector('[data-testid="tab-b"]') as HTMLElement;
    overElement(tabB);

    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 80, clientY: 0 }));
    await tick();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();

    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 80, clientY: 0 }));
    await tick();

    expect(reorder).not.toHaveBeenCalled();
  });

  it("pointercancel aborts the drag", async () => {
    const reorder = vi.fn();
    const tabs = [makeTab("a"), makeTab("b")];
    const { container } = render(DocumentTabs, { props: baseProps(tabs, reorder) });
    await tick();

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    const tabB = container.querySelector('[data-testid="tab-b"]') as HTMLElement;
    overElement(tabB);

    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 80, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointercancel", { clientX: 80, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 80, clientY: 0 }));
    await tick();

    expect(reorder).not.toHaveBeenCalled();
  });
});

describe("DocumentTabs new-tab menu (openMenuTrigger)", () => {
  // NewTabMenu portals to <body>, so query the document, not the container.
  const menuSelector = '[role="dialog"][aria-label="New tab"]';

  it("openMenuTrigger toggles the new-tab menu (mount 0 closed → 1 open → 2 closed)", async () => {
    const reorder = vi.fn();
    const tabs = [makeTab("a")];
    const { rerender } = render(DocumentTabs, {
      props: { ...baseProps(tabs, reorder), openMenuTrigger: 0 },
    });
    await tick();

    // Mount value 0 is skipped by the `> 0` guard — menu stays closed.
    expect(document.querySelector(menuSelector)).toBeNull();

    // First Ctrl+T (counter → 1) opens it. If the `untrack` wrapper ever
    // regressed, this rerender would throw effect_update_depth_exceeded.
    await rerender({ ...baseProps(tabs, reorder), openMenuTrigger: 1 });
    await tick();
    expect(document.querySelector(menuSelector)).not.toBeNull();

    // Second Ctrl+T (counter → 2) toggles it closed again.
    await rerender({ ...baseProps(tabs, reorder), openMenuTrigger: 2 });
    await tick();
    expect(document.querySelector(menuSelector)).toBeNull();
  });
});

// A30 tab-reorder drag motion. NO geometry assertions beyond the arithmetic the
// component feeds to tabDragMotion.ts — happy-dom has no layout engine, so the
// rects below are stubs and the questions that need a real one (does the pill
// track the pointer, does the parted gap survive the drop) live in
// tests/e2e/tab-drag-motion.spec.ts. What is worth pinning here is the WIRING:
// which mode the component picks, and what it writes to the DOM in each.
describe("DocumentTabs A30 drag motion", () => {
  const styleOf = (el: Element | null) => el?.getAttribute("style") ?? "";
  // The drop indicator is a 2px accent wedge on one edge, written as a
  // `border-left`/`border-right` shorthand that happy-dom expands into
  // longhands — so match the token, not the shorthand text, and let it stand
  // for either side. An inactive non-target pill carries no accent at all.
  const hasWedge = (el: Element | null) => styleOf(el).includes("--tandem-accent");
  const wrappersIn = (container: Element) =>
    Array.from(container.querySelectorAll<HTMLElement>(".tab-flip"));

  /**
   * Shadow happy-dom's always-0 `clientWidth` and hand the strip a real layout,
   * so the healthy (snapshot) path can be exercised at all. Two 100px tabs with
   * a 6px gap: lefts 0 and 106, so b's midpoint is 156.
   */
  function forceLayout(container: Element) {
    const scroller = container.querySelector('[data-testid="tab-scroll-container"]');
    Object.defineProperty(scroller, "clientWidth", { value: 400, configurable: true });
    wrappersIn(container).forEach((w, i) => {
      vi.spyOn(w, "getBoundingClientRect").mockReturnValue({
        left: i * 106,
        right: i * 106 + 100,
        width: 100,
        top: 0,
        bottom: 26,
        height: 26,
        x: i * 106,
        y: 0,
        toJSON() {},
      } as DOMRect);
    });
  }

  it("falls back to the live hit-test when there is no usable geometry", async () => {
    // This is why the nine coordinate-blind `elementFromPoint` stubs above still
    // work: happy-dom's clientWidth getter returns a field initialised to 0 and
    // never updated, so the environment probe holds unconditionally. If this
    // ever flips, the rest of this file starts testing a path the product
    // doesn't take — so pin the mode, not just the outcome.
    const reorder = vi.fn();
    const tabs = [makeTab("a"), makeTab("b")];
    const { container } = render(DocumentTabs, { props: baseProps(tabs, reorder) });
    await tick();

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    const tabB = container.querySelector('[data-testid="tab-b"]') as HTMLElement;
    overElement(tabB);

    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 80, clientY: 0 }));
    await tick();

    // Degraded: the accent wedge is the drop signal, nothing lifts, and the
    // transform layer is never touched.
    expect(hasWedge(tabB)).toBe(true);
    expect(styleOf(tabA)).toContain("transform: none");
    for (const w of wrappersIn(container)) expect(w.style.transform).toBe("");

    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 80, clientY: 0 }));
    await tick();
    expect(reorder).toHaveBeenCalledWith("a", "b", expect.stringMatching(/^(left|right)$/));
  });

  it("lifts the pill and parts the sibling once the strip has geometry", async () => {
    const reorder = vi.fn();
    const tabs = [makeTab("a"), makeTab("b")];
    const { container } = render(DocumentTabs, { props: baseProps(tabs, reorder) });
    await tick();
    forceLayout(container);

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    const tabB = container.querySelector('[data-testid="tab-b"]') as HTMLElement;
    overElement(null); // healthy mode must never consult the hit-test

    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    // Past b's midpoint (156), so the slot flips and b backs up by its own
    // width + the gap. The drag offset is the raw pointer travel.
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 200, clientY: 0 }));
    await tick();

    const [wrapA, wrapB] = wrappersIn(container);
    expect(wrapA.style.transform).toBe("translateX(200px)");
    expect(wrapB.style.transform).toBe("translateX(-106px)");
    expect(styleOf(tabA)).toContain("transform: translateY(-5px) scale(1.04)");
    // The parted gap replaces the wedge — never both.
    expect(hasWedge(tabB)).toBe(false);

    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 200, clientY: 0 }));
    await tick();

    expect(reorder).toHaveBeenCalledWith("a", "b", "right");
    // Cleared in the microtask between flip's measure() and apply().
    expect(wrapA.style.transform).toBe("");
    expect(wrapB.style.transform).toBe("");
    expect(wrapA.style.zIndex).toBe("");
    expect(styleOf(tabA)).toContain("transform: none");
  });

  it("a mid-drag tabs change drops to the wedge and strands no transform", async () => {
    const reorder = vi.fn();
    const tabsInit = [makeTab("a"), makeTab("b")];
    const { container, rerender } = render(DocumentTabs, {
      props: baseProps(tabsInit, reorder),
    });
    await tick();
    forceLayout(container);

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    const tabB = container.querySelector('[data-testid="tab-b"]') as HTMLElement;

    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 200, clientY: 0 }));
    await tick();
    expect(wrappersIn(container)[1].style.transform).toBe("translateX(-106px)");

    // A third tab arrives (Claude calling tandem_open). The snapshot's midpoints
    // and parting magnitudes now describe a strip that no longer exists.
    await rerender(baseProps([tabsInit[0], tabsInit[1], makeTab("c")], reorder));
    await tick();

    for (const w of wrappersIn(container)) expect(w.style.transform).toBe("");
    expect(styleOf(tabA)).toContain("transform: none");

    // The gesture stays alive and still commits — case B's contract — but from
    // here on the wedge is the signal, so the hit-test has to be back in play.
    overElement(tabB);
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 210, clientY: 0 }));
    await tick();
    expect(hasWedge(tabB)).toBe(true);

    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 210, clientY: 0 }));
    await tick();
    expect(reorder).toHaveBeenCalledTimes(1);
    for (const w of wrappersIn(container)) expect(w.style.transform).toBe("");
  });

  it("Escape reverts the transform layer and strands nothing", async () => {
    const reorder = vi.fn();
    const tabs = [makeTab("a"), makeTab("b")];
    const { container } = render(DocumentTabs, { props: baseProps(tabs, reorder) });
    await tick();
    forceLayout(container);

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 200, clientY: 0 }));
    await tick();
    expect(wrappersIn(container)[0].style.transform).toBe("translateX(200px)");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    // The transform goes immediately (the CSS transition carries the glide);
    // the transition declaration is stripped when the glide ends.
    for (const w of wrappersIn(container)) expect(w.style.transform).toBe("");
    expect(wrappersIn(container)[0].style.transition).toContain("--a30-settle");

    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const w of wrappersIn(container)) {
      expect(w.style.transition).toBe("");
      expect(w.style.zIndex).toBe("");
    }
    expect(reorder).not.toHaveBeenCalled();
  });

  it("unmounting mid-drag tears the gesture down without throwing", async () => {
    // @testing-library/svelte's auto-cleanup never registers here (its index.js
    // gates on a global afterEach and vitest.config.ts sets no `globals`), so
    // nothing is ever unmounted for us — an implicit version of this would test
    // nothing at all.
    const reorder = vi.fn();
    const tabs = [makeTab("a"), makeTab("b")];
    const { container, unmount } = render(DocumentTabs, { props: baseProps(tabs, reorder) });
    await tick();
    forceLayout(container);

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 200, clientY: 0 }));
    await tick();

    // Hold the wrapper references across the unmount. `container` is emptied,
    // so querying after the fact would find nothing and every style assertion
    // below would pass vacuously — which is the whole failure mode being pinned.
    const wrappers = wrappersIn(container);
    expect(wrappers[0].style.transform).toBe("translateX(200px)");

    unmount();
    await tick();

    // The window listeners went with it, so nothing is left to fire a reorder.
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 260, clientY: 0 }));
    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 260, clientY: 0 }));
    await tick();
    expect(reorder).not.toHaveBeenCalled();

    // Teardown must strip the transform layer, not just drop the listeners. A
    // real unmount takes the nodes with it so nobody would see the residue —
    // but svelte-hmr can keep these elements alive across a component swap, and
    // a leftover inline `transition` keeps `getAnimations()` non-empty, which
    // makes `fix()` early-return and the next tab close jump instead of
    // collapsing. Detached-but-styled is exactly the state to forbid.
    for (const w of wrappers) {
      expect(w.style.transform).toBe("");
      expect(w.style.transition).toBe("");
      expect(w.style.zIndex).toBe("");
    }
  });

  it("Escape suppresses the trailing click, so the cancelled tab does not switch", async () => {
    // Escape used to null `pointerId`, which made the real pointerup early-return
    // before the suppressor was installed — so the trailing synthetic click
    // reached `onswitch` and the tab activated anyway. Harmless when nothing
    // moved; under A30 it reads as "I cancelled, it flew back, and it switched".
    const reorder = vi.fn();
    const props = baseProps([makeTab("a"), makeTab("b")], reorder);
    const { container } = render(DocumentTabs, { props });
    await tick();
    forceLayout(container);

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 200, clientY: 0 }));
    await tick();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 200, clientY: 0 }));
    await tick();

    tabA.click();
    await tick();

    expect(reorder).not.toHaveBeenCalled();
    expect(props.onTabSwitch).not.toHaveBeenCalled();
  });

  it("releasing inside its own slot reverts instead of settling, and commits nothing", async () => {
    // The modal state of the gesture: picked up, jiggled, put back. The slot
    // never changes, so there is no target, `reorder` is never invoked, no
    // reconcile happens — and therefore no flip to settle the tab home. This is
    // exactly the path the CSS revert exists for; an unconditional clear here
    // would snap the pill back from mid-air instead of gliding.
    const reorder = vi.fn();
    const tabs = [makeTab("a"), makeTab("b")];
    const { container } = render(DocumentTabs, { props: baseProps(tabs, reorder) });
    await tick();
    forceLayout(container);

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    overElement(null);

    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    // 100 is past the 5px threshold but short of b's midpoint (156), so "a"
    // stays in slot 0 and nothing parts.
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 100, clientY: 0 }));
    await tick();

    const [wrapA, wrapB] = wrappersIn(container);
    expect(wrapA.style.transform).toBe("translateX(100px)");
    expect(wrapB.style.transform).toBe("");

    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 100, clientY: 0 }));
    await tick();

    expect(reorder).not.toHaveBeenCalled();
    expect(wrapA.style.transform).toBe("");
    expect(wrapA.style.transition).toContain("--a30-settle");

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(wrapA.style.transition).toBe("");
    expect(wrapA.style.zIndex).toBe("");
  });

  it("a width-only change mid-drag invalidates the snapshot too", async () => {
    // The id-set detector is blind to this: same ids, same order, but the
    // adaptive-floor effect rewrites every wrapper's min-width when the active
    // tab changes (the active name renders at font-weight 500, measurably wider
    // than the 400 it was measured at), and with flex-shrink:1 that moves every
    // left and width. Midpoints and parting magnitudes would then describe a
    // strip that no longer exists.
    const reorder = vi.fn();
    const tabs = [makeTab("a"), makeTab("b")];
    const { container, rerender } = render(DocumentTabs, { props: baseProps(tabs, reorder) });
    await tick();
    forceLayout(container);

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    const tabB = container.querySelector('[data-testid="tab-b"]') as HTMLElement;
    overElement(null);

    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 200, clientY: 0 }));
    await tick();
    expect(wrappersIn(container)[1].style.transform).toBe("translateX(-106px)");

    // Same ids, same order — only the active tab moves.
    await rerender({ ...baseProps(tabs, reorder), activeTabId: "b" });
    await tick();

    for (const w of wrappersIn(container)) expect(w.style.transform).toBe("");
    expect(styleOf(tabA)).toContain("transform: none");

    // Degraded from here, asserted through BEHAVIOUR rather than the wedge:
    // further movement must not re-part anything off the dead snapshot. The
    // wedge itself is covered by the id-change test above — here "b" is now the
    // active tab, and happy-dom mis-expands the active branch's
    // `border: 1px solid var(--tandem-border)` shorthand (a `var()` inside a
    // shorthand lands in all three longhands), swallowing the `border-left`
    // override that follows it. Real browsers cascade that correctly; it is a
    // limitation of the test DOM, not of the indicator.
    overElement(tabB);
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 210, clientY: 0 }));
    await tick();
    for (const w of wrappersIn(container)) expect(w.style.transform).toBe("");

    // The gesture is still alive and still commits, off the live hit-test.
    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 210, clientY: 0 }));
    await tick();
    expect(reorder).toHaveBeenCalledTimes(1);
  });

  it("parts every sibling it passes, not just the first", async () => {
    // Two tabs can't tell "shift the crossed neighbour" from "shift everything
    // between here and there" — with three, dragging "a" to the end has to move
    // BOTH "b" and "c" back by the same width+gap.
    const reorder = vi.fn();
    const tabs = [makeTab("a"), makeTab("b"), makeTab("c")];
    const { container } = render(DocumentTabs, { props: baseProps(tabs, reorder) });
    await tick();
    forceLayout(container); // lefts 0/106/212, midpoints 50/156/262

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    overElement(null);

    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 300, clientY: 0 }));
    await tick();

    const [wrapA, wrapB, wrapC] = wrappersIn(container);
    expect(wrapA.style.transform).toBe("translateX(300px)");
    expect(wrapB.style.transform).toBe("translateX(-106px)");
    expect(wrapC.style.transform).toBe("translateX(-106px)");

    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 300, clientY: 0 }));
    await tick();
    expect(reorder).toHaveBeenCalledWith("a", "c", "right");
    for (const w of wrappersIn(container)) expect(w.style.transform).toBe("");
  });

  it("pointercancel takes the revert path, not the settle", async () => {
    // Escape and pointercancel are separate handlers reaching the same no-call
    // release. Both must revert: nothing was committed, so no reconcile happens
    // and there is no flip to settle the pill home from mid-air.
    const reorder = vi.fn();
    const tabs = [makeTab("a"), makeTab("b")];
    const { container } = render(DocumentTabs, { props: baseProps(tabs, reorder) });
    await tick();
    forceLayout(container);

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 200, clientY: 0 }));
    await tick();
    expect(wrappersIn(container)[0].style.transform).toBe("translateX(200px)");

    window.dispatchEvent(makePointerEvent("pointercancel", { clientX: 200, clientY: 0 }));
    await tick();

    expect(reorder).not.toHaveBeenCalled();
    const [wrapA] = wrappersIn(container);
    expect(wrapA.style.transform).toBe("");
    expect(wrapA.style.transition).toContain("--a30-settle");

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(wrapA.style.transition).toBe("");
    expect(wrapA.style.zIndex).toBe("");
  });

  it("a tab being renamed cannot be grabbed", async () => {
    // Dragging from the pill's padding pulls focus off the rename input, whose
    // blur commits `finish(false)` — so the rename would be silently discarded
    // by the act of picking the tab up.
    const reorder = vi.fn();
    // `isRenamable` gates on `source === "file"`, which makeTab leaves unset —
    // without it the double-click below is a no-op and the test passes for the
    // wrong reason.
    const tabs = [{ ...makeTab("a"), source: "file" as const }, makeTab("b")];
    const { container } = render(DocumentTabs, { props: baseProps(tabs, reorder) });
    await tick();
    forceLayout(container);

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    // `renamingTabId` is DocumentTabs' own state, not a prop — double-click on
    // the name span is the real entry point, so drive it the way a user would.
    const nameA = container.querySelector('[data-testid="tab-name-a"]') as HTMLElement;
    nameA.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await tick();
    expect(container.querySelector('[data-testid="tab-rename-input-a"]')).toBeTruthy();

    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();
    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 200, clientY: 0 }));
    await tick();

    for (const w of wrappersIn(container)) expect(w.style.transform).toBe("");
    window.dispatchEvent(makePointerEvent("pointerup", { clientX: 200, clientY: 0 }));
    await tick();
    expect(reorder).not.toHaveBeenCalled();
  });

  it("Alt+Arrow is inert while a pointer drag is in flight", async () => {
    // Both reorder paths stay reachable at once (pointerdown focuses the tab and
    // the window keydown handler only intercepts Escape). A keyboard reorder
    // landing mid-gesture would commit against the pointer gesture's snapshot,
    // leave the parted siblings gliding toward a drop that no longer happens,
    // and then layer a second reorder on release.
    const reorder = vi.fn();
    const tabs = [makeTab("a"), makeTab("b")];
    const { container } = render(DocumentTabs, { props: baseProps(tabs, reorder) });
    await tick();
    forceLayout(container);

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    tabA.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    await tick();

    // Still a press, not a drag — the gate is `dragging`, not the pointer latch,
    // so keyboard reorder must still work here.
    tabA.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true }),
    );
    await tick();
    expect(reorder).toHaveBeenCalledTimes(1);
    reorder.mockClear();

    window.dispatchEvent(makePointerEvent("pointermove", { clientX: 200, clientY: 0 }));
    await tick();
    tabA.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true }),
    );
    await tick();
    expect(reorder).not.toHaveBeenCalled();
  });
});

describe("uniform tab width", () => {
  // The geometry itself needs a real layout engine and lives in
  // tests/e2e/tab-overflow.spec.ts. What's checked here is only the wiring the
  // E2E can't distinguish from a CSS regression: that the prop actually reaches
  // the wrapper. A dropped or misspelled prop silently leaves every tab in
  // adaptive mode while the setting reads as on.
  it("applies .uniform to each tab wrapper only when uniformTabWidth is set", async () => {
    const reorder = vi.fn();
    const tabs = [makeTab("a"), makeTab("b")];
    // Scope to this render's container: earlier tests in this file leave their
    // trees mounted, so a document-wide query picks up their wrappers too.
    const { rerender, container } = render(DocumentTabs, {
      props: { ...baseProps(tabs, reorder), uniformTabWidth: true },
    });
    await tick();

    const wrappers = () => Array.from(container.querySelectorAll(".tab-flip"));
    expect(wrappers()).toHaveLength(2);
    expect(wrappers().every((w) => w.classList.contains("uniform"))).toBe(true);

    await rerender({ ...baseProps(tabs, reorder), uniformTabWidth: false });
    await tick();
    expect(wrappers().some((w) => w.classList.contains("uniform"))).toBe(false);
  });

  it("defaults to adaptive when the prop is omitted (svelte-harness mounts it bare)", async () => {
    const reorder = vi.fn();
    const { container } = render(DocumentTabs, { props: baseProps([makeTab("a")], reorder) });
    await tick();
    const wrapper = container.querySelector(".tab-flip");
    expect(wrapper).not.toBeNull();
    expect(wrapper?.classList.contains("uniform")).toBe(false);
  });
});
