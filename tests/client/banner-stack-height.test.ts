// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bannerStackHeight } from "../../src/client/actions/bannerStackHeight.svelte.js";

const PROP = "--tandem-banner-stack-bottom";

interface ROCallback {
  (entries: ResizeObserverEntry[], observer: ResizeObserver): void;
}

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  callback: ROCallback;
  observed: Element[] = [];
  disconnected = false;
  constructor(cb: ROCallback) {
    this.callback = cb;
    MockResizeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  unobserve(): void {}
  trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

/**
 * happy-dom has no layout engine, so `getBoundingClientRect()` returns all
 * zeros. Stubbing it is what keeps these assertions from passing vacuously —
 * without it every measurement is 0, the last-value guard suppresses everything
 * after the first write, and a broken implementation would look identical to a
 * correct one.
 */
const STACK_TOP = 56; // real rendered TitleBar height — see index.html contract

function mountWithHeight(height: number) {
  const node = document.createElement("div");
  document.body.appendChild(node);
  let current = height;
  // Model the real layout: the stack sits directly below the TitleBar, so its
  // bottom is STACK_TOP + height. The action publishes that bottom edge.
  node.getBoundingClientRect = () =>
    ({ height: current, top: STACK_TOP, bottom: STACK_TOP + current }) as DOMRect;
  return {
    node,
    setHeight(h: number) {
      current = h;
    },
  };
}

function publishedValue(): string {
  return document.documentElement.style.getPropertyValue(PROP);
}

function latestObserver(): MockResizeObserver {
  return MockResizeObserver.instances[MockResizeObserver.instances.length - 1];
}

beforeEach(() => {
  MockResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
});

afterEach(() => {
  document.documentElement.style.removeProperty(PROP);
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("bannerStackHeight", () => {
  it("publishes the bottom edge eagerly, before the observer ever fires", () => {
    const { node } = mountWithHeight(40);
    bannerStackHeight(node);
    // Not `latestObserver().trigger()` first — the point is that the very first
    // painted frame already has the right value, since RO's first delivery is
    // asynchronous and would otherwise leave the pill on the banner for a frame.
    expect(publishedValue()).toBe("96px"); // 56 titlebar + 40 stack
  });

  it("always writes a px unit, never a bare number", () => {
    const { node } = mountWithHeight(37);
    bannerStackHeight(node);
    // Load-bearing: a bare `37` is a VALID custom property, so the failure would
    // surface a level down as `max(52px, 93)` — invalid at computed-value
    // time, collapsing the fixed pill to its static position.
    expect(publishedValue()).toBe("93px");
    expect(publishedValue()).toMatch(/^\d+px$/);
  });

  it("rounds fractional edges so sub-pixel DPR noise cannot churn", () => {
    const { node } = mountWithHeight(40.6640625);
    bannerStackHeight(node);
    expect(publishedValue()).toBe("97px"); // round(56 + 40.6640625)
  });

  it("does not rewrite the property when the rounded edge is unchanged", () => {
    const { node, setHeight } = mountWithHeight(40);
    bannerStackHeight(node);

    const setProperty = vi.spyOn(document.documentElement.style, "setProperty");

    // Same value, and a fractional wobble that rounds to the same integer:
    // both must be suppressed by the last-value guard.
    latestObserver().trigger();
    setHeight(40.4);
    latestObserver().trigger();
    expect(setProperty).not.toHaveBeenCalled();

    setHeight(72);
    latestObserver().trigger();
    expect(setProperty).toHaveBeenCalledWith(PROP, "128px");
  });

  it("reports 0 for an empty stack, then tracks its bottom edge", () => {
    const { node, setHeight } = mountWithHeight(0);
    bannerStackHeight(node);
    expect(publishedValue()).toBe("0px");

    setHeight(76);
    latestObserver().trigger();
    expect(publishedValue()).toBe("132px");

    // The resting reset runs through the observer, not destroy() — the wrapper
    // stays mounted and simply becomes empty when the last banner unmounts.
    setHeight(0);
    latestObserver().trigger();
    expect(publishedValue()).toBe("0px");
  });

  it("ignores a callback delivered after the node detaches", () => {
    const { node, setHeight } = mountWithHeight(40);
    bannerStackHeight(node);

    node.remove();
    setHeight(999);
    latestObserver().trigger();

    // A detached read returns 0 and would park the pill at its resting offset.
    expect(publishedValue()).toBe("96px");
  });

  it("removes the property and disconnects on destroy", () => {
    const { node } = mountWithHeight(40);
    const handle = bannerStackHeight(node);
    expect(publishedValue()).toBe("96px");

    handle.destroy();

    expect(latestObserver().disconnected).toBe(true);
    // Removed, not zeroed: it falls back to the `:root` 0px from index.html.
    expect(publishedValue()).toBe("");
  });

  it("still publishes an edge when ResizeObserver is unavailable", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor() {
          throw new Error("no ResizeObserver");
        }
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { node } = mountWithHeight(40);

    // Must not throw on mount, and the eager measurement must survive — which
    // only holds because it runs BEFORE the observer is constructed.
    expect(() => bannerStackHeight(node)).not.toThrow();
    expect(publishedValue()).toBe("96px");
    expect(warn).toHaveBeenCalled();
  });
});
