/**
 * Wiring coverage for `createTheme`'s effect (#992).
 *
 * The `.svelte.test.ts` extension is mandatory here: `$state`/`$effect.root`
 * below are runes, and vite-plugin-svelte only compiles files whose path
 * contains the `.svelte.` infix AND ends in `.js`/`.ts`
 * (`DEFAULT_SVELTE_MODULE_INFIX` / `buildModuleIdFilter` in
 * `@sveltejs/vite-plugin-svelte/src/utils/id.js`) -- any number of segments
 * may sit between, which is why `.svelte.test.ts` qualifies and a plain
 * `.test.ts` does not. A plain `.test.ts` throws
 * `ReferenceError: $state is not defined` even though
 * `tests/client/**\/*.test.ts` still matches the filename for test
 * discovery. Harness shape copied from
 * `tests/client/useAutostart.svelte.test.ts`.
 *
 * `tests/client/useTauriTheme.test.ts` covers `setNativeTheme` /
 * `acceptReadback`'s own logic (dedupe, latch clearing, supersession,
 * read-back gating) directly, but never touches the DOM. This file covers the
 * two things only an end-to-end reactive run can show:
 *
 *  1. the effect calls `setNativeTheme(pref)` with the RAW preference, and
 *  2. an OS theme flip reaches `data-theme` -- the chain
 *     `tauriTheme.current` -> effect re-run -> `applyTheme`, whose only
 *     subscription is the synchronous read inside `systemTheme`.
 *
 * WHAT THIS FILE DOES NOT COVER, stated rather than faked: the effect used to
 * be two sibling `$effect`s and is now one. Restoring the two-effect shape
 * keeps every test here green, because the merge buys ordering-independence
 * and there is no natural assertion for "this would still be correct under a
 * different flush order". Do not read a green run as pinning the merge.
 */
import { flushSync } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

const { isTauri } = vi.hoisted(() => ({ isTauri: vi.fn(() => true) }));
vi.mock("../../src/client/cowork/cowork-helpers.js", () => ({ isTauriRuntime: isTauri }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "set_native_theme") {
      return Promise.resolve({ overrideActive: false, osTheme: null });
    }
    return Promise.resolve("light");
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    onThemeChanged: vi.fn(() => Promise.resolve(() => {})),
  })),
}));

import type { ThemePreference } from "../../src/client/hooks/useTandemSettings.js";
import { _resetForTests, tauriTheme } from "../../src/client/hooks/useTauriTheme.svelte.js";
import { createTheme } from "../../src/client/hooks/useTheme.svelte.js";

/** Filters `invoke.mock.calls` to a single command — mirrors
 * useTauriTheme.test.ts so a stray poll tick can't flake a count. */
function callsFor(invoke: { mock: { calls: unknown[][] } }, cmd: string): unknown[][] {
  return invoke.mock.calls.filter(([c]) => c === cmd);
}

/** Drain the microtask queue (dynamic import + invoke chain) and flush the
 * pending Svelte effect queue. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

describe("createTheme effect wiring (#992)", () => {
  // Hoisted so teardown is UNCONDITIONAL. Every test used to call `cleanup()`
  // after its assertions, so the first genuine failure skipped teardown and
  // leaked a live `$effect.root` still subscribed to `tauriTheme.current`,
  // plus a stale `data-theme` on the shared documentElement. The next
  // `afterEach` then wrote `tauriTheme.current = null`, which SCHEDULED the
  // orphan — and the leaked attribute could satisfy a later test's
  // `data-theme` assertion for the wrong reason. One failure cascaded into
  // false passes.
  let cleanup: (() => void) | undefined;

  afterEach(async () => {
    cleanup?.();
    cleanup = undefined;
    document.documentElement.removeAttribute("data-theme");
    _resetForTests();
    isTauri.mockReturnValue(true);
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();
  });

  it("pushes the raw, unresolved preference to set_native_theme on init", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();

    const pref: ThemePreference = "dark";
    cleanup = $effect.root(() => {
      createTheme(() => pref);
    });
    await settle();

    expect(callsFor(invoke, "set_native_theme")).toEqual([["set_native_theme", { theme: "dark" }]]);
  });

  it("also applies the theme to the DOM from the same effect", async () => {
    const pref: ThemePreference = "dark";
    cleanup = $effect.root(() => {
      createTheme(() => pref);
    });
    await settle();

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("re-pushes to set_native_theme when the reactive preference changes", async () => {
    let pref = $state<ThemePreference>("light");
    cleanup = $effect.root(() => {
      createTheme(() => pref);
    });
    await settle();

    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();

    pref = "dark";
    flushSync();
    await settle();

    expect(callsFor(invoke, "set_native_theme")).toEqual([["set_native_theme", { theme: "dark" }]]);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("does not push to set_native_theme in browser mode, but still applies the DOM theme", async () => {
    isTauri.mockReturnValue(false);
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();

    const pref: ThemePreference = "dark";
    cleanup = $effect.root(() => {
      createTheme(() => pref);
    });
    await settle();

    expect(callsFor(invoke, "set_native_theme")).toHaveLength(0);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("an OS theme flip re-resolves a 'system' pref onto the DOM", async () => {
    // The chain nothing used to cover: `useTheme.test.ts` calls `applyTheme`
    // directly and seeds via `__TANDEM_INITIAL_THEME__`, and
    // `useTauriTheme.test.ts` never touches the DOM. Without this, the only
    // thing standing behind the effect's subscription to `tauriTheme.current`
    // was a comment -- and that comment was wrong about where the
    // subscription came from.
    const pref: ThemePreference = "system";
    cleanup = $effect.root(() => {
      createTheme(() => pref);
    });
    await settle();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    // Stands in for onThemeChanged / the poll / a release round trip -- all
    // three land here.
    tauriTheme.current = "dark";
    flushSync();

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("an OS theme flip does NOT re-run the effect under an explicit pref", async () => {
    // The counterpart, and the reason the effect must not carry a bare
    // `void tauriTheme.current`: under an explicit preference an OS flip
    // cannot change the resolved output, so it must not re-run the effect at
    // all.
    //
    // Counts effect runs via the `getPref` getter rather than watching
    // `data-theme`. A MutationObserver here looks equivalent and is NOT: the
    // re-run removes and re-sets the attribute to the SAME value inside one
    // synchronous flush, which this harness does not surface — measured, the
    // observer version passed with the bare read restored, i.e. it was hollow.
    let runs = 0;
    const getPref = (): ThemePreference => {
      runs++;
      return "dark";
    };
    cleanup = $effect.root(() => {
      createTheme(getPref);
    });
    await settle();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    // Must differ from the value the boot `get_app_theme` fetch already
    // wrote ("light"): a `$state` re-assigned to an equal value notifies
    // nothing, so flipping to "light" here would pass vacuously.
    expect(tauriTheme.current).toBe("light");
    const before = runs;
    tauriTheme.current = "dark";
    flushSync();

    expect(runs).toBe(before);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
