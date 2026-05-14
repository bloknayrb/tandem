// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it, vi } from "vitest";
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

// happy-dom's DragEvent constructor ignores the `dataTransfer` init dict (same
// quirk as Chromium per MDN). Build a generic Event and override the property.
function makeDragEvent(type: string, dt: DataTransfer, clientX = 0, clientY = 0): DragEvent {
  const evt = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(evt, "dataTransfer", { value: dt, configurable: true });
  Object.defineProperty(evt, "clientX", { value: clientX, configurable: true });
  Object.defineProperty(evt, "clientY", { value: clientY, configurable: true });
  return evt;
}

function stubDt(getDataReturn = ""): DataTransfer {
  return {
    setData: vi.fn(),
    getData: vi.fn(() => getDataReturn),
    effectAllowed: "move",
    dropEffect: "move",
  } as unknown as DataTransfer;
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

describe("DocumentTabs drag/drop", () => {
  it("case A: handleDrop uses closure-captured draggedId when dataTransfer.getData returns ''", async () => {
    const reorder = vi.fn();
    const tabs = [makeTab("a"), makeTab("b")];
    const { container } = render(DocumentTabs, { props: baseProps(tabs, reorder) });
    await tick();

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    const tabB = container.querySelector('[data-testid="tab-b"]') as HTMLElement;
    expect(tabA).toBeTruthy();
    expect(tabB).toBeTruthy();

    // Tauri WebView2 case: dataTransfer.getData("text/plain") returns "".
    // The production code must rely on closure-captured draggedId from dragstart.
    const dt = stubDt("");

    tabA.dispatchEvent(makeDragEvent("dragstart", dt));
    await tick();
    tabB.dispatchEvent(makeDragEvent("dragover", dt, 0, 0));
    tabB.dispatchEvent(makeDragEvent("drop", dt, 0, 0));
    await tick();

    expect(reorder).toHaveBeenCalledTimes(1);
    expect(reorder).toHaveBeenCalledWith("a", "b", expect.stringMatching(/^(left|right)$/));
  });

  it("case B: draggedId survives a tabs prop re-render WITHOUT id removal (regression guard for #625)", async () => {
    const reorder = vi.fn();
    const tabsInit = [makeTab("a"), makeTab("b")];
    const { container, rerender } = render(DocumentTabs, {
      props: baseProps(tabsInit, reorder),
    });
    await tick();

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    expect(tabA).toBeTruthy();

    const dt = stubDt("");
    tabA.dispatchEvent(makeDragEvent("dragstart", dt));
    await tick();

    // Mid-drag: tabs prop re-derives with the same a/b plus a new c. This is
    // the shape of a Yjs awareness ping causing orderedTabs to recompute. With
    // the deleted broad `$effect(() => { void tabs.length; clearDragState(); })`
    // re-added, this rerender would null draggedId and the drop below would
    // fall through to dt.getData("") and silently no-op.
    const tabsExpanded = [tabsInit[0], tabsInit[1], makeTab("c")];
    await rerender(baseProps(tabsExpanded, reorder));
    await tick();

    const tabB = container.querySelector('[data-testid="tab-b"]') as HTMLElement;
    tabB.dispatchEvent(makeDragEvent("dragover", dt, 0, 0));
    tabB.dispatchEvent(makeDragEvent("drop", dt, 0, 0));
    await tick();

    expect(reorder).toHaveBeenCalledTimes(1);
    expect(reorder).toHaveBeenCalledWith("a", "b", expect.stringMatching(/^(left|right)$/));
  });

  it("case D: handleDragOver does NOT preventDefault when no drag is in flight (foreign-drag gate)", async () => {
    const reorder = vi.fn();
    const tabs = [makeTab("a"), makeTab("b")];
    const { container } = render(DocumentTabs, { props: baseProps(tabs, reorder) });
    await tick();

    const tabB = container.querySelector('[data-testid="tab-b"]') as HTMLElement;
    expect(tabB).toBeTruthy();

    // No prior dragstart — draggedId is null. A foreign drag (e.g. a file from
    // Explorer, now reachable in the WebView because tauri dragDropEnabled is
    // false) must fall through to OS no-drop instead of being preventDefault'd.
    const dt = stubDt("");
    const evt = makeDragEvent("dragover", dt, 0, 0);
    const pdSpy = vi.spyOn(evt, "preventDefault");
    tabB.dispatchEvent(evt);
    await tick();

    expect(pdSpy).not.toHaveBeenCalled();
  });

  it("case E: handleDrop reports side:right for right half, side:left for left half", async () => {
    const reorder = vi.fn();
    const tabs = [makeTab("a"), makeTab("b")];
    const { container } = render(DocumentTabs, { props: baseProps(tabs, reorder) });
    await tick();

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    const tabB = container.querySelector('[data-testid="tab-b"]') as HTMLElement;
    expect(tabA).toBeTruthy();
    expect(tabB).toBeTruthy();

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

    const dt = stubDt("");
    tabA.dispatchEvent(makeDragEvent("dragstart", dt));
    await tick();
    tabB.dispatchEvent(makeDragEvent("drop", dt, 80, 10));
    await tick();

    expect(reorder).toHaveBeenCalledTimes(1);
    expect(reorder).toHaveBeenCalledWith("a", "b", "right");

    // Second drop on left half of the same tab.
    reorder.mockClear();
    tabA.dispatchEvent(makeDragEvent("dragstart", dt));
    await tick();
    tabB.dispatchEvent(makeDragEvent("drop", dt, 20, 10));
    await tick();

    expect(reorder).toHaveBeenCalledTimes(1);
    expect(reorder).toHaveBeenCalledWith("a", "b", "left");
  });

  it("case C: dragged tab removed mid-drag → narrower $effect clears draggedId, drop becomes no-op", async () => {
    const reorder = vi.fn();
    const tabsInit = [makeTab("a"), makeTab("b")];
    const { container, rerender } = render(DocumentTabs, {
      props: baseProps(tabsInit, reorder),
    });
    await tick();

    const tabA = container.querySelector('[data-testid="tab-a"]') as HTMLElement;
    const dt = stubDt("");
    tabA.dispatchEvent(makeDragEvent("dragstart", dt));
    await tick();

    // Mid-drag: tab "a" disappears (server-driven tandem_close, race). The new
    // narrower $effect should detect that draggedId is no longer in tabs and
    // null it. A subsequent drop on b must NOT call reorder with the stale id.
    await rerender({
      tabs: [tabsInit[1]],
      activeTabId: "b",
      onTabSwitch: vi.fn(),
      onTabClose: vi.fn(),
      reorder,
    });
    await tick();

    const tabB = container.querySelector('[data-testid="tab-b"]') as HTMLElement;
    tabB.dispatchEvent(makeDragEvent("drop", dt, 0, 0));
    await tick();

    expect(reorder).not.toHaveBeenCalled();
  });
});
