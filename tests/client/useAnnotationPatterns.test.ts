import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyAnnotationPatterns } from "../../src/client/hooks/useAnnotationPatterns";

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

describe("applyAnnotationPatterns", () => {
  let el: HTMLElement;
  beforeEach(() => {
    el = makeEl();
  });

  it("sets data-annotation-patterns to 'true' when enabled", () => {
    applyAnnotationPatterns(true, el);
    expect(el.getAttribute("data-annotation-patterns")).toBe("true");
  });

  it("leaves attribute absent when disabled", () => {
    applyAnnotationPatterns(false, el);
    expect(el.getAttribute("data-annotation-patterns")).toBeNull();
  });

  it("removes attribute when toggled from true to false", () => {
    applyAnnotationPatterns(true, el);
    expect(el.getAttribute("data-annotation-patterns")).toBe("true");
    applyAnnotationPatterns(false, el);
    expect(el.getAttribute("data-annotation-patterns")).toBeNull();
  });

  it("cleanup removes data-annotation-patterns", () => {
    const cleanup = applyAnnotationPatterns(true, el);
    expect(el.getAttribute("data-annotation-patterns")).toBe("true");
    cleanup();
    expect(el.getAttribute("data-annotation-patterns")).toBeNull();
  });

  it("cleanup is idempotent when attribute was not set", () => {
    const cleanup = applyAnnotationPatterns(false, el);
    expect(el.getAttribute("data-annotation-patterns")).toBeNull();
    cleanup();
    expect(el.getAttribute("data-annotation-patterns")).toBeNull();
  });

  it("defaults to document.documentElement when no element passed", () => {
    const attrs = new Map<string, string>();
    const root = {
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      removeAttribute: (name: string) => attrs.delete(name),
      getAttribute: (name: string) => attrs.get(name) ?? null,
    };
    vi.stubGlobal("document", { documentElement: root });
    applyAnnotationPatterns(true);
    expect(attrs.get("data-annotation-patterns")).toBe("true");
    vi.unstubAllGlobals();
  });
});
