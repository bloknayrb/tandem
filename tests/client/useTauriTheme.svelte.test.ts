import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { systemTheme } from "../../src/client/hooks/useTheme.svelte.js";

// (#992) a `vi.doMock` used to override this mock for a single
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

// The unlisten fn and the subscribe counter are hoisted and identity-stable for the same
// reason `isTauri` above is: the mock factory is re-invoked across `vi.resetModules()`, so
// a spy created inside it would be a different object than the one a test asserts on.
// Before #1413 this returned an anonymous `() => {}`, which made "was the subscription
// ever released?" structurally unobservable — which is why the leak went unnoticed.
const { unlistenSpy, subscribeCount } = vi.hoisted(() => ({
  unlistenSpy: vi.fn(),
  subscribeCount: { current: 0 },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    onThemeChanged: vi.fn((cb: (event: { payload: string }) => void) => {
      themeChangedCapture.current = cb;
      subscribeCount.current += 1;
      return Promise.resolve(unlistenSpy);
    }),
  })),
}));

// `invoke` is exposed through a GETTER rather than as a plain property (#1413).
// `getInvoke()` in the SUT resolves the dynamic import and THEN reads `m.invoke`, so a
// throwing getter is the only seam a test has for "the core chunk failed to load" —
// the exact condition the poll's import re-acquisition ladder exists for, and the only
// way `invokeRef` stays null. Re-arming the factory per test with `vi.doMock` is not an
// option here, for the reason this file's header gives at length. Both members are
// hoisted and identity-stable like every other mock above, so a test can flip the flag
// and every module instance sees it.
//
// `coreImportBroken` MUST be false again once a test ends, and the FILE-LEVEL
// `afterEach` directly below this mock is the guarantee — not the `finally` blocks in
// the individual tests, which are a redundant belt and are labelled as one. A test
// that throws before its `finally` still gets an `afterEach`; a test that sets the flag
// in a describe with no reset of its own gets one too. That second case is the real
// hole: the outer `beforeEach` of `setNativeTheme (#992)` binds its spy by reading
// `core.invoke`, so a flag left true anywhere in this file makes every remaining test
// in it throw at setup, with a diagnosis pointing nowhere near the culprit.
// `coreImportGate` is the OTHER half of that seam, and a different failure shape
// (#1413). The throwing getter can only express "the chunk failed"; it cannot express
// "the chunk is still loading", because the module namespace is already resolved by the
// time the getter runs. A gate the FACTORY awaits is the only way to hold
// `import("@tauri-apps/api/core")` pending, which is what the poll's import budget has
// to survive. Null by default so the factory stays synchronous for every other test;
// arming it requires `vi.resetModules()`, since a factory result is memoized.
const { invokeMock, coreImportBroken, coreImportGate } = vi.hoisted(() => ({
  invokeMock: vi.fn((cmd: string) => {
    if (cmd === "set_native_theme") {
      return Promise.resolve({ overrideActive: false, osTheme: null });
    }
    return Promise.resolve("light");
  }),
  coreImportBroken: { current: false },
  coreImportGate: { current: null as null | Promise<void> },
}));

vi.mock("@tauri-apps/api/core", async () => {
  if (coreImportGate.current) await coreImportGate.current;
  return {
    get invoke() {
      if (coreImportBroken.current) throw new Error("Failed to fetch dynamically imported module");
      return invokeMock;
    },
  };
});

// Several cases deliberately reject the Tauri IPC call. Their delayed retry callbacks can
// log after an individual test's cleanup, so this has to last for the isolated test file:
// sending those expected logs through Vitest's worker RPC during a parallel coverage teardown
// can turn an otherwise-passing suite into an EnvironmentTeardownError. The state assertions
// below are the contract here.
vi.spyOn(console, "warn").mockImplementation(() => {});

afterEach(() => {
  coreImportBroken.current = false;
  coreImportGate.current = null;
});

/**
 * Mirrors the SUT's `MAX_PUSH_RETRIES`, which is not exported. The ladder is
 * 500 + 1000 + 2000 ms, so advancing 4000 ms clears all three rungs.
 */
const MAX_PUSH_RETRIES = 3;

/**
 * Filters `invoke.mock.calls` down to a single command name. A stray poll
 * tick landing mid-test must not flake a `toHaveBeenCalledTimes`
 * assertion -- prefer this everywhere over a raw call count.
 */
function callsFor(invoke: { mock: { calls: unknown[][] } }, cmd: string): unknown[][] {
  return invoke.mock.calls.filter(([c]) => c === cmd);
}

/**
 * The notification callback `initTauriTheme` now requires (#1368). File-level and
 * identity-stable, like the mocks above, so every call site can pass the same one and
 * the #1368 describe at the foot of this file can assert on it after clearing it.
 * Every `initTauriTheme(` call in this file MUST pass a callback: `tests/` is outside
 * every tsconfig, so a bare `initTauriTheme(pushSpy)` type-checks nowhere and would leave the
 * module's `_notify` undefined until something tried to toast.
 */
const pushSpy = vi.fn();

/**
 * The `matchMedia` member every `vi.stubGlobal("window", …)` below SHOULD carry — not
 * one any assertion needs. `initTauriTheme` queries `(forced-colors: active)` (#1364)
 * as unconditionally as it calls `window.addEventListener("pagehide", …)`; without the
 * member the query throws into the source's `try`/`catch`, so those ten tests would
 * exercise the DEGRADED (matchMedia-unavailable) branch while asserting things about the
 * push pipeline. Carrying it puts them on the production path instead.
 *
 * Measured, so nobody treats ten edits to shared setup as mandatory: with all ten
 * `matchMedia: inertMatchMedia` lines stripped and the #1364 source fix in place, the
 * file still passes 37/37. This is a fidelity improvement, not a requirement. (The source
 * also warns on that branch; vitest surfaced no console output for this file in either
 * run, so treat the warn as unobserved here rather than as measured.)
 *
 * Inert on purpose: these stubs belong to tests about the push pipeline, not about the
 * forced-colors listener, which has its own describe — with its own live fake — at the
 * bottom of this file. Note the inertness is exactly what makes note 1 down there true:
 * this function ignores its query argument, so it can stand in for `matchMedia` without
 * ever standing in for the fake.
 *
 * The source could have feature-detected `matchMedia` instead, and an earlier draft of
 * #1364 did. That was rejected: the guard would have been shaped by these stubs rather
 * than by any real host, and it would silently disable the whole fix on a host that
 * genuinely lacks `matchMedia`. Extending the stubs is the repo's precedent.
 */
function inertMatchMedia(): {
  matches: boolean;
  addEventListener: () => void;
  removeEventListener: () => void;
} {
  return { matches: false, addEventListener: () => {}, removeEventListener: () => {} };
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

  it("initTauriTheme(pushSpy) is a no-op when isTauriRuntime() returns false", async () => {
    isTauri.mockReturnValue(false);
    const { invoke } = await import("@tauri-apps/api/core");
    const { initTauriTheme, _resetForTests } = await import(
      "../../src/client/hooks/useTauriTheme.svelte.js"
    );
    _resetForTests();
    vi.mocked(invoke).mockClear();
    initTauriTheme(pushSpy);
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

  it("_resetForTests() clears window.__TANDEM_INITIAL_THEME__", async () => {
    isTauri.mockReturnValue(false);
    vi.stubGlobal("window", { __TANDEM_INITIAL_THEME__: "dark" });
    const { _resetForTests } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
    _resetForTests();
    expect((window as any).__TANDEM_INITIAL_THEME__).toBeUndefined();
  });

  it("_resetForTests() resets _initialized so initTauriTheme can run again", async () => {
    // The name of the test above used to claim this too, while asserting only
    // the window seed. Without the `_initialized = false` reset, the bridge is
    // un-reinitializable after the first test that touches it, and every later
    // test in a file silently shares one initialization.
    isTauri.mockReturnValue(true);
    const core = await import("@tauri-apps/api/core");
    const invoke = vi.mocked(core.invoke) as unknown as { mock: { calls: unknown[][] } };
    vi.mocked(core.invoke).mockClear();
    const { initTauriTheme, _resetForTests } = await import(
      "../../src/client/hooks/useTauriTheme.svelte.js"
    );
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      matchMedia: inertMatchMedia,
      __TANDEM_INITIAL_THEME__: undefined,
    });

    initTauriTheme(pushSpy);
    await flushAsync();
    expect(callsFor(invoke, "get_app_theme")).toHaveLength(1);

    initTauriTheme(pushSpy); // guarded by _initialized — must not re-run
    await flushAsync();
    expect(callsFor(invoke, "get_app_theme")).toHaveLength(1);

    _resetForTests();
    initTauriTheme(pushSpy);
    await flushAsync();
    expect(callsFor(invoke, "get_app_theme")).toHaveLength(2);
  });

  it("initTauriTheme(pushSpy) writes through to window.__TANDEM_INITIAL_THEME__ on invoke resolve", async () => {
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
      removeEventListener: vi.fn(),
      matchMedia: inertMatchMedia,
      hasFocus: () => true,
    });

    initTauriTheme(pushSpy);

    // Flush the async chain: import(core) → invoke resolves → setTauriTheme
    await flushAsync();

    expect((window as any).__TANDEM_INITIAL_THEME__).toBe("dark");
    expect(systemTheme()).toBe("dark");

    _resetForTests();
  });

  it("_resetForTests() clears the 3s poll interval so it does not leak across tests", async () => {
    // Pre-existing leak (#992): initTauriTheme's setInterval was
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
      vi.stubGlobal("window", {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        matchMedia: inertMatchMedia,
      });

      initTauriTheme(pushSpy);
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

describe("setNativeTheme (#992)", () => {
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Bound to the hoisted mock DIRECTLY rather than through the module's getter
    // (#1413). They are the same function, but the getter is a seam built for the SUT:
    // it throws while `coreImportBroken` is true, so reading it here would make the
    // harness itself a casualty of a flag a test forgot to clear. Going straight to
    // `invokeMock` keeps the broken-import seam pointed only at the code under test.
    invoke = invokeMock as unknown as ReturnType<typeof vi.fn>;
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

  it("clears the dedupe latch on rejection, so a retry is not silently swallowed", async () => {
    const { setNativeTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
    invoke.mockImplementationOnce(() => Promise.reject(new Error("ipc failed")));

    setNativeTheme("dark");
    await flushAsync();
    expect(callsFor(invoke, "set_native_theme")).toHaveLength(1);

    // Committing lastPush before the await, with no clear on failure,
    // meant this second call — the SAME pref, retried after a failure — was
    // silently deduped away forever. It must go through again.
    setNativeTheme("dark");
    await flushAsync();
    expect(callsFor(invoke, "set_native_theme")).toHaveLength(2);
  });

  it("clears the latch even when the rejection is already superseded", async () => {
    // The wedge the seq-guarded rollback left open. A(dark) and B(light) are
    // both in flight; B rejects first and (under the old code) restored the
    // latch to "dark", then A's rejection was skipped as stale and restored
    // nothing. The latch then claimed "dark" — a value that never landed —
    // and re-picking dark was deduped away permanently.
    const { setNativeTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
    let rejectA!: (e: Error) => void;
    let rejectB!: (e: Error) => void;
    invoke.mockImplementationOnce(() => new Promise((_r, rej) => (rejectA = rej)));
    setNativeTheme("dark"); // seq 1
    invoke.mockImplementationOnce(() => new Promise((_r, rej) => (rejectB = rej)));
    setNativeTheme("light"); // seq 2 supersedes
    await flushAsync();
    expect(callsFor(invoke, "set_native_theme")).toHaveLength(2);

    rejectB(new Error("b failed"));
    await flushAsync();
    rejectA(new Error("a failed")); // stale — but still invalidates the latch
    await flushAsync();

    const before = callsFor(invoke, "set_native_theme").length;
    setNativeTheme("dark");
    await flushAsync();
    expect(callsFor(invoke, "set_native_theme").length).toBeGreaterThan(before);
  });

  it("re-issues the last CONFIRMED preference after a failed push in between", async () => {
    // Regression guard for the dedupe INPUT (#1369). The obvious restructure
    // is to dedupe against "the last preference we know about" — i.e. to fall
    // back to the last RESOLVED outcome when nothing is in flight. Trace why
    // that is wrong: dark resolves, system rejects and arms the 500 ms retry,
    // then the user re-picks dark. A `lastResolved`-aware dedupe
    // short-circuits that third call, so `cancelRetry()` never runs, and the
    // armed "system" retry lands afterwards — releasing the native override
    // while the app renders dark. A rejection means "no claim", full stop:
    // only what we ASSERTED (and have not had rejected) may dedupe.
    vi.useFakeTimers();
    try {
      const { setNativeTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");

      setNativeTheme("dark"); // resolves — this is the last CONFIRMED pref
      await vi.advanceTimersByTimeAsync(0);

      invoke.mockImplementationOnce(() => Promise.reject(new Error("release failed")));
      setNativeTheme("system"); // rejects — arms a 500 ms retry of "system"
      await vi.advanceTimersByTimeAsync(0);

      setNativeTheme("dark"); // must go through, and must disarm that retry
      await vi.advanceTimersByTimeAsync(0);
      expect(callsFor(invoke, "set_native_theme")).toHaveLength(3);

      // Past every rung of the ladder (500 + 1000 + 2000 = 3500 ms, so 4000
      // clears it with room): nothing more may be issued. Only the single
      // armed 500 ms rung is actually pending here — the point is that
      // disarming it left nothing behind at any later delay either.
      await vi.advanceTimersByTimeAsync(4000);
      expect(callsFor(invoke, "set_native_theme")).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not touch overrideActive on a rejected push", async () => {
    // A rejected push means the native override state is UNKNOWN. Clearing
    // the flag would open the read-back gate onto a possibly still-forced
    // appearance, and the poll would then write an echo of our own force in
    // as if it were an OS reading.
    const { setNativeTheme, initTauriTheme } = await import(
      "../../src/client/hooks/useTauriTheme.svelte.js"
    );
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      matchMedia: inertMatchMedia,
      __TANDEM_INITIAL_THEME__: undefined,
    });
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_app_theme") return Promise.resolve("light");
      return Promise.resolve({ overrideActive: true, osTheme: null });
    });
    initTauriTheme(pushSpy);
    setNativeTheme("dark"); // resolves with overrideActive: true
    await flushAsync();

    // Now a release that fails before the native override is actually let go.
    invoke.mockImplementationOnce(() => Promise.reject(new Error("release failed")));
    setNativeTheme("system");
    await flushAsync();

    // The gate must still be shut: this echo of the forced theme is discarded.
    themeChangedCapture.current?.({ payload: "dark" });
    await flushAsync();
    expect(systemTheme()).toBe("light");
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

    // Resolve the FIRST (now-stale) push with an outcome that CONTRADICTS
    // seq 2's. `osTheme: null` here would make the assertion below pass
    // whether or not the staleness guard exists — the un-guarded path would
    // write nothing either way — which is exactly how this test used to pass
    // for the wrong reason.
    resolveFirst({ overrideActive: true, osTheme: "dark" });
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
      removeEventListener: vi.fn(),
      matchMedia: inertMatchMedia,
      __TANDEM_INITIAL_THEME__: undefined,
    });
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_app_theme") return Promise.resolve("light");
      return Promise.resolve({ overrideActive: false, osTheme: null });
    });

    initTauriTheme(pushSpy);
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
      vi.stubGlobal("window", {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        matchMedia: inertMatchMedia,
        __TANDEM_INITIAL_THEME__: undefined,
      });

      invoke.mockImplementation((cmd: string) => {
        if (cmd === "get_app_theme") return Promise.resolve("light");
        return Promise.resolve({ overrideActive: false, osTheme: null });
      });

      initTauriTheme(pushSpy);
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

  it("an OS read-back arriving while a push is unsettled is discarded, and honoured once it settles", async () => {
    // #1369 item C. `lastResolved` describes the last push to have RESOLVED,
    // so in the window between an override's appearance flipping and its
    // `invoke` resolving BOTH of the pre-existing gates pass: the read-back's
    // stamp equals `pushSeq` (it is taken at delivery) and no resolved
    // outcome has reported `overrideActive` yet. Without the in-flight gate
    // this event is ACCEPTED, i.e. this test is red on master by
    // construction (it was written against the pre-#1369 shape).
    const { setNativeTheme, initTauriTheme } = await import(
      "../../src/client/hooks/useTauriTheme.svelte.js"
    );
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      matchMedia: inertMatchMedia,
      __TANDEM_INITIAL_THEME__: undefined,
    });
    // hasFocus false so no poll tick can confound the assertions below.
    vi.stubGlobal("document", { hasFocus: () => false });
    // invoke default comes from beforeEach; the two commands in play behave identically.

    initTauriTheme(pushSpy);
    await flushAsync();
    expect(themeChangedCapture.current).not.toBeNull();
    expect(systemTheme()).toBe("light");

    // Hold the push with a CAPTURED resolver, branched on the command so the
    // `Once` implementation cannot be consumed by a stray `get_app_theme`.
    let resolveHeld!: (v: unknown) => void;
    invoke.mockImplementationOnce((cmd: string) =>
      cmd === "set_native_theme"
        ? new Promise((r) => {
            resolveHeld = r;
          })
        : Promise.resolve("light"),
    );
    setNativeTheme("dark");
    await flushAsync();

    themeChangedCapture.current?.({ payload: "dark" });
    await flushAsync();
    expect(systemTheme()).toBe("light"); // discarded — the push has not settled

    resolveHeld({ overrideActive: false, osTheme: null });
    await flushAsync();

    // A window, not a lockout: once the push settles the same event lands.
    themeChangedCapture.current?.({ payload: "dark" });
    await flushAsync();
    expect(systemTheme()).toBe("dark");
  });

  it("the in-flight read-back gate expires, so a push that never settles cannot freeze the theme", async () => {
    // Pins the BOUND, not the gate. Resolving a held push only proves the
    // gate opens on a SETTLED push; a promise that neither resolves nor
    // rejects reaches neither the `.then` nor the `.catch`, and the retry
    // ladder fires on rejection only — so an unbounded `if (inFlight) return`
    // would freeze `tauriTheme.current` for the rest of the session. Without
    // this test, `issuedAt` and PUSH_SETTLE_CEILING_MS read as unused
    // ceremony and get simplified away.
    vi.useFakeTimers();
    try {
      const { setNativeTheme, initTauriTheme } = await import(
        "../../src/client/hooks/useTauriTheme.svelte.js"
      );
      vi.stubGlobal("window", {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        matchMedia: inertMatchMedia,
        __TANDEM_INITIAL_THEME__: undefined,
      });
      vi.stubGlobal("document", { hasFocus: () => false });
      // invoke default comes from beforeEach; the two commands in play behave identically.

      initTauriTheme(pushSpy);
      await vi.advanceTimersByTimeAsync(0);
      expect(themeChangedCapture.current).not.toBeNull();
      expect(systemTheme()).toBe("light");

      invoke.mockImplementationOnce((cmd: string) =>
        cmd === "set_native_theme" ? new Promise(() => {}) : Promise.resolve("light"),
      );
      setNativeTheme("dark");
      await vi.advanceTimersByTimeAsync(0);

      themeChangedCapture.current?.({ payload: "dark" });
      await vi.advanceTimersByTimeAsync(0);
      expect(systemTheme()).toBe("light"); // gate shut

      // vitest's fake timers fake `performance` and `Date` (default `toFake`
      // is every timer sinon knows, minus nextTick/queueMicrotask), and this
      // repo sets no `fakeTimers` config — so `performance.now()`, which is
      // what `issuedAt` is measured on, advances here. Measured, not assumed.
      //
      // Pin the bound from BOTH sides. Without the lower assertion the value
      // is bracketed only to "somewhere in (a few ms, 3001]" — a mutant
      // dropping the ceiling to 500 ms survives, which would silently reopen
      // the echo window for every healthy push slower than half a second.
      await vi.advanceTimersByTimeAsync(2999);
      themeChangedCapture.current?.({ payload: "dark" });
      await vi.advanceTimersByTimeAsync(0);
      expect(systemTheme()).toBe("light"); // still inside the ceiling

      await vi.advanceTimersByTimeAsync(2);
      themeChangedCapture.current?.({ payload: "dark" });
      await vi.advanceTimersByTimeAsync(0);
      expect(systemTheme()).toBe("dark"); // gate expired — degraded to pre-#1369
    } finally {
      // Stops the poll interval while fake timers are still installed;
      // afterEach would otherwise run it against real ones. In the `finally`
      // so an assertion failure above cannot leak the interval.
      (await import("../../src/client/hooks/useTauriTheme.svelte.js"))._resetForTests();
      vi.useRealTimers();
    }
  });

  it("seeds the boot theme even though the first push is still unsettled", async () => {
    // The boot `get_app_theme` fetch is deliberately NOT gated on
    // `lastPush.inFlight`, and that decision had no test: adding the gate
    // passed the entire suite. It is not self-limiting either — the poll that
    // would correct it is skipped while the window is unfocused, so a
    // backgrounded launch holds the wrong theme indefinitely, and
    // `window.__TANDEM_INITIAL_THEME__` carries it into the pre-mount seed.
    const { setNativeTheme, initTauriTheme } = await import(
      "../../src/client/hooks/useTauriTheme.svelte.js"
    );
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      matchMedia: inertMatchMedia,
      __TANDEM_INITIAL_THEME__: undefined,
    });
    vi.stubGlobal("document", { hasFocus: () => false });
    invoke.mockImplementation((cmd: string) =>
      cmd === "get_app_theme" ? Promise.resolve("dark") : new Promise(() => {}),
    );

    initTauriTheme(pushSpy);
    setNativeTheme("dark"); // same tick as createTheme's effect; never settles
    await flushAsync();

    // "dark", not "light": a vacuous version of this test would assert
    // "light", which is also what `systemTheme()` returns when
    // `tauriTheme.current` is still null.
    expect(systemTheme()).toBe("dark");
  });

  it("re-enables OS read-backs once the retry ladder is exhausted", async () => {
    // The failure the ladder exists to prevent, reached THROUGH the ladder.
    // A failed release leaves `lastResolved.overrideActive` true, which pins
    // both the poll and every `onThemeChanged` shut. While a retry is pending
    // that is the right trade — a transient unknown resolves in seconds. Past
    // the cap there is nothing left to reopen the gate, so holding it shut
    // renders a theme matching neither the OS nor the native surfaces for the
    // rest of the session. "We stopped trying" has to degrade to "stop
    // suppressing".
    vi.useFakeTimers();
    try {
      const { setNativeTheme, initTauriTheme, _resetForTests } = await import(
        "../../src/client/hooks/useTauriTheme.svelte.js"
      );
      vi.stubGlobal("window", {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        matchMedia: inertMatchMedia,
        __TANDEM_INITIAL_THEME__: undefined,
      });
      vi.stubGlobal("document", { hasFocus: () => false });

      invoke.mockImplementation((cmd: string) =>
        cmd === "get_app_theme"
          ? Promise.resolve("light")
          : Promise.resolve({ overrideActive: true, osTheme: null }),
      );
      initTauriTheme(pushSpy);
      await vi.advanceTimersByTimeAsync(0);
      setNativeTheme("dark"); // succeeds — the override is now live
      await vi.advanceTimersByTimeAsync(0);

      // Gate shut: an OS event while the override is forced is an echo.
      themeChangedCapture.current?.({ payload: "dark" });
      await vi.advanceTimersByTimeAsync(0);
      expect(systemTheme()).toBe("light");

      // Now fail the release on every attempt, ladder included.
      invoke.mockImplementation((cmd: string) =>
        cmd === "get_app_theme"
          ? Promise.resolve("light")
          : Promise.reject(new Error("release failed")),
      );
      setNativeTheme("system");
      await vi.advanceTimersByTimeAsync(4000); // 500 + 1000 + 2000, plus slack

      // Four attempts and no more: the ladder is spent, not looping.
      expect(callsFor(invoke, "set_native_theme")).toHaveLength(1 + 1 + MAX_PUSH_RETRIES);

      // The gate must now be OPEN. Before this fix `lastResolved` stayed
      // `{ overrideActive: true }` forever and this read-back was discarded.
      themeChangedCapture.current?.({ payload: "dark" });
      await vi.advanceTimersByTimeAsync(0);
      expect(systemTheme()).toBe("dark");

      _resetForTests();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives each new user intent a fresh retry budget", async () => {
    // `retryAttempts` is module-scope, so without a reset the budget belongs
    // to the SESSION rather than to one intent: a user toggling themes
    // against a failing invoke burns all three rungs in three picks, and
    // every later failure then retries zero times, silently. The reset lives
    // inside `cancelRetry`'s `if (retryHandle !== null)` guard — the retry
    // timer nulls the handle before re-entering, so the ladder's own rungs do
    // NOT refill their budget. Both halves are asserted here, because moving
    // that reset out of the guard turns the ladder into a 500 ms hot loop.
    vi.useFakeTimers();
    try {
      const { setNativeTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
      invoke.mockImplementation(() => Promise.reject(new Error("nope")));

      // Three distinct intents, each superseding the previous one's armed
      // retry before it can fire.
      setNativeTheme("dark");
      await vi.advanceTimersByTimeAsync(0);
      setNativeTheme("light");
      await vi.advanceTimersByTimeAsync(0);
      setNativeTheme("warm");
      await vi.advanceTimersByTimeAsync(0);
      const afterThreeIntents = callsFor(invoke, "set_native_theme").length;
      expect(afterThreeIntents).toBe(3); // no rung has fired yet

      // The third intent must still own a FULL ladder, not a spent one.
      await vi.advanceTimersByTimeAsync(4000);
      expect(callsFor(invoke, "set_native_theme")).toHaveLength(
        afterThreeIntents + MAX_PUSH_RETRIES,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a fresh budget to an intent that supersedes an IN-FLIGHT retry", async () => {
    // The gap the `retryHandle !== null` guard alone does not cover. The retry
    // timer nulls `retryHandle` BEFORE re-pushing, so between the timer firing
    // and that push settling there is an armed ladder with no handle to find.
    // A new user intent landing in that window used to inherit the spent
    // counter and retry fewer times than the intent before it — silently, and
    // not reproducibly, since it depends on where the pick lands relative to
    // the 500 ms rung. `viaRetry` on `lastPush` is what closes it.
    vi.useFakeTimers();
    try {
      const { setNativeTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");

      // A hung invoke: the retry push neither resolves nor rejects, so it is
      // still in flight — `retryHandle` is null and the ladder is half spent.
      let hang = false;
      invoke.mockImplementation(() =>
        hang ? new Promise(() => {}) : Promise.reject(new Error("nope")),
      );

      setNativeTheme("dark");
      await vi.advanceTimersByTimeAsync(0);
      hang = true;
      await vi.advanceTimersByTimeAsync(500); // rung 1 fires and hangs
      const beforeNewIntent = callsFor(invoke, "set_native_theme").length;

      // A new user pick supersedes the in-flight retry.
      hang = false;
      setNativeTheme("light");
      await vi.advanceTimersByTimeAsync(0);

      // It must own a FULL ladder. With the budget leaked it gets two rungs.
      await vi.advanceTimersByTimeAsync(4000);
      expect(callsFor(invoke, "set_native_theme")).toHaveLength(
        beforeNewIntent + 1 + MAX_PUSH_RETRIES,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // #1413 — the onThemeChanged unlisten handle used to be discarded, so every HMR
  // generation left a live listener behind, and each survivor kept writing the
  // process-global `window.__TANDEM_INITIAL_THEME__`.
  describe("onThemeChanged subscription lifecycle (#1413)", () => {
    it("releases the listener on _resetForTests()", async () => {
      isTauri.mockReturnValue(true);
      vi.resetModules();
      unlistenSpy.mockClear();
      const { initTauriTheme, _resetForTests } = await import(
        "../../src/client/hooks/useTauriTheme.svelte.js"
      );
      _resetForTests();
      initTauriTheme(pushSpy);
      // Let the dynamic import() of @tauri-apps/api/window resolve.
      await vi.waitFor(() => expect(themeChangedCapture.current).not.toBeNull());
      // The mock records the subscribe synchronously, one microtask BEFORE the SUT stores
      // the handle. Wait for the store, not the subscribe, or this asserts on a handle
      // that does not exist yet and passes only by grace of waitFor's scheduler.
      await flushAsync();

      expect(unlistenSpy).not.toHaveBeenCalled();
      _resetForTests();
      expect(unlistenSpy).toHaveBeenCalledTimes(1);
    });

    it("does not accumulate subscriptions across reset + re-init", async () => {
      isTauri.mockReturnValue(true);
      vi.resetModules();
      unlistenSpy.mockClear();
      subscribeCount.current = 0;
      const { initTauriTheme, _resetForTests } = await import(
        "../../src/client/hooks/useTauriTheme.svelte.js"
      );

      for (let i = 0; i < 3; i++) {
        _resetForTests();
        initTauriTheme(pushSpy);
        await vi.waitFor(() => expect(subscribeCount.current).toBe(i + 1));
        await flushAsync(); // see note above: subscribe is recorded before the handle lands
      }
      _resetForTests();

      // Three generations subscribed; all three must have been released. Before the fix
      // this was 3 subscribes and 0 releases.
      expect(subscribeCount.current).toBe(3);
      expect(unlistenSpy).toHaveBeenCalledTimes(3);
    });

    it("_resetForTests() clears the disposed latch so a later init still subscribes", async () => {
      // Guards the trap in the sibling useTauriFileDrop._resetForTests, which omits the
      // equivalent clear: a latched flag would silently turn every later init into a
      // no-op subscription while the suite stayed green.
      isTauri.mockReturnValue(true);
      vi.resetModules();
      subscribeCount.current = 0;
      const { initTauriTheme, _resetForTests } = await import(
        "../../src/client/hooks/useTauriTheme.svelte.js"
      );
      _resetForTests();
      initTauriTheme(pushSpy);
      await vi.waitFor(() => expect(subscribeCount.current).toBe(1));
      _resetForTests();
      initTauriTheme(pushSpy);
      await vi.waitFor(() => expect(subscribeCount.current).toBe(2));
      await flushAsync();
      expect(themeChangedCapture.current).not.toBeNull();
      // These three are the only tests in the file that would otherwise END initialized —
      // leaving `_initialized` true, a live subscription and a running 3s poll for
      // anything appended after them. The test at the top of this file exists to assert
      // that poll does not leak across tests; do not make it a liar by relying on being
      // last in the file.
      _resetForTests();
    });
  });

  // Regression guard: the fix for #1413 (above) introduced the SAME leak class one
  // function below it. The `pagehide` listener that replaced the old `{ once: true }`
  // registration was, for a time, an inline arrow function stored nowhere and never
  // removed — every HMR generation left a permanent listener on the real `window`.
  // These tests use happy-dom's real `window` (no `vi.stubGlobal` here) and spy on its
  // real `addEventListener`/`removeEventListener`, so a listener that is registered but
  // never removed is observable the same way the #1413 tests make `unlistenSpy` observable.
  describe("pagehide listener lifecycle", () => {
    it("removes the pagehide listener on _resetForTests()", async () => {
      isTauri.mockReturnValue(true);
      vi.resetModules();
      const addSpy = vi.spyOn(window, "addEventListener");
      const removeSpy = vi.spyOn(window, "removeEventListener");
      const { initTauriTheme, _resetForTests } = await import(
        "../../src/client/hooks/useTauriTheme.svelte.js"
      );
      _resetForTests();
      addSpy.mockClear();
      removeSpy.mockClear();

      initTauriTheme(pushSpy);
      expect(addSpy).toHaveBeenCalledWith("pagehide", expect.any(Function));
      expect(removeSpy).not.toHaveBeenCalledWith("pagehide", expect.any(Function));

      _resetForTests();
      expect(removeSpy).toHaveBeenCalledWith("pagehide", expect.any(Function));

      addSpy.mockRestore();
      removeSpy.mockRestore();
    });

    it("does not accumulate pagehide listeners across reset + re-init", async () => {
      isTauri.mockReturnValue(true);
      vi.resetModules();
      const addSpy = vi.spyOn(window, "addEventListener");
      const removeSpy = vi.spyOn(window, "removeEventListener");
      const { initTauriTheme, _resetForTests } = await import(
        "../../src/client/hooks/useTauriTheme.svelte.js"
      );
      _resetForTests();
      addSpy.mockClear();
      removeSpy.mockClear();

      // Three generations, exactly as the #1413 accumulation test above does for
      // onThemeChanged. Before this fix, only `addEventListener` calls would show here —
      // three registrations and zero removals, i.e. three permanent listeners. Each loop
      // iteration's leading `_resetForTests()` releases the PRIOR iteration's listener (a
      // no-op on iteration 0, since nothing is registered yet), and the trailing reset
      // after the loop releases the third: three `initTauriTheme(pushSpy)` calls, three releases.
      for (let i = 0; i < 3; i++) {
        _resetForTests();
        initTauriTheme(pushSpy);
      }
      _resetForTests();

      const pagehideAdds = addSpy.mock.calls.filter((c) => c[0] === "pagehide");
      const pagehideRemoves = removeSpy.mock.calls.filter((c) => c[0] === "pagehide");
      expect(pagehideAdds).toHaveLength(3); // one per initTauriTheme(pushSpy) call in the loop
      expect(pagehideRemoves).toHaveLength(3); // every registered generation must be released

      addSpy.mockRestore();
      removeSpy.mockRestore();
    });

    it("a persisted (bfcache) pagehide does not remove the listener; a real one does", async () => {
      // The whole reason this listener is not `{ once: true }`: a bfcache-eligible hide
      // must leave the module subscribed so a restored page still has a path back to a
      // real unload. Invoking the captured handler directly (rather than dispatching a
      // real `pagehide` event, which some describe-block-local window stubs elsewhere in
      // this file leave unable to do) exercises exactly the branch `initTauriTheme` reads
      // — `event.persisted` — without depending on happy-dom's event plumbing surviving
      // whatever the previous test in this file left `window` as.
      isTauri.mockReturnValue(true);
      vi.resetModules();
      const addSpy = vi.spyOn(window, "addEventListener");
      const removeSpy = vi.spyOn(window, "removeEventListener");
      const { initTauriTheme, _resetForTests } = await import(
        "../../src/client/hooks/useTauriTheme.svelte.js"
      );
      _resetForTests();
      initTauriTheme(pushSpy);
      const handler = addSpy.mock.calls.find((c) => c[0] === "pagehide")?.[1] as unknown as (e: {
        persisted: boolean;
      }) => void;
      expect(handler).toBeTypeOf("function");
      removeSpy.mockClear();

      handler({ persisted: true });
      expect(removeSpy).not.toHaveBeenCalledWith("pagehide", expect.any(Function));

      handler({ persisted: false });
      expect(removeSpy).toHaveBeenCalledWith("pagehide", expect.any(Function));

      addSpy.mockRestore();
      removeSpy.mockRestore();
      _resetForTests();
    });
  });

  // #1368 — `set_native_theme` used to serialize a successful force, a release, a
  // High-Contrast decline and a total no-op on a pre-1903 Windows as the same two
  // fields, so the client had nothing to react to and every failure in this module
  // terminated at a `console.warn` that reaches nothing in a release build.
  //
  // These drive the RESOLVED outcome only; the rejection path belongs to #1413.
  describe("unsupported-host notification (#1368)", () => {
    beforeEach(() => {
      // Load-bearing: `vi.stubGlobal("window", {...})` calls earlier in this file are
      // only undone inside the FIRST describe, so without this the SUT would register
      // its pagehide listener on a leftover plain object and the real poll/teardown
      // paths would not behave as they do in the app.
      vi.unstubAllGlobals();
      pushSpy.mockClear();
    });

    afterEach(async () => {
      // Every test here ends initialized (a live poll, a live subscription). The test
      // at the top of this file exists to assert the poll does not leak across tests;
      // do not make it a liar.
      const { _resetForTests } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
      _resetForTests();
    });

    /** Resolve every `set_native_theme` push with this `applied` discriminant. */
    function resolveWith(applied: string): void {
      invoke.mockImplementation((cmd: string) => {
        if (cmd === "set_native_theme")
          return Promise.resolve({ overrideActive: false, osTheme: null, applied });
        return Promise.resolve("light");
      });
    }

    /** Calls pushed to the notification callback that carry THIS feature's dedupKey. */
    function nativeThemeToasts(): { dedupKey?: string; severity?: string; message?: string }[] {
      return pushSpy.mock.calls
        .map((c) => c[0] as { dedupKey?: string; severity?: string; message?: string })
        .filter((n) => n?.dedupKey === "native-theme-push");
    }

    it("toasts once when the host cannot apply an app mode", async () => {
      const { initTauriTheme, setNativeTheme } = await import(
        "../../src/client/hooks/useTauriTheme.svelte.js"
      );
      initTauriTheme(pushSpy);
      resolveWith("unsupported-host");
      setNativeTheme("dark");
      await flushAsync();

      const toasts = nativeThemeToasts();
      expect(toasts).toHaveLength(1);
      expect(toasts[0].severity).toBe("warning");
      expect(toasts[0].message).toMatch(/Windows/);
    });

    it("says nothing for any outcome that is not an unsupported host", async () => {
      // `declined-high-contrast` is the user's own accessibility setting winning and
      // `skipped-platform` is Linux, where a Windows-menu toast would be actively
      // wrong. `applied-without-menu-flush` is the regression pin: the app mode IS
      // set there (ordinal 135 succeeded; only ordinal 136 did not), so attaching
      // "native menus can't follow the app theme" to it would be a false claim,
      // permanently, in an activity tray that is a log.
      const mod = await import("../../src/client/hooks/useTauriTheme.svelte.js");
      for (const applied of [
        "forced",
        "released",
        "applied-without-menu-flush",
        "declined-high-contrast",
        "skipped-platform",
      ]) {
        mod._resetForTests();
        pushSpy.mockClear();
        mod.initTauriTheme(pushSpy);
        resolveWith(applied);
        mod.setNativeTheme("dark");
        await flushAsync();
        expect(nativeThemeToasts(), `applied=${applied}`).toHaveLength(0);
      }
    });

    it("does not toast again for a second unsupported-host push in the same session", async () => {
      // Two DIFFERENT preferences, so the module's own dedupe latch cannot be what
      // suppresses the second toast — this has to be the session latch.
      const { initTauriTheme, setNativeTheme } = await import(
        "../../src/client/hooks/useTauriTheme.svelte.js"
      );
      initTauriTheme(pushSpy);
      resolveWith("unsupported-host");
      setNativeTheme("dark");
      await flushAsync();
      setNativeTheme("light");
      await flushAsync();

      expect(callsFor(invoke, "set_native_theme")).toHaveLength(2);
      expect(nativeThemeToasts()).toHaveLength(1);
    });

    it("_resetForTests() clears the latch so a later push can toast again", async () => {
      // The trap the `disposed` latch's comment in the SUT describes: a session latch
      // that `_resetForTests` forgets silences every subsequent test, silently.
      const mod = await import("../../src/client/hooks/useTauriTheme.svelte.js");
      mod.initTauriTheme(pushSpy);
      resolveWith("unsupported-host");
      mod.setNativeTheme("dark");
      await flushAsync();
      expect(nativeThemeToasts()).toHaveLength(1);

      mod._resetForTests();
      pushSpy.mockClear();
      mod.initTauriTheme(pushSpy);
      mod.setNativeTheme("dark");
      await flushAsync();
      expect(nativeThemeToasts()).toHaveLength(1);
    });

    it("a REJECTED push produces no unsupported-host copy", async () => {
      // Scoped to this feature's COPY rather than to "no notification at all". What
      // this pins is that the `applied` surfacing lives in the resolved `.then` ONLY —
      // a failed push has no outcome, and inventing one is the #1362 class of bug.
      //
      // NARROWED BY #1413, which is what makes the assertion match the name. This
      // shipped filtering on `dedupKey === "native-theme-push"` alone, and #1413's
      // exhaustion toast shares that key deliberately (one broken feature, one
      // activity-tray entry). The key-only assertion was green here only by a timing
      // accident: this test runs on REAL timers and `flushAsync()` is a single
      // `setTimeout(…, 0)`, so it never reaches the ~3.5 s ladder exhaustion where
      // #1413 toasts. Replacing that one line with a 4000 ms wait — no source change —
      // reddens it on CORRECT behaviour. Anything that later gives this test fake
      // timers, or lowers the retry ladder's base delay, would then get a red test
      // and a diagnosis pointing at #1368's `applied` surfacing, which is not where
      // the change was.
      //
      // The message predicate is what restores the intent: `/Windows/` is the
      // unsupported-host copy ("Native menus can't follow the app theme on this
      // Windows build."), and #1413's exhaustion copy is deliberately host-neutral —
      // its own test pins `not.toMatch(/menus?|windows|…/i)`. So this still reddens
      // for its target mutation (hoisting the `applied` surfacing into the `.catch`)
      // while no longer forbidding a toast that legitimately belongs there.
      const { initTauriTheme, setNativeTheme } = await import(
        "../../src/client/hooks/useTauriTheme.svelte.js"
      );
      initTauriTheme(pushSpy);
      invoke.mockImplementation((cmd: string) => {
        if (cmd === "set_native_theme") return Promise.reject(new Error("set_theme failed: boom"));
        return Promise.resolve("light");
      });
      setNativeTheme("dark");
      await flushAsync();

      expect(callsFor(invoke, "set_native_theme").length).toBeGreaterThan(0);
      expect(nativeThemeToasts().filter((t) => /Windows/.test(t.message ?? ""))).toHaveLength(0);
    });
  });

  // #1368 — the half of the wire contract #1413 actually consumes. `null` is a
  // MEANINGFUL answer here ("this rejection never reached Rust"), which is exactly why
  // a code that the narrowing function fails to recognise is so dangerous: it is
  // indistinguishable from a client-side failure and #1413's handler would take the
  // wrong branch forever with nothing failing.
  describe("nativeThemeErrorCode (#1368)", () => {
    it("recognises every code Rust can send", async () => {
      const { nativeThemeErrorCode } = await import(
        "../../src/client/hooks/useTauriTheme.svelte.js"
      );
      // Listed literally rather than derived: this is the independent statement of the
      // contract. `tests/docs/native-theme-claims.test.ts` pins these same four against
      // the Rust enum, so the two together close the loop Rust -> union -> runtime.
      for (const code of [
        "high-contrast-unknown",
        "set-theme-failed",
        "app-mode-timeout",
        "main-thread-unavailable",
      ]) {
        expect(nativeThemeErrorCode({ code, message: "x" }), `code=${code}`).toBe(code);
      }
    });

    it("returns null for anything that is not a native rejection", async () => {
      const { nativeThemeErrorCode } = await import(
        "../../src/client/hooks/useTauriTheme.svelte.js"
      );
      // A bare string is what a sidecar older than #1368 sends, and what every one of
      // these five causes used to arrive as.
      expect(nativeThemeErrorCode("set_theme failed: boom")).toBeNull();
      expect(nativeThemeErrorCode(new Error("dynamic import failed"))).toBeNull();
      expect(nativeThemeErrorCode(null)).toBeNull();
      expect(nativeThemeErrorCode(undefined)).toBeNull();
      expect(nativeThemeErrorCode({})).toBeNull();
      expect(nativeThemeErrorCode({ code: "nope" })).toBeNull();
      expect(nativeThemeErrorCode({ code: 7 })).toBeNull();
    });
  });

  // ------------------------------------------------------------------------
  // #1413 — every failure path in this module used to terminate at a
  // `console.warn`, which in a shipped desktop build reaches nothing at all:
  // `tauri-plugin-log` declares no `TargetKind::Webview`, nothing calls
  // `attachConsole`, and the release build has no devtools feature. These pin
  // where each failure now goes instead — one toast, everything else into the
  // client log that `formatDiagnostics` drains into Copy Diagnostics and the
  // prefilled bug-report body.
  //
  // Harness rules, learned the hard way and worth keeping:
  //
  //  1. `vi.unstubAllGlobals()` first, exactly as the #1368 describe above does:
  //     a `window` stub leaked from an earlier describe makes the SUT register
  //     its pagehide listener on a plain object the test cannot reach.
  //  2. `_resetClientLog()` in `beforeEach`, or one test's entries are counted
  //     by the next one's assertions.
  //  3. Every assertion filters on scope AND a specific event, never on scope
  //     alone. Several scenarios here deliberately generate two or three
  //     independent `useTauriTheme` entries at once — a boot-fetch failure
  //     alongside a poll failure, an import failure alongside a give-up — and a
  //     scope-only predicate would silently miscount them.
  describe("failure surfacing (#1413)", () => {
    /** Mirrors the SUT's `POLL_INTERVAL_MS`, which is not exported. */
    const POLL_INTERVAL_MS = 3000;

    beforeEach(async () => {
      vi.unstubAllGlobals();
      pushSpy.mockClear();
      const { _resetClientLog } = await import("../../src/client/utils/client-log.js");
      _resetClientLog();
    });

    afterEach(async () => {
      // `coreImportBroken` is NOT reset here — the file-level `afterEach` beside the
      // mock owns that, so it holds for every describe in this file rather than only
      // this one. The `finally` blocks inside the individual tests below are a
      // redundant belt on top of it, kept for locality, and are not what makes the
      // discipline hold.
      const { _resetForTests } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
      _resetForTests();
      const { _resetClientLog } = await import("../../src/client/utils/client-log.js");
      _resetClientLog();
    });

    /** Client-log entries for this module whose `event` matches `pattern`. */
    async function entries(pattern: RegExp) {
      const { readClientLog } = await import("../../src/client/utils/client-log.js");
      return readClientLog().filter((e) => e.scope === "useTauriTheme" && pattern.test(e.event));
    }

    /** Notifications carrying this feature's dedupKey (shared with #1368). */
    function nativeThemeToasts(): { dedupKey?: string; severity?: string; message?: string }[] {
      return pushSpy.mock.calls
        .map((c) => c[0] as { dedupKey?: string; severity?: string; message?: string })
        .filter((n) => n?.dedupKey === "native-theme-push");
    }

    /** Reject every `set_native_theme` with `value`; resolve `get_app_theme`. */
    function rejectPushWith(value: unknown): void {
      invoke.mockImplementation((cmd: string) =>
        cmd === "set_native_theme" ? Promise.reject(value) : Promise.resolve("light"),
      );
    }

    // -------- item 1: the exhausted retry ladder is the one toast --------

    it("toasts once, in host-neutral copy, when the retry ladder is exhausted", async () => {
      // The message is asserted in BOTH directions on purpose. The positive half
      // pins that a user is told anything at all; the negative half pins that the
      // copy names no platform surface. There is no `applied` and no host
      // information on this path — `getInvoke()` never caches a rejection, so a
      // failed `import("@tauri-apps/api/core")` or a renamed command rejects all
      // four rungs on EVERY platform, Linux included, where `set_native_theme`
      // resolves to a no-op action by design (#1363). "Menus may not follow your
      // theme" would there assert a degradation that is the permanent designed
      // state. The menus sentence belongs only where `applied` exists.
      vi.useFakeTimers();
      try {
        vi.stubGlobal("document", { hasFocus: () => false });
        const { initTauriTheme, setNativeTheme } = await import(
          "../../src/client/hooks/useTauriTheme.svelte.js"
        );
        initTauriTheme(pushSpy);
        await vi.advanceTimersByTimeAsync(0);
        rejectPushWith(new Error("set_theme failed: boom"));
        pushSpy.mockClear();

        setNativeTheme("dark");
        await vi.advanceTimersByTimeAsync(4000); // 500 + 1000 + 2000, plus slack

        expect(callsFor(invoke, "set_native_theme")).toHaveLength(1 + MAX_PUSH_RETRIES);
        const toasts = nativeThemeToasts();
        expect(toasts).toHaveLength(1);
        expect(toasts[0].severity).toBe("warning");
        expect(toasts[0].message).toMatch(/couldn't apply your theme to the system/);
        expect(toasts[0].message).toMatch(/still follows your choice/);
        expect(toasts[0].message).not.toMatch(/menus?|windows|macos|linux|tray/i);
      } finally {
        vi.useRealTimers();
      }
    });

    it("toasts once per session, however many times the ladder is exhausted", async () => {
      // The `dedupKey` alone does NOT give this. It coalesces repeats in the toast
      // LIST and permanently in the activity tray, but `schedulePopDismiss` dismisses
      // a `warning` toast after `TOAST_DISMISS_MS.warning` (6 s), and a repeat arriving
      // after that pops a NEW toast. A broken bridge with a user picking light, then
      // dark, then light again produces exhaustions ~7 s apart — comfortably past the
      // dismissal — so without the session latch every pick pops another notice about
      // the same one broken thing. `pushFailureToasted` is the second layer, sibling to
      // #1368's `unsupportedHostToasted`, and this pins both it and its reset.
      //
      // Two DIFFERENT preferences, so the SUT's `pref === lastPush?.pref` short-circuit
      // cannot be what suppresses the second toast.
      vi.useFakeTimers();
      try {
        vi.stubGlobal("document", { hasFocus: () => false });
        const mod = await import("../../src/client/hooks/useTauriTheme.svelte.js");
        mod.initTauriTheme(pushSpy);
        await vi.advanceTimersByTimeAsync(0);
        rejectPushWith(new Error("set_theme failed: boom"));
        pushSpy.mockClear();

        mod.setNativeTheme("dark");
        await vi.advanceTimersByTimeAsync(4000);
        mod.setNativeTheme("light");
        await vi.advanceTimersByTimeAsync(4000);

        // Both ladders really ran — otherwise this would pass for the wrong reason.
        expect(callsFor(invoke, "set_native_theme")).toHaveLength(2 * (1 + MAX_PUSH_RETRIES));
        expect(nativeThemeToasts()).toHaveLength(1);
        // Every occurrence is still counted where repetition is informative: the
        // recorder entry, not the notification.
        const gaveUp = await entries(/^set_native_theme gave up/);
        expect(gaveUp).toHaveLength(1);
        expect(gaveUp[0].count).toBe(2);

        // The trap #1368's own latch test names: a session latch that
        // `_resetForTests` forgets silences every later test, silently.
        mod._resetForTests();
        pushSpy.mockClear();
        mod.initTauriTheme(pushSpy);
        await vi.advanceTimersByTimeAsync(0);
        mod.setNativeTheme("dark");
        await vi.advanceTimersByTimeAsync(4000);
        expect(nativeThemeToasts()).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not toast while rungs remain — a transient failure the ladder repairs is silent", async () => {
      // A SHAPE guard, not a regression pin, and it is labelled as one because it
      // passes with the toast deleted entirely. What it catches is the toast being
      // hoisted above the `retryAttempts < MAX_PUSH_RETRIES` branch: a `warning`
      // notification never expires (`shared/types.ts`), so one raised on rung 1 for
      // a failure that repairs itself 500 ms later is permanent noise in the
      // activity tray.
      vi.useFakeTimers();
      try {
        vi.stubGlobal("document", { hasFocus: () => false });
        const { initTauriTheme, setNativeTheme } = await import(
          "../../src/client/hooks/useTauriTheme.svelte.js"
        );
        initTauriTheme(pushSpy);
        await vi.advanceTimersByTimeAsync(0);
        rejectPushWith(new Error("set_theme failed: boom"));
        pushSpy.mockClear();

        setNativeTheme("dark");
        // 1600 ms covers the initial push and the first two retries (500 + 1000);
        // the third rung is armed for 2000 ms later, so the ladder is NOT spent.
        await vi.advanceTimersByTimeAsync(1600);

        expect(callsFor(invoke, "set_native_theme").length).toBeGreaterThan(1);
        expect(nativeThemeToasts()).toHaveLength(0);
        // Silent to the USER, not to a bug report: a push that eventually
        // succeeds on rung 3 is still evidence, so the rungs are recorded.
        const retries = await entries(/^set_native_theme push failed; retrying$/);
        expect(retries).toHaveLength(1);
        expect(retries[0].count).toBe(3); // one per rejection, coalesced by cause
      } finally {
        vi.useRealTimers();
      }
    });

    // -------- #1368's error code, consumed --------

    it("names the native cause at exhaustion, and carries Rust's own sentence as the detail", async () => {
      // Before #1368 these four arrived as four English sentences the client could
      // not tell apart; the code is what separates them, and `event` must be a
      // static literal, so the classification has to live in the branch. The
      // `detail` half matters independently: `describeCause` reads only
      // `name`/`message` off an object and a `NativeThemeError` has no `name`, so
      // passing the rejection straight through would record the bare word "Object".
      const cases: [string, string, RegExp][] = [
        [
          "high-contrast-unknown",
          "could not determine the High Contrast setting; declined to force an app mode and released any prior override",
          /High Contrast state is unknown/,
        ],
        ["set-theme-failed", "SetWindowTheme failed", /could not set the theme/],
        ["app-mode-timeout", "timed out waiting for the main thread", /app-mode call timed out/],
        ["main-thread-unavailable", "no main thread", /main thread was unavailable/],
      ];
      for (const [code, message, expected] of cases) {
        vi.useFakeTimers();
        try {
          vi.stubGlobal("document", { hasFocus: () => false });
          const mod = await import("../../src/client/hooks/useTauriTheme.svelte.js");
          const { _resetClientLog } = await import("../../src/client/utils/client-log.js");
          mod._resetForTests();
          _resetClientLog();
          mod.initTauriTheme(pushSpy);
          await vi.advanceTimersByTimeAsync(0);
          rejectPushWith({ code, message });

          mod.setNativeTheme("dark");
          await vi.advanceTimersByTimeAsync(4000);

          const matched = await entries(expected);
          expect(matched, `code=${code}`).toHaveLength(1);
          expect(matched[0].detail, `code=${code}`).toContain(message);
          // Exactly one "gave up" line, so a future edit cannot emit both the
          // classified branch and a generic fallback.
          expect(await entries(/^set_native_theme gave up/), `code=${code}`).toHaveLength(1);
        } finally {
          vi.useRealTimers();
        }
      }
    });

    it("says the push never reached the native layer when the rejection carries no code", async () => {
      // `null` from `nativeThemeErrorCode` is an ANSWER, not a parse failure: a
      // dynamic-import failure, a renamed command or a sidecar older than #1368 all
      // land here, and none of them is a Rust refusal. Recording them as one would
      // send a maintainer looking at the wrong side of the IPC boundary.
      vi.useFakeTimers();
      try {
        vi.stubGlobal("document", { hasFocus: () => false });
        const { initTauriTheme, setNativeTheme } = await import(
          "../../src/client/hooks/useTauriTheme.svelte.js"
        );
        initTauriTheme(pushSpy);
        await vi.advanceTimersByTimeAsync(0);
        rejectPushWith(new TypeError("invokeRef is not a function"));

        setNativeTheme("dark");
        await vi.advanceTimersByTimeAsync(4000);

        const matched = await entries(/never reached the native layer/);
        expect(matched).toHaveLength(1);
        expect(matched[0].detail).toContain("TypeError: invokeRef is not a function");
      } finally {
        vi.useRealTimers();
      }
    });

    // -------- item 2 (as it actually occurs): degraded outcomes that RESOLVE --------

    it("records a High Contrast decline, which resolves successfully and never reaches the .catch", async () => {
      // The issue frames this as the `Unknown` probe failing, but that is not the
      // state that occurs: `HighContrast::On` makes Rust decline the force and
      // return `Ok`, so the promise RESOLVES and the `.catch` is never entered.
      // Before this row the only client-side record of "the right-click menu
      // stopped following my theme" was an outcome the client threw away.
      //
      // Recorder-only, and the second half of this test is what pins that: #1368
      // deliberately raises no toast here, because a High Contrast decline is the
      // user's own accessibility setting winning.
      const { initTauriTheme, setNativeTheme } = await import(
        "../../src/client/hooks/useTauriTheme.svelte.js"
      );
      initTauriTheme(pushSpy);
      invoke.mockImplementation((cmd: string) =>
        cmd === "set_native_theme"
          ? Promise.resolve({
              overrideActive: false,
              osTheme: null,
              applied: "declined-high-contrast",
            })
          : Promise.resolve("light"),
      );
      setNativeTheme("dark");
      await flushAsync();

      expect(await entries(/High Contrast is active/)).toHaveLength(1);
      expect(nativeThemeToasts()).toHaveLength(0);
    });

    it("records a missing menu flush, which #1368 deliberately leaves untoasted", async () => {
      const { initTauriTheme, setNativeTheme } = await import(
        "../../src/client/hooks/useTauriTheme.svelte.js"
      );
      initTauriTheme(pushSpy);
      invoke.mockImplementation((cmd: string) =>
        cmd === "set_native_theme"
          ? Promise.resolve({
              overrideActive: false,
              osTheme: null,
              applied: "applied-without-menu-flush",
            })
          : Promise.resolve("light"),
      );
      setNativeTheme("dark");
      await flushAsync();

      expect(await entries(/open menus keep the old theme/)).toHaveLength(1);
      expect(nativeThemeToasts()).toHaveLength(0);
    });

    it("counts every unsupported-host push, though #1368's toast fires only once", async () => {
      // The recorder row sits OUTSIDE `unsupportedHostToasted` on purpose: the
      // toast is a notification and fires once, the record is evidence and counts.
      // Two DIFFERENT preferences, so the module's own dedupe latch cannot be what
      // produces the single entry — that has to be `record()` coalescing.
      const { initTauriTheme, setNativeTheme } = await import(
        "../../src/client/hooks/useTauriTheme.svelte.js"
      );
      initTauriTheme(pushSpy);
      invoke.mockImplementation((cmd: string) =>
        cmd === "set_native_theme"
          ? Promise.resolve({ overrideActive: false, osTheme: null, applied: "unsupported-host" })
          : Promise.resolve("light"),
      );
      setNativeTheme("dark");
      await flushAsync();
      setNativeTheme("light");
      await flushAsync();

      expect(callsFor(invoke, "set_native_theme")).toHaveLength(2);
      const matched = await entries(/unsupported on this host/);
      expect(matched).toHaveLength(1);
      expect(matched[0].count).toBe(2);
      expect(nativeThemeToasts()).toHaveLength(1);
    });

    // -------- item 3: the poll's import re-acquisition --------

    it("records each failed re-acquisition of the invoke import", async () => {
      // The empty catch this replaces justified itself with "already logged by the
      // init path". That is false in the case that matters: the init path logs the
      // FIRST failure, at startup, and a chunk fetch that starts failing twenty
      // minutes later is a different event it could not have logged.
      vi.useFakeTimers();
      try {
        vi.stubGlobal("document", { hasFocus: () => true });
        coreImportBroken.current = true;
        const { initTauriTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
        initTauriTheme(pushSpy);
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

        const matched = await entries(/could not re-acquire the invoke import/);
        expect(matched).toHaveLength(1);
        expect(matched[0].count).toBe(3); // one per attempt, coalesced by cause
        // Scope-only filtering would also pick up the init path's own import
        // failure; these are two different events and must stay distinguishable.
        expect(await entries(/^Tauri API import failed$/)).toHaveLength(1);
      } finally {
        coreImportBroken.current = false;
        vi.useRealTimers();
      }
    });

    it("stops the poll, loudly, once it gives up re-acquiring the invoke import", async () => {
      // On Windows the poll is the PRIMARY mechanism (onThemeChanged reliability
      // for app-mode-only flips is undocumented), so this point is where the app
      // stops following the OS theme for the rest of the session — and it used to
      // be a bare `return` that emitted nothing and left the interval firing every
      // three seconds forever, doing nothing.
      //
      // `vi.getTimerCount()` is the assertion because the interval's inertness is
      // exactly why a call-count assertion cannot see this: with `invokeRef` null
      // and the budget spent, `get_app_theme` is not called either way. The timer
      // count is the only observable that distinguishes "dead but running" from
      // "stopped".
      vi.useFakeTimers();
      try {
        vi.stubGlobal("document", { hasFocus: () => true });
        coreImportBroken.current = true;
        const { initTauriTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
        initTauriTheme(pushSpy);

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3); // budget spent, not yet spent-and-checked
        expect(await entries(/gave up re-acquiring/)).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(1); // the poll interval, still live

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // the tick that gives up
        expect(await entries(/gave up re-acquiring/)).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        coreImportBroken.current = false;
        vi.useRealTimers();
      }
    });

    it("spends the import budget on failed attempts, not on ticks that watch one", async () => {
      // The give-up above became TERMINAL (`stopPoll()`), which turns a miscounted
      // budget into a dead bridge rather than a wasted interval. `getInvoke()` memoizes
      // `invokePromise` and clears it only on REJECTION, so while one import is pending
      // every tick gets that same promise back: counting ticks would spend all three
      // attempts on ONE slow import, give up at tick 4, and stop the poll — and then
      // the import could still resolve, set `invokeRef`, and find no interval left to
      // use it. The OS-theme poll would be dead for the session.
      //
      // The gate is what makes that expressible: the throwing getter used by the two
      // tests above can only say "the chunk failed", never "the chunk is still
      // loading". `vi.resetModules()` is required because a mock factory's result is
      // memoized after its first call.
      vi.useFakeTimers();
      let release!: () => void;
      try {
        vi.stubGlobal("document", { hasFocus: () => true });
        coreImportGate.current = new Promise<void>((r) => {
          release = r;
        });
        vi.resetModules();
        const mod = await import("../../src/client/hooks/useTauriTheme.svelte.js");
        mod.initTauriTheme(pushSpy);

        // Five ticks — well past MAX_POLL_IMPORT_ATTEMPTS — with the import still in
        // flight the whole time. Nothing has failed, so nothing may be given up on.
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
        const log = await import("../../src/client/utils/client-log.js");
        expect(
          log.readClientLog().filter((e) => /gave up re-acquiring/.test(e.event)),
        ).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(1); // the poll interval, still live

        // The slow import lands. The poll must still be there to use it.
        release();
        coreImportGate.current = null;
        invokeMock.mockClear();
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
        expect(callsFor(invokeMock, "get_app_theme").length).toBeGreaterThan(0);
      } finally {
        release?.();
        coreImportGate.current = null;
        vi.useRealTimers();
      }
    });

    // -------- item 4: an outage's shape, not just its start --------

    it("escalates a sustained poll outage instead of reporting it once, ever", async () => {
      // `pollErrorLogged` was reset only by a SUCCESSFUL poll, so a permanently
      // failing poll produced exactly one line per session and a 15-second outage
      // was indistinguishable from a three-hour one.
      //
      // The predicate is anchored on the two poll events specifically. This
      // scenario also fails the boot `get_app_theme` fetch, which records a THIRD
      // entry under the same scope — a scope-only filter would count it and pass
      // for the wrong reason.
      vi.useFakeTimers();
      try {
        vi.stubGlobal("document", { hasFocus: () => true });
        invoke.mockImplementation((cmd: string) =>
          cmd === "get_app_theme"
            ? Promise.reject(new Error("poll boom"))
            : Promise.resolve({ overrideActive: false, osTheme: null }),
        );
        const { initTauriTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
        initTauriTheme(pushSpy);
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 6);

        // Failure 1 → "theme poll failed"; failure 5 → "theme poll still failing";
        // 2-4 and 6 are silent. Exactly two, not six and not one.
        expect(await entries(/^theme poll (failed|still failing)$/)).toHaveLength(2);
        expect(await entries(/^get_app_theme boot fetch failed$/)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("escalates geometrically, so a long outage is distinguishable from a short one", async () => {
      // The rung ladder is 5 → 25 → 125 → …, and the event string is static, so
      // successive rungs COALESCE into one entry whose `firstAt`/`at`/`count`
      // bracket the outage. Without `nextEscalation *= 5` the second rung never
      // arrives and a three-hour outage renders identically to a fifteen-second one.
      vi.useFakeTimers();
      try {
        vi.stubGlobal("document", { hasFocus: () => true });
        invoke.mockImplementation((cmd: string) =>
          cmd === "get_app_theme"
            ? Promise.reject(new Error("poll boom"))
            : Promise.resolve({ overrideActive: false, osTheme: null }),
        );
        const { initTauriTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
        initTauriTheme(pushSpy);
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 25);

        const matched = await entries(/^theme poll still failing$/);
        expect(matched).toHaveLength(1);
        expect(matched[0].count).toBe(2); // failure 5 and failure 25
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports a second outage after a recovery, rather than staying suppressed", async () => {
      // The one-shot latch made the SECOND outage of a session invisible. The
      // counter has to go back to zero on a successful tick for the next failure to
      // be reported at all — and the `count` is what shows it did.
      vi.useFakeTimers();
      try {
        vi.stubGlobal("document", { hasFocus: () => true });
        let failPoll = true;
        invoke.mockImplementation((cmd: string) => {
          if (cmd !== "get_app_theme")
            return Promise.resolve({ overrideActive: false, osTheme: null });
          return failPoll ? Promise.reject(new Error("poll boom")) : Promise.resolve("light");
        });
        const { initTauriTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
        initTauriTheme(pushSpy);

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // outage 1, failure 1
        failPoll = false;
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // recovery
        failPoll = true;
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // outage 2, failure 1 again

        const matched = await entries(/^theme poll failed$/);
        expect(matched).toHaveLength(1);
        expect(matched[0].count).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("records the END of a sustained outage, which is the only thing that bounds it", async () => {
      // This used to be a `console.info` proposal, which writes the one signal that
      // bounds an outage into precisely the sink this whole issue is about. Gated
      // on the outage having escalated, so an ordinary single blip adds no line.
      vi.useFakeTimers();
      try {
        vi.stubGlobal("document", { hasFocus: () => true });
        let failPoll = true;
        invoke.mockImplementation((cmd: string) => {
          if (cmd !== "get_app_theme")
            return Promise.resolve({ overrideActive: false, osTheme: null });
          return failPoll ? Promise.reject(new Error("poll boom")) : Promise.resolve("light");
        });
        const { initTauriTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
        initTauriTheme(pushSpy);

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
        expect(await entries(/recovered after a sustained outage/)).toHaveLength(0);

        failPoll = false;
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        expect(await entries(/recovered after a sustained outage/)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not report a recovery for a single blip", async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal("document", { hasFocus: () => true });
        let failPoll = true;
        invoke.mockImplementation((cmd: string) => {
          if (cmd !== "get_app_theme")
            return Promise.resolve({ overrideActive: false, osTheme: null });
          return failPoll ? Promise.reject(new Error("poll boom")) : Promise.resolve("light");
        });
        const { initTauriTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
        initTauriTheme(pushSpy);

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        failPoll = false;
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

        expect(await entries(/^theme poll failed$/)).toHaveLength(1);
        expect(await entries(/recovered after a sustained outage/)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    // -------- item 6: the catch sites the fallback comment never covered --------

    it("records a teardown unlisten failure instead of dropping it on the floor", async () => {
      // Teardown hygiene, and the least visible of the conversions: it fires from
      // `_resetForTests`, `teardown()` and the HMR dispose race, none of which a
      // user is watching. Kept recorder-only — there is nothing for a user to do
      // about it and the page is going away.
      const mod = await import("../../src/client/hooks/useTauriTheme.svelte.js");
      mod.initTauriTheme(pushSpy);
      await flushAsync();
      unlistenSpy.mockImplementationOnce(() => {
        throw new Error("unlisten boom");
      });

      mod._resetForTests();

      const matched = await entries(/^onThemeChanged unlisten failed$/);
      expect(matched).toHaveLength(1);
      expect(matched[0].detail).toContain("Error: unlisten boom");
    });

    it("the module's source contains no reference to `console` outside comments", () => {
      // THIS IS A SPELLING CHECK, NOT A SEMANTIC ONE, and the name says only what it
      // can actually verify. It reads source text. It cannot tell that a failure is
      // reported at all: a converted site turned back into an empty `catch {}` is
      // invisible to it by construction, and that is the exact defect shape this file
      // shipped for months. The behavioural tests above are what pin reporting; this
      // pins only that no *new* site can quietly choose the console again.
      // (`tests/shared/unc-check-duplication.test.ts` labels a check of this shape the
      // same way — the honesty, not the mechanism, is what is being copied.)
      //
      // Why it is worth having anyway: four of the converted sites are genuinely hard
      // to drive from a test — the superseded-rejection branch, the `onThemeChanged`
      // subscribe failure, the window-API import failure and the disposed-branch
      // unlisten each need a second throwing module seam to reach — and a per-site
      // behavioural test for each would cost more than it pins. The framing fact of
      // #1413 is structural: in a shipped desktop build there is no WebView console
      // (`tauri-plugin-log` declares no `TargetKind::Webview`, nothing calls
      // `attachConsole`, and the release build has no devtools feature), so a
      // `console.*` call in THIS module is by definition a failure path with no reader.
      //
      // `logClientWarning` still writes the identical console line, so nothing is lost
      // for a developer with an inspector open — the rule is about the call site.
      const src = readFileSync(
        join(import.meta.dirname, "..", "..", "src", "client", "hooks", "useTauriTheme.svelte.ts"),
        "utf8",
      );
      // Comments are stripped rather than pattern-excluded, so the module's prose may
      // go on naming `console.warn` as the thing it stopped doing while the check
      // itself matches the bare IDENTIFIER. A call-shaped regex (`console\.warn\s*\(`)
      // was the first version of this and it false-passes on every aliasing shape:
      // `console.warn.bind(console)`, `console["warn"](…)`, `const { warn } = console`.
      // Matching `console` at all costs nothing here — the module has no legitimate
      // use for it — and closes all of them at once.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code.match(/\bconsole\b/g) ?? []).toEqual([]);
      // A floor, so deleting the recorder calls outright cannot pass the check above
      // by emptying the file of both. Set to the EXACT current count, not a loose
      // fraction of it: at a loose floor the four sites with no behavioural test could
      // be deleted for free, which is the hole this number exists to close. Raising it
      // when a site is added is free; lowering it is the deliberate act it should be.
      expect((src.match(/\blogClientWarning\s*\(/g) ?? []).length).toBeGreaterThanOrEqual(21);
    });

    // -------- teardown must invalidate pushes, not just cancel armed timers --------

    it("a real pagehide stops a ladder that an in-flight rejection would otherwise re-arm", async () => {
      // `teardown()` calls `cancelRetry()`, which clears a timer that is ALREADY
      // waiting. It cannot reach a `set_native_theme` promise still in flight, and
      // that promise's `.catch` re-arms the ladder as soon as it passes its
      // `seq === pushSeq` check — so without the `pushSeq++` in `teardown`, a torn-down
      // module keeps climbing rungs and can toast on exhaustion through a `_notify`
      // that teardown does not reset. `_resetForTests` hides this by accident (it sets
      // `pushSeq = 0`, which makes any captured `seq >= 1` look superseded), so the
      // test has to drive the REAL `pagehide` path to see it at all.
      //
      // The push is held open deliberately: an immediately-rejecting mock settles
      // before `pagehide` can land, which is the one ordering that cannot exhibit the
      // bug.
      vi.useFakeTimers();
      const addSpy = vi.spyOn(window, "addEventListener");
      try {
        vi.stubGlobal("document", { hasFocus: () => false });
        const { initTauriTheme, setNativeTheme } = await import(
          "../../src/client/hooks/useTauriTheme.svelte.js"
        );
        initTauriTheme(pushSpy);
        await vi.advanceTimersByTimeAsync(0);
        const handler = addSpy.mock.calls.find((c) => c[0] === "pagehide")?.[1] as unknown as (e: {
          persisted: boolean;
        }) => void;
        expect(handler).toBeTypeOf("function");

        let rejectPush: (reason: unknown) => void = () => {};
        invoke.mockImplementation((cmd: string) =>
          cmd === "set_native_theme"
            ? new Promise((_resolve, reject) => {
                rejectPush = reject;
              })
            : Promise.resolve("light"),
        );
        pushSpy.mockClear();

        setNativeTheme("dark");
        await vi.advanceTimersByTimeAsync(0);
        const issued = callsFor(invoke, "set_native_theme").length;
        expect(issued).toBe(1); // the push is in flight, not settled

        handler({ persisted: false }); // real unload -> teardown()
        rejectPush(new Error("set_theme failed: boom"));
        await vi.advanceTimersByTimeAsync(8000); // past every rung of the ladder

        expect(callsFor(invoke, "set_native_theme")).toHaveLength(issued);
        expect(nativeThemeToasts()).toHaveLength(0);
        // Superseded, not silently swallowed: the outcome still reaches the recorder.
        expect(await entries(/superseded/)).toHaveLength(1);
      } finally {
        addSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });
});

/**
 * #1364 — an OS High Contrast toggle must re-issue the CURRENT preference.
 *
 * The Windows guard that declines to force an app mode while High Contrast is on
 * (`native_theme_action`, native_theme.rs) samples `SPI_GETHIGHCONTRAST` once per push, and
 * nothing subscribes to changes. Since the preference has not changed, `createTheme`'s
 * effect does not re-run and the dedupe latch would refuse the push if it did — so the
 * forced app mode stayed in place until the user's next theme change.
 *
 * PLACEMENT AND HARNESS ARE LOAD-BEARING, in this order:
 *
 *  1. This describe sits LAST in the file, and its `beforeEach` starts with
 *     `vi.unstubAllGlobals()`. `describe("setNativeTheme (#992)")`'s own `beforeEach`
 *     never unstubs, so without this the last `vi.stubGlobal("window", …)` above — the
 *     one in "does not accumulate pagehide listeners" — is still in force. Its
 *     `matchMedia` is `inertMatchMedia`, which IGNORES its query argument and returns a
 *     throwaway MediaQueryList, so the SUT registers its listener on an object
 *     `fc.fire()` can never reach. Re-measured against this file as it ships, with only
 *     the `beforeEach` unstub commented out: `typeof window.matchMedia === "function"`,
 *     `window.matchMedia === inertMatchMedia`, the fake's listener count is 0, and
 *     1 of the 6 tests fails — the FIRST one only, because this describe's own
 *     `afterEach` unstubs and tests 2-6 then run against the real happy-dom window.
 *     That masking is itself the argument for keeping the `beforeEach` unstub rather
 *     than leaning on the `afterEach`: relying on it would make the harness depend on
 *     execution order, and a `.only` or a reordering would silently break test 1 alone.
 *     (An earlier version of this note recorded `typeof window.matchMedia ===
 *     "undefined"` and "every test below would fail". That was measured honestly and
 *     then falsified by this very diff, which added `matchMedia` to those ten stubs —
 *     re-measure a comment after the diff stops changing, not when you first write it.)
 *
 *  2. `installForcedColorsFake` hands back the SAME MediaQueryList object for every
 *     `(forced-colors: active)` query, and `fire()` invokes the handlers CAPTURED from
 *     that object's `addEventListener`. happy-dom returns a NEW MediaQueryList per
 *     `matchMedia()` call, so dispatching on a freshly obtained one reaches nothing and
 *     would silently no-op. The test must own the object the SUT received.
 *
 *  3. `afterEach` calls `_resetForTests()` UNCONDITIONALLY rather than each test ending
 *     with it: a failing test would skip a trailing call and leak a live 3s poll (real
 *     `document.hasFocus()` is true once globals are unstubbed) plus a live listener into
 *     whatever runs next. The test at the top of this file exists to catch exactly that.
 *
 * WHICH TESTS ARE LOAD-BEARING (measured against master, not asserted):
 *   - "re-pushes the current preference", "re-pushes on every forced-colors change" and
 *     the listener-lifecycle test are RED before the fix, on the assertion that matters.
 *   - The two GUARD tests below also go red on master, but only on their PRECONDITION —
 *     the re-push they need to follow up never happens. Their own distinguishing
 *     assertions are vacuous there, so read them as shape guards, not as regression
 *     coverage.
 *   - "does not push when no preference has ever been pushed" passes on master and is a
 *     pure guard.
 */
describe("forced-colors re-push (#1364)", () => {
  let invoke: ReturnType<typeof vi.fn>;

  /** The fake `(forced-colors: active)` MediaQueryList — see note 2 above. */
  function installForcedColorsFake(): {
    fire: () => void;
    listenerCount: () => number;
    addCalls: () => number;
    removeCalls: () => number;
  } {
    const listeners = new Set<() => void>();
    let addCalls = 0;
    let removeCalls = 0;
    const realMatchMedia =
      typeof window.matchMedia === "function" ? window.matchMedia.bind(window) : null;
    const mql = {
      matches: false,
      media: "(forced-colors: active)",
      addEventListener: (type: string, cb: () => void) => {
        if (type !== "change") return;
        listeners.add(cb);
        addCalls++;
      },
      removeEventListener: (type: string, cb: () => void) => {
        if (type === "change" && listeners.delete(cb)) removeCalls++;
      },
    };
    vi.stubGlobal("matchMedia", (query: string) =>
      query.includes("forced-colors") ? mql : (realMatchMedia?.(query) ?? inertMatchMedia()),
    );
    return {
      // Copy before iterating: a handler is free to re-register during dispatch.
      fire: () => {
        for (const cb of [...listeners]) cb();
      },
      listenerCount: () => listeners.size,
      addCalls: () => addCalls,
      removeCalls: () => removeCalls,
    };
  }

  beforeEach(async () => {
    vi.unstubAllGlobals(); // FIRST — see note 1 above
    const core = await import("@tauri-apps/api/core");
    invoke = vi.mocked(core.invoke) as any;
    invoke.mockReset();
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

  afterEach(async () => {
    const { _resetForTests } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
    _resetForTests(); // unconditional — see note 3 above
    isTauri.mockReturnValue(false);
    vi.unstubAllGlobals();
  });

  // RED BEFORE THE FIX. Nothing in the module touched `matchMedia` at all, so this
  // asserted 1 against 0.
  it("re-pushes the current preference when forced-colors changes, bypassing the dedupe latch", async () => {
    const fc = installForcedColorsFake();
    const { initTauriTheme, setNativeTheme, _resetForTests } = await import(
      "../../src/client/hooks/useTauriTheme.svelte.js"
    );
    _resetForTests();
    initTauriTheme(pushSpy);
    setNativeTheme("dark");
    await flushAsync();
    expect(callsFor(invoke, "set_native_theme")).toHaveLength(1);

    fc.fire();
    await flushAsync();

    // The SAME preference goes out again — that is the whole point: on Windows,
    // `native_theme_action` re-samples High Contrast and maps "dark" to AllowDark
    // (release) while it is on, and back to ForceDark once it is off.
    expect(callsFor(invoke, "set_native_theme")).toEqual([
      ["set_native_theme", { theme: "dark" }],
      ["set_native_theme", { theme: "dark" }],
    ]);
  });

  // RED BEFORE THE FIX, but only as "the test above with a second event" — it cannot
  // distinguish a correct implementation from one that re-pushes on an unrelated media
  // change. What it pins is that the handler is LEVEL-INDEPENDENT: it never reads
  // `event.matches`, so one code path covers High-Contrast-on and High-Contrast-off, and
  // there is deliberately no `matches` branch in the source to drift out of sync.
  it("re-pushes on every forced-colors change, not just the first (no `matches` branch)", async () => {
    const fc = installForcedColorsFake();
    const { initTauriTheme, setNativeTheme, _resetForTests } = await import(
      "../../src/client/hooks/useTauriTheme.svelte.js"
    );
    _resetForTests();
    initTauriTheme(pushSpy);
    setNativeTheme("dark");
    await flushAsync();

    fc.fire(); // High Contrast on  -> Rust releases the force
    await flushAsync();
    fc.fire(); // High Contrast off -> Rust re-applies it
    await flushAsync();

    expect(callsFor(invoke, "set_native_theme")).toHaveLength(3);
  });

  // GUARD. Measured on master it fails, but only on its PRECONDITION (the re-push it
  // needs to follow up never happens); its own distinguishing assertion — the final
  // `toHaveLength(2)` — is vacuous there. It pins the SHAPE of the
  // fix: the bypass skips the READ of the dedupe latch for one call and clears nothing,
  // so the latch still holds afterwards. An implementation written as
  // `lastPush = null; setNativeTheme(pref)` fails here, and that shape also reopens
  // `acceptReadback`'s in-flight gate and lets `createTheme`'s effect double-push.
  it("GUARD: the bypass does not clear the latch — a later identical push still dedupes", async () => {
    const fc = installForcedColorsFake();
    const { initTauriTheme, setNativeTheme, _resetForTests } = await import(
      "../../src/client/hooks/useTauriTheme.svelte.js"
    );
    _resetForTests();
    initTauriTheme(pushSpy);
    setNativeTheme("dark");
    await flushAsync();
    fc.fire();
    await flushAsync();
    expect(callsFor(invoke, "set_native_theme")).toHaveLength(2);

    setNativeTheme("dark"); // the effect's ordinary re-run — must still no-op
    await flushAsync();

    expect(callsFor(invoke, "set_native_theme")).toHaveLength(2);
  });

  // GUARD (vacuous on master). `lastPush` is this module's only record of the
  // preference, and it is null whenever there is no claim. Pushing `undefined` would be
  // worse than waiting for the next real theme change.
  it("GUARD: does not push when no preference has ever been pushed", async () => {
    const fc = installForcedColorsFake();
    const { initTauriTheme, _resetForTests } = await import(
      "../../src/client/hooks/useTauriTheme.svelte.js"
    );
    _resetForTests();
    initTauriTheme(pushSpy);
    await flushAsync();

    fc.fire();
    await flushAsync();

    expect(callsFor(invoke, "set_native_theme")).toHaveLength(0);
  });

  // GUARD. Like the latch guard above, it fails on master on its PRECONDITION only (no
  // forced push happens there to reject); its own final assertion is vacuous. Pins the
  // accepted limitation: a forced re-push that REJECTS clears `lastPush` (the failure path's
  // unconditional `lastPush = null`), after which the module holds no claim and a further
  // toggle must no-op rather than guess. Reachable in production: `set_native_theme`
  // returns Err whenever the High Contrast probe yields `Unknown`, so on such a machine
  // every toggle lands here.
  it("GUARD: after a rejected forced re-push, a further change no-ops (no claim to re-assert)", async () => {
    const fc = installForcedColorsFake();
    const { initTauriTheme, setNativeTheme, _resetForTests } = await import(
      "../../src/client/hooks/useTauriTheme.svelte.js"
    );
    _resetForTests();
    initTauriTheme(pushSpy);
    setNativeTheme("dark");
    await flushAsync();

    invoke.mockImplementationOnce(() => Promise.reject(new Error("ipc failed")));
    fc.fire();
    await flushAsync();
    expect(callsFor(invoke, "set_native_theme")).toHaveLength(2);

    fc.fire();
    await flushAsync();

    expect(callsFor(invoke, "set_native_theme")).toHaveLength(2);
  });

  // RED BEFORE THE FIX (the `toBe(1)` sees 0). The leak class #1413's landed half closed
  // for `onThemeChanged` and the `pagehide` handler, one function further down: a
  // listener that is registered but never released is structurally unobservable, which is
  // how the earlier leaks went unnoticed.
  it("releases the forced-colors listener on teardown, and does not accumulate", async () => {
    const fc = installForcedColorsFake();
    const { initTauriTheme, _resetForTests } = await import(
      "../../src/client/hooks/useTauriTheme.svelte.js"
    );
    _resetForTests();

    initTauriTheme(pushSpy);
    expect(fc.listenerCount()).toBe(1);
    _resetForTests();
    expect(fc.listenerCount()).toBe(0);

    for (let i = 0; i < 3; i++) {
      initTauriTheme(pushSpy);
      _resetForTests();
    }
    expect(fc.addCalls()).toBe(4); // one per initTauriTheme()
    expect(fc.removeCalls()).toBe(4); // every registered generation released
    expect(fc.listenerCount()).toBe(0);
  });
});
