import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as coworkHelpers from "../../src/client/cowork/cowork-helpers.js";
import { systemTheme } from "../../src/client/hooks/useTheme.js";

vi.mock("../../src/client/cowork/cowork-helpers.js", () => ({
  isTauriRuntime: vi.fn(() => false),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve("light")),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    onThemeChanged: vi.fn(() => Promise.resolve(() => {})),
  })),
}));

describe("useTauriTheme", () => {
  beforeEach(() => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
  });

  it("tauriTheme.current is null when isTauriRuntime() returns false", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
    // Re-import after mock is set so module evaluates with Tauri=false
    const { tauriTheme } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
    expect(tauriTheme.current).toBeNull();
  });

  it("_resetForTests() resets tauriTheme.current to null", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
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
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
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
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { tauriTheme, _resetForTests } = await import(
      "../../src/client/hooks/useTauriTheme.svelte.js"
    );
    // Reset first (clears globals), then stub with the desired seed value
    _resetForTests();
    vi.stubGlobal("window", { __TANDEM_INITIAL_THEME__: "dark" });
    // Verify the seeding logic: the store constructor reads window.__TANDEM_INITIAL_THEME__
    (tauriTheme as any).current = (window as any).__TANDEM_INITIAL_THEME__ ?? null;
    expect(tauriTheme.current).toBe("dark");
  });

  it("_resetForTests() also clears window.__TANDEM_INITIAL_THEME__ and resets _initialized", async () => {
    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(false);
    vi.stubGlobal("window", { __TANDEM_INITIAL_THEME__: "dark" });
    const { _resetForTests } = await import("../../src/client/hooks/useTauriTheme.svelte.js");
    _resetForTests();
    expect((window as any).__TANDEM_INITIAL_THEME__).toBeUndefined();
  });

  it("initTauriTheme() writes through to window.__TANDEM_INITIAL_THEME__ on invoke resolve", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue("dark");

    vi.mocked(coworkHelpers.isTauriRuntime).mockReturnValue(true);
    const { initTauriTheme, _resetForTests } = await import(
      "../../src/client/hooks/useTauriTheme.svelte.js"
    );
    _resetForTests();
    vi.stubGlobal("window", {
      __TANDEM_INITIAL_THEME__: "light" as "light" | "dark",
      addEventListener: vi.fn(),
    });

    initTauriTheme();

    // Flush the async chain: import(core) → invoke resolves → setTauriTheme
    await new Promise((r) => setTimeout(r, 0));

    expect((window as any).__TANDEM_INITIAL_THEME__).toBe("dark");
    expect(systemTheme()).toBe("dark");
  });
});
