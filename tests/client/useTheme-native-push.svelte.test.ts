/**
 * Wiring coverage for `createTheme`'s merged effect (#1362 rev2, B4).
 *
 * The `.svelte.test.ts` extension is mandatory here: `$state`/`$effect.root`
 * below are runes, and only files vite-plugin-svelte recognizes as Svelte
 * modules (`*.svelte`, `*.svelte.js`, `*.svelte.ts` -- the ".svelte." infix,
 * not merely a trailing ".ts") get compiled. A plain `.test.ts` throws
 * `ReferenceError: $state is not defined` even though
 * `tests/client/**\/*.test.ts` still matches the filename for test
 * discovery. Harness shape copied from
 * `tests/client/useAutostart.svelte.test.ts` (`$effect.root` + `flushSync()`
 * + a microtask-drain `settle()` helper).
 *
 * `tests/client/useTauriTheme.test.ts` covers `setNativeTheme` /
 * `acceptReadback`'s own logic (dedupe, rollback, supersession, read-back
 * gating) directly. This file covers only the WIRING: that `createTheme`'s
 * single merged `$effect` actually calls `setNativeTheme(pref)` before
 * returning `applyTheme(...)`'s cleanup -- end to end, through a real
 * reactive `$state` getter, against the real `setNativeTheme` (not a mock of
 * it), so that deleting the `setNativeTheme(pref)` line from the merged
 * effect turns this file red.
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
import { _resetForTests } from "../../src/client/hooks/useTauriTheme.svelte.js";
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

describe("createTheme merged effect (#992 rev2, B4)", () => {
  afterEach(async () => {
    _resetForTests();
    isTauri.mockReturnValue(true);
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();
  });

  it("pushes the raw, unresolved preference to set_native_theme on init", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();

    const pref: ThemePreference = "dark";
    const cleanup = $effect.root(() => {
      createTheme(() => pref);
    });
    await settle();

    expect(callsFor(invoke, "set_native_theme")).toEqual([["set_native_theme", { theme: "dark" }]]);
    cleanup();
  });

  it("also applies the theme to the DOM from the same effect", async () => {
    const pref: ThemePreference = "dark";
    const cleanup = $effect.root(() => {
      createTheme(() => pref);
    });
    await settle();

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    cleanup();
  });

  it("re-pushes to set_native_theme when the reactive preference changes", async () => {
    let pref = $state<ThemePreference>("light");
    const cleanup = $effect.root(() => {
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
    cleanup();
  });

  it("does not push to set_native_theme in browser mode, but still applies the DOM theme", async () => {
    isTauri.mockReturnValue(false);
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();

    const pref: ThemePreference = "dark";
    const cleanup = $effect.root(() => {
      createTheme(() => pref);
    });
    await settle();

    expect(callsFor(invoke, "set_native_theme")).toHaveLength(0);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    cleanup();
  });
});
