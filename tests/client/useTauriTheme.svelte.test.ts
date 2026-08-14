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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "set_native_theme") {
      return Promise.resolve({ overrideActive: false, osTheme: null });
    }
    return Promise.resolve("light");
  }),
}));

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
    vi.stubGlobal("window", { addEventListener: vi.fn(), __TANDEM_INITIAL_THEME__: undefined });

    initTauriTheme();
    await flushAsync();
    expect(callsFor(invoke, "get_app_theme")).toHaveLength(1);

    initTauriTheme(); // guarded by _initialized — must not re-run
    await flushAsync();
    expect(callsFor(invoke, "get_app_theme")).toHaveLength(1);

    _resetForTests();
    initTauriTheme();
    await flushAsync();
    expect(callsFor(invoke, "get_app_theme")).toHaveLength(2);
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

describe("setNativeTheme (#992)", () => {
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
    vi.stubGlobal("window", { addEventListener: vi.fn(), __TANDEM_INITIAL_THEME__: undefined });
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_app_theme") return Promise.resolve("light");
      return Promise.resolve({ overrideActive: true, osTheme: null });
    });
    initTauriTheme();
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
    vi.stubGlobal("window", { addEventListener: vi.fn(), __TANDEM_INITIAL_THEME__: undefined });
    // hasFocus false so no poll tick can confound the assertions below.
    vi.stubGlobal("document", { hasFocus: () => false });
    // invoke default comes from beforeEach; the two commands in play behave identically.

    initTauriTheme();
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
      const { setNativeTheme, initTauriTheme, _resetForTests } = await import(
        "../../src/client/hooks/useTauriTheme.svelte.js"
      );
      vi.stubGlobal("window", { addEventListener: vi.fn(), __TANDEM_INITIAL_THEME__: undefined });
      vi.stubGlobal("document", { hasFocus: () => false });
      // invoke default comes from beforeEach; the two commands in play behave identically.

      initTauriTheme();
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
    vi.stubGlobal("window", { addEventListener: vi.fn(), __TANDEM_INITIAL_THEME__: undefined });
    vi.stubGlobal("document", { hasFocus: () => false });
    invoke.mockImplementation((cmd: string) =>
      cmd === "get_app_theme" ? Promise.resolve("dark") : new Promise(() => {}),
    );

    initTauriTheme();
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
      vi.stubGlobal("window", { addEventListener: vi.fn(), __TANDEM_INITIAL_THEME__: undefined });
      vi.stubGlobal("document", { hasFocus: () => false });

      invoke.mockImplementation((cmd: string) =>
        cmd === "get_app_theme"
          ? Promise.resolve("light")
          : Promise.resolve({ overrideActive: true, osTheme: null }),
      );
      initTauriTheme();
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
      initTauriTheme();
      // Let the dynamic import() of @tauri-apps/api/window resolve.
      await vi.waitFor(() => expect(themeChangedCapture.current).not.toBeNull());

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
        initTauriTheme();
        await vi.waitFor(() => expect(subscribeCount.current).toBe(i + 1));
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
      initTauriTheme();
      await vi.waitFor(() => expect(subscribeCount.current).toBe(1));
      _resetForTests();
      initTauriTheme();
      await vi.waitFor(() => expect(subscribeCount.current).toBe(2));
      expect(themeChangedCapture.current).not.toBeNull();
    });
  });
});
