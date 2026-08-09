import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { systemTheme } from "../../src/client/hooks/useTheme.svelte.js";

// B0 (#1362 rev2): a `vi.doMock` used to override this mock for a single
// test survived `vi.resetModules()` for the REST of the file, so every
// later `.mockReturnValue()` call on the statically-imported spy configured
// a DIFFERENT module instance than the one the freshly re-imported SUT
// actually used -- a reviewer measured this empirically (a red
// "does not invoke in browser mode" test with the isTauriRuntime guard
// still present in the source). A hoisted, identity-stable mock fn closes
// the gap: even if vitest re-invokes this factory across a
// `vi.resetModules()` call, it always returns the SAME `isTauri` function,
// so configuring it anywhere in this file reliably reaches the SUT.
// `vi.doUnmock` is not an alternative -- it restores the real, unmocked
// module, silently breaking every Tauri-path test instead.
const { isTauri } = vi.hoisted(() => ({ isTauri: vi.fn(() => false) }));
vi.mock("../../src/client/cowork/cowork-helpers.js", () => ({ isTauriRuntime: isTauri }));

// Captures the `onThemeChanged` callback so tests can drive OS read-backs
// directly. The previous mock discarded the callback entirely (returned an
// unsubscribe promise and nothing else), which made the read-back gating in
// `acceptReadback` (staleness + overrideActive suppression) untestable.
const { themeChangedCapture } = vi.hoisted(() => ({
  themeChangedCapture: { current: null as null | ((event: { payload: string }) => void) },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    onThemeChanged: vi.fn((cb: (event: { payload: string }) => void) => {
      themeChangedCapture.current = cb;
      return Promise.resolve(() => {});
    }),
  })),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "set_native_theme") {
      return Promise.resolve({ overrideActive: false, osTheme: null });
    }
    return Promise.resolve("light");
  }),
}));

/**
 * Filters `invoke.mock.calls` down to a single command name. A stray 3s
 * poll tick landing mid-test must not flake a `toHaveBeenCalledTimes`
 * assertion -- prefer this everywhere over a raw call count.
 */
function callsFor(invoke: { mock: { calls: unknown[][] } }, cmd: string): unknown[][] {
  return invoke.mock.calls.filter(([c]) => c === cmd);
}

/** Drain the microtask queue so a dynamic-import + invoke chain settles. */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("useTauriTheme", () => {
  beforeEach(() => {
    isTauri.mockReturnValue(false);
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    isTauri.mockReturnValue(false);
  });

  it("tauriTheme.current is null when isTauriRuntime() returns false", async () => {
    isTauri.mockReturnValue(false);
    const { tauriTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
    expect(tauriTheme.current).toBeNull();
  });

  it("_resetForTests() resets tauriTheme.current to null", async () => {
    isTauri.mockReturnValue(false);
    const { tauriTheme, _resetForTests } = await import(
      "../../src/client/hooks/useTauriTheme.svelte.js"
    );
    // Manually set a value to verify reset clears it
    (tauriTheme as any).current = "dark";
    expect(tauriTheme.current).toBe("dark");
    _resetForTests();
    expect(tauriTheme.current).toBeNull();
  });

  it("initTauriTheme() is a no-op when isTauriRuntime() returns false", async () => {
    isTauri.mockReturnValue(false);
    const { invoke } = await import("@tauri-apps/api/core");
    const { initTauriTheme, _resetForTests } = await import(
      "../../src/client/hooks/useTauriTheme.svelte.js"
    );
    _resetForTests();
    vi.mocked(invoke).mockClear();
    initTauriTheme();
    // invoke must not have been called — no Tauri IPC in browser mode
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it("tauriTheme.current initializes from __TANDEM_INITIAL_THEME__ when isTauriRuntime() returns true", async () => {
    // vi.resetModules() clears the module cache so the re-import below
    // re-evaluates the TauriThemeStore singleton constructor with fresh
    // dependencies. Because `isTauri` is a vi.hoisted() identity (see the
    // top of this file), it stays the SAME function object across the
    // reset — no vi.doMock() needed to make this transition visible to the
    // freshly re-imported SUT.
    vi.resetModules();
    isTauri.mockReturnValue(true);

    Object.defineProperty(window, "__TANDEM_INITIAL_THEME__", {
      value: "dark",
      writable: true,
      configurable: true,
    });

    const { tauriTheme: freshStore } = await import(
      "../../src/client/hooks/useTauriTheme.svelte.js"
    );
    expect(freshStore.current).toBe("dark");

    // Restore for subsequent tests
    delete (window as any).__TANDEM_INITIAL_THEME__;
    isTauri.mockReturnValue(false);
    vi.resetModules();
  });

  it("_resetForTests() also clears window.__TANDEM_INITIAL_THEME__ and resets _initialized", async () => {
    isTauri.mockReturnValue(false);
    vi.stubGlobal("window", { __TANDEM_INITIAL_THEME__: "dark" });
    const { _resetForTests } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
    _resetForTests();
    expect((window as any).__TANDEM_INITIAL_THEME__).toBeUndefined();
  });

  it("initTauriTheme() writes through to window.__TANDEM_INITIAL_THEME__ on invoke resolve", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockImplementation(((cmd: string) => {
      if (cmd === "get_app_theme") return Promise.resolve("dark");
      return Promise.resolve({ overrideActive: false, osTheme: null });
    }) as any);

    isTauri.mockReturnValue(true);
    const { initTauriTheme, _resetForTests } = await import(
      "../../src/client/hooks/useTauriTheme.svelte.js"
    );
    _resetForTests();
    vi.stubGlobal("window", {
      __TANDEM_INITIAL_THEME__: "light" as "light" | "dark",
      addEventListener: vi.fn(),
      hasFocus: () => true,
    });

    initTauriTheme();

    // Flush the async chain: import(core) → invoke resolves → setTauriTheme
    await flushAsync();

    expect((window as any).__TANDEM_INITIAL_THEME__).toBe("dark");
    expect(systemTheme()).toBe("dark");

    _resetForTests();
  });

  it("_resetForTests() clears the 3s poll interval so it does not leak across tests", async () => {
    // Pre-existing leak (#1362 rev2, B5): initTauriTheme's setInterval was
    // never captured/cleared by _resetForTests, so every test that called
    // initTauriTheme left a live timer ticking into the next test — exactly
    // what a filtered call-count assertion elsewhere in this file would
    // otherwise trip over.
    vi.useFakeTimers();
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      vi.mocked(invoke).mockClear();
      vi.mocked(invoke).mockImplementation(((cmd: string) => {
        if (cmd === "get_app_theme") return Promise.resolve("light");
        return Promise.resolve({ overrideActive: false, osTheme: null });
      }) as any);
      isTauri.mockReturnValue(true);
      const { initTauriTheme, _resetForTests } = await import(
        "../../src/client/hooks/useTauriTheme.svelte.js"
      );
      _resetForTests();
      vi.stubGlobal("document", { hasFocus: () => true });
      vi.stubGlobal("window", { addEventListener: vi.fn() });

      initTauriTheme();
      await vi.advanceTimersByTimeAsync(0); // let the initial get_app_theme settle
      vi.mocked(invoke).mockClear();

      _resetForTests();
      await vi.advanceTimersByTimeAsync(10_000); // several poll periods, if the timer survived

      expect(callsFor(vi.mocked(invoke), "get_app_theme")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      isTauri.mockReturnValue(false);
    }
  });
});

describe("setNativeTheme (#992 rev2)", () => {
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const core = await import("@tauri-apps/api/core");
    invoke = vi.mocked(core.invoke) as any;
    invoke.mockClear();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "set_native_theme")
        return Promise.resolve({ overrideActive: false, osTheme: null });
      return Promise.resolve("light");
    });
    isTauri.mockReturnValue(true);
    const { _resetForTests } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
    _resetForTests();
    themeChangedCapture.current = null;
  });

  afterEach(() => {
    isTauri.mockReturnValue(false);
  });

  it("does not invoke in browser mode (no Tauri runtime)", async () => {
    isTauri.mockReturnValue(false);
    const { setNativeTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
    invoke.mockClear();

    setNativeTheme("dark");
    await flushAsync();

    expect(callsFor(invoke, "set_native_theme")).toHaveLength(0);
  });

  it("invokes set_native_theme with the raw, unresolved preference", async () => {
    const { setNativeTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
    setNativeTheme("dark");
    await flushAsync();
    expect(callsFor(invoke, "set_native_theme")).toEqual([["set_native_theme", { theme: "dark" }]]);
  });

  it("passes 'system' through unresolved — Rust clears the override on this transition", async () => {
    // The critical case (#992): the transition INTO "system" must still
    // call through — Rust maps "system" to "no override", not "skip".
    const { setNativeTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
    setNativeTheme("system");
    await flushAsync();
    expect(callsFor(invoke, "set_native_theme")).toEqual([
      ["set_native_theme", { theme: "system" }],
    ]);
  });

  it("dedupes identical consecutive preferences", async () => {
    const { setNativeTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
    setNativeTheme("dark");
    await flushAsync();
    setNativeTheme("dark");
    await flushAsync();
    expect(callsFor(invoke, "set_native_theme")).toHaveLength(1);
  });

  it("rolls back the dedupe latch on rejection, so a retry is not silently swallowed", async () => {
    const { setNativeTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
    invoke.mockImplementationOnce(() => Promise.reject(new Error("ipc failed")));

    setNativeTheme("dark");
    await flushAsync();
    expect(callsFor(invoke, "set_native_theme")).toHaveLength(1);

    // Rev1 regression: committing lastPushedPref before the await meant this
    // second call — the SAME pref, retried after a failure — was silently
    // deduped away forever. It must go through again.
    setNativeTheme("dark");
    await flushAsync();
    expect(callsFor(invoke, "set_native_theme")).toHaveLength(2);
  });

  it("discards a stale resolved outcome once superseded by a later push", async () => {
    const { setNativeTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
    let resolveFirst!: (v: { overrideActive: boolean; osTheme: string | null }) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );

    setNativeTheme("dark"); // seq 1, left pending
    invoke.mockImplementationOnce(() =>
      Promise.resolve({ overrideActive: false, osTheme: "light" }),
    );
    setNativeTheme("system"); // seq 2 — different pref, so this issues too
    await flushAsync();

    // Resolve the FIRST (now-stale) push with a contradictory outcome.
    resolveFirst({ overrideActive: true, osTheme: null });
    await flushAsync();

    // seq 2's outcome must win — seq 1's is discarded, not applied.
    expect(systemTheme()).toBe("light");
  });

  it("overrideActive suppresses OS read-backs while forced, and honours them again after release", async () => {
    const { setNativeTheme, initTauriTheme } = await import(
      "../../src/client/hooks/useTauriTheme.svelte.js"
    );
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      __TANDEM_INITIAL_THEME__: undefined,
    });
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_app_theme") return Promise.resolve("light");
      return Promise.resolve({ overrideActive: false, osTheme: null });
    });

    initTauriTheme();
    await flushAsync();
    expect(themeChangedCapture.current).not.toBeNull();
    expect(systemTheme()).toBe("light");

    // Force an override whose outcome doesn't itself carry an osTheme
    // (Windows-shaped: overrideActive stays false there in practice, but
    // this exercises the general "no osTheme on this round trip" case).
    invoke.mockImplementationOnce(() => Promise.resolve({ overrideActive: true, osTheme: null }));
    setNativeTheme("dark");
    await flushAsync();

    // A real-looking OS notification arrives while forced — this is an
    // echo of our own force and must be ignored, not written through.
    themeChangedCapture.current?.({ payload: "dark" });
    expect(systemTheme()).toBe("light"); // unchanged

    // Release: outcome carries the authoritative osTheme in the SAME round
    // trip — no poll dependency, no 3s window.
    invoke.mockImplementationOnce(() =>
      Promise.resolve({ overrideActive: false, osTheme: "dark" }),
    );
    setNativeTheme("system");
    await flushAsync();
    expect(systemTheme()).toBe("dark");

    // Now that the override is released, a genuine OS notification is honoured.
    themeChangedCapture.current?.({ payload: "light" });
    expect(systemTheme()).toBe("light");

    vi.stubGlobal("document", { hasFocus: () => true }); // no-op poll guard cleanup safety
  });

  it("poll read-backs issued before a push are discarded once superseded (staleness gate)", async () => {
    vi.useFakeTimers();
    try {
      const { initTauriTheme, setNativeTheme, _resetForTests } = await import(
        "../../src/client/hooks/useTauriTheme.svelte.js"
      );
      _resetForTests();
      vi.stubGlobal("document", { hasFocus: () => true });
      vi.stubGlobal("window", { addEventListener: vi.fn(), __TANDEM_INITIAL_THEME__: undefined });

      invoke.mockImplementation((cmd: string) => {
        if (cmd === "get_app_theme") return Promise.resolve("light");
        return Promise.resolve({ overrideActive: false, osTheme: null });
      });

      initTauriTheme();
      await vi.advanceTimersByTimeAsync(0); // initial get_app_theme fetch settles
      expect(systemTheme()).toBe("light");

      // Arm the poll's NEXT get_app_theme call to hang until resolved
      // manually, so a push can land in the gap between issue and resolve.
      let resolvePoll!: (v: string) => void;
      invoke.mockImplementationOnce((cmd: string) => {
        if (cmd === "get_app_theme") {
          return new Promise((resolve) => {
            resolvePoll = resolve;
          });
        }
        return Promise.resolve({ overrideActive: false, osTheme: null });
      });

      await vi.advanceTimersByTimeAsync(3000); // fires the poll tick; invoke is now pending

      // A push lands in the gap — must invalidate the pending poll read.
      invoke.mockImplementationOnce(() =>
        Promise.resolve({ overrideActive: false, osTheme: null }),
      );
      setNativeTheme("dark");
      await vi.advanceTimersByTimeAsync(0);

      // The stale poll now resolves with a contradictory value.
      resolvePoll("dark");
      await vi.advanceTimersByTimeAsync(0);

      expect(systemTheme()).toBe("light"); // stale poll discarded, not "dark"

      _resetForTests();
    } finally {
      vi.useRealTimers();
      isTauri.mockReturnValue(false);
    }
  });
});
