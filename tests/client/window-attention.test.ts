// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #2168 Unit D: createWindowAttention's focus tracking — the trusted-input
// correction, the `visibleCountsAsActive` widening, and the Tauri branch's
// ordering/leak guarantees. Round 4 (A3): the desktop app's native
// `isVisible() && !isMinimized()` reads, which WebView2's `visibilityState`
// cannot stand in for.

type Subscribe = (...args: unknown[]) => Promise<() => void>;

const tauri = vi.hoisted(() => ({
  enabled: false,
  onFocusChanged: null as null | Subscribe,
  isFocused: null as null | (() => Promise<boolean>),
  onResized: null as null | Subscribe,
  isVisible: null as null | (() => Promise<boolean>),
  isMinimized: null as null | (() => Promise<boolean>),
}));

vi.mock(import("@client/cowork/cowork-helpers"), () => ({
  isTauriRuntime: () => tauri.enabled,
}));
vi.mock(import("@client/cowork/cowork-helpers.js"), () => ({
  isTauriRuntime: () => tauri.enabled,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: (...args: unknown[]) => tauri.onFocusChanged?.(...args),
    isFocused: () => tauri.isFocused?.(),
    onResized: (...args: unknown[]) => tauri.onResized?.(...args),
    isVisible: () => tauri.isVisible?.(),
    isMinimized: () => tauri.isMinimized?.(),
  }),
}));

const { default: Harness } = await import("./fixtures/WindowAttentionHarness.svelte");

async function flush() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await tick();
  }
}

function active(): string {
  return screen.getByTestId("active").textContent ?? "";
}

/** happy-dom marks every dispatched event untrusted; stub the flag per instance. */
function dispatchInput(type: "keydown" | "pointerdown", trusted: boolean) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "isTrusted", { value: trusted });
  document.body.dispatchEvent(event);
}

/**
 * happy-dom reports a window dispatch's `target` as its internal window, not
 * the global `window` proxy the hook compares against, so pin it per instance.
 */
function blurWindow() {
  const event = new Event("blur");
  Object.defineProperty(event, "target", { get: () => window });
  window.dispatchEvent(event);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  tauri.enabled = false;
  tauri.onFocusChanged = null;
  tauri.isFocused = null;
  // Defaults: a shown, unminimised window whose resize subscription succeeds,
  // so the focus-only specs below see exactly the behaviour they always did.
  tauri.onResized = () => Promise.resolve(vi.fn());
  tauri.isVisible = () => Promise.resolve(true);
  tauri.isMinimized = () => Promise.resolve(false);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createWindowAttention — web", () => {
  it("a window blur makes the window inactive", async () => {
    render(Harness);
    expect(active()).toBe("true");
    blurWindow();
    await tick();
    expect(active()).toBe("false");
  });

  it("trusted keydown or pointerdown corrects a stale unfocused state", async () => {
    render(Harness);
    blurWindow();
    await tick();
    dispatchInput("keydown", true);
    await tick();
    expect(active()).toBe("true");

    blurWindow();
    await tick();
    dispatchInput("pointerdown", true);
    await tick();
    expect(active()).toBe("true");
  });

  it("corrects a false hasFocus() seed at load on trusted input", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    render(Harness);
    expect(active()).toBe("false");
    dispatchInput("keydown", true);
    await tick();
    expect(active()).toBe("true");
  });

  it("untrusted (script-dispatched) input does not correct focus", async () => {
    render(Harness);
    blurWindow();
    await tick();
    dispatchInput("keydown", false);
    dispatchInput("pointerdown", false);
    await tick();
    expect(active()).toBe("false");
  });

  it("stops listening for input after unmount", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(Harness);
    unmount();
    for (const type of ["pointerdown", "keydown"]) {
      const added = addSpy.mock.calls.find(([t]) => t === type);
      expect(added?.[2]).toEqual({ capture: true, passive: true });
      const removed = removeSpy.mock.calls.find(([t]) => t === type);
      expect(removed?.[1]).toBe(added?.[1]);
      expect(removed?.[2]).toEqual({ capture: true, passive: true });
    }
  });

  it("with visibleCountsAsActive, a blurred but visible window stays active", async () => {
    render(Harness, { props: { visibleCountsAsActive: true } });
    blurWindow();
    await tick();
    expect(active()).toBe("true");
  });

  it("visibleCountsAsActive is read reactively", async () => {
    const { rerender } = render(Harness, { props: { visibleCountsAsActive: false } });
    blurWindow();
    await tick();
    expect(active()).toBe("false");
    await rerender({ visibleCountsAsActive: true });
    expect(active()).toBe("true");
  });

  it("visibleCountsAsActive never makes a hidden page active", async () => {
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    render(Harness, { props: { visibleCountsAsActive: true } });
    expect(active()).toBe("false");
    vis.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await tick();
    expect(active()).toBe("true");
  });
});

describe("createWindowAttention — Tauri", () => {
  beforeEach(() => {
    tauri.enabled = true;
  });

  it("applies the native isFocused() seed when no event arrived meanwhile", async () => {
    const unlisten = vi.fn();
    tauri.onFocusChanged = () => Promise.resolve(unlisten);
    tauri.isFocused = () => Promise.resolve(false);
    render(Harness);
    await flush();
    expect(active()).toBe("false");
  });

  it("an onFocusChanged event that lands before isFocused resolves wins", async () => {
    const native: { handler: ((e: { payload: boolean }) => void) | null } = { handler: null };
    const seed = deferred<boolean>();
    tauri.onFocusChanged = (cb) => {
      native.handler = cb as (e: { payload: boolean }) => void;
      return Promise.resolve(vi.fn());
    };
    tauri.isFocused = () => seed.promise;
    render(Harness);
    await flush();
    expect(native.handler).not.toBeNull();

    // The user focuses the window while the seed read is in flight; the seed
    // then resolves with the stale pre-event answer.
    native.handler?.({ payload: false });
    await tick();
    expect(active()).toBe("false");
    native.handler?.({ payload: true });
    seed.resolve(false);
    await flush();
    expect(active()).toBe("true");
  });

  it("a DOM event during the seed read also wins over the stale seed", async () => {
    const seed = deferred<boolean>();
    tauri.onFocusChanged = () => Promise.resolve(vi.fn());
    tauri.isFocused = () => seed.promise;
    render(Harness);
    await flush();
    blurWindow();
    seed.resolve(true);
    await flush();
    expect(active()).toBe("false");
  });

  it("a rejected isFocused still unlistens on unmount", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unlistenFocus = vi.fn();
    const unlistenResize = vi.fn();
    tauri.onFocusChanged = () => Promise.resolve(unlistenFocus);
    tauri.onResized = () => Promise.resolve(unlistenResize);
    tauri.isFocused = () => Promise.reject(new Error("ipc down"));
    const { unmount } = render(Harness);
    await flush();
    expect(warn).toHaveBeenCalled();
    expect(unlistenFocus).not.toHaveBeenCalled();
    expect(unlistenResize).not.toHaveBeenCalled();
    unmount();
    expect(unlistenFocus).toHaveBeenCalledTimes(1);
    expect(unlistenResize).toHaveBeenCalledTimes(1);
  });

  it("unmount before onFocusChanged resolves still calls unlisten", async () => {
    const subscribed = deferred<() => void>();
    const isFocused = vi.fn(() => Promise.resolve(true));
    const onResized = vi.fn(() => Promise.resolve(vi.fn()));
    const isVisible = vi.fn(() => Promise.resolve(true));
    tauri.onFocusChanged = () => subscribed.promise;
    tauri.isFocused = isFocused;
    tauri.onResized = onResized;
    tauri.isVisible = isVisible;
    const { unmount } = render(Harness);
    await flush();
    unmount();
    const unlisten = vi.fn();
    subscribed.resolve(unlisten);
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(isFocused).not.toHaveBeenCalled();
    expect(onResized).not.toHaveBeenCalled();
    expect(isVisible).not.toHaveBeenCalled();
  });

  it("unmount before onResized resolves unlistens each listener exactly once", async () => {
    const unlistenFocus = vi.fn();
    const resizeSubscribed = deferred<() => void>();
    const isVisible = vi.fn(() => Promise.resolve(true));
    tauri.onFocusChanged = () => Promise.resolve(unlistenFocus);
    tauri.onResized = () => resizeSubscribed.promise;
    tauri.isFocused = () => Promise.resolve(true);
    tauri.isVisible = isVisible;
    const { unmount } = render(Harness);
    await flush();
    unmount();
    expect(unlistenFocus).toHaveBeenCalledTimes(1);
    const unlistenResize = vi.fn();
    resizeSubscribed.resolve(unlistenResize);
    await flush();
    expect(unlistenFocus).toHaveBeenCalledTimes(1);
    expect(unlistenResize).toHaveBeenCalledTimes(1);
    // The seed read never starts once the hook is gone.
    expect(isVisible).not.toHaveBeenCalled();
  });

  it("unmount during the isFocused read unlistens exactly once and ignores the seed", async () => {
    const seed = deferred<boolean>();
    const unlistenFocus = vi.fn();
    const unlistenResize = vi.fn();
    tauri.onFocusChanged = () => Promise.resolve(unlistenFocus);
    tauri.onResized = () => Promise.resolve(unlistenResize);
    tauri.isFocused = () => seed.promise;
    const { unmount } = render(Harness);
    await flush();
    unmount();
    seed.resolve(false);
    await flush();
    expect(unlistenFocus).toHaveBeenCalledTimes(1);
    expect(unlistenResize).toHaveBeenCalledTimes(1);
  });
});

describe("createWindowAttention — Tauri native visibility (A3)", () => {
  // Every spec here turns the "visible counts as active" toggle ON, so focus
  // is out of the picture and the result is visibility alone — the case where
  // WebView2's always-"visible" page made a minimised window read as active.
  const toggleOn = { props: { visibleCountsAsActive: true } };

  type FocusHandler = (e: { payload: boolean }) => void;
  const handlers: { focus: FocusHandler | null; resize: (() => void) | null } = {
    focus: null,
    resize: null,
  };

  beforeEach(() => {
    tauri.enabled = true;
    handlers.focus = null;
    handlers.resize = null;
    tauri.onFocusChanged = (cb) => {
      handlers.focus = cb as FocusHandler;
      return Promise.resolve(vi.fn());
    };
    tauri.onResized = (cb) => {
      handlers.resize = cb as () => void;
      return Promise.resolve(vi.fn());
    };
    tauri.isFocused = () => Promise.resolve(false);
  });

  it("a window seeded hidden is inactive even with the toggle on", async () => {
    tauri.isVisible = () => Promise.resolve(false);
    render(Harness, toggleOn);
    await flush();
    expect(active()).toBe("false");
  });

  it("a window seeded minimised is inactive even with the toggle on", async () => {
    tauri.isMinimized = () => Promise.resolve(true);
    render(Harness, toggleOn);
    await flush();
    expect(active()).toBe("false");
  });

  it("a blur followed by a minimised read makes the window inactive", async () => {
    render(Harness, toggleOn);
    await flush();
    expect(active()).toBe("true");
    tauri.isMinimized = () => Promise.resolve(true);
    handlers.focus?.({ payload: false });
    await flush();
    expect(active()).toBe("false");
  });

  it("a resize while unfocused and minimised makes the window inactive", async () => {
    render(Harness, toggleOn);
    await flush();
    expect(active()).toBe("true");
    tauri.isMinimized = () => Promise.resolve(true);
    handlers.resize?.();
    await flush();
    expect(active()).toBe("false");
  });

  it("a visibilitychange re-reads the native window", async () => {
    render(Harness, toggleOn);
    await flush();
    tauri.isVisible = () => Promise.resolve(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(active()).toBe("false");
  });

  it("focus gained wins at once, and a read already in flight cannot undo it", async () => {
    tauri.isVisible = () => Promise.resolve(false);
    render(Harness, toggleOn);
    await flush();
    expect(active()).toBe("false");

    // A resize starts a read that samples the window while still hidden…
    const stale = deferred<boolean>();
    const trailing = deferred<boolean>();
    const reads = [stale, trailing];
    tauri.isVisible = () => (reads.shift() ?? deferred<boolean>()).promise;
    handlers.resize?.();
    await flush();

    // …then the user restores it: focus true is authoritative immediately,
    // before any read has answered.
    handlers.focus?.({ payload: true });
    await tick();
    expect(active()).toBe("true");

    // The stale "hidden" answer lands late and must be discarded.
    stale.resolve(false);
    await flush();
    expect(active()).toBe("true");

    // The trailing read the focus event requested then confirms it.
    trailing.resolve(true);
    await flush();
    expect(active()).toBe("true");
  });

  it("coalesces a burst of triggers to one read in flight plus one trailing", async () => {
    render(Harness, toggleOn);
    await flush();
    const first = deferred<boolean>();
    const isVisible = vi.fn(() => first.promise);
    tauri.isVisible = isVisible;
    for (let i = 0; i < 5; i++) handlers.resize?.();
    await flush();
    expect(isVisible).toHaveBeenCalledTimes(1);
    isVisible.mockImplementation(() => Promise.resolve(true));
    first.resolve(true);
    await flush();
    expect(isVisible).toHaveBeenCalledTimes(2);
  });

  it("polls only while hidden, and the poll recovers a window shown without focus", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const isVisible = vi.fn(() => Promise.resolve(false));
    tauri.isVisible = isVisible;
    // Focused, so once shown nothing else keeps the poll running.
    tauri.isFocused = () => Promise.resolve(true);
    render(Harness, toggleOn);
    await flush();
    expect(active()).toBe("false");

    // Shown without focus (a refused set_focus): no focus, resize or
    // visibility event fires, so only the poll can notice.
    isVisible.mockImplementation(() => Promise.resolve(true));
    vi.advanceTimersByTime(2_000);
    await flush();
    expect(active()).toBe("true");

    // Once shown, the poll stops.
    const calls = isVisible.mock.calls.length;
    vi.advanceTimersByTime(20_000);
    await flush();
    expect(isVisible.mock.calls.length).toBe(calls);
  });

  it("with the toggle on, polls an unfocused shown window so a silent hide to tray is noticed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const isVisible = vi.fn(() => Promise.resolve(true));
    tauri.isVisible = isVisible;
    tauri.isFocused = () => Promise.resolve(false);
    render(Harness, toggleOn);
    await flush();
    expect(active()).toBe("true");

    // Closed to the tray from the taskbar while unfocused: no focus, resize or
    // visibility event fires, so only the poll can notice.
    isVisible.mockImplementation(() => Promise.resolve(false));
    vi.advanceTimersByTime(2_000);
    await flush();
    expect(active()).toBe("false");
  });

  it("with the toggle off, an unfocused shown window is not polled", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const isVisible = vi.fn(() => Promise.resolve(true));
    tauri.isVisible = isVisible;
    tauri.isFocused = () => Promise.resolve(false);
    render(Harness, { props: { visibleCountsAsActive: false } });
    await flush();
    const calls = isVisible.mock.calls.length;
    vi.advanceTimersByTime(20_000);
    await flush();
    expect(isVisible.mock.calls.length).toBe(calls);
  });

  it("the poll stops on unmount", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const isVisible = vi.fn(() => Promise.resolve(false));
    tauri.isVisible = isVisible;
    const { unmount } = render(Harness, toggleOn);
    await flush();
    unmount();
    const calls = isVisible.mock.calls.length;
    vi.advanceTimersByTime(20_000);
    await flush();
    expect(isVisible.mock.calls.length).toBe(calls);
  });

  it("trusted input recovers a window read as hidden; untrusted input does not", async () => {
    tauri.isVisible = () => Promise.resolve(false);
    render(Harness, toggleOn);
    await flush();
    expect(active()).toBe("false");
    dispatchInput("pointerdown", false);
    await tick();
    expect(active()).toBe("false");
    dispatchInput("pointerdown", true);
    await tick();
    expect(active()).toBe("true");
  });

  it("a rejected read keeps the last value and stays active", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    tauri.isVisible = () => Promise.reject(new Error("ipc down"));
    render(Harness, toggleOn);
    await flush();
    expect(warn).toHaveBeenCalled();
    expect(active()).toBe("true");
  });

  it("a getter that throws synchronously does not wedge later reads", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    tauri.isVisible = () => {
      throw new Error("sync ipc failure");
    };
    render(Harness, toggleOn);
    await flush();
    expect(active()).toBe("true");
    tauri.isVisible = () => Promise.resolve(false);
    handlers.resize?.();
    await flush();
    expect(active()).toBe("false");
  });
});
