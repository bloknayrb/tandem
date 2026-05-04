import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyHighContrast } from "../../src/client/hooks/useHighContrast";

/**
 * Minimal HTMLElement stub that tracks attributes.
 */
function makeEl() {
  const attrs = new Map<string, string>();
  return {
    setAttribute: (name: string, value: string) => attrs.set(name, value),
    removeAttribute: (name: string) => attrs.delete(name),
    getAttribute: (name: string) => attrs.get(name) ?? null,
  } as unknown as HTMLElement;
}

describe("applyHighContrast", () => {
  let el: HTMLElement;
  beforeEach(() => {
    el = makeEl();
  });

  it("sets data-high-contrast to 'true' when enabled", () => {
    applyHighContrast(true, el);
    expect(el.getAttribute("data-high-contrast")).toBe("true");
  });

  it("leaves attribute absent when disabled", () => {
    applyHighContrast(false, el);
    expect(el.getAttribute("data-high-contrast")).toBeNull();
  });

  it("removes attribute when toggled from true to false", () => {
    applyHighContrast(true, el);
    expect(el.getAttribute("data-high-contrast")).toBe("true");
    applyHighContrast(false, el);
    expect(el.getAttribute("data-high-contrast")).toBeNull();
  });

  it("cleanup removes data-high-contrast", () => {
    const cleanup = applyHighContrast(true, el);
    expect(el.getAttribute("data-high-contrast")).toBe("true");
    cleanup();
    expect(el.getAttribute("data-high-contrast")).toBeNull();
  });

  it("cleanup is idempotent when attribute was not set", () => {
    const cleanup = applyHighContrast(false, el);
    expect(el.getAttribute("data-high-contrast")).toBeNull();
    cleanup();
    expect(el.getAttribute("data-high-contrast")).toBeNull();
  });

  it("defaults to document.documentElement when no element passed", () => {
    const attrs = new Map<string, string>();
    const root = {
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      removeAttribute: (name: string) => attrs.delete(name),
      getAttribute: (name: string) => attrs.get(name) ?? null,
    };
    vi.stubGlobal("document", { documentElement: root });
    applyHighContrast(true);
    expect(attrs.get("data-high-contrast")).toBe("true");
    vi.unstubAllGlobals();
  });
});
