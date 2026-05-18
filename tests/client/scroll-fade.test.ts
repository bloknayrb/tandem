// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollFade } from "../../src/client/actions/scrollFade.svelte.js";

interface ROCallback {
  (entries: ResizeObserverEntry[], observer: ResizeObserver): void;
}

// Minimal ResizeObserver stub: capture the callback so tests can trigger it
// manually, and track observe/disconnect calls.
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

function makeNode(opts: {
  scrollTop?: number;
  clientHeight?: number;
  scrollHeight?: number;
  attached?: boolean;
}): HTMLElement {
  const node = document.createElement("div");
  // Default to attached so isConnected = true unless caller opts out.
  if (opts.attached !== false) {
    document.body.appendChild(node);
  }
  Object.defineProperty(node, "scrollTop", {
    value: opts.scrollTop ?? 0,
    configurable: true,
  });
  Object.defineProperty(node, "clientHeight", {
    value: opts.clientHeight ?? 100,
    configurable: true,
  });
  Object.defineProperty(node, "scrollHeight", {
    value: opts.scrollHeight ?? 100,
    configurable: true,
  });
  return node;
}

describe("scrollFade action", () => {
  let originalRO: typeof ResizeObserver | undefined;

  beforeEach(() => {
    MockResizeObserver.instances = [];
    originalRO = globalThis.ResizeObserver;
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });

  afterEach(() => {
    if (originalRO) {
      vi.stubGlobal("ResizeObserver", originalRO);
    }
    document.body.replaceChildren();
  });

  it("sets data-overflow-bottom=true when content overflows below the viewport", () => {
    const node = makeNode({ scrollTop: 0, clientHeight: 100, scrollHeight: 500 });
    const action = scrollFade(node);
    expect(node.getAttribute("data-overflow-bottom")).toBe("true");
    expect(node.getAttribute("data-overflow-top")).toBeNull();
    action.destroy();
  });

  it("sets both top and bottom when scrolled past the start", () => {
    const node = makeNode({ scrollTop: 50, clientHeight: 100, scrollHeight: 500 });
    scrollFade(node);
    expect(node.getAttribute("data-overflow-top")).toBe("true");
    expect(node.getAttribute("data-overflow-bottom")).toBe("true");
  });

  it("sets neither when content fits inside the viewport", () => {
    const node = makeNode({ scrollTop: 0, clientHeight: 100, scrollHeight: 100 });
    scrollFade(node);
    expect(node.getAttribute("data-overflow-top")).toBeNull();
    expect(node.getAttribute("data-overflow-bottom")).toBeNull();
  });

  it("does not throw and skips writes when node is detached at update time", () => {
    const node = makeNode({ scrollTop: 0, clientHeight: 100, scrollHeight: 500, attached: false });
    const action = scrollFade(node);
    // Initial update ran with the node detached → isConnected=false short-circuits,
    // so no attrs were written.
    expect(node.getAttribute("data-overflow-bottom")).toBeNull();
    // Re-trigger via the captured RO callback to prove the guard holds across
    // post-mount fires.
    expect(() => MockResizeObserver.instances[0]?.trigger()).not.toThrow();
    expect(node.getAttribute("data-overflow-bottom")).toBeNull();
    action.destroy();
  });

  it("destroy() removes the scroll listener and disconnects the observer", () => {
    const node = makeNode({ scrollTop: 0, clientHeight: 100, scrollHeight: 500 });
    const removeSpy = vi.spyOn(node, "removeEventListener");
    const action = scrollFade(node);
    const observer = MockResizeObserver.instances[0];
    expect(observer).toBeDefined();
    expect(observer?.observed).toContain(node);
    action.destroy();
    expect(removeSpy).toHaveBeenCalledWith("scroll", expect.any(Function));
    expect(observer?.disconnected).toBe(true);
  });

  it("recovers gracefully when ResizeObserver construction throws", () => {
    // Replace the global with one that throws on construction.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor() {
          throw new Error("ResizeObserver unsupported");
        }
      },
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const node = makeNode({ scrollTop: 0, clientHeight: 100, scrollHeight: 500 });

    // Action should still return a usable destroy() even after the RO throw,
    // so the scroll listener doesn't leak.
    const action = scrollFade(node);
    expect(warnSpy).toHaveBeenCalledWith(
      "[tandem:scrollFade] ResizeObserver init failed",
      expect.any(Error),
    );
    expect(node.getAttribute("data-overflow-bottom")).toBe("true"); // initial update still ran

    const removeSpy = vi.spyOn(node, "removeEventListener");
    action.destroy();
    expect(removeSpy).toHaveBeenCalledWith("scroll", expect.any(Function));

    warnSpy.mockRestore();
  });
});
