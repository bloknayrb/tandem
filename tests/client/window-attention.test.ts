// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #2168 Unit D: createWindowAttention's focus tracking — the trusted-input
// correction, the `visibleCountsAsActive` widening, and the Tauri branch's
// ordering/leak guarantees.

const tauri = vi.hoisted(() => ({
  enabled: false,
  onFocusChanged: null as null | ((...args: unknown[]) => Promise<() => void>),
  isFocused: null as null | (() => Promise<boolean>),
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
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
    const unlisten = vi.fn();
    tauri.onFocusChanged = () => Promise.resolve(unlisten);
    tauri.isFocused = () => Promise.reject(new Error("ipc down"));
    const { unmount } = render(Harness);
    await flush();
    expect(warn).toHaveBeenCalled();
    expect(unlisten).not.toHaveBeenCalled();
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("unmount before onFocusChanged resolves still calls unlisten", async () => {
    const subscribed = deferred<() => void>();
    const isFocused = vi.fn(() => Promise.resolve(true));
    tauri.onFocusChanged = () => subscribed.promise;
    tauri.isFocused = isFocused;
    const { unmount } = render(Harness);
    await flush();
    unmount();
    const unlisten = vi.fn();
    subscribed.resolve(unlisten);
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(isFocused).not.toHaveBeenCalled();
  });

  it("unmount during the isFocused read unlistens exactly once and ignores the seed", async () => {
    const seed = deferred<boolean>();
    const unlisten = vi.fn();
    tauri.onFocusChanged = () => Promise.resolve(unlisten);
    tauri.isFocused = () => seed.promise;
    const { unmount } = render(Harness);
    await flush();
    unmount();
    seed.resolve(false);
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
