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
