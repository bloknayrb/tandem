import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyDensity } from "../../src/client/hooks/useDensity";

/**
 * Minimal HTMLElement stub that tracks dataset/attribute values,
 * mirroring the pattern used in useTheme.test.ts.
 */
function makeEl() {
  const attrs = new Map<string, string>();
  return {
    setAttribute: (name: string, value: string) => attrs.set(name, value),
    removeAttribute: (name: string) => attrs.delete(name),
    getAttribute: (name: string) => attrs.get(name) ?? null,
  } as unknown as HTMLElement;
}

describe("applyDensity", () => {
  let el: HTMLElement;
  beforeEach(() => {
    el = makeEl();
  });

  it("sets data-density to 'compact'", () => {
    applyDensity("compact", el);
    expect(el.getAttribute("data-density")).toBe("compact");
  });

  it("sets data-density to 'spacious'", () => {
    applyDensity("spacious", el);
    expect(el.getAttribute("data-density")).toBe("spacious");
  });

  it("sets data-density to 'cozy'", () => {
    applyDensity("cozy", el);
    expect(el.getAttribute("data-density")).toBe("cozy");
  });

  it("cleanup removes data-density", () => {
    const cleanup = applyDensity("compact", el);
    expect(el.getAttribute("data-density")).toBe("compact");
    cleanup();
    expect(el.getAttribute("data-density")).toBeNull();
  });

  it("switching density updates the attribute", () => {
    applyDensity("compact", el);
    expect(el.getAttribute("data-density")).toBe("compact");
    applyDensity("spacious", el);
    expect(el.getAttribute("data-density")).toBe("spacious");
  });

  it("defaults to document.documentElement when no element passed", () => {
    const attrs = new Map<string, string>();
    const root = {
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      removeAttribute: (name: string) => attrs.delete(name),
      getAttribute: (name: string) => attrs.get(name) ?? null,
    };
    vi.stubGlobal("document", { documentElement: root });
    applyDensity("spacious");
    expect(attrs.get("data-density")).toBe("spacious");
    vi.unstubAllGlobals();
  });
});
