import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTheme, systemTheme } from "../../src/client/hooks/useTheme.js";

describe("systemTheme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 'light' when window is undefined (SSR/Node)", () => {
    // No window stub — globalThis.window is absent in the vitest node env.
    expect(systemTheme()).toBe("light");
  });

  it("returns 'dark' when matchMedia matches the dark-scheme query", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    expect(systemTheme()).toBe("dark");
  });

  it("returns 'light' when matchMedia does not match", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    expect(systemTheme()).toBe("light");
  });

  it("returns 'light' when matchMedia throws (old WebViews/jsdom quirks)", () => {
    vi.stubGlobal("window", {
      matchMedia: () => {
        throw new Error("no matchMedia");
      },
    });
    expect(systemTheme()).toBe("light");
  });
});

describe("resolveTheme", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes 'light' through", () => {
    expect(resolveTheme("light")).toBe("light");
  });

  it("passes 'dark' through", () => {
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("delegates 'system' to the current systemTheme() result", () => {
    expect(resolveTheme("system")).toBe("light");
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    expect(resolveTheme("system")).toBe("dark");
  });
});
