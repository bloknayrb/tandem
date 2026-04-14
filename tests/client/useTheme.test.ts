import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, resolveTheme, systemTheme } from "../../src/client/hooks/useTheme.js";

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

/**
 * Exercise applyTheme — the side-effect core of useTheme — against stubbed
 * document/window globals. This covers the useEffect body directly without
 * pulling in a DOM environment (jsdom/happy-dom aren't installed here; the
 * hook body is a one-liner over applyTheme).
 */
describe("useTheme — DOM side effects (via applyTheme)", () => {
  type Listener = (evt: { matches: boolean }) => void;

  /** Minimal stubs for document.documentElement and window.matchMedia. */
  function installDomStubs(matchesDark = false) {
    const attrs = new Map<string, string>();
    const root = {
      setAttribute: (name: string, value: string) => {
        attrs.set(name, value);
      },
      removeAttribute: (name: string) => {
        attrs.delete(name);
      },
      getAttribute: (name: string) => attrs.get(name) ?? null,
    };
    const listeners = new Set<Listener>();
    const mq = {
      matches: matchesDark,
      addEventListener: (_: string, fn: Listener) => {
        listeners.add(fn);
      },
      removeEventListener: (_: string, fn: Listener) => {
        listeners.delete(fn);
      },
    };
    vi.stubGlobal("document", { documentElement: root });
    vi.stubGlobal("window", { matchMedia: () => mq });
    return {
      attrs,
      listeners,
      // Simulate the OS flipping prefers-color-scheme
      fireChange: (matches: boolean) => {
        mq.matches = matches;
        for (const fn of listeners) fn({ matches });
      },
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sets data-theme='light' when pref is 'light'", () => {
    const { attrs } = installDomStubs();
    applyTheme("light");
    expect(attrs.get("data-theme")).toBe("light");
  });

  it("sets data-theme='dark' when pref is 'dark'", () => {
    const { attrs } = installDomStubs();
    applyTheme("dark");
    expect(attrs.get("data-theme")).toBe("dark");
  });

  it("cleanup removes data-theme (non-system pref)", () => {
    const { attrs } = installDomStubs();
    const cleanup = applyTheme("dark");
    expect(attrs.get("data-theme")).toBe("dark");
    cleanup();
    expect(attrs.get("data-theme")).toBeUndefined();
  });

  it("with pref='system' and matchMedia dark, sets 'dark'", () => {
    const { attrs } = installDomStubs(true);
    applyTheme("system");
    expect(attrs.get("data-theme")).toBe("dark");
  });

  it("with pref='system', matchMedia change listener re-applies theme", () => {
    const { attrs, fireChange } = installDomStubs(false);
    applyTheme("system");
    expect(attrs.get("data-theme")).toBe("light");
    fireChange(true);
    expect(attrs.get("data-theme")).toBe("dark");
    fireChange(false);
    expect(attrs.get("data-theme")).toBe("light");
  });

  it("with pref='system', cleanup removes the matchMedia listener", () => {
    const { attrs, listeners, fireChange } = installDomStubs(false);
    const cleanup = applyTheme("system");
    expect(listeners.size).toBe(1);
    cleanup();
    expect(listeners.size).toBe(0);
    expect(attrs.get("data-theme")).toBeUndefined();
    // After unmount, a media-query change must NOT touch the attribute.
    fireChange(true);
    expect(attrs.get("data-theme")).toBeUndefined();
  });
});
