import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyAccentHue } from "../../src/client/hooks/useAccentHue";

/**
 * Minimal HTMLElement stub that tracks style custom properties, mirroring the
 * pattern in useTheme.test.ts (no DOM environment required).
 */
function makeEl() {
  const props = new Map<string, string>();
  return {
    style: {
      setProperty: (name: string, value: string) => props.set(name, value),
      removeProperty: (name: string) => props.delete(name),
      getPropertyValue: (name: string) => props.get(name) ?? "",
    },
  } as unknown as HTMLElement;
}

describe("applyAccentHue", () => {
  let el: HTMLElement;
  beforeEach(() => {
    el = makeEl();
  });

  it("sets --tandem-accent-h to the given hue", () => {
    applyAccentHue(120, el);
    expect(el.style.getPropertyValue("--tandem-accent-h")).toBe("120deg");
  });

  it("clamps below 0 to 0", () => {
    applyAccentHue(-10, el);
    expect(el.style.getPropertyValue("--tandem-accent-h")).toBe("0deg");
  });

  it("clamps above 360 to 360", () => {
    applyAccentHue(400, el);
    expect(el.style.getPropertyValue("--tandem-accent-h")).toBe("360deg");
  });

  it("rounds fractional hues", () => {
    applyAccentHue(239.7, el);
    expect(el.style.getPropertyValue("--tandem-accent-h")).toBe("240deg");
  });

  it("accepts hue 0 (red) without clamping to default", () => {
    applyAccentHue(0, el);
    expect(el.style.getPropertyValue("--tandem-accent-h")).toBe("0deg");
  });

  it("accepts hue 360 (full circle)", () => {
    applyAccentHue(360, el);
    expect(el.style.getPropertyValue("--tandem-accent-h")).toBe("360deg");
  });

  it("cleanup removes the property", () => {
    const cleanup = applyAccentHue(239, el);
    expect(el.style.getPropertyValue("--tandem-accent-h")).toBe("239deg");
    cleanup();
    expect(el.style.getPropertyValue("--tandem-accent-h")).toBe("");
  });

  it("defaults to document.documentElement when no element passed", () => {
    const props = new Map<string, string>();
    const root = {
      style: {
        setProperty: (name: string, value: string) => props.set(name, value),
        removeProperty: (name: string) => props.delete(name),
        getPropertyValue: (name: string) => props.get(name) ?? "",
      },
    };
    vi.stubGlobal("document", { documentElement: root });
    applyAccentHue(180);
    expect(props.get("--tandem-accent-h")).toBe("180deg");
    vi.unstubAllGlobals();
  });
});
